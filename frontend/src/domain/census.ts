import type { Death, Move, Record_, Sale, Species } from "../db/types";
import { ALL_SPECIES } from "./rules";

/**
 * SPEC 19.1 — what the farm holds, by species, as at a date.
 *
 * **One counting rule, taking a date.** "Right now" is this function with
 * today's date, not a second, simpler version of it. That is the whole design
 * of this module: a live count and an as-at count that drift apart give two
 * screens that disagree about how many hens the farm has, and there is no way
 * for anyone reading them to tell which is lying.
 *
 * The rule is the one the server already uses in
 * `backend/app/domain/reconcile.py`, with a date bound added to each term:
 *
 *     head = initial_head_count − sold − died − split away
 *
 * clamped at zero. Everything the app knows about a count is an event with a
 * date on it, which is what makes the as-at view cheap: no snapshots, no
 * history table, just the same subtraction with `<= asAt` on each part.
 *
 * The clamp matters and is not defensive coding. SPEC 6.7: two devices offline
 * can each sell 5 head from a group of 8, and both sales are real and both are
 * kept. The count floors at zero rather than going negative, and the anomaly is
 * raised on the server where it can be acted on.
 *
 * Head counts only, never percentages (SPEC 4.2), and animals and groups are
 * both counted by head — one cow is one head, a flock of 240 hens is 240.
 */

export interface CensusInput {
  records: Record_[];
  moves: Move[];
  sales: Sale[];
  deaths: Death[];
}

export interface SpeciesCensus {
  species: Species;
  /** Live head on this date. */
  head: number;
  /** How many records those head are spread across — one flock of 240 and 240
   *  single birds are the same headcount and a very different farm. */
  records: number;
}

export interface Census {
  asAt: string;
  bySpecies: SpeciesCensus[];
  /** Total live head across every species. */
  total: number;
}

/**
 * The date a record joined the farm.
 *
 * Its first move is the arrival (SPEC 4.1 orders by date then created_at), and
 * that is the date the user typed. `arrival_date` is the fallback for a record
 * added with no room, and `created_at` the last resort — a record with neither
 * is one the app has no arrival information for at all, and counting it from
 * when the row was written is the least wrong of the remaining options.
 *
 * This is not an age and must never be used as one. SPEC 13.4 forbids
 * substituting a creation date for a date of birth, and nothing here does: a
 * two-year-old cow bought last week arrived last week and is not a week old.
 */
export function joinedOn(record: Record_, movesFor: Move[]): string {
  let earliest: Move | null = null;
  for (const move of movesFor) {
    if (move.deleted_at) continue;
    if (
      earliest === null ||
      move.date < earliest.date ||
      (move.date === earliest.date && move.created_at < earliest.created_at)
    ) {
      earliest = move;
    }
  }
  if (earliest) return earliest.date;
  if (record.arrival_date) return record.arrival_date;
  return record.created_at.slice(0, 10);
}

/** Everything a headcount needs, grouped once rather than re-scanned per
 *  record. Over thousands of rows the naive version is quadratic (SPEC 6.13). */
interface Index {
  movesByRecord: Map<string, Move[]>;
  salesByRecord: Map<string, Sale[]>;
  deathsByRecord: Map<string, Death[]>;
  childrenByParent: Map<string, Record_[]>;
}

function index(input: CensusInput): Index {
  const movesByRecord = new Map<string, Move[]>();
  for (const move of input.moves) {
    if (move.deleted_at) continue;
    const list = movesByRecord.get(move.record_id);
    if (list) list.push(move);
    else movesByRecord.set(move.record_id, [move]);
  }

  const salesByRecord = new Map<string, Sale[]>();
  for (const sale of input.sales) {
    if (sale.deleted_at) continue;
    const list = salesByRecord.get(sale.record_id);
    if (list) list.push(sale);
    else salesByRecord.set(sale.record_id, [sale]);
  }

  const deathsByRecord = new Map<string, Death[]>();
  for (const death of input.deaths) {
    if (death.deleted_at) continue;
    const list = deathsByRecord.get(death.record_id);
    if (list) list.push(death);
    else deathsByRecord.set(death.record_id, [death]);
  }

  const childrenByParent = new Map<string, Record_[]>();
  for (const record of input.records) {
    if (record.deleted_at || !record.parent_record_id) continue;
    const list = childrenByParent.get(record.parent_record_id);
    if (list) list.push(record);
    else childrenByParent.set(record.parent_record_id, [record]);
  }

  return { movesByRecord, salesByRecord, deathsByRecord, childrenByParent };
}

/**
 * Live head on one record as at a date.
 *
 * Zero before the record arrived, and zero once everything has left it. Both
 * are real answers rather than absences: a record that has not arrived yet and
 * one whose whole group has been sold both hold nothing on the date asked
 * about.
 */
function headAsAt(record: Record_, asAt: string, idx: Index): number {
  const moves = idx.movesByRecord.get(record.id) ?? [];
  if (joinedOn(record, moves) > asAt) return 0;

  let head = record.initial_head_count;

  for (const sale of idx.salesByRecord.get(record.id) ?? []) {
    if (sale.date <= asAt) head -= sale.count;
  }
  for (const death of idx.deathsByRecord.get(record.id) ?? []) {
    if (death.date <= asAt) head -= death.count;
  }
  /**
   * Head split off into a child record (SPEC 4.3). The child carries its own
   * independent move history starting at the destination, so the date it
   * joined is the date the split happened — and before that date the head was
   * still on the parent, which is exactly where this counts it. Without the
   * date bound a past census would show a group already short of the head it
   * had not yet lost.
   */
  for (const child of idx.childrenByParent.get(record.id) ?? []) {
    const childMoves = idx.movesByRecord.get(child.id) ?? [];
    if (joinedOn(child, childMoves) <= asAt) head -= child.initial_head_count;
  }

  // SPEC 6.7 — two offline devices can both sell from the same group, and both
  // sales are kept. The count floors here; the anomaly is raised on the server.
  return Math.max(head, 0);
}

/**
 * The census.
 *
 * Pass today for "right now". Species with no live head are left out entirely
 * rather than listed as zero: a farm that has never kept geese should not have
 * to read a line telling it so, and one that sold its last goose last month is
 * told by the line's absence rather than by a zero that looks like a mistake.
 * The order is `ALL_SPECIES` (SPEC 18), so it is the same order as every filter
 * row and list section in the app.
 */
export function censusAsAt(asAt: string, input: CensusInput): Census {
  const idx = index(input);
  const head = new Map<Species, number>();
  const counts = new Map<Species, number>();

  for (const record of input.records) {
    if (record.deleted_at) continue;
    const live = headAsAt(record, asAt, idx);
    if (live === 0) continue;
    head.set(record.species, (head.get(record.species) ?? 0) + live);
    counts.set(record.species, (counts.get(record.species) ?? 0) + 1);
  }

  const bySpecies = ALL_SPECIES.filter((species) => head.has(species)).map((species) => ({
    species,
    head: head.get(species)!,
    records: counts.get(species)!,
  }));

  return {
    asAt,
    bySpecies,
    total: bySpecies.reduce((sum, row) => sum + row.head, 0),
  };
}
