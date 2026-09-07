import { describe, expect, it } from "vitest";

import type { StockCount, StockIntake, StockOuttake } from "../db/types";
import { averageCostPerKg, balanceFor, balancesAsAt, sackWeightWarning } from "./stores";

/**
 * SPEC 20.8 — the derived balance.
 *
 * This is the same rule as `head_count` (SPEC 3.4) with one addition: a stock
 * count *resets* rather than subtracts. The tests are shaped like
 * `census.test.ts` for that reason — what matters is that there is one counting
 * rule taking a date, and that "right now" is that rule asked for today.
 */

const S1 = "store-1";
const S2 = "store-2";
const COFFEE = "produce-coffee";
const MAIZE = "produce-maize";

function stamp(over: { created_at?: string; deleted_at?: string | null } = {}) {
  return {
    created_at: over.created_at ?? "2026-03-01T08:00:00Z",
    updated_at: over.created_at ?? "2026-03-01T08:00:00Z",
    device_id: "d",
    deleted_at: over.deleted_at ?? null,
  };
}

function intake(over: Partial<StockIntake> = {}): StockIntake {
  return {
    id: "in-1",
    ...stamp({ created_at: over.created_at, deleted_at: over.deleted_at }),
    store_id: S1,
    produce_type_id: COFFEE,
    date: "2026-03-01",
    sacks: 10,
    kg: 620,
    source: "garden",
    garden_name: "Lower garden",
    seller: null,
    customer_id: null,
    cost: null,
    harvest_label: null,
    notes: null,
    ...over,
  };
}

function outtake(over: Partial<StockOuttake> = {}): StockOuttake {
  return {
    id: "out-1",
    ...stamp({ created_at: over.created_at, deleted_at: over.deleted_at }),
    store_id: S1,
    produce_type_id: COFFEE,
    date: "2026-04-01",
    sacks: 4,
    kg: 248,
    reason: "sold",
    price_basis: "kg",
    unit_price: 4200,
    total_price: 1_041_600,
    customer_id: null,
    to_store_id: null,
    notes: null,
    ...over,
  };
}

function count(over: Partial<StockCount> = {}): StockCount {
  return {
    id: "cnt-1",
    ...stamp({ created_at: over.created_at, deleted_at: over.deleted_at }),
    store_id: S1,
    produce_type_id: COFFEE,
    date: "2026-05-01",
    counted_sacks: 5,
    counted_kg: 300,
    notes: null,
    ...over,
  };
}

const empty = { intakes: [], outtakes: [], counts: [] };

describe("what is in a store now", () => {
  it("adds intakes and subtracts outtakes", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 620, sacks: 10 })],
      outtakes: [outtake({ kg: 248, sacks: 4 })],
    });
    expect(balance.kg).toBe(372);
    expect(balance.sacks).toBe(6);
  });

  it("keeps each store and produce type apart", () => {
    const balances = balancesAsAt("2026-09-07", {
      ...empty,
      intakes: [
        intake({ id: "a", store_id: S1, produce_type_id: COFFEE, kg: 620, sacks: 10 }),
        intake({ id: "b", store_id: S2, produce_type_id: COFFEE, kg: 100, sacks: 2 }),
        intake({ id: "c", store_id: S1, produce_type_id: MAIZE, kg: 400, sacks: 4 }),
      ],
    });
    expect(balances).toHaveLength(3);
    expect(balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ id: "a", kg: 620, sacks: 10 })],
    }).kg).toBe(620);
  });

  it("ignores a soft-deleted event", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 620, sacks: 10 })],
      outtakes: [outtake({ kg: 248, sacks: 4, deleted_at: "2026-04-02T00:00:00Z" })],
    });
    expect(balance.kg).toBe(620);
  });

  /** A pair holding nothing is absent rather than listed as zero, the same way
   *  the census omits a species the farm does not keep. */
  it("leaves out a series that has gone to zero", () => {
    const balances = balancesAsAt("2026-09-07", {
      ...empty,
      intakes: [intake({ kg: 620, sacks: 10 })],
      outtakes: [outtake({ kg: 620, sacks: 10 })],
    });
    expect(balances).toEqual([]);
  });
});

