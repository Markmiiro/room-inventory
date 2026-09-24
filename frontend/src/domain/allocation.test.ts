import { describe, expect, it } from "vitest";

import type { Death, Expense, Move, Record_, Sale } from "../db/types";
import {
  allocateExpense,
  departuresFrom,
  expenseShareFor,
  headDays,
  periodForExpense,
} from "./allocation";

/**
 * SPEC 4.4 — estimated cost share, weighted by head-days.
 *
 * These tests were written before the calculation existed, and every expected
 * number below was worked out by hand from the spec rather than by running the
 * code. That ordering is the whole point: this calculation cannot fail loudly.
 * It produces a plausible number whatever it does, so a test written afterwards
 * would only agree with whatever the implementation happened to do.
 *
 * The arithmetic is spelled out in each case so a reader can check it without
 * re-deriving the rule.
 */

const SEPTEMBER = { start: "2026-09-01", end: "2026-09-30" }; // 30 days

function record(over: Partial<Record_> = {}): Record_ {
  return {
    id: "rec-a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    kind: "group",
    species: "cattle",
    tag: "A",
    breed: null,
    sex: null,
    date_of_birth: null,
    arrival_date: "2026-01-01",
    initial_head_count: 1,
    head_count: 1,
    offspring_baseline: null,
    offspring_baseline_updated_at: null,
    dam_record_id: null,
    sire_record_id: null,
    sire_name: null,
    birth_id: null,
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-a",
    from_room_id: null,
    to_room_id: "room-1",
    date: "2026-01-01",
    count: 1,
    reason: "new_arrival",
    note: null,
    ...over,
  };
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: "exp-1",
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    amount: 30_000,
    category_id: "cat-feed",
    date: "2026-09-15",
    applies_to: "farm",
    applies_to_id: null,
    note: null,
    ...over,
  };
}

