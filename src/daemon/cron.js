/**
 * Local schedule expressions. Stdlib only; no cloud, no timezone database.
 *
 * Supported:
 *   - 5-field cron: min hour dom month dow (`*`, `n`, `n-m`, star-slash-n, `n,m`, names)
 *   - aliases: `@hourly` `@daily` `@midnight` `@weekly` `@monthly`
 *   - interval: `@every 15m` `@every 2h` (optional `s` for tests)
 *   - clock: `09:00` `09:00 mon-fri` `21:30 weekdays` `08:00 sat,sun`
 *
 * Evaluation uses the machine's local timezone (`Date` local getters).
 */

const WEEKDAY_NAMES = Object.freeze({
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
});

const MONTH_NAMES = Object.freeze({
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
});

const ALIASES = Object.freeze({
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
});

const EVERY_RE = /^@every\s+(\d+)\s*(s|sec|secs|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?:\s+(.+))?$/;

export class ScheduleExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleExprError';
  }
}

export function localParts(date) {
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    day: date.getDate(),
    month: date.getMonth() + 1,
    weekday: date.getDay(),
    ms: date.getTime(),
  };
}

export function parseScheduleExpr(input) {
  const source = String(input ?? '').trim();
  if (!source) throw new ScheduleExprError('Schedule expression is required.');

  const every = parseEvery(source);
  if (every) return every;

  const clock = parseClock(source);
  if (clock) return clock;

  const aliased = ALIASES[source.toLowerCase()];
  const cronText = aliased || source;
  if (cronText.startsWith('@')) {
    throw new ScheduleExprError(
      `Unsupported schedule expression "${source}". Use 5-field cron, @hourly/@daily/@weekly/@monthly, @every <n>m|h, or HH:MM [weekdays].`,
    );
  }
  return parseCron(cronText, source);
}

function parseEvery(source) {
  const match = source.match(EVERY_RE);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) {
    throw new ScheduleExprError(`@every amount must be a positive integer, got "${source}".`);
  }
  const unit = match[2].toLowerCase();
  const ms =
    unit.startsWith('h') ? amount * 3_600_000 : unit.startsWith('s') ? amount * 1_000 : amount * 60_000;
  if (ms < 1_000) throw new ScheduleExprError(`@every interval is too small: "${source}".`);
  return { kind: 'every', source, everyMs: ms };
}

function parseClock(source) {
  const match = source.match(CLOCK_RE);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new ScheduleExprError(`Invalid clock time "${source}". Use HH:MM in 24-hour local time.`);
  }
  const dowRaw = (match[3] || '*').trim().toLowerCase();
  const weekday = expandWeekdayToken(dowRaw);
  return {
    kind: 'cron',
    source,
    minute: singleton(minute, 0, 59),
    hour: singleton(hour, 0, 23),
    day: anyField(),
    month: anyField(),
    weekday,
  };
}

function expandWeekdayToken(raw) {
  if (raw === '*' || raw === 'daily' || raw === 'everyday' || raw === 'every day') return anyField();
  if (raw === 'weekdays' || raw === 'weekday') return expandField('mon-fri', 0, 7, WEEKDAY_NAMES, true);
  if (raw === 'weekends' || raw === 'weekend') return expandField('sat,sun', 0, 7, WEEKDAY_NAMES, true);
  return expandField(raw, 0, 7, WEEKDAY_NAMES, true);
}

function parseCron(text, source) {
  const fields = text.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new ScheduleExprError(
      `Cron must have 5 fields (min hour dom month dow), got ${fields.length} in "${source}".`,
    );
  }
  return {
    kind: 'cron',
    source,
    minute: expandField(fields[0], 0, 59),
    hour: expandField(fields[1], 0, 23),
    day: expandField(fields[2], 1, 31),
    month: expandField(fields[3], 1, 12, MONTH_NAMES),
    weekday: expandField(fields[4], 0, 7, WEEKDAY_NAMES, true),
  };
}

function anyField() {
  return { any: true, values: null };
}

