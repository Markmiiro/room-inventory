import type {
  HealthRecord,
  Record_,
  ScheduleSpecies,
  Species,
  TreatmentSchedule,
} from "../db/types";
import { ageBasis } from "./age";
import { addDays, daysBetween } from "./format";
import { isBird } from "./rules";

/**
 * SPEC 13.3 — what each record is due for, and when.
 *
 * A pure function of records, schedules and treatment history, so the answer is
 * the same on the Health screen, on Record detail, in the alert rules and on
 * the Calendar. All four read this; none re-derives it.
 *
 * The rule that carries the most weight is the one about where an interval
 * counts from:
 *
 *   **Intervals count from what actually happened, not from the plan.**
 *
 * Deworm on the 7th when it was due on the 10th and the next one falls due
 * three months after the 7th, not after the 10th. This is not a rounding
 * detail. Counting from the plan would let a schedule drift permanently ahead
 * of the animal — every early dose shortening the real gap by the number of
 * days it was early, compounding over a year into a genuinely over-treated
 * animal. The plan is a guide; the animal's history is the truth.
 *
 * The consequence worth noting is that a schedule's own `first_due_age_days`
 * and `repeat_every_days` are only ever read to compute a *gap*. Once a
 * treatment exists against a schedule, the plan's dates stop being consulted at
 * all — the last real dose is the only anchor.
 */

export interface DueItem {
  /** Stable across recomputation: one schedule against one record. */
  id: string;
  record: Record_;
  schedule: TreatmentSchedule;
  /** YYYY-MM-DD. */
  dueDate: string;
  /** Negative when overdue, 0 today, positive when still coming. */
  days: number;
  /** The dose this one counts from, when there is one. Null for a first dose. */
  lastGiven: HealthRecord | null;
}

export interface ScheduleInputs {
  records: Record_[];
  schedules: TreatmentSchedule[];
  health: HealthRecord[];
  /** Today in East Africa Time, as YYYY-MM-DD. */
  today: string;
}

/**
 * Whether a schedule's species setting covers one record's species.
 *
 * `all` covers everything and `birds` covers the four of SPEC 18 — the seeded
 * Newcastle and Gumboro rows are written that way, because one interval the
 * farmer can edit once beats four copies that have to be kept agreeing.
 */
export function speciesCovered(scope: ScheduleSpecies, species: Species): boolean {
  if (scope === "all") return true;
  if (scope === "birds") return isBird(species);
  return scope === species;
}

/**
 * Whether a schedule covers a record at all — species and kind (SPEC 13.3).
 *
 * Deliberately says nothing about age. A record a schedule applies to but whose
 * age is unknown is still covered by the schedule; it simply cannot produce a
 * date, and SPEC 13.4 wants that surfaced rather than treated as "not
 * applicable".
 */
export function scheduleCovers(schedule: TreatmentSchedule, record: Record_): boolean {
  if (!speciesCovered(schedule.species, record.species)) return false;
  if (schedule.applies_to === "animals" && record.kind !== "animal") return false;
  if (schedule.applies_to === "groups" && record.kind !== "group") return false;
  return true;
}

/** The active records one schedule currently applies to — the count the manage
 *  screen shows against each row (SPEC 13.6). */
export function recordsCovered(
  schedule: TreatmentSchedule,
  records: Record_[],
): Record_[] {
  return records.filter(
    (record) =>
      record.status === "active" && !record.deleted_at && scheduleCovers(schedule, record),
  );
}

/**
 * The next due date for one schedule against one record, or null.
 *
 * Null has three distinct causes, and none of them is an error:
 *   - the record's age cannot be computed (SPEC 13.4);
 *   - the schedule is one-off and has already been given;
 *   - the schedule has neither a first age nor an interval, so it never fires.
 */
export function nextDueFor(
  schedule: TreatmentSchedule,
  record: Record_,
  history: HealthRecord[],
): { dueDate: string; lastGiven: HealthRecord | null } | null {
  const given = mostRecentAgainst(schedule, history);

  if (given) {
    // A dose exists. From here the plan's first-due age is irrelevant — only
    // the interval matters, and only measured from the day the dose actually
    // happened. A one-off schedule (no interval) is finished.
    if (schedule.repeat_every_days == null || schedule.repeat_every_days <= 0) return null;
    return {
      dueDate: addDays(given.date, schedule.repeat_every_days),
      lastGiven: given,
    };
  }

  // No dose yet, so the first one is counted from birth or arrival. SPEC 13.3:
  // where there is no first-due age, the interval doubles as one.
  const from = ageBasis(record);
  if (!from) return null;

  const offset = schedule.first_due_age_days ?? schedule.repeat_every_days;
  if (offset == null || offset < 0) return null;

  return { dueDate: addDays(from, offset), lastGiven: null };
}

