/**
 * Shared Studio chrome chip for local Android devices. Reads
 * `GET /api/android` (`androidStatus`) and links to `/android`.
 * Never writes, installs, screenshots, or dumps logcat.
 */

export const ANDROID_CHIP_HREF = '/android';
export const ANDROID_CHIP_PATH = '/api/android';
export const ANDROID_CHIP_LABEL = 'android';

function deviceCountOf(status) {
  const devices = Array.isArray(status?.devices) ? status.devices : [];
  return devices.length;
}

/** View model from `androidStatus` / GET `/api/android`. Quiet when adb is down or no devices. */
export function androidChipFromStatus(status) {
  const deviceCount = deviceCountOf(status);
  const failed = status?.ok === false || Boolean(status?.error);
  const quiet = failed || deviceCount === 0;
  return {
    href: ANDROID_CHIP_HREF,
    quiet,
    hidden: quiet,
    deviceCount,
    label: quiet ? '' : ANDROID_CHIP_LABEL,
  };
}

export function renderAndroidChip(el, view) {
  if (!el) return view;
  el.setAttribute('href', view.href || ANDROID_CHIP_HREF);
  el.hidden = Boolean(view.hidden || view.quiet);
  el.textContent = view.label || '';
  if (view.quiet) el.removeAttribute('aria-label');
  else el.setAttribute('aria-label', view.label);
  return view;
}

/** GET `/api/android` only. Callers must not pass a write method. */
export async function loadAndroidChip(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(ANDROID_CHIP_PATH);
  const body = typeof response.json === 'function' ? await response.json() : response;
  if (!response.ok && response.ok !== undefined) {
    throw new Error(body?.error?.message || 'android chip read failed');
  }
  return androidChipFromStatus(body);
}

export async function refreshAndroidChip(el, fetchImpl = globalThis.fetch) {
  return renderAndroidChip(el, await loadAndroidChip(fetchImpl));
}

export function startAndroidChip({
  root = globalThis.document,
  fetchImpl,
  target = globalThis,
} = {}) {
  const el = root?.getElementById?.('android-chip');
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!el || !fetchFn) return () => {};

  const refresh = () => refreshAndroidChip(el, fetchFn).catch(() => undefined);
  const onPageShow = (event) => {
    if (event?.persisted) refresh();
  };
  target?.addEventListener?.('pageshow', onPageShow);
  refresh();
  return () => target?.removeEventListener?.('pageshow', onPageShow);
}

if (typeof document !== 'undefined') {
  startAndroidChip();
}
