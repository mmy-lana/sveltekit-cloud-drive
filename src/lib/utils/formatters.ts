/**
 * Pure presentation helpers for byte counts, quotas and timestamps.
 *
 * Every function here is deterministic and side-effect free: no DOM access, no
 * store access, no `Date.now()` hidden inside a format call — the reference
 * time is always an explicit parameter so that server-rendered and
 * client-rendered output can be compared, and so tests stay stable.
 */
import type { StorageQuota } from '$lib/types/drive';
import type { Timestamp } from 'firebase/firestore';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Byte ladder used for human-readable sizes. 1024-based (binary), as storage vendors report. */
export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Ratio above which the quota gauge switches to its warning presentation. */
export const QUOTA_WARNING_THRESHOLD = 0.8;

/** Ratio above which the quota gauge switches to its critical presentation. */
export const QUOTA_CRITICAL_THRESHOLD = 0.95;

/** Any timestamp older than this is rendered as an absolute date. */
export const RELATIVE_TIME_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Localised formatter cache                                                   */
/* -------------------------------------------------------------------------- */

const numberFormatters = new Map<string, Intl.NumberFormat>();

/** Cached `Intl.NumberFormat` per locale+options key. */
function getNumberFormatter(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? 'default'}|${JSON.stringify(options)}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat(locale, options);
  numberFormatters.set(key, formatter);
  return formatter;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Cached `Intl.DateTimeFormat` per locale+options key. */
