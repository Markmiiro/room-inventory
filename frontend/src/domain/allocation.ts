import type { Death, Expense, Move, Record_, Sale, Species } from "../db/types";
import { daysBetween } from "./format";

/**
 * SPEC 4.4 — estimated cost share.
 *
 * Purchase prices and treatment costs belong to a record directly. Expenses do
 * not: you feed a room, not an animal. So an expense is spread across whatever
 * was in its pool, weighted by **head-days** — `head_count × days present`.
 *
 * Head-days rather than a plain split because neither number alone is honest.
 * Ten head there for a fortnight and five head there all month ate the same
 * amount of feed; a per-record split would say the first cost twice as much,
 * and a per-head split would say it cost the same as ten head all month.
 *
 * The result is an **estimate**, and SPEC 4.4 requires that word to appear in
 * words wherever a figure from here is shown. Nothing in this module rounds its
 * way to a total that ties out with the farm's actual spend, and it is not
 * supposed to: an expense whose pool was empty is money that was really spent
 * and genuinely cannot be attributed to an animal.
 */

export interface Period {
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Inclusive, YYYY-MM-DD. */
  end: string;
}

export type Pool =
  | { kind: "farm" }
  | { kind: "species"; species: Species }
  | { kind: "room"; roomId: string };

/**
 * The month containing the expense.
 *
 * SPEC 3.10 gives an expense a single date, and SPEC 4.4 says a single-date
 * expense is spread over the month containing it — so this is always the rule,
 * not a fallback for expenses that lack a range.
 */
export function periodForExpense(expense: Expense): Period {
  const [year, month] = expense.date.slice(0, 10).split("-").map(Number);
  const y = year ?? 1970;
  const m = month ?? 1;
  // Day 0 of the next month is the last day of this one, which gets February
  // and leap years right without a table.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay)}` };
}

/**
 * How and when a record left.
 *
 * `head` matters as much as `on`. A record's `head_count` is what it holds
 * *now*, and a sold record holds nothing — so using it would multiply the days
 * it was present by zero and charge it for none of the feed it ate. What it had
 * while it was here is the head that left on the day it left.
 */
export interface Departure {
  /** Inclusive: the day it left still counts. */
  on: string;
  /** The head it carried during its last stretch of presence. */
  head: number;
}

export interface HeadDaysInput {
  record: Record_;
  /** Every move, or at least every move of this record. */
  moves: Move[];
  period: Period;
  pool: Pool;
  /** Undefined means the record is still on the farm. */
  departure?: Departure | null;
}

/** `head_count × days present during the period`, for one record in one pool. */
export function headDays({ record, moves, period, pool, departure }: HeadDaysInput): number {
  if (pool.kind === "species" && record.species !== pool.species) return 0;

  const ownMoves = moves.filter((m) => m.record_id === record.id && !m.deleted_at);
  const arrived = arrivalOf(record, ownMoves);
  if (!arrived) return 0;

  // The window this record could count for at all, before the pool narrows it.
  const from = later(period.start, arrived);
  const to = departure ? earlier(period.end, departure.on) : period.end;

  const days =
    pool.kind === "room"
      ? daysInRoom(ownMoves, pool.roomId, from, to)
      : inclusiveDays(from, to);

  return days * (departure ? departure.head : record.head_count);
}

/**
 * One expense, split across the records in its pool.
 *
 * Returns whole shillings per record id. Records with no head-days in the
 * period are absent rather than present with zero — there is a difference
 * between "carried none of this" and "was not there".
 */
export function allocateExpense(
  expense: Expense,
  records: Record_[],
  moves: Move[],
  departures: Map<string, Departure> = new Map(),
): Map<string, number> {
  const shares = new Map<string, number>();
  if (expense.deleted_at) return shares;

  const period = periodForExpense(expense);
  const pool = poolFor(expense);
  if (!pool) return shares;

  const weights: Array<{ id: string; weight: number }> = [];
  for (const record of records) {
    if (record.deleted_at) continue;
    const departure = departures.get(record.id) ?? null;
    // SPEC 4.4 spreads across active records. One that has left still counts
    // for the days it was here, but only once we know when that was.
    if (record.status !== "active" && !departure) continue;

    const weight = headDays({ record, moves, period, pool, departure });
    if (weight > 0) weights.push({ id: record.id, weight });
  }

  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total === 0) return shares;

  // Largest remainder, so the shares add up to what was actually spent. Money
  // is whole shillings (SPEC 1), and a plain round would leak or invent one.
  const exact = weights.map((w) => ({
    id: w.id,
    value: (expense.amount * w.weight) / total,
  }));
  let assigned = 0;
  for (const { id, value } of exact) {
    const floored = Math.floor(value);
    shares.set(id, floored);
    assigned += floored;
  }

  // Ties broken by record id so the same expense splits the same way on every
  // load. Otherwise a record's estimated profit flickers by a shilling
  // depending on the order rows came back from the database.
  const remainders = exact
    .map(({ id, value }) => ({ id, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction === a.fraction ? a.id.localeCompare(b.id) : b.fraction - a.fraction));

  for (let i = 0; i < expense.amount - assigned; i += 1) {
    const winner = remainders[i % remainders.length]!;
    shares.set(winner.id, (shares.get(winner.id) ?? 0) + 1);
  }

  return shares;
}

