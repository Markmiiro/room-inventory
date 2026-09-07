import { describe, expect, it } from "vitest";

import type { Death, Move, Record_, Sale } from "../db/types";
import { censusAsAt } from "./census";

/**
 * SPEC 19.1 — the census.
 *
 * The property these tests exist to hold is that there is **one counting
 * rule**. `censusAsAt(today)` is the live count; there is no second, simpler
 * version of it for "right now". Two counts that can drift give two screens
 * disagreeing about how many hens the farm has, with no way to tell which is
 * lying — so the last describe block below checks the as-at count against the
 * `head_count` the database maintains, which is the drift that would matter.
 */

function record(over: Partial<Record_> = {}): Record_ {
  return {
    id: "rec-1",
    created_at: "2026-01-05T00:00:00Z",
    updated_at: "2026-01-05T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    kind: "group",
    species: "hens",
    tag: "H-Flock",
    breed: null,
    sex: null,
    date_of_birth: null,
    arrival_date: null,
    initial_head_count: 100,
    head_count: 100,
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
    created_at: "2026-01-05T00:00:00Z",
    updated_at: "2026-01-05T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    from_room_id: null,
    to_room_id: "room-1",
    date: "2026-01-05",
    count: 100,
    reason: "new_arrival",
    note: null,
    ...over,
  };
}

function sale(over: Partial<Sale> = {}): Sale {
  return {
    id: "sl-1",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    date: "2026-03-01",
    price: 500_000,
    count: 10,
    customer_id: null,
    notes: null,
    ...over,
  };
}

function death(over: Partial<Death> = {}): Death {
  return {
    id: "dt-1",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    date: "2026-02-01",
    count: 5,
    cause: "illness",
    vet_id: null,
    notes: null,
    ...over,
  };
}

const empty = { records: [], moves: [], sales: [], deaths: [] };

describe("counting what is there now", () => {
  it("counts a group by head, not as one record", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [record({ initial_head_count: 240, head_count: 240 })],
      moves: [move()],
    });
    expect(census.bySpecies).toEqual([{ species: "hens", head: 240, records: 1 }]);
    expect(census.total).toBe(240);
  });

  it("counts a single animal as one head", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [record({ kind: "animal", species: "cattle", initial_head_count: 1, head_count: 1 })],
      moves: [move({ count: 1 })],
    });
    expect(census.total).toBe(1);
  });

  it("adds up several records of one species", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [
        record({ id: "a", initial_head_count: 100 }),
        record({ id: "b", initial_head_count: 140 }),
      ],
      moves: [move({ record_id: "a" }), move({ id: "mv-2", record_id: "b" })],
    });
    expect(census.bySpecies).toEqual([{ species: "hens", head: 240, records: 2 }]);
  });

  it("reports each species separately, in the SPEC 18 order", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [
        record({ id: "a", species: "hens", initial_head_count: 240 }),
        record({ id: "b", species: "cattle", initial_head_count: 7 }),
        record({ id: "c", species: "pigs", initial_head_count: 2 }),
      ],
      moves: [
        move({ record_id: "a" }),
        move({ id: "mv-2", record_id: "b" }),
        move({ id: "mv-3", record_id: "c" }),
      ],
    });
    // Mammals before birds, matching every filter row and list section.
    expect(census.bySpecies.map((r) => r.species)).toEqual(["cattle", "pigs", "hens"]);
    expect(census.total).toBe(249);
  });

  /** A farm that never kept geese should not have to read a line saying so. */
  it("leaves out a species with no live head", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [record({ species: "geese", initial_head_count: 4 })],
      moves: [move()],
      sales: [sale({ count: 4 })],
    });
    expect(census.bySpecies).toEqual([]);
    expect(census.total).toBe(0);
  });

  it("subtracts sales and deaths", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [record({ initial_head_count: 100 })],
      moves: [move()],
      sales: [sale({ count: 10 })],
      deaths: [death({ count: 5 })],
    });
    expect(census.total).toBe(85);
  });

  it("ignores a soft-deleted record, sale and death", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [
        record({ id: "a", initial_head_count: 100 }),
        record({ id: "gone", initial_head_count: 50, deleted_at: "2026-04-01T00:00:00Z" }),
      ],
      moves: [move({ record_id: "a" })],
      sales: [sale({ record_id: "a", count: 10, deleted_at: "2026-04-01T00:00:00Z" })],
      deaths: [death({ record_id: "a", count: 5, deleted_at: "2026-04-01T00:00:00Z" })],
    });
    expect(census.total).toBe(100);
  });

  /**
   * SPEC 6.7 — two devices offline can each sell 5 head from a group of 8, and
   * both sales are real and both are kept. The count floors at zero rather than
   * going negative; the anomaly is raised on the server.
   */
  it("floors at zero rather than going negative", () => {
    const census = censusAsAt("2026-09-07", {
      ...empty,
      records: [record({ initial_head_count: 8 })],
      moves: [move()],
      sales: [
        sale({ id: "s1", count: 5 }),
        sale({ id: "s2", count: 5 }),
      ],
    });
    expect(census.total).toBe(0);
  });
});

