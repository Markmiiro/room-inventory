import { describe, expect, it } from "vitest";

import type { ProduceType, StockIntake, StockOuttake } from "../db/types";
import { farmMoney, produceMoney } from "./money";
import { periodFrom } from "./period";

/**
 * SPEC 20.10 — produce joins the farm's money.
 *
 * One farm total with produce broken out (20.16 Q3): a sold outtake is income
 * and a bought intake is a cost, exactly as an animal sale and purchase are.
 * During harvest produce may dominate, and a headline that silently excluded it
 * would be wrong in the season it matters most.
 */

const TODAY = "2026-09-07";
const YEAR = periodFrom(TODAY, 12);
const S1 = "store-1";
const COFFEE = "produce-coffee";
const MAIZE = "produce-maize";

const base = {
  created_at: "2026-03-01T08:00:00Z",
  updated_at: "2026-03-01T08:00:00Z",
  device_id: "d",
  deleted_at: null,
};

const TYPES: ProduceType[] = [
  { id: COFFEE, ...base, name: "Coffee", is_active: true, typical_sack_kg: null, notes: null },
  { id: MAIZE, ...base, name: "Maize", is_active: true, typical_sack_kg: null, notes: null },
];

function intake(over: Partial<StockIntake> = {}): StockIntake {
  return {
    id: "in-1", ...base, store_id: S1, produce_type_id: COFFEE, date: "2026-03-01",
    sacks: 10, kg: 620, source: "garden", garden_name: null, seller: null,
    customer_id: null, cost: null, harvest_label: null, notes: null, ...over,
  };
}

function outtake(over: Partial<StockOuttake> = {}): StockOuttake {
  return {
    id: "out-1", ...base, store_id: S1, produce_type_id: COFFEE, date: "2026-07-01",
    sacks: 4, kg: 248, reason: "sold", price_basis: "kg", unit_price: 4200,
    total_price: 1_041_600, customer_id: null, to_store_id: null, notes: null, ...over,
  };
}

describe("produce in the farm total", () => {
  it("counts a sold outtake as income", () => {
    const money = farmMoney(YEAR, {
      sales: [], purchases: [], expenses: [],
      outtakes: [outtake({ total_price: 1_000_000 })],
    });
    expect(money.produceSales).toBe(1_000_000);
    expect(money.sales).toBe(1_000_000);
    expect(money.profit).toBe(1_000_000);
  });

  it("counts a bought intake as a cost", () => {
    const money = farmMoney(YEAR, {
      sales: [], purchases: [], expenses: [],
      intakes: [intake({ source: "bought", cost: 600_000 })],
    });
    expect(money.producePurchases).toBe(600_000);
    expect(money.profit).toBe(-600_000);
  });

  /**
   * SPEC 20.9 — growing it was already recorded as Expenses, and a second
   * notional cost here would count the same shillings twice.
   */
  it("adds nothing for garden produce", () => {
    const money = farmMoney(YEAR, {
      sales: [], purchases: [], expenses: [],
      intakes: [intake({ source: "garden", cost: null, kg: 5000 })],
    });
    expect(money.producePurchases).toBe(0);
    expect(money.profit).toBe(0);
  });

  it("earns nothing from home use, spoilage or a gift", () => {
    const money = farmMoney(YEAR, {
      sales: [], purchases: [], expenses: [],
      outtakes: [
        outtake({ id: "a", reason: "home_use", total_price: null }),
        outtake({ id: "b", reason: "spoiled", total_price: null }),
        outtake({ id: "c", reason: "gift", total_price: null }),
      ],
    });
    expect(money.produceSales).toBe(0);
  });

  it("adds produce to livestock rather than replacing it", () => {
    const money = farmMoney(YEAR, {
      sales: [{ ...base, id: "s1", record_id: "r", date: "2026-05-01", price: 2_000_000, count: 1, customer_id: null, notes: null }],
      purchases: [],
      expenses: [],
      outtakes: [outtake({ total_price: 1_000_000 })],
    });
    expect(money.sales).toBe(3_000_000);
    expect(money.produceSales).toBe(1_000_000);
  });

  /** Every existing caller passes no stock at all, and must be unaffected. */
  it("is unchanged for a farm with no produce", () => {
    const money = farmMoney(YEAR, { sales: [], purchases: [], expenses: [] });
    expect(money).toMatchObject({ sales: 0, purchases: 0, profit: 0, produceSales: 0, producePurchases: 0 });
  });
});

