import { execFile } from 'node:child_process';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_SERVICE_LABEL, generateLaunchAgent } from './launchd.js';

const DEFAULT_BIN = fileURLToPath(new URL('../../../bin/toris.js', import.meta.url));

function runFile(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exitCode: error?.code && Number.isInteger(error.code) ? error.code : error ? 1 : 0, stdout: stdout || '', stderr: stderr || error?.message || '' });
    });
  });
}

export class StudioServiceManager {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.uid = options.uid ?? process.getuid?.();
    this.userHome = options.userHome || homedir();
    this.torisHome = options.torisHome || join(this.userHome, '.toris');
    this.nodePath = options.nodePath || process.execPath;
    this.binPath = options.binPath || DEFAULT_BIN;
    this.workingDirectory = options.workingDirectory || dirname(dirname(this.binPath));
    this.runner = options.runner || runFile;
    this.launchAgentsDirectory = join(this.userHome, 'Library', 'LaunchAgents');
    this.logDirectory = join(this.torisHome, 'logs');
    this.plistPath = join(this.launchAgentsDirectory, `${STUDIO_SERVICE_LABEL}.plist`);
    this.domain = `gui/${this.uid}`;
    this.target = `${this.domain}/${STUDIO_SERVICE_LABEL}`;
  }

  #assertSupported() {
    if (this.platform !== 'darwin' || !Number.isInteger(this.uid)) throw new Error('Toris Studio service requires a macOS user launch domain.');
  }

  async #required(args, action) {
    const result = await this.runner('launchctl', args);
    if (result.exitCode !== 0) throw new Error(`${action} failed: ${result.stderr || result.stdout}`);
    return result;
  }

  async install() {
    this.#assertSupported();
    await mkdir(this.launchAgentsDirectory, { recursive: true });
    await mkdir(this.logDirectory, { recursive: true });
    const plist = generateLaunchAgent({
      nodePath: this.nodePath,
      binPath: this.binPath,
      torisHome: this.torisHome,
      workingDirectory: this.workingDirectory,
      logDirectory: this.logDirectory,
    });
    const temporary = `${this.plistPath}.${process.pid}.tmp`;
    await writeFile(temporary, plist, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.plistPath);
    await this.runner('launchctl', ['bootout', this.domain, this.plistPath]);
    await this.#required(['bootstrap', this.domain, this.plistPath], 'launchctl bootstrap');
    await this.#required(['kickstart', '-k', this.target], 'launchctl kickstart');
    return { ...(await this.status()), plistPath: this.plistPath };
  }

  async status() {
    this.#assertSupported();
    let installed = true;
    try { await access(this.plistPath); } catch { installed = false; }
    const result = await this.runner('launchctl', ['print', this.target]);
    return {
      installed,
      running: result.exitCode === 0 && /state\s*=\s*running/i.test(result.stdout),
      label: STUDIO_SERVICE_LABEL,
      plistPath: this.plistPath,
    };
  }

  async restart() {
    this.#assertSupported();
    await this.#required(['kickstart', '-k', this.target], 'launchctl kickstart');
    return await this.status();
  }

  async uninstall() {
    this.#assertSupported();
    await this.runner('launchctl', ['bootout', this.domain, this.plistPath]);
    await unlink(this.plistPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    return { installed: false, running: false, label: STUDIO_SERVICE_LABEL, plistPath: this.plistPath };
  }
}
