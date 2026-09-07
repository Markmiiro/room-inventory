import type { Move, Record_ } from "./types";

/**
 * Recovering the arrival dates that were discarded for animals.
 *
 * `createRecord` used to keep `arrival_date` only for groups, so the date typed
 * on the add form was dropped on the way into the database for an animal. It
 * was not quite lost: the record's initial placement — the move with a null
 * `from_room_id` — was dated with exactly that value.
 *
 * So this is a **recovery of what the user entered**, not a guess. The date
 * written is the one they typed, read back from the row it was written to
 * instead of the one it should have been. That distinction is what makes it
 * allowed at all: SPEC 13.4 forbids inventing a date, and this invents nothing.
 *
 * It is pure so it can be tested without standing up an old database version.
 * `schema.ts`'s version 8 upgrade is the wiring;
 * `backend/alembic/versions/0007_backfill_animal_arrival_date.py` does the same
 * thing on the server, deriving the same date from the same move so the two
 * agree without needing to talk.
 *
 * None of this changes an animal's age. SPEC 13.3 counts that from the date of
 * birth, and `domain/age.ts` does not read `arrival_date` for an animal — a
 * two-year-old cow bought last week arrived last week and is not a week old.
 */
export interface ArrivalRecovery {
  recordId: string;
  arrival_date: string;
}

export function recoverAnimalArrivalDates(
  records: Record_[],
  moves: Move[],
): ArrivalRecovery[] {
  // The initial placement per record: null `from_room_id`, earliest by date and
  // then created_at — the order SPEC 4.1 uses everywhere else.
  const arrivalOf = new Map<string, Move>();
  for (const move of moves) {
    if (move.deleted_at || move.from_room_id !== null) continue;
    const held = arrivalOf.get(move.record_id);
    if (
      held === undefined ||
      move.date < held.date ||
      (move.date === held.date && move.created_at < held.created_at)
    ) {
      arrivalOf.set(move.record_id, move);
    }
  }

  const recovered: ArrivalRecovery[] = [];
  for (const record of records) {
    // Groups always kept their arrival date, so there is nothing to recover.
    if (record.kind !== "animal" || record.deleted_at) continue;
    // Never overwrite a value already present, whether typed since the fix or
    // merged in from another device.
    if (record.arrival_date) continue;

    const move = arrivalOf.get(record.id);
    // An animal added with no room has no initial move, so there is nothing to
    // read back. It stays null rather than being given today's date, which
    // would be exactly the invented figure SPEC 13.4 forbids.
    if (!move) continue;

    recovered.push({ recordId: record.id, arrival_date: move.date });
  }
  return recovered;
}

/**
 * SPEC 18 — moving the `poultry` records onto `hens`.
 *
 * The enum lost a value, so every row still carrying it has to go somewhere.
 * `hens` is the destination because it is the only one that can be defended: it
 * is far and away the most common bird on a smallholding, and the one default
 * the old value carried — a six-week sale target (SPEC 15.2) — is a broiler
 * hen's, so a `poultry` row was already being treated as a hen everywhere the
 * age mattered.
 *
 * It is still a guess for any bird that was not a hen, and the app must not
 * pretend otherwise. That is why this returns the rows it changed rather than
 * changing them quietly: the count is stored under `META.poultrySplit` and
 * shown once on Animals, so the person who knows which pens hold ducks can go
 * and correct them. A migration that silently retyped part of the flock and
 * said nothing would be indistinguishable from data loss.
 *
 * Deleted rows are remapped too. They are soft-deleted, still readable under
 * "Sold or dead" (SPEC 4.8), and leaving a value behind that no longer exists
 * in the enum would break every screen that reads one back.
 */
export const POULTRY = "poultry";
export const POULTRY_REPLACEMENT = "hens";

export function recordsToRemapFromPoultry(records: Array<Pick<Record_, "id" | "species">>): string[] {
  return records.filter((r) => (r.species as string) === POULTRY).map((r) => r.id);
}

/**
 * The same remap for schedules, which go to `birds` rather than to `hens`.
 *
 * A schedule is a rule, not an animal. The Newcastle and Gumboro rows were
 * written for poultry as a category and they still apply to all four birds, so
 * narrowing them to hens would silently stop vaccinating the ducks — the exact
 * kind of quiet gap SPEC 13.1 exists to close. The seeded IDs do not change, so
 * any interval the farmer had already edited survives (SPEC 16).
 */
export function schedulesToRemapFromPoultry(
  schedules: Array<{ id: string; species: string }>,
): string[] {
  return schedules.filter((s) => s.species === POULTRY).map((s) => s.id);
}

/**
 * And for expenses tagged to a species (SPEC 3.10, 4.4).
 *
 * An expense with `applies_to: "species"` holds the species name in
 * `applies_to_id`. Missing these would leave the feed bill for the birds
 * allocated to a species no record has, so its whole cost would silently stop
 * reaching any animal's estimated share (SPEC 4.4) — the figure would not go
 * wrong loudly, it would just quietly drop out.
 */
export function expensesToRemapFromPoultry(
  expenses: Array<{ id: string; applies_to: string; applies_to_id: string | null }>,
): string[] {
  return expenses
    .filter((e) => e.applies_to === "species" && e.applies_to_id === POULTRY)
    .map((e) => e.id);
}
