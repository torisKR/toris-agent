/**
 * Shared Studio chrome chip for today's spend. Reads `GET /api/brief`
 * (`buildBrief` / `summarizeCost`) and links to `/brief`. Never writes.
 */

export const SPEND_CHIP_HREF = '/brief';

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return `$${amount.toFixed(2)}`;
}

function finiteUsd(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/** View model from `buildBrief().spend`. Quiet when spend is 0 and no budget. */
export function spendChipFromBrief(spend) {
  const spentUsd = finiteUsd(spend?.spentUsd) ?? 0;
  const capUsd = finiteUsd(spend?.capUsd);
  const hasBudget = capUsd != null && capUsd > 0;
  const remainingUsd = hasBudget
    ? (finiteUsd(spend?.remainingUsd) ?? Math.max(0, capUsd - spentUsd))
    : null;
  const quiet = spentUsd === 0 && !hasBudget;
  return {
    href: SPEND_CHIP_HREF,
    quiet,
    hidden: quiet,
    spentUsd,
    capUsd: hasBudget ? capUsd : null,
    remainingUsd,
    label: quiet ? '' : (hasBudget ? `${money(spentUsd)} / ${money(capUsd)}` : money(spentUsd)),
    remainingLabel: hasBudget ? `${money(remainingUsd)} left` : '',
  };
}

export function renderSpendChip(el, view) {
  if (!el) return view;
  el.setAttribute('href', view.href || SPEND_CHIP_HREF);
  el.hidden = Boolean(view.hidden || view.quiet);
  el.textContent = view.label || '';
  const title = view.remainingLabel || '';
  if (title) el.setAttribute('title', title);
  else el.removeAttribute('title');
  const aria = view.quiet
    ? "Today's spend"
    : (title ? `Today's spend ${view.label}, ${title}` : `Today's spend ${view.label}`);
  el.setAttribute('aria-label', aria);
  return view;
}

/** GET `/api/brief` only. Callers must not pass a write method. */
export async function loadSpendChip(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/brief');
  const body = typeof response.json === 'function' ? await response.json() : response;
  if (!response.ok && response.ok !== undefined) {
    throw new Error(body?.error?.message || 'spend chip read failed');
  }
  return spendChipFromBrief(body?.spend);
}

export async function refreshSpendChip(el, fetchImpl = globalThis.fetch) {
  return renderSpendChip(el, await loadSpendChip(fetchImpl));
}

export function startSpendChip({
  root = globalThis.document,
  fetchImpl,
  target = globalThis,
} = {}) {
  const el = root?.getElementById?.('spend-chip');
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!el || !fetchFn) return () => {};

  const refresh = () => refreshSpendChip(el, fetchFn).catch(() => undefined);
  const onPageShow = (event) => {
    if (event?.persisted) refresh();
  };
  target?.addEventListener?.('pageshow', onPageShow);
  refresh();
  return () => target?.removeEventListener?.('pageshow', onPageShow);
}

if (typeof document !== 'undefined') {
  startSpendChip();
}
