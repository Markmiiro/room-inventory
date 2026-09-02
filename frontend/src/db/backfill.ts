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