function getDateTimeFormatter(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale ?? 'default'}|${JSON.stringify(options)}`;
  const cached = dateTimeFormatters.get(key);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

const relativeFormatters = new Map<string | undefined, Intl.RelativeTimeFormat>();

/** Cached `Intl.RelativeTimeFormat` per locale. */
function getRelativeFormatter(locale: string | undefined): Intl.RelativeTimeFormat {
  const cached = relativeFormatters.get(locale);
  if (cached) return cached;

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  relativeFormatters.set(locale, formatter);
  return formatter;
}

/* -------------------------------------------------------------------------- */
/* Byte formatting                                                             */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link formatBytes}. */
export interface FormatBytesOptions {
  /** BCP-47 locale. `undefined` follows the runtime default. */
  locale?: string;
  /** Maximum fraction digits per magnitude. Default `0` (e.g. `1.2 MB`, `999 KB`). */
  decimals?: number;
  /** Append a space between the number and the unit. Default `true`. */
  space?: boolean;
}

/** Coerce any numeric input to a finite, non-negative byte count. */
function toSafeByteCount(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes;
}

/**
 * Format a byte count with a binary unit ladder.
 *
 * @example
 * formatBytes(0)            // "0 B"
 * formatBytes(1536)         // "1.5 KB"
 * formatBytes(5_368_709_120)// "5 GB"
 */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const { locale, decimals = 0, space = true } = options;
  const safeBytes = toSafeByteCount(bytes);

  if (safeBytes < 1) return `0${space ? ' ' : ''}B`;

  const exponent = Math.min(
    Math.floor(Math.log(safeBytes) / Math.log(1024)),
    BYTE_UNITS.length - 1
  );
  const value = safeBytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent];

  // `maximumFractionDigits` alone would round 1.05 KB to "1 KB"; forcing a
  // minimum of 0 keeps the caller's intent explicit and never adds noise.
  const formatted = getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, decimals)
  }).format(value);

  return `${formatted}${space ? ' ' : ''}${unit}`;
}

/**
 * Format an exact byte count, e.g. `1,048,576 bytes`.
 *
 * Used where the precise number matters more than the magnitude (quota
 * tooltips, quota rejection errors).
 */
export function formatBytesPrecise(bytes: number, locale?: string): string {
  const safeBytes = toSafeByteCount(bytes);
  const formatted = getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(safeBytes);

  return `${formatted} ${safeBytes === 1 ? 'byte' : 'bytes'}`;
}

/**
 * Format bytes with an explicit SI-vs-binary choice.
 *
 * Storage vendors label 1024-based units as GB while the label technically
 * means 10^9. This helper makes the base explicit at the call site.
 */
export function formatBytesWithBase(
  bytes: number,
  base: 1000 | 1024 = 1024,
  options: FormatBytesOptions = {}
): string {
  const { locale, decimals = 0, space = true } = options;
  const safeBytes = toSafeByteCount(bytes);
  if (safeBytes < 1) return `0${space ? ' ' : ''}B`;

  const siUnits = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;
  const units = base === 1000 ? siUnits : BYTE_UNITS;
  const exponent = Math.min(Math.floor(Math.log(safeBytes) / Math.log(base)), units.length - 1);
  const value = safeBytes / base ** exponent;

  const formatted = getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, decimals)
  }).format(value);

  return `${formatted}${space ? ' ' : ''}${units[exponent]}`;
}

/* -------------------------------------------------------------------------- */
/* Transfer rates                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Format a transfer rate, e.g. `4.2 MB/s`.
 *
 * Negative and non-finite inputs collapse to `0 B/s` rather than printing
 * `NaN` into the upload drawer.
 */
export function formatTransferRate(bytesPerSecond: number, locale?: string): string {
  const safeRate = toSafeByteCount(bytesPerSecond);
  return `${formatBytes(safeRate, { locale, decimals: 1 })}/s`;
}

/**
 * Format an estimated remaining duration from progress data.
 *
 * Returns `null` when the estimate is not yet meaningful (no bytes moved yet,
 * or no measurable rate), so callers can render a neutral placeholder instead
 * of a wrong number.
 */
export function formatEtaSeconds(
  bytesRemaining: number,
  bytesPerSecond: number
): number | null {
  if (!Number.isFinite(bytesRemaining) || bytesRemaining <= 0) return 0;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return Math.round(bytesRemaining / bytesPerSecond);
}

/* -------------------------------------------------------------------------- */
/* Percentages, counts                                                         */
/* -------------------------------------------------------------------------- */

/** Clamp any numeric value into the inclusive `[0, 1]` range. */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Clamp any numeric value into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Format a ratio as a whole-number percentage.
 *
 * @example formatPercentage(0.5) // "50%"
 * formatPercentage(1)     // "100%"
 */
export function formatPercentage(ratio: number, locale?: string): string {
  const percentage = clampRatio(ratio) * 100;
  const rounded = getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(percentage);

  return `${rounded}%`;
}

/**
 * Format a part-of-whole ratio as a percentage with one decimal place.
 *
 * Used by the quota gauge where "79.6%" versus "80%" is a meaningful
 * difference near the warning threshold.
 */
export function formatPercentagePrecise(ratio: number, locale?: string): string {
  const percentage = clampRatio(ratio) * 100;
  const formatted = getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  }).format(percentage);

  return `${formatted}%`;
}

/** Format a completed-progress value (0-100) as a whole percentage. */
export function formatProgressPercentage(progress: number, locale?: string): string {
  return formatPercentage(clamp(progress, 0, 100) / 100, locale);
}

/**
 * Compact item counts for badges: `1`, `1.2K`, `3.4M`.
 */
export function formatCount(count: number, locale?: string): string {
  if (!Number.isFinite(count) || count <= 0) return '0';

  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' }
  ] as const;

  for (const unit of units) {
    if (count >= unit.threshold) {
      const value = count / unit.threshold;
      const formatted = getNumberFormatter(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1
      }).format(value);
      return `${formatted}${unit.suffix}`;
    }
  }

  return getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(count);
}

/** Pluralise a noun against a count, e.g. `formatItems(1) // "1 item"`. */
export function formatItems(count: number, singular: string, plural = `${singular}s`): string {
  const safeCount = Number.isFinite(count) ? count : 0;
  return `${formatCount(safeCount)} ${safeCount === 1 ? singular : plural}`;
}