describe("as at a past date", () => {
  const input = {
    ...empty,
    intakes: [intake({ date: "2026-03-01", kg: 620, sacks: 10 })],
    outtakes: [outtake({ date: "2026-04-01", kg: 248, sacks: 4 })],
  };

  it("counts nothing before the first intake", () => {
    expect(balanceFor("2026-02-28", S1, COFFEE, input).kg).toBe(0);
  });

  it("counts the intake on its own date", () => {
    expect(balanceFor("2026-03-01", S1, COFFEE, input).kg).toBe(620);
  });

  it("does not subtract an outtake that has not happened yet", () => {
    expect(balanceFor("2026-03-31", S1, COFFEE, input).kg).toBe(620);
  });

  it("subtracts it on its own date", () => {
    expect(balanceFor("2026-04-01", S1, COFFEE, input).kg).toBe(372);
  });
});

/**
 * SPEC 20.7 — a count resets the running total rather than adjusting it. This
 * is the one place the rule differs from `head_count`.
 */
describe("a stock count", () => {
  it("resets the balance to what was counted", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ date: "2026-03-01", kg: 620, sacks: 10 })],
      counts: [count({ date: "2026-05-01", counted_kg: 300, counted_sacks: 5 })],
    });
    // Not 620, and not 620 minus anything: the store was opened and looked at.
    expect(balance.kg).toBe(300);
    expect(balance.sacks).toBe(5);
  });

  it("lets later events accumulate from the counted figure", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [
        intake({ id: "a", date: "2026-03-01", kg: 620, sacks: 10 }),
        intake({ id: "b", date: "2026-06-01", kg: 100, sacks: 2 }),
      ],
      counts: [count({ date: "2026-05-01", counted_kg: 300, counted_sacks: 5 })],
    });
    expect(balance.kg).toBe(400);
    expect(balance.sacks).toBe(7);
  });

  it("has no effect on a date before it was taken", () => {
    const balance = balanceFor("2026-04-30", S1, COFFEE, {
      ...empty,
      intakes: [intake({ date: "2026-03-01", kg: 620, sacks: 10 })],
      counts: [count({ date: "2026-05-01", counted_kg: 300, counted_sacks: 5 })],
    });
    expect(balance.kg).toBe(620);
  });

  it("takes the later of two counts", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      counts: [
        count({ id: "c1", date: "2026-05-01", counted_kg: 300, counted_sacks: 5 }),
        count({ id: "c2", date: "2026-07-01", counted_kg: 250, counted_sacks: 4 }),
      ],
    });
    expect(balance.kg).toBe(250);
  });

  /**
   * A count and a delivery on the same day. SPEC 4.1's ordering — date then
   * created_at — decides it, so the one written second happens second. Any
   * other rule would make a count's meaning depend on the time of day it was
   * typed.
   */
  it("lets a same-day delivery recorded after the count add to it", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      counts: [count({ date: "2026-05-01", created_at: "2026-05-01T09:00:00Z", counted_kg: 300, counted_sacks: 5 })],
      intakes: [intake({ date: "2026-05-01", created_at: "2026-05-01T14:00:00Z", kg: 100, sacks: 2 })],
    });
    expect(balance.kg).toBe(400);
  });

  it("supersedes a same-day delivery recorded before it", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ date: "2026-05-01", created_at: "2026-05-01T09:00:00Z", kg: 100, sacks: 2 })],
      counts: [count({ date: "2026-05-01", created_at: "2026-05-01T14:00:00Z", counted_kg: 300, counted_sacks: 5 })],
    });
    expect(balance.kg).toBe(300);
  });
});

/**
 * SPEC 20.14.1 and 20.14.2 — taking out more than is there is warned about but
 * allowed, and two devices selling the same stock offline both keep their
 * outtake. Same rule as SPEC 6.7 for oversold groups.
 */
