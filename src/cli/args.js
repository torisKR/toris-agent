import { UsageError } from '../core/errors.js';

const GLOBAL_BOOLEANS = new Set(['json', 'no-color', 'verbose', 'help', 'version']);
const KNOWN_BOOLEANS = new Set([...GLOBAL_BOOLEANS, 'dry-run', 'yes', 'md', 'follow']);
const ALIASES = { p: 'project', f: 'follow', h: 'help', v: 'version', s: 'status', n: 'limit' };

/**
 * Minimal argv parser: no dependency, predictable rules.
 * `--flag`, `--key value`, `--key=value`, `-p value`, `--` terminator.
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = Object.create(null);
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (KNOWN_BOOLEANS.has(body)) { flags[body] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = ALIASES[arg.slice(1)];
      if (!key) throw new UsageError(`Unknown flag "${arg}"`);
      const next = argv[i + 1];
      if (KNOWN_BOOLEANS.has(key) || next === undefined || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

export function requirePositional(positionals, index, name) {
  const value = positionals[index];
  if (!value) throw new UsageError(`Missing required argument <${name}>`);
  return value;
}

export function asNumber(value, name) {
  if (value === undefined || value === true) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new UsageError(`--${name} must be a number, got "${value}"`);
  return num;
}
