/**
 * SPEC 1 — currency and time.
 *
 * Money is whole shillings held as integers. Nothing here ever produces a
 * float: rounding errors in a ledger are the kind of bug nobody notices until
 * the totals stop agreeing.
 */

export function formatUGX(shillings: number): string {
  const sign = shillings < 0 ? "−" : "";
  return `${sign}UGX ${Math.abs(Math.trunc(shillings)).toLocaleString("en-US")}`;
}

/** Short form for summary cards only — never on a form or a record detail. */
export function formatUGXShort(shillings: number): string {
  const abs = Math.abs(Math.trunc(shillings));
  const sign = shillings < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}UGX ${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000) return `${sign}UGX ${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sign}UGX ${abs.toLocaleString("en-US")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A plain YYYY-MM-DD carries no timezone (SPEC 1), so it is split by hand
 *  rather than passed through Date, which would shift it. */
export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function formatDateShort(isoDate: string): string {
  const [, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  if (!month || !day) return isoDate;
  return `${day} ${MONTHS[month - 1]}`;
}

/** A UTC timestamp shown in East Africa Time (UTC+3). */
export function formatTimestamp(iso: string): string {
  const eat = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const day = eat.getUTCDate();
  const month = MONTHS[eat.getUTCMonth()];
  const hours = String(eat.getUTCHours()).padStart(2, "0");
  const minutes = String(eat.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hours}:${minutes}`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : pluralForm ?? `${singular}s`;
}

/**
 * "head" as a unit of livestock does not inflect: one head, twelve head.
 *
 * It takes the count only so call sites read like the other unit helpers, and
 * so this stays the one place the rule lives — `plural(n, "head")` would
 * produce "heads", which is wrong everywhere it appears.
 */
export function headUnit(_count: number): string {
  return "head";
}

/**
 * How long something has been alive, or in the building — "2y 4m", "3w", "5d".
 *
 * The unit shrinks as the span does, because that is the way the number is
 * actually used: a day matters for a newborn and not at all for a four-year-old
 * cow. Dates are plain YYYY-MM-DD and carry no timezone (SPEC 1), so this
 * counts days between them rather than going through Date arithmetic on
 * timestamps.
 */
export function formatAge(from: string, today: string): string {
  const days = daysBetween(from, today);
  // Nothing useful to say about something that arrived this morning, and "0d"
  // beside a tag reads like a broken field. Callers drop the empty string.
  if (days <= 0) return "";
  if (days < 7) return `${days}d`;
  if (days < 56) return `${Math.floor(days / 7)}w`;

  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(today);
  let months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  if (months < 12) return `${Math.max(months, 1)}m`;

  const years = Math.floor(months / 12);
  months -= years * 12;
  return months ? `${years}y ${months}m` : `${years}y`;
}

function parts(isoDate: string): [number, number, number] {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  return [year ?? 0, month ?? 0, day ?? 0];
}

/** Whole days from one plain date to another; negative if `to` is earlier.
 *  Exported because the alert rules count days in both directions. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  // Date.UTC takes a zero-based month. Passing the one-based month shifts each
  // date into the following month, and because months are different lengths
  // that shift does not cancel out across a month boundary.
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** A plain date shifted by whole days, staying a plain date. Going through
 *  local time would drift across a DST boundary in either direction. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = parts(isoDate);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
