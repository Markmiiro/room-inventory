import { describe, expect, it } from "vitest";

import type { ProduceType, StockCount, StockIntake, StockOuttake, Store } from "../db/types";
import { computeAlerts } from "./alerts";

/**
 * SPEC 20.12 — the produce store alerts.
 *
 * Added to the existing rules in `domain/alerts.ts` rather than derived
 * separately, so Alerts, Rooms and Calendar cannot disagree about them. They
 * read the same balance the store screens read: an alert that contradicted the
 * card it points at would be worse than no alert at all.
 */

const TODAY = "2026-09-07";
const S1 = "store-1";
const COFFEE = "produce-coffee";

const base = { created_at: "2026-03-01T08:00:00Z", updated_at: "2026-03-01T08:00:00Z", device_id: "d", deleted_at: null };

const store: Store = { id: S1, ...base, code: "S1", name: "Upper store", capacity_sacks: null, notes: null };
const coffee: ProduceType = { id: COFFEE, ...base, name: "Coffee", is_active: true, typical_sack_kg: null, notes: null };

function intake(over: Partial<StockIntake> = {}): StockIntake {
  return {
    id: "in-1", ...base, store_id: S1, produce_type_id: COFFEE, date: "2026-03-01",
    sacks: 10, kg: 620, source: "garden", garden_name: null, seller: null,
    customer_id: null, cost: null, harvest_label: null, notes: null, ...over,
  };
}

function outtake(over: Partial<StockOuttake> = {}): StockOuttake {
  return {
    id: "out-1", ...base, store_id: S1, produce_type_id: COFFEE, date: "2026-04-01",
    sacks: 4, kg: 248, reason: "sold", price_basis: null, unit_price: null,
    total_price: null, customer_id: null, to_store_id: null, notes: null, ...over,
  };
}

function count(over: Partial<StockCount> = {}): StockCount {
  return {
    id: "cnt-1", ...base, store_id: S1, produce_type_id: COFFEE, date: "2026-09-01",
    counted_sacks: 6, counted_kg: 372, notes: null, ...over,
  };
}

function alerts(stock: { intakes?: StockIntake[]; outtakes?: StockOuttake[]; counts?: StockCount[] }, stores = [store]) {
  return computeAlerts({
    rooms: [], records: [], moves: [], health: [], today: TODAY,
    stores, produceTypes: [coffee],
    stock: { intakes: stock.intakes ?? [], outtakes: stock.outtakes ?? [], counts: stock.counts ?? [] },
  });
}

const kinds = (list: ReturnType<typeof computeAlerts>) => list.map((a) => a.kind);

describe("a store balance that went negative", () => {
  /**
   * SPEC 20.14.1 and 20.14.2 — both outtakes are kept and the balance clamps at
   * zero. Without this alert the overdraw leaves no trace anywhere: the store
   * simply reads empty, which is also what an empty store reads like.
   */
  it("is urgent", () => {
    const list = alerts({ intakes: [intake({ kg: 100, sacks: 2 })], outtakes: [outtake({ kg: 150, sacks: 3 })] });
    const negative = list.find((a) => a.kind === "store_negative");
    expect(negative?.priority).toBe("urgent");
    expect(negative?.title).toContain("Coffee");
    expect(negative?.title).toContain("Upper store");
  });

  it("says nothing has been discarded, because nothing has", () => {
    const list = alerts({ intakes: [intake({ kg: 100, sacks: 2 })], outtakes: [outtake({ kg: 150, sacks: 3 })] });
    expect(list.find((a) => a.kind === "store_negative")?.detail).toContain("nothing has been discarded");
  });

  it("stays quiet on an ordinary balance", () => {
    expect(kinds(alerts({ intakes: [intake()], outtakes: [outtake()] }))).not.toContain("store_negative");
  });
});

describe("a store over capacity", () => {
  const small: Store = { ...store, capacity_sacks: 5 };

  /** SPEC 20.12 — measured in sacks across the whole store: a store is full of
   *  sacks whatever is in them. */
  it("counts every produce type together", () => {
    const list = alerts({ intakes: [intake({ sacks: 4, kg: 200 }), intake({ id: "in-2", sacks: 4, kg: 200, produce_type_id: COFFEE })] }, [small]);
    const over = list.find((a) => a.kind === "store_over_capacity");
    expect(over?.priority).toBe("this_week");
    expect(over?.detail).toContain("8 sacks");
    expect(over?.detail).toContain("holds 5");
  });

  it("stays quiet at exactly capacity", () => {
    expect(kinds(alerts({ intakes: [intake({ sacks: 5, kg: 300 })] }, [small]))).not.toContain("store_over_capacity");
  });

  /** Optional, and unset until the farm says otherwise — so no capacity means
   *  no warning rather than a warning against zero. */
  it("stays quiet when no capacity has been set", () => {
    expect(kinds(alerts({ intakes: [intake({ sacks: 400, kg: 20000 })] }))).not.toContain("store_over_capacity");
  });
});

describe("stock that has not been counted", () => {
  it("is raised when there has never been a count", () => {
    const list = alerts({ intakes: [intake()] });
    const overdue = list.find((a) => a.kind === "stock_count_overdue");
    expect(overdue?.priority).toBe("later");
    expect(overdue?.detail).toContain("never been a stock count");
  });

  it("is raised again once ninety days have passed", () => {
    const list = alerts({ intakes: [intake()], counts: [count({ date: "2026-05-01", counted_kg: 620, counted_sacks: 10 })] });
    expect(kinds(list)).toContain("stock_count_overdue");
  });

  it("stays quiet on a recent count", () => {
    const list = alerts({ intakes: [intake()], counts: [count({ date: "2026-09-01", counted_kg: 620, counted_sacks: 10 })] });
    expect(kinds(list)).not.toContain("stock_count_overdue");
  });

  /**
   * SPEC 20.12 says "where stock exists". A store holding nothing does not need
   * counting, and saying so every ninety days would train people to ignore the
   * whole list.
   */
  it("stays quiet about a store holding nothing", () => {
    const list = alerts({ intakes: [intake({ kg: 100, sacks: 2 })], outtakes: [outtake({ kg: 100, sacks: 2 })] });
    expect(kinds(list)).not.toContain("stock_count_overdue");
  });
});

describe("a large variance", () => {
  it("is raised when a count differed from the ledger by more than a tenth", () => {
    const list = alerts({
      intakes: [intake({ kg: 1000, sacks: 16 })],
      counts: [count({ date: "2026-09-01", counted_kg: 850, counted_sacks: 14 })],
    });
    const variance = list.find((a) => a.kind === "large_variance");
    expect(variance?.priority).toBe("this_week");
    expect(variance?.detail).toContain("short");
    // Dated, so the Calendar can place it on the day it happened.
    expect(variance?.date).toBe("2026-09-01");
  });

  it("stays quiet on a count that nearly matched", () => {
    const list = alerts({
      intakes: [intake({ kg: 1000, sacks: 16 })],
      counts: [count({ date: "2026-09-01", counted_kg: 980, counted_sacks: 16 })],
    });
    expect(kinds(list)).not.toContain("large_variance");
  });
});

/**
 * Every farm until its first delivery, and every farm that keeps no produce at
 * all. The rules must cost nothing to have switched on.
 */
describe("a farm with no produce", () => {
  it("raises no store alerts at all", () => {
    expect(alerts({})).toEqual([]);
  });

  it("raises none when the caller passes no stock at all", () => {
    expect(
      computeAlerts({ rooms: [], records: [], moves: [], health: [], today: TODAY }),
    ).toEqual([]);
  });
});