function singleton(value, min, max) {
  if (value < min || value > max) throw new ScheduleExprError(`Value ${value} is out of range ${min}-${max}.`);
  return { any: false, values: new Set([value]) };
}

function expandField(raw, min, max, names = {}, weekday = false) {
  const text = String(raw).trim().toLowerCase();
  if (!text) throw new ScheduleExprError('Empty cron field.');
  if (text === '*') return anyField();
  const values = new Set();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) throw new ScheduleExprError(`Invalid cron field "${raw}".`);
    const [rangePart, stepPart] = splitStep(token);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new ScheduleExprError(`Invalid cron step in "${raw}".`);
    }
    const [start, end] = parseRange(rangePart, min, max, names);
    for (let n = start; n <= end; n += step) {
      values.add(weekday ? normalizeDow(n) : n);
    }
  }
  if (values.size === 0) throw new ScheduleExprError(`Cron field "${raw}" matches nothing.`);
  return { any: false, values };
}

function splitStep(token) {
  const idx = token.indexOf('/');
  if (idx === -1) return [token, undefined];
  return [token.slice(0, idx), token.slice(idx + 1)];
}

function parseRange(rangePart, min, max, names) {
  if (rangePart === '*') return [min, max];
  if (rangePart.includes('-')) {
    const [a, b] = rangePart.split('-');
    const start = resolveNumber(a, names);
    const end = resolveNumber(b, names);
    if (start < min || end > max || start > end) {
      throw new ScheduleExprError(`Invalid cron range "${rangePart}".`);
    }
    return [start, end];
  }
  const value = resolveNumber(rangePart, names);
  if (value < min || value > max) {
    throw new ScheduleExprError(`Cron value "${rangePart}" is out of range ${min}-${max}.`);
  }
  return [value, value];
}

function resolveNumber(raw, names) {
  const text = String(raw).trim().toLowerCase();
  if (Object.hasOwn(names, text)) return names[text];
  if (/^\d+$/.test(text)) return Number(text);
  throw new ScheduleExprError(`Unknown cron name "${raw}".`);
}

function normalizeDow(value) {
  return value === 7 ? 0 : value;
}

export function matchesCron(parsed, parts) {
  if (parsed.kind !== 'cron') return false;
  return (
    fieldHas(parsed.minute, parts.minute) &&
    fieldHas(parsed.hour, parts.hour) &&
    fieldHas(parsed.month, parts.month) &&
    matchDay(parsed, parts)
  );
}

function fieldHas(field, value) {
  return field.any || field.values.has(value);
}

/**
 * Standard cron: when both day-of-month and day-of-week are restricted, a
 * date matches if either field matches. `*` on one field means "ignore it".
 */
function matchDay(parsed, parts) {
  const dom = fieldHas(parsed.day, parts.day);
  const dow = fieldHas(parsed.weekday, parts.weekday);
  if (parsed.day.any && parsed.weekday.any) return true;
  if (parsed.day.any) return dow;
  if (parsed.weekday.any) return dom;
  return dom || dow;
}

export function nextDueAfter(expr, from, partsOf = localParts) {
  const parsed = typeof expr === 'string' ? parseScheduleExpr(expr) : expr;
  const start = from instanceof Date ? from : new Date(from);
  if (!Number.isFinite(start.getTime())) throw new ScheduleExprError('from must be a valid date');
  if (parsed.kind === 'every') return new Date(start.getTime() + parsed.everyMs);

  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  for (let t = cursor.getTime(); t <= limit; t += 60_000) {
    const date = new Date(t);
    if (matchesCron(parsed, partsOf(date))) return date;
  }
  throw new ScheduleExprError(`No occurrence of "${parsed.source}" in the next year.`);
}

export function describeExpr(expr) {
  const parsed = typeof expr === 'string' ? parseScheduleExpr(expr) : expr;
  if (parsed.kind === 'every') {
    const ms = parsed.everyMs;
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
    return `every ${ms / 1_000}s`;
  }
  return parsed.source;
}
