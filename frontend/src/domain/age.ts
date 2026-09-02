import type { Record_ } from "../db/types";
import { daysBetween } from "./format";

/**
 * SPEC 13.4 — how old a record is, and what to do when nobody knows.
 *
 * This lives on its own because two features depend on it and must agree.
 * Treatment schedules (SPEC 13) count a first dose from an age; sale readiness
 * (SPEC 15) compares an age against a target. If each worked out age for
 * itself, a record could be old enough to sell and too young to vaccinate on
 * the same day, from the same missing field.
 *
 * The rule the spec cares about most is the one about not guessing. An age
 * derived from the day someone happened to type the record in is not an age; it
 * is the record's own creation date wearing an age's clothes, and every
 * schedule computed from it would be wrong in a way nothing on screen would
 * show. So there is no fallback here. Age is known or it is not, and the
 * unknown case is carried through as `null` for the callers to surface.
 */

/**
 * The date a record's age counts from: birth for an animal, arrival for a
 * group (SPEC 13.3).
 *
 * Null is a real answer, not a failure. Returning today, or `created_at`, would
 * make every caller downstream silently confident about a number it invented.
 */
export function ageBasis(record: Record_): string | null {
  return record.kind === "animal" ? record.date_of_birth : record.arrival_date;
}

/** Whole days old, or null when there is nothing to count from. */
export function ageInDays(record: Record_, today: string): number | null {
  const from = ageBasis(record);
  if (!from) return null;
  return daysBetween(from, today);
}

/** True when nothing schedules or sale-readiness needs can be computed. */
export function isAgeUnknown(record: Record_): boolean {
  return ageBasis(record) === null;
}

/**
 * SPEC 13.4 — the chip, in words.
 *
 * One constant rather than a string typed into each of the four screens that
 * shows it, so the wording cannot drift between the Animals list and the record
 * it opens.
 */
export const AGE_UNKNOWN_CHIP = "Age unknown — no schedule";

/** What the chip means, for the places with room to say it. */
export const AGE_UNKNOWN_DETAIL =
  "Without a date of birth this record's age cannot be worked out, so no treatment schedule runs for it and no sale readiness is shown.";

/**
 * The active records whose age cannot be computed.
 *
 * Sold and dead records are excluded: nothing is scheduled for them and nothing
 * is sold twice, so naming them would be an alert nobody can act on (SPEC 6.2).
 */
export function recordsWithUnknownAge(records: Record_[]): Record_[] {
  return records.filter(
    (record) => record.status === "active" && !record.deleted_at && isAgeUnknown(record),
  );
}

/**
 * Which field is missing, named the way the user would name it.
 *
 * A group is asked for an arrival date and an animal for a date of birth, so an
 * alert that said "date of birth" about a group would point at a field that
 * screen does not have.
 */
export function missingAgeField(record: Record_): "date of birth" | "arrival date" {
  return record.kind === "animal" ? "date of birth" : "arrival date";
}