/** Everything one record carries across every expense — the last term of the
 *  per-record profit in SPEC 4.5. */
export function expenseShareFor(
  recordId: string,
  expenses: Expense[],
  records: Record_[],
  moves: Move[],
  departures: Map<string, Departure> = new Map(),
): number {
  return expenses.reduce(
    (sum, expense) =>
      sum + (allocateExpense(expense, records, moves, departures).get(recordId) ?? 0),
    0,
  );
}

// ---------------------------------------------------------------------------

function poolFor(expense: Expense): Pool | null {
  if (expense.applies_to === "farm") return { kind: "farm" };
  if (!expense.applies_to_id) return null;
  return expense.applies_to === "species"
    ? { kind: "species", species: expense.applies_to_id as Species }
    : { kind: "room", roomId: expense.applies_to_id };
}

/** The first day this record was anywhere on the farm. */
function arrivalOf(record: Record_, ownMoves: Move[]): string | null {
  const earliest = ownMoves.reduce<string | null>(
    (best, move) => (best === null || move.date < best ? move.date : best),
    null,
  );
  return earliest ?? record.arrival_date ?? record.date_of_birth ?? record.created_at.slice(0, 10);
}

/**
 * Days spent in one room, within a window.
 *
 * A move's own date belongs to the destination — the animal is in the new room
 * that night — so a stay runs from its move date to the day before the next
 * move. Summing the stays rather than walking day by day keeps this cheap when
 * the Money summary asks for a year at a time.
 */
function daysInRoom(ownMoves: Move[], roomId: string, from: string, to: string): number {
  if (from > to) return 0;

  const ordered = [...ownMoves].sort((a, b) =>
    a.date === b.date ? a.created_at.localeCompare(b.created_at) : a.date.localeCompare(b.date),
  );

  let days = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const move = ordered[i]!;
    if (move.to_room_id !== roomId) continue;
    const next = ordered[i + 1];
    const stayStart = move.date;
    const stayEnd = next ? addDay(next.date, -1) : to;
    days += inclusiveDays(later(stayStart, from), earlier(stayEnd, to));
  }
  return days;
}

function inclusiveDays(from: string, to: string): number {
  return from > to ? 0 : daysBetween(from, to) + 1;
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

function addDay(isoDate: string, by: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + by)).toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}


/**
 * The day each record stopped being on the farm.
 *
 * SPEC 4.4 charges a record for the days it was present. Without this, an
 * animal sold on the 2nd still carries a full month of feed — which is not an
 * error anyone would see, just a number that is quietly too big. That is the
 * whole reason Sales and Deaths were built before anything read the allocation.
 *
 * A record leaves on the day its head reached zero, so the departure is the
 * date of the event that took the last of it — by date, then by `created_at`
 * for two events on the same day, matching how SPEC 4.1 orders moves.
 */
export function departuresFrom(
  records: Record_[],
  sales: Sale[],
  deaths: Death[],
): Map<string, Departure> {
  const leaving = new Map<string, Array<{ date: string; created_at: string; count: number }>>();
  for (const event of [...sales, ...deaths]) {
    if (event.deleted_at) continue;
    const list = leaving.get(event.record_id) ?? [];
    list.push({ date: event.date, created_at: event.created_at, count: event.count });
    leaving.set(event.record_id, list);
  }

  const departures = new Map<string, Departure>();
  for (const record of records) {
    // Still here. A record that has lost some head but not all of it has no
    // departure date, and its remaining head keep counting.
    if (record.status === "active") continue;

    const events = (leaving.get(record.id) ?? []).sort((a, b) =>
      a.date === b.date ? a.created_at.localeCompare(b.created_at) : a.date.localeCompare(b.date),
    );
    if (events.length === 0) continue;

    // Walk forward to the event that took the count to zero. A group oversold
    // by two offline devices (SPEC 6.7) keeps both sales, so the later one is
    // not the departure — the record was already gone.
    // The head it carried on its way out is the count of the event that
    // emptied it — that is what was still here to be fed until that day.
    let remaining = record.initial_head_count;
    for (const event of events) {
      remaining -= event.count;
      if (remaining <= 0) {
        departures.set(record.id, { on: event.date, head: event.count });
        break;
      }
    }
    // Every head accounted for by splits rather than by this record's own
    // events: fall back to the last event there was.
    if (!departures.has(record.id)) {
      const last = events[events.length - 1]!;
      departures.set(record.id, { on: last.date, head: last.count });
    }
  }

  return departures;
}