describe("taking out more than is there", () => {
  it("clamps at zero rather than going negative", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 100, sacks: 2 })],
      outtakes: [outtake({ kg: 150, sacks: 3 })],
    });
    expect(balance.kg).toBe(0);
    expect(balance.sacks).toBe(0);
  });

  it("keeps both outtakes when two devices sell the same stock", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 100, sacks: 2 })],
      outtakes: [
        outtake({ id: "o1", kg: 80, sacks: 1 }),
        outtake({ id: "o2", kg: 80, sacks: 1 }),
      ],
    });
    expect(balance.kg).toBe(0);
    expect(balance.wentNegative).toBe(true);
  });

  /** The overdraw must survive a later delivery, or the alert would vanish the
   *  moment more produce arrived. */
  it("remembers the overdraw even after a later intake covers it", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [
        intake({ id: "a", date: "2026-03-01", kg: 100, sacks: 2 }),
        intake({ id: "b", date: "2026-06-01", kg: 500, sacks: 8 }),
      ],
      outtakes: [outtake({ date: "2026-04-01", kg: 150, sacks: 3 })],
    });
    expect(balance.kg).toBe(450);
    expect(balance.wentNegative).toBe(true);
  });

  it("is still listed even when it clamps to nothing", () => {
    const balances = balancesAsAt("2026-09-07", {
      ...empty,
      outtakes: [outtake({ kg: 50, sacks: 1 })],
    });
    // A correction waiting to be made, not an empty shelf.
    expect(balances).toHaveLength(1);
    expect(balances[0]!.wentNegative).toBe(true);
  });

  /**
   * Kilograms are the one non-integer quantity in the app, so the balance is a
   * sum of decimals. Binary floating point does not add them cleanly — this is
   * 371.79999999999995 without the rounding in `fold` — and a farmer reading a
   * weight should not be able to tell what order the deliveries were typed in.
   */
  it("does not leak floating point noise into a weight", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 620.1, sacks: 10 })],
      outtakes: [outtake({ kg: 248.3, sacks: 4 })],
    });
    expect(balance.kg).toBe(371.8);
  });

  it("keeps a weight exact across many small deliveries", () => {
    const intakes = Array.from({ length: 10 }, (_, i) =>
      intake({ id: `a${i}`, kg: 0.1, sacks: null }),
    );
    expect(balanceFor("2026-09-07", S1, COFFEE, { ...empty, intakes }).kg).toBe(1);
  });

  it("reports no overdraw on an ordinary series", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 620, sacks: 10 })],
      outtakes: [outtake({ kg: 248, sacks: 4 })],
    });
    expect(balance.wentNegative).toBe(false);
  });
});

/**
 * SPEC 20.8 and 20.14.3 — sacks are optional, kilograms are not. A sack figure
 * assembled from events that did not all carry one is a floor, not a total, and
 * must say so rather than look complete.
 */
describe("sacks entered on some events but not others", () => {
  it("marks the sack balance partial", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [
        intake({ id: "a", kg: 620, sacks: 10 }),
        intake({ id: "b", kg: 100, sacks: null }),
      ],
    });
    expect(balance.sacksPartial).toBe(true);
    // Kilograms stay exact regardless.
    expect(balance.kg).toBe(720);
    expect(balance.sacks).toBe(10);
  });

  it("is not partial when every event carries sacks", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 620, sacks: 10 })],
    });
    expect(balance.sacksPartial).toBe(false);
  });

  it("withholds the average sack weight while the sack figure is partial", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [
        intake({ id: "a", kg: 620, sacks: 10 }),
        intake({ id: "b", kg: 100, sacks: null }),
      ],
    });
    expect(balance.averageSackKg).toBeNull();
  });

  it("offers the average sack weight when both figures are complete", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ kg: 620, sacks: 10 })],
    });
    expect(balance.averageSackKg).toBe(62);
  });

  /** A count restates both figures, so it clears a partial history. */
  it("stops being partial after a count that gives both figures", () => {
    const balance = balanceFor("2026-09-07", S1, COFFEE, {
      ...empty,
      intakes: [intake({ date: "2026-03-01", kg: 100, sacks: null })],
      counts: [count({ date: "2026-05-01", counted_kg: 300, counted_sacks: 5 })],
    });
    expect(balance.sacksPartial).toBe(false);
    expect(balance.sacks).toBe(5);
  });
});

/**
 * SPEC 20.9 — weighted average cost per kilogram. Garden produce enters at zero
 * cost because growing it is already recorded as Expenses; counting it again
 * here would understate the farm's profit.
 */
