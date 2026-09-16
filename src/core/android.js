import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { detectBinary } from './providers.js';
import { createId } from './ids.js';
import { TorisError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const LOGCAT_DEFAULT_LINES = 200;
const LOGCAT_MAX_LINES = 2_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export const ANDROID_ACTIONS = Object.freeze([
  'status',
  'devices',
  'screenshot',
  'logcat',
  'install',
]);

export function androidHome(torisHome) {
  return join(torisHome, 'android');
}

export function inspectAndroidTools({ detect = detectBinary, env = process.env } = {}) {
  const adb = detect('adb', { env });
  const emulator = detect('emulator', { env });
  return {
    adb,
    emulator,
    ready: Boolean(adb),
  };
}

export function androidDoctorChecks(options = {}) {
  const tools = inspectAndroidTools(options);
  return [
    {
      name: 'adb',
      status: tools.adb ? 'PASS' : 'WARN',
      detail: tools.adb ?? 'adb not on PATH; Android verify is optional',
    },
    {
      name: 'emulator',
      status: tools.emulator ? 'PASS' : 'WARN',
      detail: tools.emulator ?? 'emulator not on PATH; device or Expo Go is enough',
    },
  ];
}

/**
 * Spawn argv (never a shell) so serials and APK paths cannot inject commands.
 */
export function spawnArgv(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, encoding = 'utf8' } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({
        exitCode: -1,
        stdout: encoding === 'buffer' ? Buffer.alloc(0) : '',
        stderr: String(err.message),
        timedOut: false,
      });
      return;
    }
    const out = [];
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();
    const finish = (code) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      resolvePromise({
        exitCode: code ?? -1,
        stdout: encoding === 'buffer' ? stdoutBuf : stdoutBuf.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    };
    child.on('error', (error) => {
      err.push(Buffer.from(String(error.message)));
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

function requireAdb(tools) {
  if (!tools.adb) {
    throw new TorisError(
      'adb is not on PATH. Install Android platform-tools, or skip Android verify — the rest of toris does not need it.',
      'E_ADB_MISSING',
    );
  }
  return tools.adb;
}

function withSerial(serial, rest) {
  const id = typeof serial === 'string' ? serial.trim() : '';
  if (!id) return rest;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new TorisError(`Invalid device serial "${id}".`, 'E_ADB_SERIAL');
  }
  return ['-s', id, ...rest];
}

export function parseAdbDevices(stdout) {
  const devices = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices')) continue;
    const match = line.match(/^(\S+)\s+(\S+)(.*)$/);
    if (!match) continue;
    const extra = match[3].trim();
    const fields = Object.fromEntries(
      extra
        .split(/\s+/)
        .filter((part) => part.includes(':'))
        .map((part) => {
          const at = part.indexOf(':');
          return [part.slice(0, at), part.slice(at + 1)];
        }),
    );
    devices.push({
      serial: match[1],
      state: match[2],
      ...fields,
    });
  }
  return devices;
}

async function runAdb(tools, args, options = {}) {
  const bin = requireAdb(tools);
  const exec = options.exec || spawnArgv;
  const result = await exec(bin, args, options);
  if (result.timedOut) {
    throw new TorisError(`adb timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`, 'E_ADB_TIMEOUT');
  }
  return result;
}

export async function androidStatus(options = {}) {
  const tools = inspectAndroidTools(options);
  if (!tools.adb) {
    return { ok: false, ...tools, version: null, devices: [] };
  }
  const version = await runAdb(tools, ['version'], options);
  const devices = await androidDevices({ ...options, tools });
  return {
    ok: version.exitCode === 0,
    ...tools,
    version: String(version.stdout || '').trim().split(/\r?\n/)[0] || null,
    devices: devices.devices,
  };
}

export async function androidDevices(options = {}) {
  const tools = options.tools || inspectAndroidTools(options);
  const result = await runAdb(tools, ['devices', '-l'], options);
  if (result.exitCode !== 0) {
    throw new TorisError(result.stderr.trim() || 'adb devices failed.', 'E_ADB');
  }
  return { ok: true, adb: tools.adb, devices: parseAdbDevices(result.stdout) };
}

function looksLikePng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 4).equals(PNG_MAGIC);
}

