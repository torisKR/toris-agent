/**
 * Shared Studio chrome chip for the local daemon. Reads `GET /api/daemon`
 * (`presentDaemonSnapshot` / `readDaemonStatus`) and links to `/daemon`.
 * Never writes, starts, stops, or enqueues.
 */

export const DAEMON_CHIP_HREF = '/daemon';
export const DAEMON_CHIP_PATH = '/api/daemon';
export const DAEMON_CHIP_LABEL = 'daemon';

/** View model from `{ status: { running } }`. Quiet when the worker is down. */
export function daemonChipFromStatus(status) {
  const running = Boolean(status?.running);
  const quiet = !running;
  return {
    href: DAEMON_CHIP_HREF,
    quiet,
    hidden: quiet,
    running,
    label: quiet ? '' : DAEMON_CHIP_LABEL,
  };
}

export function renderDaemonChip(el, view) {
  if (!el) return view;
  el.setAttribute('href', view.href || DAEMON_CHIP_HREF);
  el.hidden = Boolean(view.hidden || view.quiet);
  el.textContent = view.label || '';
  if (view.quiet) el.removeAttribute('aria-label');
  else el.setAttribute('aria-label', view.label);
  return view;
}

/** GET `/api/daemon` only. Callers must not pass a write method. */
export async function loadDaemonChip(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(DAEMON_CHIP_PATH);
  const body = typeof response.json === 'function' ? await response.json() : response;
  if (!response.ok && response.ok !== undefined) {
    throw new Error(body?.error?.message || 'daemon chip read failed');
  }
  return daemonChipFromStatus(body?.status);
}

export async function refreshDaemonChip(el, fetchImpl = globalThis.fetch) {
  return renderDaemonChip(el, await loadDaemonChip(fetchImpl));
}

export function startDaemonChip({
  root = globalThis.document,
  fetchImpl,
  target = globalThis,
} = {}) {
  const el = root?.getElementById?.('daemon-chip');
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!el || !fetchFn) return () => {};

  const refresh = () => refreshDaemonChip(el, fetchFn).catch(() => undefined);
  const onPageShow = (event) => {
    if (event?.persisted) refresh();
  };
  target?.addEventListener?.('pageshow', onPageShow);
  refresh();
  return () => target?.removeEventListener?.('pageshow', onPageShow);
}

if (typeof document !== 'undefined') {
  startDaemonChip();
}
