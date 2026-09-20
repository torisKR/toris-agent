/**
 * Shared Studio chrome chip for pending patches. Reads
 * `GET /api/patches?status=pending` (`listPatches` / `presentPatch`)
 * and links to `/patches`. Never writes.
 */

export const PATCHES_CHIP_HREF = '/patches';
export const PATCHES_CHIP_PATH = '/api/patches?status=pending';

function pendingCountOf(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.length;
}

/** View model from `{ items }` / pending count. Quiet when count is 0. */
export function patchesChipFromList(body) {
  const pendingCount = pendingCountOf(body);
  const quiet = pendingCount === 0;
  return {
    href: PATCHES_CHIP_HREF,
    quiet,
    hidden: quiet,
    pendingCount,
    label: quiet ? '' : `${pendingCount} pending`,
  };
}

export function renderPatchesChip(el, view) {
  if (!el) return view;
  el.setAttribute('href', view.href || PATCHES_CHIP_HREF);
  el.hidden = Boolean(view.hidden || view.quiet);
  el.textContent = view.label || '';
  if (view.quiet) el.removeAttribute('aria-label');
  else el.setAttribute('aria-label', view.label);
  return view;
}

/** GET `/api/patches?status=pending` only. Callers must not pass a write method. */
export async function loadPatchesChip(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(PATCHES_CHIP_PATH);
  const body = typeof response.json === 'function' ? await response.json() : response;
  if (!response.ok && response.ok !== undefined) {
    throw new Error(body?.error?.message || 'patches chip read failed');
  }
  return patchesChipFromList(body);
}

export async function refreshPatchesChip(el, fetchImpl = globalThis.fetch) {
  return renderPatchesChip(el, await loadPatchesChip(fetchImpl));
}

export function startPatchesChip({
  root = globalThis.document,
  fetchImpl,
  target = globalThis,
} = {}) {
  const el = root?.getElementById?.('patches-chip');
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!el || !fetchFn) return () => {};

  const refresh = () => refreshPatchesChip(el, fetchFn).catch(() => undefined);
  const onPageShow = (event) => {
    if (event?.persisted) refresh();
  };
  target?.addEventListener?.('pageshow', onPageShow);
  refresh();
  return () => target?.removeEventListener?.('pageshow', onPageShow);
}

if (typeof document !== 'undefined') {
  startPatchesChip();
}