export async function androidScreenshot(options = {}) {
  const tools = options.tools || inspectAndroidTools(options);
  const home = options.home;
  if (!home) throw new TorisError('android screenshot needs a toris home.', 'E_ADB');
  const dir = join(androidHome(home), 'screenshots');
  await mkdir(dir, { recursive: true });
  const id = createId('scr');
  const file = join(dir, `${id}.png`);
  const result = await runAdb(tools, withSerial(options.serial, ['exec-out', 'screencap', '-p']), {
    ...options,
    encoding: 'buffer',
    timeoutMs: options.timeoutMs ?? 20_000,
  });
  if (result.exitCode !== 0) {
    const err = String(result.stderr || result.stdout || 'screencap failed').trim();
    throw new TorisError(err, 'E_ADB');
  }
  const png = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  if (!looksLikePng(png)) {
    throw new TorisError('adb screencap did not return a PNG. Is a device connected?', 'E_ADB');
  }
  await writeFile(file, png);
  return {
    ok: true,
    id,
    path: file,
    bytes: png.length,
    serial: options.serial || null,
  };
}

export async function androidLogcat(options = {}) {
  const tools = options.tools || inspectAndroidTools(options);
  const home = options.home;
  if (!home) throw new TorisError('android logcat needs a toris home.', 'E_ADB');
  const requested = Number(options.lines);
  const lines = Number.isFinite(requested)
    ? Math.min(LOGCAT_MAX_LINES, Math.max(1, Math.trunc(requested)))
    : LOGCAT_DEFAULT_LINES;
  const dir = join(androidHome(home), 'logs');
  await mkdir(dir, { recursive: true });
  const id = createId('log');
  const file = join(dir, `${id}.log`);
  const result = await runAdb(tools, withSerial(options.serial, ['logcat', '-d', '-t', String(lines)]), {
    ...options,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
  if (result.exitCode !== 0) {
    throw new TorisError(String(result.stderr || 'logcat failed').trim(), 'E_ADB');
  }
  const text = String(result.stdout ?? '');
  await writeFile(file, text);
  return {
    ok: true,
    id,
    path: file,
    bytes: Buffer.byteLength(text),
    lines,
    serial: options.serial || null,
    tail: text.length > 4_000 ? text.slice(-4_000) : text,
  };
}

export async function androidInstall(options = {}) {
  const tools = options.tools || inspectAndroidTools(options);
  const apk = resolve(String(options.apk ?? ''));
  try {
    await access(apk, constants.R_OK);
  } catch {
    throw new TorisError(`APK not readable: ${apk}`, 'E_ADB_APK');
  }
  if (!apk.toLowerCase().endsWith('.apk')) {
    throw new TorisError('install expects a .apk file.', 'E_ADB_APK');
  }
  const result = await runAdb(tools, withSerial(options.serial, ['install', '-r', apk]), {
    ...options,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode !== 0) throw new TorisError(output || 'adb install failed.', 'E_ADB');
  return {
    ok: true,
    apk: basename(apk),
    path: apk,
    serial: options.serial || null,
    output,
  };
}

export async function runAndroidAction(action, options = {}) {
  switch (action) {
    case 'status':
      return androidStatus(options);
    case 'devices':
      return androidDevices(options);
    case 'screenshot':
      return androidScreenshot(options);
    case 'logcat':
      return androidLogcat(options);
    case 'install':
      return androidInstall(options);
    default:
      throw new TorisError(
        `Unknown android action "${action}". Use ${ANDROID_ACTIONS.join('|')}.`,
        'E_USAGE',
      );
  }
}