describe("the period an expense is spread over", () => {
  it("uses the month containing a single-date expense", () => {
    // SPEC 4.4 — "For a single-date expense, the period is the month
    // containing it." Every expense has one date, so this is always the rule.
    expect(periodForExpense(expense({ date: "2026-09-15" }))).toEqual(SEPTEMBER);
  });

  it("covers the whole of a short month", () => {
    expect(periodForExpense(expense({ date: "2026-02-10" }))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("includes the leap day", () => {
    expect(periodForExpense(expense({ date: "2024-02-10" }))).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
  });
});

describe("head-days", () => {
  it("counts every day of the period for a record that was there throughout", () => {
    // 1 head × 30 days = 30.
    const weight = headDays({
      record: record({ head_count: 1 }),
      moves: [move({ date: "2026-01-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });

    expect(weight).toBe(30);
  });

  it("multiplies by head, not by record", () => {
    // SPEC 4.2 — the unit is head. 12 head × 30 days = 360.
    const weight = headDays({
      record: record({ head_count: 12 }),
      moves: [move({ date: "2026-01-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });

    expect(weight).toBe(360);
  });

  it("gives a record present for ten days a third of the weight of one present throughout", () => {
    // The example SPEC 4.4 gives in words. Arrived 21 September: 21st to 30th
    // inclusive is 10 days. 10 ÷ 30 = one third.
    const partial = headDays({
      record: record({ head_count: 1 }),
      moves: [move({ date: "2026-09-21" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });
    const whole = headDays({
      record: record({ head_count: 1 }),
      moves: [move({ date: "2026-01-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });

    expect(partial).toBe(10);
    expect(partial * 3).toBe(whole);
  });

  it("counts the day of arrival", () => {
    // Arriving on the last day of the month is one day of presence, not none.
    const weight = headDays({
      record: record({ head_count: 1 }),
      moves: [move({ date: "2026-09-30" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });

    expect(weight).toBe(1);
  });

  it("gives nothing to a record that arrived after the period ended", () => {
    const weight = headDays({
      record: record({ head_count: 5 }),
      moves: [move({ date: "2026-10-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });

    expect(weight).toBe(0);
  });

  it("stops counting on the day a record left", () => {
    // A record sold on 10 September was fed for ten days of that month, not
    // thirty. The departure day is inclusive: it ate that morning.
    const weight = headDays({
      record: record({ head_count: 0, status: "sold" }),
      moves: [move({ date: "2026-01-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
      departure: { on: "2026-09-10", head: 1 },
    });

    expect(weight).toBe(10);
  });

  it("uses the head that left, not the nothing the record holds now", () => {
    // A sold record's `head_count` is zero. Multiplying days present by that
    // would charge a group of twelve for none of the month it spent eating —
    // no error, no warning, just a cost that quietly went missing.
    const weight = headDays({
      record: record({ head_count: 0, status: "sold" }),
      moves: [move({ date: "2026-01-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
      departure: { on: "2026-09-10", head: 12 },
    });

    expect(weight).toBe(120);
  });

  it("weighs a big group briefly the same as a small group throughout", () => {
    // 10 head × 15 days = 150. 5 head × 30 days = 150. Head-days is the point:
    // neither number alone would say these two cost the same to feed.
    const brief = headDays({
      record: record({ head_count: 10 }),
      moves: [move({ date: "2026-09-16" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });
    const steady = headDays({
      record: record({ head_count: 5 }),
      moves: [move({ date: "2026-01-01" })],
      period: SEPTEMBER,
      pool: { kind: "farm" },
    });

    expect(brief).toBe(150);
    expect(steady).toBe(150);
  });

  describe("by room", () => {
    it("counts only the days the record was in that room", () => {
      // In R1 from 1 to 10 September, then R2 from the 11th. The move date
      // belongs to the destination: the animal sleeps in the new room that
      // night. R1 gets 10 days, R2 gets 20, and they sum to the month.
      const moves = [
        move({ id: "m1", date: "2026-01-01", to_room_id: "room-1" }),
        move({ id: "m2", date: "2026-09-11", from_room_id: "room-1", to_room_id: "room-2" }),
      ];
      const args = { record: record({ head_count: 1 }), moves, period: SEPTEMBER };

      expect(headDays({ ...args, pool: { kind: "room", roomId: "room-1" } })).toBe(10);
      expect(headDays({ ...args, pool: { kind: "room", roomId: "room-2" } })).toBe(20);
      expect(headDays({ ...args, pool: { kind: "farm" } })).toBe(30);
    });

    it("adds up both stays when a record leaves a room and comes back", () => {
      // R1 for the first 10 days, R2 for 10, R1 again for the last 10.
      const moves = [
        move({ id: "m1", date: "2026-01-01", to_room_id: "room-1" }),
        move({ id: "m2", date: "2026-09-11", from_room_id: "room-1", to_room_id: "room-2" }),
        move({ id: "m3", date: "2026-09-21", from_room_id: "room-2", to_room_id: "room-1" }),
      ];

      expect(
        headDays({
          record: record({ head_count: 1 }),
          moves,
          period: SEPTEMBER,
          pool: { kind: "room", roomId: "room-1" },
        }),
      ).toBe(20);
    });

    it("gives nothing for a room the record never entered", () => {
      expect(
        headDays({
          record: record({ head_count: 4 }),
          moves: [move({ date: "2026-01-01" })],
          period: SEPTEMBER,
          pool: { kind: "room", roomId: "room-9" },
        }),
      ).toBe(0);
    });
  });

  describe("by species", () => {
    it("counts a record of that species and ignores the rest", () => {
      const args = { moves: [move({ date: "2026-01-01" })], period: SEPTEMBER };

      expect(
        headDays({ ...args, record: record({ species: "cattle", head_count: 2 }), pool: { kind: "species", species: "cattle" } }),
      ).toBe(60);
      expect(
        headDays({ ...args, record: record({ species: "pigs", head_count: 2 }), pool: { kind: "species", species: "cattle" } }),
      ).toBe(0);
    });
  });
});

describe("allocating one expense", () => {
  const throughout = [move({ record_id: "rec-a", date: "2026-01-01" })];

  it("splits a farm expense in proportion to head-days", () => {
    // A: 1 head × 30 days = 30. B: 1 head × 10 days = 10. Total 40.
    // A gets 30,000 × 30/40 = 22,500. B gets 30,000 × 10/40 = 7,500.
    const records = [
      record({ id: "rec-a", tag: "A" }),
      record({ id: "rec-b", tag: "B" }),
    ];
    const moves = [
      ...throughout,
      move({ id: "m2", record_id: "rec-b", date: "2026-09-21" }),
    ];

    const shares = allocateExpense(expense({ amount: 30_000 }), records, moves);

    expect(shares.get("rec-a")).toBe(22_500);
    expect(shares.get("rec-b")).toBe(7_500);
  });

  it("spreads a species expense only across that species", () => {
    // Two cattle at 30 head-days each, one pig ignored. 20,000 ÷ 2 = 10,000.
    const records = [
      record({ id: "rec-a", species: "cattle" }),
      record({ id: "rec-b", species: "cattle" }),
      record({ id: "rec-c", species: "pigs" }),
    ];
    const moves = [
      move({ id: "m1", record_id: "rec-a", date: "2026-01-01" }),
      move({ id: "m2", record_id: "rec-b", date: "2026-01-01" }),
      move({ id: "m3", record_id: "rec-c", date: "2026-01-01" }),
    ];

    const shares = allocateExpense(
      expense({ amount: 20_000, applies_to: "species", applies_to_id: "cattle" }),
      records,
      moves,
    );

    expect(shares.get("rec-a")).toBe(10_000);
    expect(shares.get("rec-b")).toBe(10_000);
    expect(shares.has("rec-c")).toBe(false);
  });

  it("spreads a room expense across what was actually in that room", () => {
    // A was in R1 all month (30 head-days). B moved into R1 on the 21st
    // (10 head-days). 12,000 × 30/40 = 9,000 and × 10/40 = 3,000.
    const records = [record({ id: "rec-a" }), record({ id: "rec-b" })];
    const moves = [
      move({ id: "m1", record_id: "rec-a", date: "2026-01-01", to_room_id: "room-1" }),
      move({ id: "m2", record_id: "rec-b", date: "2026-01-01", to_room_id: "room-2" }),
      move({
        id: "m3", record_id: "rec-b", date: "2026-09-21",
        from_room_id: "room-2", to_room_id: "room-1",
      }),
    ];

    const shares = allocateExpense(
      expense({ amount: 12_000, applies_to: "room", applies_to_id: "room-1" }),
      records,
      moves,
    );

    expect(shares.get("rec-a")).toBe(9_000);
    expect(shares.get("rec-b")).toBe(3_000);
  });

  it("never loses a shilling to rounding", () => {
    // 100 across three equal records is 33.33 each. Money is whole shillings
    // (SPEC 1), so one record has to carry the extra — and the shares still
    // have to add up to what was actually spent.
    const records = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })];
    const moves = [
      move({ id: "m1", record_id: "a", date: "2026-01-01" }),
      move({ id: "m2", record_id: "b", date: "2026-01-01" }),
      move({ id: "m3", record_id: "c", date: "2026-01-01" }),
    ];

    const shares = allocateExpense(expense({ amount: 100 }), records, moves);
    const total = [...shares.values()].reduce((sum, n) => sum + n, 0);

    expect(total).toBe(100);
    expect([...shares.values()].sort()).toEqual([33, 33, 34]);
  });

  it("does not invent a shilling when every share rounds up", () => {
    // 101 across three equal records is 33.67 each. Rounding each to the
    // nearest whole shilling gives 34 + 34 + 34 = 102 — a shilling that was
    // never spent, on a screen whose whole job is to be trusted about money.
    // Floor-then-distribute cannot do that: it can only hand out what is left.
    const records = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })];
    const moves = [
      move({ id: "m1", record_id: "a", date: "2026-01-01" }),
      move({ id: "m2", record_id: "b", date: "2026-01-01" }),
      move({ id: "m3", record_id: "c", date: "2026-01-01" }),
    ];

    const shares = allocateExpense(expense({ amount: 101 }), records, moves);
    const total = [...shares.values()].reduce((sum, n) => sum + n, 0);

    expect(total).toBe(101);
    expect([...shares.values()].sort()).toEqual([33, 34, 34]);
  });

  it("hands the rounding remainder out in a fixed order", () => {
    // Otherwise the same expense reallocates differently between two loads and
    // a record's estimated profit flickers by a shilling for no reason.
    const records = [record({ id: "c" }), record({ id: "a" }), record({ id: "b" })];
    const moves = [
      move({ id: "m1", record_id: "a", date: "2026-01-01" }),
      move({ id: "m2", record_id: "b", date: "2026-01-01" }),
      move({ id: "m3", record_id: "c", date: "2026-01-01" }),
    ];

    const first = allocateExpense(expense({ amount: 100 }), records, moves);
    const second = allocateExpense(expense({ amount: 100 }), [...records].reverse(), moves);

    expect(first.get("a")).toBe(second.get("a"));
    expect(first.get("b")).toBe(second.get("b"));
    expect(first.get("c")).toBe(second.get("c"));
  });

  it("allocates nothing when the pool is empty rather than dividing by zero", () => {
    // An expense against a room that was empty all month. The money was still
    // spent — it simply cannot be attributed to an animal, and saying so is
    // better than spreading it somewhere it did not go.
    const shares = allocateExpense(
      expense({ amount: 5_000, applies_to: "room", applies_to_id: "room-9" }),
      [record({ id: "rec-a" })],
      [move({ record_id: "rec-a", date: "2026-01-01" })],
    );

    expect(shares.size).toBe(0);
  });

  it("ignores a deleted expense", () => {
    const shares = allocateExpense(
      expense({ deleted_at: "2026-09-16T00:00:00Z" }),
      [record({ id: "rec-a" })],
      [move({ record_id: "rec-a", date: "2026-01-01" })],
    );

    expect(shares.size).toBe(0);
  });
});

describe("a record's total share", () => {
  const records = [record({ id: "rec-a" }), record({ id: "rec-b" })];
  const moves = [
    move({ id: "m1", record_id: "rec-a", date: "2026-01-01" }),
    move({ id: "m2", record_id: "rec-b", date: "2026-01-01" }),
  ];

  it("adds up every expense that touched it", () => {
    // Two equal records, so each takes half of both: 5,000 + 1,000 = 6,000.
    const expenses = [
      expense({ id: "e1", amount: 10_000, date: "2026-09-15" }),
      expense({ id: "e2", amount: 2_000, date: "2026-08-15" }),
    ];

    expect(expenseShareFor("rec-a", expenses, records, moves)).toBe(6_000);
  });

  it("counts nothing from a period the record was not there for", () => {
    // Arrived in September, so an August expense is not its to carry.
    const late = [record({ id: "rec-a" }), record({ id: "rec-b" })];
    const lateMoves = [
      move({ id: "m1", record_id: "rec-a", date: "2026-09-01" }),
      move({ id: "m2", record_id: "rec-b", date: "2026-01-01" }),
    ];
    const expenses = [expense({ id: "e2", amount: 2_000, date: "2026-08-15" })];

    expect(expenseShareFor("rec-a", expenses, late, lateMoves)).toBe(0);
    expect(expenseShareFor("rec-b", expenses, late, lateMoves)).toBe(2_000);
  });

  it("is an estimate that need not sum to the farm total", () => {
    // SPEC 4.5 says so plainly, and it is true here: an expense with an empty
    // pool is spent but unallocated, so the per-record figures come to less
    // than what left the account. The Money summary has to say this rather
    // than quietly reconcile it.
    const expenses = [
      expense({ id: "e1", amount: 10_000 }),
      expense({ id: "e2", amount: 5_000, applies_to: "room", applies_to_id: "room-9" }),
    ];

    const allocated =
      expenseShareFor("rec-a", expenses, records, moves) +
      expenseShareFor("rec-b", expenses, records, moves);

    expect(allocated).toBe(10_000);
    expect(allocated).toBeLessThan(15_000);
  });
});


/**
 * The wiring, tested the same way as the arithmetic.
 *
 * A correct formula fed the wrong inputs is the same wrong number on screen,
 * and the input that matters most here is the departure date: without it a
 * record sold on the 2nd carries a whole month of feed, silently.
 */
function sale(over: Partial<Sale> = {}): Sale {
  return {
    id: "sale-1",
    created_at: "2026-09-10T08:00:00Z",
    updated_at: "2026-09-10T08:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-a",
    date: "2026-09-10",
    price: 1_000_000,
    count: 1,
    customer_id: null,
    notes: null,
    ...over,
  };
}

function death(over: Partial<Death> = {}): Death {
  return {
    id: "death-1",
    created_at: "2026-09-10T08:00:00Z",
    updated_at: "2026-09-10T08:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-a",
    date: "2026-09-10",
    count: 1,
    cause: "illness",
    vet_id: null,
    notes: null,
    ...over,
  };
}

describe("working out when a record left", () => {
  it("uses the date of the sale that took the last of it", () => {
    const records = [record({ id: "rec-a", status: "sold", initial_head_count: 1, head_count: 0 })];

    expect(departuresFrom(records, [sale({ date: "2026-09-10" })], []).get("rec-a")).toEqual({
      on: "2026-09-10",
      head: 1,
    });
  });

  it("uses the death when that is what emptied the record", () => {
    const records = [record({ id: "rec-a", status: "dead", initial_head_count: 1, head_count: 0 })];

    expect(departuresFrom(records, [], [death({ date: "2026-09-04" })]).get("rec-a")).toEqual({
      on: "2026-09-04",
      head: 1,
    });
  });

  it("waits for the sale that empties a group, not the first one", () => {
    // SPEC 3.8 — a group may be sold in parts. It is still being fed between
    // the first sale and the last.
    const records = [record({ id: "rec-a", status: "sold", initial_head_count: 10, head_count: 0 })];
    const sales = [
      sale({ id: "s1", date: "2026-09-05", count: 4 }),
      sale({ id: "s2", date: "2026-09-20", count: 6 }),
    ];

    expect(departuresFrom(records, sales, []).get("rec-a")).toEqual({ on: "2026-09-20", head: 6 });
  });

  it("gives no departure to a group that has only been sold in part", () => {
    // Still active, still eating. A departure date here would stop charging it
    // for feed it is genuinely consuming.
    const records = [record({ id: "rec-a", status: "active", initial_head_count: 10, head_count: 6 })];

    expect(departuresFrom(records, [sale({ count: 4 })], []).has("rec-a")).toBe(false);
  });

  it("keeps feeding an oversold group until the sale that actually emptied it", () => {
    // SPEC 6.7 — two offline devices each sell five from a group of eight.
    // Both sales are kept and the count clamps at zero. The first sale left
    // three head behind, and those three went on eating until the 25th, so
    // that is the day the record left rather than the 6th.
    const records = [record({ id: "rec-a", status: "sold", initial_head_count: 8, head_count: 0 })];
    const sales = [
      sale({ id: "s1", date: "2026-09-06", count: 5 }),
      sale({ id: "s2", date: "2026-09-25", count: 5 }),
    ];

    expect(departuresFrom(records, sales, []).get("rec-a")).toEqual({
      on: "2026-09-25",
      head: 5,
    });
  });

  it("counts sales and deaths together", () => {
    const records = [record({ id: "rec-a", status: "dead", initial_head_count: 5, head_count: 0 })];

    expect(
      departuresFrom(
        records,
        [sale({ id: "s1", date: "2026-09-05", count: 3 })],
        [death({ id: "d1", date: "2026-09-12", count: 2 })],
      ).get("rec-a"),
    ).toEqual({ on: "2026-09-12", head: 2 });
  });

  it("ignores a deleted sale", () => {
    // The deleted sale would have emptied the record on the 5th all by itself.
    // Counting it would end the record's life a fortnight early and stop
    // charging it for feed it went on eating.
    const records = [record({ id: "rec-a", status: "sold", initial_head_count: 2, head_count: 0 })];
    const sales = [
      sale({ id: "s1", date: "2026-09-05", count: 2, deleted_at: "2026-09-06T00:00:00Z" }),
      sale({ id: "s2", date: "2026-09-20", count: 2 }),
    ];

    expect(departuresFrom(records, sales, []).get("rec-a")).toEqual({ on: "2026-09-20", head: 2 });
  });
});

describe("feeding departures into the allocation", () => {
  const moves = [
    move({ id: "m1", record_id: "rec-a", date: "2026-01-01" }),
    move({ id: "m2", record_id: "rec-b", date: "2026-01-01" }),
  ];

  it("charges a sold record only for the days it was still here", () => {
    // A left on 10 September: 10 head-days. B stayed all month: 30. Of 40,000,
    // A carries 10/40 = 10,000 and B carries 30/40 = 30,000.
    //
    // Without the departure both would look identical and split it 20,000 each
    // — no error, no warning, just the wrong number on the record's screen.
    const records = [
      record({ id: "rec-a", status: "sold", initial_head_count: 1, head_count: 0 }),
      record({ id: "rec-b", status: "active" }),
    ];
    const departures = departuresFrom(records, [sale({ date: "2026-09-10" })], []);

    const shares = allocateExpense(expense({ amount: 40_000 }), records, moves, departures);

    expect(shares.get("rec-a")).toBe(10_000);
    expect(shares.get("rec-b")).toBe(30_000);
  });

  it("drops a record that had already left before the period began", () => {
    const records = [
      record({ id: "rec-a", status: "sold", initial_head_count: 1, head_count: 0 }),
      record({ id: "rec-b", status: "active" }),
    ];
    const departures = departuresFrom(records, [sale({ date: "2026-08-15" })], []);

    const shares = allocateExpense(expense({ amount: 40_000 }), records, moves, departures);

    expect(shares.has("rec-a")).toBe(false);
    expect(shares.get("rec-b")).toBe(40_000);
  });

  it("leaves a sold record out entirely when no departure date is known", () => {
    // The state this app was in before Sales and Deaths existed. Excluding it
    // is wrong by a little; charging it a full month would be wrong by a lot,
    // and neither would announce itself — so the safer wrong is the one that
    // does not inflate a cost.
    const records = [
      record({ id: "rec-a", status: "sold", initial_head_count: 1, head_count: 0 }),
      record({ id: "rec-b", status: "active" }),
    ];

    const shares = allocateExpense(expense({ amount: 40_000 }), records, moves, new Map());

    expect(shares.has("rec-a")).toBe(false);
    expect(shares.get("rec-b")).toBe(40_000);
  });
});
