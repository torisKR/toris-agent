import { spawn as nodeSpawn } from 'node:child_process';

export class PythonBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PythonBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

function tail(buffer, chunk, limit) {
  const next = Buffer.concat([buffer, Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

function parseResult(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  try {
    const result = JSON.parse(lines.at(-1));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object required');
    return result;
  } catch {
    throw new PythonBridgeError('PYTHON_PROTOCOL', 'Python bridge did not return a JSON object');
  }
}

export function runProcess(options) {
  const spawn = options.spawn || nodeSpawn;
  const timeoutMs = options.timeoutMs || 15 * 60 * 1000;
  const maxOutputBytes = options.maxOutputBytes || 1024 * 1024;

  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(options.bin, options.args || [], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const exceed = () => {
      child.kill('SIGKILL');
      finish(reject, new PythonBridgeError('PYTHON_OUTPUT_LIMIT', 'Python bridge exceeded its output limit'));
    };

    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > maxOutputBytes) return exceed();
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr, chunk, maxOutputBytes);
    });
    child.once('error', (error) => {
      finish(reject, new PythonBridgeError('PYTHON_SPAWN', error.message, { cause: error }));
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      const stderrText = stderr.toString('utf8');
      if (exitCode !== 0) {
        finish(reject, new PythonBridgeError('PYTHON_EXIT', `Python bridge exited with code ${exitCode}`, { exitCode, signal, stderr: stderrText }));
        return;
      }
      try {
        finish(resolve, parseResult(stdout.toString('utf8')));
      } catch (error) {
        finish(reject, error);
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new PythonBridgeError('PYTHON_TIMEOUT', `Python bridge exceeded ${timeoutMs}ms`, { timeoutMs }));
    }, timeoutMs);

    const input = options.input == null ? '' : `${JSON.stringify(options.input)}\n`;
    child.stdin.end(input);
  });
}