/** Format a whole number with locale grouping. */
export function formatNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '0';
  return getNumberFormatter(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

/* -------------------------------------------------------------------------- */
/* Durations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Format a duration in seconds as a compact human string.
 *
 * @example formatDuration(45)    // "45s"
 * formatDuration(3661)  // "1h 1m"
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';

  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor((totalSeconds / 3600) % 24);
  const days = Math.floor(totalSeconds / 86400);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                  */
/* -------------------------------------------------------------------------- */

/** Anything the drive can hand to a date formatter. */
export type DateLike = Timestamp | Date | number | string;

/**
 * Convert a Firestore `Timestamp`, `Date`, epoch number or ISO string into a
 * millisecond epoch.
 *
 * Returns `null` for values that cannot represent a real instant, so callers
 * render an explicit "unknown" affordance instead of `Invalid Date`.
 */
export function toEpochMs(value: DateLike | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  // Firestore Timestamp: duck-typed to avoid a hard instanceof dependency on
  // the concrete class identity across bundles.
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  if (typeof toMillis === 'function') {
    const millis = (toMillis as () => number).call(value);
    return Number.isFinite(millis) ? millis : null;
  }

  const seconds = (value as { seconds?: unknown }).seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  return null;
}

/** True when both instants fall on the same calendar day in the runtime timezone. */
export function isSameDay(left: DateLike, right: DateLike = Date.now()): boolean {
  const leftMs = toEpochMs(left);
  const rightMs = toEpochMs(right);
  if (leftMs === null || rightMs === null) return false;

  const a = new Date(leftMs);
  const b = new Date(rightMs);

  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** True when the instant is within the last 24 hours (relative to `now`). */
export function isWithinLastDay(value: DateLike, now: DateLike = Date.now()): boolean {
  const valueMs = toEpochMs(value);
  const nowMs = toEpochMs(now);
  if (valueMs === null || nowMs === null) return false;

  const delta = nowMs - valueMs;
  return delta >= 0 && delta < 24 * 60 * 60 * 1000;
}

/**
 * Render an instant as a relative phrase: `just now`, `5 minutes ago`,
 * `yesterday`, `3 days ago`, then a short absolute date.
 *
 * @param value  the instant to describe
 * @param now    reference time (defaults to `Date.now()`)
 * @returns the formatted phrase, or `null` when the value is not a real instant
 *
 * @example
 * formatRelativeTime(epochOf(nowMs - 90_000), nowMs) // "2 minutes ago"
 */
export function formatRelativeTime(value: DateLike, now: DateLike = Date.now()): string | null {
  const valueMs = toEpochMs(value);
  const nowMs = toEpochMs(now);
  if (valueMs === null || nowMs === null) return null;

  const diffMs = valueMs - nowMs;
  const absoluteDiff = Math.abs(diffMs);
  const formatter = getRelativeFormatter(undefined);

  if (absoluteDiff < 45_000) {
    return 'just now';
  }

  // Anything beyond the cutoff degrades to a concrete date: "34 days ago" is
  // noise in a file list.
  if (absoluteDiff > RELATIVE_TIME_CUTOFF_MS) {
    return formatAbsoluteDate(valueMs);
  }

  const units: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000]
  ];

  for (const [unit, unitMs] of units) {
    if (absoluteDiff >= unitMs) {
      return formatter.format(Math.round(diffMs / unitMs), unit);
    }
  }

  return 'just now';
}

/** Render a locale-aware calendar date, e.g. `5 Mar 2026`. */
export function formatAbsoluteDate(value: DateLike): string | null {
  const ms = toEpochMs(value);
  if (ms === null) return null;

  return getDateTimeFormatter(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(ms));
}

/** Render a locale-aware calendar date with weekday, e.g. `Thu, 5 Mar 2026`. */
export function formatLongDate(value: DateLike): string | null {
  const ms = toEpochMs(value);
  if (ms === null) return null;

  return getDateTimeFormatter(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(ms));
}

/** Render a clock time, e.g. `14:05`. */
export function formatTimeOfDay(value: DateLike): string | null {
  const ms = toEpochMs(value);
  if (ms === null) return null;

  return getDateTimeFormatter(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ms));
}

/** Render a full date + time stamp, e.g. `5 Mar 2026, 14:05`. */
export function formatDateTime(value: DateLike): string | null {
  const ms = toEpochMs(value);
  if (ms === null) return null;

  return getDateTimeFormatter(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ms));
}

/**
 * Pick the right label for a "Date modified" column.
 *
 * Today renders a clock time, this week renders a relative phrase, anything
 * older renders a calendar date. Falls back to an em dash when the value is
 * not a real instant, so a corrupt timestamp never renders `Invalid Date`.
 */