describe("counting what was there on a past date", () => {
  it("does not count a record that had not arrived yet", () => {
    const input = {
      ...empty,
      records: [record({ initial_head_count: 100 })],
      moves: [move({ date: "2026-06-01" })],
    };
    expect(censusAsAt("2026-05-31", input).total).toBe(0);
    expect(censusAsAt("2026-06-01", input).total).toBe(100);
  });

  it("counts head that had not been sold yet on that date", () => {
    const input = {
      ...empty,
      records: [record({ initial_head_count: 100 })],
      moves: [move({ date: "2026-01-05" })],
      sales: [sale({ date: "2026-03-01", count: 10 })],
    };
    expect(censusAsAt("2026-02-28", input).total).toBe(100);
    // The sale's own date is included: it had left by the end of that day.
    expect(censusAsAt("2026-03-01", input).total).toBe(90);
  });

  it("counts head that had not died yet on that date", () => {
    const input = {
      ...empty,
      records: [record({ initial_head_count: 100 })],
      moves: [move()],
      deaths: [death({ date: "2026-02-01", count: 5 })],
    };
    expect(censusAsAt("2026-01-31", input).total).toBe(100);
    expect(censusAsAt("2026-02-01", input).total).toBe(95);
  });

  it("uses the arrival date when a record has no move", () => {
    const input = {
      ...empty,
      records: [record({ initial_head_count: 20, arrival_date: "2026-04-10", current_room_id: null })],
    };
    expect(censusAsAt("2026-04-09", input).total).toBe(0);
    expect(censusAsAt("2026-04-10", input).total).toBe(20);
  });

  it("falls back to when the row was written if there is nothing else", () => {
    const input = {
      ...empty,
      records: [record({ initial_head_count: 20, created_at: "2026-05-20T09:00:00Z" })],
    };
    expect(censusAsAt("2026-05-19", input).total).toBe(0);
    expect(censusAsAt("2026-05-20", input).total).toBe(20);
  });

  it("takes the earliest move as the arrival, not the latest", () => {
    const input = {
      ...empty,
      records: [record({ initial_head_count: 20 })],
      moves: [
        move({ id: "mv-2", date: "2026-07-01", from_room_id: "room-1", to_room_id: "room-2" }),
        move({ id: "mv-1", date: "2026-01-05" }),
      ],
    };
    expect(censusAsAt("2026-02-01", input).total).toBe(20);
  });
});

/**
 * SPEC 4.3 — splitting a group.
 *
 * The head does not leave the farm, it moves to a new record. The census must
 * not double-count it after the split, and must not lose it before.
 */
describe("a group that was split", () => {
  const parent = record({ id: "parent", initial_head_count: 100, head_count: 60 });
  const child = record({
    id: "child",
    initial_head_count: 40,
    head_count: 40,
    parent_record_id: "parent",
    tag: "H-Flock-2",
  });
  const input = {
    ...empty,
    records: [parent, child],
    moves: [
      move({ id: "mv-p", record_id: "parent", date: "2026-01-05" }),
      move({ id: "mv-c", record_id: "child", date: "2026-06-01", to_room_id: "room-2" }),
    ],
  };

  it("counts the head once after the split, not twice", () => {
    const census = censusAsAt("2026-09-07", input);
    expect(census.total).toBe(100);
    expect(census.bySpecies).toEqual([{ species: "hens", head: 100, records: 2 }]);
  });

  it("counts it all on the parent before the split", () => {
    const census = censusAsAt("2026-05-31", input);
    expect(census.total).toBe(100);
    // One record, because the child had not been created yet.
    expect(census.bySpecies).toEqual([{ species: "hens", head: 100, records: 1 }]);
  });

  it("does not take the split off the parent early", () => {
    // The bug this pins: subtracting every child regardless of date would show
    // the parent already short of head it had not yet lost.
    expect(censusAsAt("2026-03-01", input).total).toBe(100);
  });
});

/**
 * The drift that would matter.
 *
 * `head_count` is a column the database maintains, by the rule in
 * `backend/app/domain/reconcile.py`. `censusAsAt(today)` derives the same
 * number from the events. If these two ever disagree, two screens disagree
 * about how many hens the farm has — so they are checked against each other
 * rather than each being tested alone.
 */
describe("today's census against the stored head_count", () => {
  const cases: Array<[string, { records: Record_[]; moves: Move[]; sales: Sale[]; deaths: Death[] }]> = [
    [
      "an untouched group",
      { ...empty, records: [record({ initial_head_count: 240, head_count: 240 })], moves: [move()] },
    ],
    [
      "a group with sales and deaths",
      {
        ...empty,
        records: [record({ initial_head_count: 100, head_count: 85 })],
        moves: [move()],
        sales: [sale({ count: 10 })],
        deaths: [death({ count: 5 })],
      },
    ],
    [
      "a split parent and its child",
      {
        ...empty,
        records: [
          record({ id: "parent", initial_head_count: 100, head_count: 60 }),
          record({
            id: "child",
            initial_head_count: 40,
            head_count: 40,
            parent_record_id: "parent",
          }),
        ],
        moves: [
          move({ id: "mv-p", record_id: "parent" }),
          move({ id: "mv-c", record_id: "child", date: "2026-06-01" }),
        ],
      },
    ],
    [
      "a group sold out entirely",
      {
        ...empty,
        records: [record({ initial_head_count: 20, head_count: 0, status: "sold" })],
        moves: [move()],
        sales: [sale({ count: 20 })],
      },
    ],
  ];

  for (const [name, input] of cases) {
    it(`agrees with head_count for ${name}`, () => {
      const stored = input.records
        .filter((r) => !r.deleted_at)
        .reduce((sum, r) => sum + r.head_count, 0);
      expect(censusAsAt("2026-09-07", input).total).toBe(stored);
    });
  }
});