/**
 * The most recent treatment logged against this schedule.
 *
 * Matched on `schedule_id` alone. An ad-hoc treatment of the same type — a sick
 * animal dewormed out of turn — carries a null `schedule_id` and deliberately
 * does not count, because SPEC 13.3 says it "does not disturb any schedule".
 *
 * Ordered by the date the dose was given, with `created_at` breaking ties, so
 * two doses entered on two devices for the same day resolve the same way
 * everywhere.
 */
function mostRecentAgainst(
  schedule: TreatmentSchedule,
  history: HealthRecord[],
): HealthRecord | null {
  let best: HealthRecord | null = null;
  for (const treatment of history) {
    if (treatment.deleted_at) continue;
    if (treatment.schedule_id !== schedule.id) continue;
    if (
      best === null ||
      treatment.date > best.date ||
      (treatment.date === best.date && treatment.created_at > best.created_at)
    ) {
      best = treatment;
    }
  }
  return best;
}

/**
 * Every scheduled item due for every active record, soonest first.
 *
 * Records whose age is unknown produce nothing here — that silence is the whole
 * point of SPEC 13.4, and is reported separately by the alert rules rather than
 * papered over with a guessed date.
 */
export function scheduleDueItems(inputs: ScheduleInputs): DueItem[] {
  const { records, schedules, health, today } = inputs;

  const activeSchedules = schedules.filter((s) => s.is_active && !s.deleted_at);
  const activeRecords = records.filter((r) => r.status === "active" && !r.deleted_at);

  // Grouped once rather than filtered per (record, schedule) pair: with
  // thousands of rows and a dozen schedules the naive form is a full scan of
  // the treatment history per schedule (SPEC 6.13).
  const historyByRecord = new Map<string, HealthRecord[]>();
  for (const treatment of health) {
    if (treatment.deleted_at) continue;
    const list = historyByRecord.get(treatment.record_id) ?? [];
    list.push(treatment);
    historyByRecord.set(treatment.record_id, list);
  }

  const items: DueItem[] = [];
  for (const record of activeRecords) {
    const history = historyByRecord.get(record.id) ?? [];
    for (const schedule of activeSchedules) {
      if (!scheduleCovers(schedule, record)) continue;
      const next = nextDueFor(schedule, record, history);
      if (!next) continue;
      items.push({
        id: `${schedule.id}:${record.id}`,
        record,
        schedule,
        dueDate: next.dueDate,
        days: daysBetween(today, next.dueDate),
        lastGiven: next.lastGiven,
      });
    }
  }

  return items.sort((a, b) =>
    a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate.localeCompare(b.dueDate),
  );
}

/** One record's upcoming scheduled items — Record detail's Health tab (SPEC 13.6). */
export function dueItemsForRecord(items: DueItem[], recordId: string): DueItem[] {
  return items.filter((item) => item.record.id === recordId);
}

/**
 * A schedule's timing said in words — "First at 4 months, then every 6 months".
 *
 * SPEC 13.6 asks for the timing in words on every row, because "120 / 180" on a
 * list of eight schedules is not something anyone can read at a glance.
 */
export function timingInWords(schedule: TreatmentSchedule): string {
  const first = schedule.first_due_age_days;
  const repeat = schedule.repeat_every_days;

  if (first != null && repeat != null) {
    return `First at ${durationInWords(first)}, then every ${durationInWords(repeat)}`;
  }
  if (first != null) return `Once, at ${durationInWords(first)}`;
  if (repeat != null) return `Every ${durationInWords(repeat)} from birth or arrival`;
  return "No timing set, so it never becomes due";
}

/**
 * A span of days as the farm would say it.
 *
 * Only exact multiples become months or weeks. "2 months" for 63 days would be
 * a rounded restatement of a number the user typed exactly, and on a schedule
 * screen that is the number they are checking against their vet's advice.
 */
export function durationInWords(days: number): string {
  if (days % 365 === 0 && days >= 365) return unit(days / 365, "year");
  if (days % 30 === 0 && days >= 30) return unit(days / 30, "month");
  if (days % 7 === 0 && days >= 7) return unit(days / 7, "week");
  return unit(days, "day");
}

function unit(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