describe("what produce is worth", () => {
  it("averages the cost of bought produce over its weight", () => {
    const cost = averageCostPerKg(S1, COFFEE, [
      intake({ id: "a", source: "bought", kg: 100, cost: 500_000 }),
      intake({ id: "b", source: "bought", kg: 100, cost: 300_000 }),
    ]);
    expect(cost).toBe(4000);
  });

  it("dilutes the average with garden produce, which enters at zero", () => {
    const cost = averageCostPerKg(S1, COFFEE, [
      intake({ id: "a", source: "bought", kg: 100, cost: 400_000 }),
      intake({ id: "b", source: "garden", kg: 100, cost: null }),
    ]);
    // 400,000 over 200 kg. Not 4,000 — the garden weight is real weight.
    expect(cost).toBe(2000);
  });

  /** "No purchase cost on record" and "it cost nothing" are different
   *  statements, and zero shillings a kilogram reads as the second. */
  it("says nothing rather than zero when nothing was bought", () => {
    const cost = averageCostPerKg(S1, COFFEE, [intake({ source: "garden", kg: 620, cost: null })]);
    expect(cost).toBeNull();
  });

  it("ignores another store's intakes", () => {
    const cost = averageCostPerKg(S1, COFFEE, [
      intake({ id: "a", store_id: S2, source: "bought", kg: 100, cost: 900_000 }),
    ]);
    expect(cost).toBeNull();
  });
});


/**
 * SPEC 20.17 — the typical sack weight, and the one thing it is for.
 *
 * It exists to catch a typo: 600 kg typed where 60 was meant. Two properties
 * matter more than the threshold. It **warns and never blocks**, so no caller
 * may gate on it. And **nothing is ever computed from it** — this function
 * returns words or nothing, never a quantity, because SPEC 20.8 forbids
 * deriving sacks and kilograms from one another.
 */
describe("the sack weight warning", () => {
  it("warns when the weight per sack is wildly high", () => {
    // The case it exists for: 600 typed where 60 was meant.
    const warning = sackWeightWarning("Coffee", 60, 1, 600);
    expect(warning).toContain("600");
    expect(warning).toContain("60");
    expect(warning).toContain("Coffee");
  });

  it("warns when the weight per sack is wildly low", () => {
    expect(sackWeightWarning("Maize", 100, 10, 60)).not.toBeNull();
  });

  it("says nothing about an ordinary load", () => {
    expect(sackWeightWarning("Coffee", 60, 10, 620)).toBeNull();
  });

  /** Deliberately wide. A warning that fires on a normal load is one people
   *  learn to scroll past, and then it catches nothing. */
  it("tolerates a sack half again as heavy, or half as heavy", () => {
    expect(sackWeightWarning("Coffee", 60, 1, 90)).toBeNull();
    expect(sackWeightWarning("Coffee", 60, 1, 30)).toBeNull();
    expect(sackWeightWarning("Coffee", 60, 1, 91)).not.toBeNull();
    expect(sackWeightWarning("Coffee", 60, 1, 29)).not.toBeNull();
  });

  /**
   * SPEC 20.17 — with nothing set, no warning appears and everything else
   * works normally. This is the shipped state, so it is the important case.
   */
  it("says nothing when the farm has not set a typical weight", () => {
    expect(sackWeightWarning("Coffee", null, 1, 600)).toBeNull();
  });

  it("says nothing when sacks were not recorded", () => {
    // There is no weight per sack to check, and a warning with a blank in it is
    // worse than none.
    expect(sackWeightWarning("Coffee", 60, null, 600)).toBeNull();
  });

  it("says nothing when either figure is zero", () => {
    expect(sackWeightWarning("Coffee", 60, 0, 600)).toBeNull();
    expect(sackWeightWarning("Coffee", 60, 10, 0)).toBeNull();
    expect(sackWeightWarning("Coffee", 0, 10, 600)).toBeNull();
  });

  /**
   * The guarantee, asserted as a type-level fact rather than left to review: it
   * returns a message or nothing. There is no number here for a caller to
   * mistake for a measurement.
   */
  it("returns words or nothing, never a quantity", () => {
    const warned = sackWeightWarning("Coffee", 60, 1, 600);
    const quiet = sackWeightWarning("Coffee", 60, 10, 620);
    expect(typeof warned).toBe("string");
    expect(quiet).toBeNull();
  });
});