export function formatModifiedDate(value: DateLike, now: DateLike = Date.now()): string {
  const ms = toEpochMs(value);
  if (ms === null) return '—';

  if (isSameDay(ms, now)) {
    return getDateTimeFormatter(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  }

  const relative = formatRelativeTime(ms, now);
  if (relative === null) return '—';
  return relative;
}

/* -------------------------------------------------------------------------- */
/* Quota                                                                       */
/* -------------------------------------------------------------------------- */

/** Severity bands used by the storage meter. */
export type QuotaSeverity = 'ok' | 'warning' | 'critical';

/** Every number the storage meter needs, pre-computed and clamped for display. */
export interface QuotaUsage {
  usedBytes: number;
  reservedBytes: number;
  totalBytes: number;
  /** `usedBytes + reservedBytes`, never above `totalBytes`. */
  committedBytes: number;
  availableBytes: number;
  /** Share of the total consumed by committed data, in `[0, 1]`. */
  usedRatio: number;
  /** Share of the total held by in-flight reservations, in `[0, 1]`. */
  reservedRatio: number;
  /** Share of the total consumed by committed + reserved bytes, in `[0, 1]`. */
  occupiedRatio: number;
  severity: QuotaSeverity;
}

/** Map a raw occupancy ratio onto its warning band. */
export function getQuotaSeverity(occupiedRatio: number): QuotaSeverity {
  if (occupiedRatio >= QUOTA_CRITICAL_THRESHOLD) return 'critical';
  if (occupiedRatio >= QUOTA_WARNING_THRESHOLD) return 'warning';
  return 'ok';
}

/**
 * Derive the full quota breakdown for a storage meter.
 *
 * A zero/absent `totalBytes` (an un-provisioned account) yields a safe
 * zeroed breakdown rather than `NaN`/`Infinity` leaking into the UI.
 */
export function getQuotaUsage(quota: StorageQuota): QuotaUsage {
  const usedBytes = toSafeByteCount(quota.usedBytes);
  const reservedBytes = toSafeByteCount(quota.reservedBytes);
  const totalBytes = toSafeByteCount(quota.totalBytes);

  if (totalBytes === 0) {
    return {
      usedBytes,
      reservedBytes,
      totalBytes,
      committedBytes: usedBytes,
      availableBytes: 0,
      usedRatio: 0,
      reservedRatio: 0,
      occupiedRatio: 0,
      severity: 'ok'
    };
  }

  const committedBytes = clamp(usedBytes + reservedBytes, 0, totalBytes);
  const availableBytes = totalBytes - committedBytes;
  const occupiedRatio = clampRatio(committedBytes / totalBytes);

  return {
    usedBytes,
    reservedBytes,
    totalBytes,
    committedBytes,
    availableBytes,
    usedRatio: clampRatio(usedBytes / totalBytes),
    reservedRatio: clampRatio(reservedBytes / totalBytes),
    occupiedRatio,
    severity: getQuotaSeverity(occupiedRatio)
  };
}

/**
 * One-line quota summary for tooltips and the sidebar footer.
 *
 * @example
 * formatQuotaSummary({ usedBytes: 5e9, reservedBytes: 0, totalBytes: 1e10 })
 * // "5 GB of 10 GB used"
 */
export function formatQuotaSummary(quota: StorageQuota, locale?: string): string {
  const usage = getQuotaUsage(quota);
  return `${formatBytes(usage.usedBytes, { locale, decimals: 1 })} of ${formatBytes(usage.totalBytes, {
    locale,
    decimals: 0
  })} used`;
}

/**
 * Human-readable rejection message for a reservation that would exceed quota.
 *
 * Surfaced verbatim by the upload queue when the authoritative transaction
 * refuses the hold, so the user knows exactly how much room is missing.
 */
export function formatQuotaExceededMessage(
  requestedBytes: number,
  quota: StorageQuota,
  locale?: string
): string {
  const usage = getQuotaUsage(quota);
  const shortfall = Math.max(0, requestedBytes - usage.availableBytes);

  return (
    `Not enough storage. This upload needs ${formatBytes(requestedBytes, { locale, decimals: 1 })}, ` +
    `but only ${formatBytes(usage.availableBytes, { locale, decimals: 1 })} is available. ` +
    `Free up ${formatBytes(shortfall, { locale, decimals: 1 })} or remove a file to continue.`
  );
}
