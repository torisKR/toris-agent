/**
 * Shared Studio chrome chip for the Design Mode annotation tray. Reads
 * `GET /api/design/tray` (`DesignStore.getTray` / `presentTray`)
 * and links to `/design`. Never writes, clears, or sends a turn.
 */

export const DESIGN_CHIP_HREF = '/design';
export const DESIGN_CHIP_PATH = '/api/design/tray';

function itemCountOf(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.length;
}

/** View model from `{ items }` / tray count. Quiet when count is 0. */
export function designChipFromTray(body) {
  const itemCount = itemCountOf(body);
  const quiet = itemCount === 0;
  return {
    href: DESIGN_CHIP_HREF,
    quiet,
    hidden: quiet,
    itemCount,
    label: quiet ? '' : `${itemCount} design`,
  };
}

export function renderDesignChip(el, view) {
  if (!el) return view;
  el.setAttribute('href', view.href || DESIGN_CHIP_HREF);
  el.hidden = Boolean(view.hidden || view.quiet);
  el.textContent = view.label || '';
  if (view.quiet) el.removeAttribute('aria-label');
  else el.setAttribute('aria-label', view.label);
  return view;
}

/** GET `/api/design/tray` only. Callers must not pass a write method. */
export async function loadDesignChip(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(DESIGN_CHIP_PATH);
  const body = typeof response.json === 'function' ? await response.json() : response;
  if (!response.ok && response.ok !== undefined) {
    throw new Error(body?.error?.message || 'design chip read failed');
  }
  return designChipFromTray(body);
}

export async function refreshDesignChip(el, fetchImpl = globalThis.fetch) {
  return renderDesignChip(el, await loadDesignChip(fetchImpl));
}

export function startDesignChip({
  root = globalThis.document,
  fetchImpl,
  target = globalThis,
} = {}) {
  const el = root?.getElementById?.('design-chip');
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!el || !fetchFn) return () => {};

  const refresh = () => refreshDesignChip(el, fetchFn).catch(() => undefined);
  const onPageShow = (event) => {
    if (event?.persisted) refresh();
  };
  target?.addEventListener?.('pageshow', onPageShow);
  refresh();
  return () => target?.removeEventListener?.('pageshow', onPageShow);
}

if (typeof document !== 'undefined') {
  startDesignChip();
}
