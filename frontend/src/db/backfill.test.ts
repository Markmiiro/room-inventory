import { describe, expect, it } from "vitest";

import { recoverAnimalArrivalDates } from "./backfill";
import type { Move, Record_ } from "./types";

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