describe("money and weight by produce type", () => {
  it("reports weight in and out alongside the money", () => {
    const { rows } = produceMoney(YEAR, {
      produceTypes: TYPES,
      intakes: [intake({ kg: 2480, source: "bought", cost: 2_000_000 })],
      outtakes: [outtake({ kg: 620, total_price: 2_604_000 })],
    });
    expect(rows[0]).toMatchObject({
      name: "Coffee", kgIn: 2480, kgOut: 620, kgSold: 620,
      spent: 2_000_000, earned: 2_604_000, difference: 604_000, bought: 1, sold: 1,
    });
  });

  /**
   * A move is the same sacks in a different store, not produce leaving the
   * farm. Counting it would double the weight out, because the mirrored intake
   * has already added it back in.
   */
  it("ignores a move in both directions", () => {
    const { totals } = produceMoney(YEAR, {
      produceTypes: TYPES,
      intakes: [intake({ id: "mirror", kg: 200, source: "garden" })],
      outtakes: [outtake({ reason: "moved", kg: 200, total_price: null, to_store_id: "store-2" })],
    });
    expect(totals.kgOut).toBe(0);
  });

  it("keeps produce types apart and orders them by name", () => {
    const { rows } = produceMoney(YEAR, {
      produceTypes: TYPES,
      intakes: [
        intake({ id: "a", produce_type_id: MAIZE, kg: 800 }),
        intake({ id: "b", produce_type_id: COFFEE, kg: 620 }),
      ],
      outtakes: [],
    });
    expect(rows.map((r) => r.name)).toEqual(["Coffee", "Maize"]);
  });

  /**
   * SPEC 20.10 — home use, seed, gifts and spoilage are real losses the farm
   * should be able to see. Spoilage in particular.
   */
  describe("what left without earning anything", () => {
    it("values it at the weighted average cost", () => {
      const { rows } = produceMoney(YEAR, {
        produceTypes: TYPES,
        // 1,000,000 over 1000 kg = 1,000 a kilogram.
        intakes: [intake({ kg: 1000, source: "bought", cost: 1_000_000 })],
        outtakes: [outtake({ reason: "spoiled", kg: 50, total_price: null })],
      });
      expect(rows[0]!.takenWithoutSaleKg).toBe(50);
      expect(rows[0]!.spoiledKg).toBe(50);
      expect(rows[0]!.takenWithoutSaleValue).toBe(50_000);
    });

    /** Garden weight dilutes the average, because it is real weight that
     *  really did cost nothing to buy. */
    it("dilutes the average with garden produce", () => {
      const { rows } = produceMoney(YEAR, {
        produceTypes: TYPES,
        intakes: [
          intake({ id: "a", kg: 1000, source: "bought", cost: 1_000_000 }),
          intake({ id: "b", kg: 1000, source: "garden", cost: null }),
        ],
        outtakes: [outtake({ reason: "spoiled", kg: 100, total_price: null })],
      });
      expect(rows[0]!.takenWithoutSaleValue).toBe(50_000);
    });

    /**
     * "Nothing was ever bought" and "it was worth nothing" are different
     * statements, and a loss reported as UGX 0 reads as the second.
     */
    it("says nothing rather than zero when nothing was ever bought", () => {
      const { rows } = produceMoney(YEAR, {
        produceTypes: TYPES,
        intakes: [intake({ kg: 1000, source: "garden", cost: null })],
        outtakes: [outtake({ reason: "spoiled", kg: 50, total_price: null })],
      });
      expect(rows[0]!.takenWithoutSaleKg).toBe(50);
      expect(rows[0]!.takenWithoutSaleValue).toBeNull();
    });

    it("does not count a sale as taken without earning", () => {
      const { rows } = produceMoney(YEAR, {
        produceTypes: TYPES,
        intakes: [intake({ kg: 1000, source: "bought", cost: 1_000_000 })],
        outtakes: [outtake({ reason: "sold", kg: 50, total_price: 200_000 })],
      });
      expect(rows[0]!.takenWithoutSaleKg).toBe(0);
      expect(rows[0]!.takenWithoutSaleValue).toBeNull();
    });

    /**
     * The average is drawn from all of history rather than the period, because
     * produce bought last year and eaten this year cost what it cost. Valuing
     * it from this period's purchases alone would price the spoilage off sacks
     * that had nothing to do with it.
     */
    it("values it from every purchase, not just this period's", () => {
      const { rows } = produceMoney(periodFrom(TODAY, 3), {
        produceTypes: TYPES,
        intakes: [intake({ date: "2026-01-01", kg: 1000, source: "bought", cost: 1_000_000 })],
        outtakes: [outtake({ date: "2026-08-01", reason: "spoiled", kg: 50, total_price: null })],
      });
      expect(rows[0]!.takenWithoutSaleValue).toBe(50_000);
      // The January purchase is outside the period, so it is not spending now.
      expect(rows[0]!.spent).toBe(0);
    });
  });

  it("gives farm totals across every produce type", () => {
    const { totals } = produceMoney(YEAR, {
      produceTypes: TYPES,
      intakes: [
        intake({ id: "a", kg: 2480, source: "bought", cost: 2_000_000 }),
        intake({ id: "b", produce_type_id: MAIZE, kg: 800, source: "garden" }),
      ],
      outtakes: [outtake({ kg: 620, total_price: 2_604_000 })],
    });
    expect(totals).toMatchObject({
      kgIn: 3280, kgOut: 620, spent: 2_000_000, earned: 2_604_000, bought: 1, sold: 1,
    });
  });

  it("ignores rows outside the period and soft-deleted ones", () => {
    const { totals } = produceMoney(periodFrom(TODAY, 3), {
      produceTypes: TYPES,
      intakes: [
        intake({ id: "old", date: "2026-01-01", kg: 500 }),
        intake({ id: "gone", date: "2026-08-01", kg: 500, deleted_at: "2026-08-02T00:00:00Z" }),
      ],
      outtakes: [],
    });
    expect(totals.kgIn).toBe(0);
  });
});
