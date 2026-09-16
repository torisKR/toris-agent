import { HttpError } from './http.js';
import { assertSafeHttpUrl, injectPickerMarkup } from './design.js';

const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

function isHtml(contentType) {
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml' || type === '';
}

/**
 * Fetch a page for the Design Mode iframe. The result is rewritten so the
 * picker script runs on Studio origin while relative assets still point at
 * the target via <base>.
 */
export async function loadProxiedPage(targetUrl, options = {}) {
  let parsed;
  try {
    parsed = assertSafeHttpUrl(targetUrl, 'target URL');
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  const fetchImpl = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = parsed.href;
  let response;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new HttpError(504, 'target page timed out');
      throw new HttpError(502, `cannot fetch target page: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = header(response.headers, 'location');
      if (!location) throw new HttpError(502, 'target redirected without a Location');
      current = new URL(location, current).href;
      try {
        assertSafeHttpUrl(current, 'redirect URL');
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      continue;
    }
    break;
  }
  if (!response || response.status >= 400) {
    throw new HttpError(502, `target page returned HTTP ${response?.status ?? 0}`);
  }
  const contentType = header(response.headers, 'content-type');
  if (!isHtml(contentType)) {
    throw new HttpError(415, 'target URL did not return HTML');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_HTML_BYTES) throw new HttpError(413, 'target page is too large to proxy');
  const html = buffer.toString('utf8');
  return {
    url: current,
    html: injectPickerMarkup(html, {
      pickerSrc: '/assets/design-picker.js',
      baseHref: current,
    }),
  };
}

export const FRAME_CSP =
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; script-src 'self' * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src *; frame-ancestors 'self'; base-uri *; object-src 'none'";

export const SAMPLE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'";
