/**
 * The period both Money tabs are read over.
 *
 * Pulled out of the Money screen when Analytics arrived (SPEC 19). Two screens
 * sharing a selector but each working out its own date range is how they end up
 * quietly reporting different periods under the same label — the selector says
 * "12 months" on both, and only the numbers disagree. There is one definition
 * here and both read it.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The choices on the selector, in the order they appear. */
export const PERIOD_OPTIONS = [3, 12, 60] as const;
export type PeriodMonths = (typeof PERIOD_OPTIONS)[number];

export function periodOptionLabel(months: number): string {
  return months === 60 ? "5 years" : `${months} months`;
}

export interface Period {
  /** First day included, `YYYY-MM-DD`. */
  since: string;
  /** Last day included — today, in East Africa Time. */
  until: string;
  months: number;
}

/**
 * The window ending today and running back `months` whole months.
 *
 * It starts on the first of its earliest month rather than on the same day
 * number, so "3 months" is three calendar months a farmer can point at on a
 * wall rather than an interval that starts mid-month.
 */
export function periodFrom(today: string, months: number): Period {
  const [y, m] = today.split("-").map(Number);
  const since = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 - (months - 1), 1))
    .toISOString()
    .slice(0, 10);
  return { since, until: today, months };
}

/** Whether a dated row falls inside the period. Dates are plain `YYYY-MM-DD`
 *  and sort lexically, so no parsing is needed (SPEC 1). */
export function inPeriod(period: Period, date: string): boolean {
  return date >= period.since && date <= period.until;
}

export function rowsInPeriod<T extends { date: string }>(period: Period, rows: T[]): T[] {
  return rows.filter((row) => inPeriod(period, row.date));
}

export function periodLabel(period: Period): string {
  const [sy, sm] = period.since.split("-").map(Number);
  const [ty, tm] = period.until.split("-").map(Number);
  return `${MONTHS[(sm ?? 1) - 1]} ${sy} to ${MONTHS[(tm ?? 1) - 1]} ${ty}`;
}
