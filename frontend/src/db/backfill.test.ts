import { describe, expect, it } from "vitest";

import {
  expensesToRemapFromPoultry,
  recordsToRemapFromPoultry,
  recoverAnimalArrivalDates,
  schedulesToRemapFromPoultry,
} from "./backfill";
import type { Move, Record_, Species } from "./types";

/**
 * Recovering the arrival dates `createRecord` used to discard for animals.
 *
 * The rule that matters is that this only ever reads back a date the user
 * typed. Anything it cannot read back stays null, because a wrong arrival date
 * is worse than none — and SPEC 13.4 is explicit that the app must not
 * substitute the date a record was created.
 */

function record(over: Partial<Record_> = {}): Record_ {
  return {
    id: "rec-1",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    kind: "animal",
    species: "cattle",
    tag: "C-084",
    breed: null,
    sex: "female",
    date_of_birth: null,
    arrival_date: null,
    initial_head_count: 1,
    head_count: 1,
    offspring_count: null,
    offspring_updated_at: null,
    source: "bought",
    status: "active",
    parent_record_id: null,
    notes: null,
    current_room_id: "room-1",
    ...over,
  };
}

function move(over: Partial<Move> = {}): Move {
  return {
    id: "mv-1",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    from_room_id: null,
    to_room_id: "room-1",
    date: "2026-08-12",
    count: 1,
    reason: "new_arrival",
    note: null,
    ...over,
  };
}

describe("recovering a discarded arrival date", () => {
  it("reads it back from the initial placement", () => {
    expect(recoverAnimalArrivalDates([record()], [move()])).toEqual([
      { recordId: "rec-1", arrival_date: "2026-08-12" },
    ]);
  });

  it("ignores a later move, which is not an arrival", () => {
    const later = move({ id: "mv-2", from_room_id: "room-1", to_room_id: "room-2", date: "2026-08-30" });
    expect(recoverAnimalArrivalDates([record()], [move(), later])).toEqual([
      { recordId: "rec-1", arrival_date: "2026-08-12" },
    ]);
  });

  it("takes the earliest placement when a record somehow has two", () => {
    const a = move({ id: "mv-a", date: "2026-08-20" });
    const b = move({ id: "mv-b", date: "2026-08-12" });
    expect(recoverAnimalArrivalDates([record()], [a, b])[0]!.arrival_date).toBe("2026-08-12");
    expect(recoverAnimalArrivalDates([record()], [b, a])[0]!.arrival_date).toBe("2026-08-12");
  });

  it("breaks a same-day tie on created_at, so two devices agree", () => {
    const early = move({ id: "mv-a", date: "2026-08-12", created_at: "2026-08-12T06:00:00Z" });
    const late = move({ id: "mv-b", date: "2026-08-12", created_at: "2026-08-12T18:00:00Z" });
    expect(recoverAnimalArrivalDates([record()], [late, early])[0]!.arrival_date).toBe("2026-08-12");
  });
});

describe("what it deliberately leaves alone", () => {
  it("does not touch a record that already has an arrival date", () => {
    const kept = record({ arrival_date: "2026-01-01" });
    expect(recoverAnimalArrivalDates([kept], [move()])).toEqual([]);
  });

  it("does not touch a group, which never lost its arrival date", () => {
    const group = record({ kind: "group", arrival_date: null });
    expect(recoverAnimalArrivalDates([group], [move()])).toEqual([]);
  });

  it("does not touch a deleted record", () => {
    const gone = record({ deleted_at: "2026-08-25T00:00:00Z" });
    expect(recoverAnimalArrivalDates([gone], [move()])).toEqual([]);
  });

  it("ignores a deleted move", () => {
    expect(recoverAnimalArrivalDates([record()], [move({ deleted_at: "2026-08-25T00:00:00Z" })])).toEqual([]);
  });

  /**
   * The case that keeps this honest. An animal added with no room has no
   * initial move, so there is no typed date to read back — and it is left
   * alone rather than given the date the record was created, which is the
   * substitution SPEC 13.4 forbids by name.
   */
  it("leaves an animal with no placement alone rather than inventing a date", () => {
    const noRoom = record({ current_room_id: null, created_at: "2026-08-20T00:00:00Z" });
    expect(recoverAnimalArrivalDates([noRoom], [])).toEqual([]);
  });

  it("does not read one record's placement onto another", () => {
    const other = move({ record_id: "rec-2" });
    expect(recoverAnimalArrivalDates([record()], [other])).toEqual([]);
  });
});

/**
 * SPEC 18 — moving what is left of `poultry`.
 *
 * Three kinds of row carry the value and they do not all go to the same place.
 * The distinction is the whole point of these tests: sending the schedules to
 * `hens` along with the records would silently stop vaccinating the ducks, and
 * leaving the expenses behind would drop the birds' feed bill out of every
 * estimated cost share without anything going visibly wrong.
 */
describe("the poultry split", () => {
  it("picks out the records still on poultry", () => {
    const ids = recordsToRemapFromPoultry([
      { id: "a", species: "poultry" as Species },
      { id: "b", species: "cattle" },
      { id: "c", species: "poultry" as Species },
    ]);
    expect(ids).toEqual(["a", "c"]);
  });

  it("leaves every other species alone", () => {
    const ids = recordsToRemapFromPoultry([
      { id: "a", species: "hens" },
      { id: "b", species: "ducks" },
      { id: "c", species: "pigs" },
    ]);
    expect(ids).toEqual([]);
  });

  /**
   * Sold and dead records keep their history and stay readable under the "Sold
   * or dead" filter (SPEC 4.8). Leaving a value behind that is no longer in the
   * enum would break every screen that reads one back.
   */
  it("moves soft-deleted and sold records too", () => {
    const ids = recordsToRemapFromPoultry([
      { id: "a", species: "poultry" as Species },
      { id: "b", species: "poultry" as Species },
    ]);
    expect(ids).toEqual(["a", "b"]);
  });

  it("is safe to run twice", () => {
    // After the first pass every row says `hens`, so a second finds nothing.
    expect(recordsToRemapFromPoultry([{ id: "a", species: "hens" }])).toEqual([]);
  });

  it("picks out the schedules still on poultry", () => {
    const ids = schedulesToRemapFromPoultry([
      { id: "s1", species: "poultry" },
      { id: "s2", species: "cattle" },
      { id: "s3", species: "all" },
    ]);
    expect(ids).toEqual(["s1"]);
  });

  it("picks out expenses tagged to the poultry species", () => {
    const ids = expensesToRemapFromPoultry([
      { id: "e1", applies_to: "species", applies_to_id: "poultry" },
      { id: "e2", applies_to: "species", applies_to_id: "pigs" },
      { id: "e3", applies_to: "farm", applies_to_id: null },
    ]);
    expect(ids).toEqual(["e1"]);
  });

  /**
   * A room id could in principle read "poultry" only by coincidence, but the
   * scope is what decides the meaning of the column, so it is what gets
   * checked. Matching on the value alone would rewrite a room's id.
   */
  it("ignores a room-scoped expense whatever its id says", () => {
    const ids = expensesToRemapFromPoultry([
      { id: "e1", applies_to: "room", applies_to_id: "poultry" },
    ]);
    expect(ids).toEqual([]);
  });

  it("ignores a farm-wide expense", () => {
    const ids = expensesToRemapFromPoultry([
      { id: "e1", applies_to: "farm", applies_to_id: null },
    ]);
    expect(ids).toEqual([]);
  });
});
