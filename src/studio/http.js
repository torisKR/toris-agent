import { timingSafeEqual } from 'node:crypto';
import { resolve, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function readJson(request, options = {}) {
  const limitBytes = options.limitBytes || 256 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new HttpError(413, 'request body is too large');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw new HttpError(400, 'request body must be a JSON object');
  }
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertStudioMutation(request, options) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = options.origin || 'http://127.0.0.1:5824';
  if (request.headers.origin !== origin) throw new HttpError(403, 'invalid studio origin');
  if (!sameSecret(request.headers['x-toris-studio-token'], options.token)) {
    throw new HttpError(403, 'invalid studio token');
  }
}

function compile(pattern) {
  const names = [];
  const parts = pattern.split('/').filter(Boolean).map((part) => {
    if (part.startsWith(':')) {
      names.push(part.slice(1));
      return '([^/]+)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { names, expression: new RegExp(`^/${parts.join('/')}/?$`) };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, handler, ...compile(pattern) });
    return this;
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.expression.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
      return { handler: route.handler, params };
    }
    return null;
  }
}

export function resolveStaticFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'invalid static path');
  }
  const segments = decoded.split('/');
  if (decoded.includes('\0') || segments.includes('..')) throw new HttpError(400, 'invalid static path');
  const base = resolve(root);
  const candidate = resolve(base, decoded.replace(/^\/+/, ''));
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) throw new HttpError(400, 'invalid static path');
  return candidate;
}
