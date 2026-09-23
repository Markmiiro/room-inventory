import { describe, expect, it } from "vitest";

import type { Expense, Purchase, Record_, Sale } from "../db/types";
import { farmMoney, moneyBySpecies } from "./money";
import { periodFrom } from "./period";

/**
 * SPEC 19.2 — money by species, and the farm totals both Money tabs read.
 *
 * The figures here are exact: purchases and sales belong to a record directly
 * and carry their own price. Nothing is allocated, which is why none of it
 * carries the "estimated" labelling SPEC 4.4 requires — and why the difference
 * per species is deliberately not called profit.
 */

const TODAY = "2026-09-07";
const YEAR = periodFrom(TODAY, 12);

function record(over: Partial<Record_> = {}): Record_ {
  return {
    id: "rec-1",
    created_at: "2026-01-05T00:00:00Z",
    updated_at: "2026-01-05T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    kind: "animal",
    species: "cattle",
    tag: "C-1",
    breed: null,
    sex: "female",
    date_of_birth: null,
    arrival_date: null,
    initial_head_count: 1,
    head_count: 1,
    offspring_baseline: null,
    offspring_baseline_updated_at: null,
    dam_record_id: null,
    sire_record_id: null,
    birth_id: null,
    source: "bought",
    status: "active",
    parent_record_id: null,
    notes: null,
    current_room_id: "room-1",
    ...over,
  };
}

function purchase(over: Partial<Purchase> = {}): Purchase {
  return {
    id: "pu-1",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    date: "2026-02-01",
    price: 1_000_000,
    seller: null,
    count: 1,
    ...over,
  };
}

function sale(over: Partial<Sale> = {}): Sale {
  return {
    id: "sl-1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    date: "2026-05-01",
    price: 1_500_000,
    count: 1,
    customer_id: null,
    notes: null,
    ...over,
  };
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: "ex-1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    amount: 200_000,
    category_id: "cat-1",
    date: "2026-05-01",
    applies_to: "farm",
    applies_to_id: null,
    note: null,
    ...over,
  };
}

describe("the farm totals", () => {
  it("is sales less purchases less expenses (SPEC 4.5)", () => {
    const money = farmMoney(YEAR, {
      sales: [sale({ price: 1_500_000 })],
      purchases: [purchase({ price: 1_000_000 })],
      expenses: [expense({ amount: 200_000 })],
    });
    expect(money).toMatchObject({
      sales: 1_500_000,
      purchases: 1_000_000,
      expenses: 200_000,
      profit: 300_000,
    });
    // SPEC 20.10 — the produce half is broken out, and is zero on a farm that
    // keeps none. Asserted rather than ignored: a produce figure leaking into a
    // livestock-only farm's totals would be silent.
    expect(money.produceSales).toBe(0);
    expect(money.producePurchases).toBe(0);
  });

  it("reports a loss as a negative figure rather than hiding it", () => {
    const money = farmMoney(YEAR, {
      sales: [],
      purchases: [purchase({ price: 1_000_000 })],
      expenses: [],
    });
    expect(money.profit).toBe(-1_000_000);
  });

  it("counts only what falls inside the period", () => {
    const money = farmMoney(periodFrom(TODAY, 3), {
      // June onward for a 3-month period ending in September.
      sales: [sale({ date: "2026-05-01", price: 900_000 })],
      purchases: [],
      expenses: [],
    });
    expect(money.sales).toBe(0);
  });
});

describe("money by species", () => {
  const records = [
    record({ id: "cow", species: "cattle" }),
    record({ id: "flock", species: "hens", kind: "group" }),
  ];

  it("splits spending and earning by the species of the record", () => {
    const { rows } = moneyBySpecies(YEAR, {
      records,
      purchases: [
        purchase({ id: "p1", record_id: "cow", price: 1_000_000 }),
        purchase({ id: "p2", record_id: "flock", price: 400_000, count: 100 }),
      ],
      sales: [sale({ id: "s1", record_id: "cow", price: 1_500_000 })],
    });

    expect(rows).toEqual([
      {
        species: "cattle",
        spent: 1_000_000,
        earned: 1_500_000,
        difference: 500_000,
        bought: 1,
        sold: 1,
        boughtHead: 1,
        soldHead: 1,
      },
      {
        species: "hens",
        spent: 400_000,
        earned: 0,
        difference: -400_000,
        bought: 1,
        sold: 0,
        boughtHead: 100,
        soldHead: 0,
      },
    ]);
  });

  /**
   * SPEC 19.3 — the counts are the point. One UGX 4M bull and forty hens at
   * 100,000 each are the same money and entirely different news, and the
   * figure alone cannot tell them apart.
   */
  it("counts the purchases and sales behind the money", () => {
    const { rows } = moneyBySpecies(YEAR, {
      records: [record({ id: "cow" })],
      purchases: [
        purchase({ id: "p1", record_id: "cow", price: 2_000_000 }),
        purchase({ id: "p2", record_id: "cow", price: 2_000_000 }),
      ],
      sales: [sale({ id: "s1", record_id: "cow", price: 1_000_000 })],
    });
    expect(rows[0]).toMatchObject({ bought: 2, sold: 1, spent: 4_000_000 });
  });

  it("counts head as well as rows, since a sale can carry several", () => {
    const { rows } = moneyBySpecies(YEAR, {
      records: [record({ id: "flock", species: "hens", kind: "group" })],
      purchases: [],
      sales: [sale({ record_id: "flock", count: 40, price: 4_000_000 })],
    });
    expect(rows[0]).toMatchObject({ sold: 1, soldHead: 40 });
  });

  it("gives the farm totals for each column", () => {
    const { totals } = moneyBySpecies(YEAR, {
      records,
      purchases: [
        purchase({ id: "p1", record_id: "cow", price: 1_000_000 }),
        purchase({ id: "p2", record_id: "flock", price: 400_000 }),
      ],
      sales: [sale({ id: "s1", record_id: "cow", price: 1_500_000 })],
    });
    expect(totals).toMatchObject({
      spent: 1_400_000,
      earned: 1_500_000,
      difference: 100_000,
      bought: 2,
      sold: 1,
    });
  });

  it("reads in the SPEC 18 species order", () => {
    const { rows } = moneyBySpecies(YEAR, {
      records: [
        record({ id: "a", species: "turkeys" }),
        record({ id: "b", species: "cattle" }),
        record({ id: "c", species: "hens" }),
      ],
      purchases: [
        purchase({ id: "p1", record_id: "a" }),
        purchase({ id: "p2", record_id: "b" }),
        purchase({ id: "p3", record_id: "c" }),
      ],
      sales: [],
    });
    expect(rows.map((r) => r.species)).toEqual(["cattle", "hens", "turkeys"]);
  });

  it("leaves out a species with no money in the period", () => {
    const { rows } = moneyBySpecies(YEAR, {
      records,
      purchases: [purchase({ record_id: "cow" })],
      sales: [],
    });
    expect(rows.map((r) => r.species)).toEqual(["cattle"]);
  });

  it("ignores rows outside the period", () => {
    const { rows, totals } = moneyBySpecies(periodFrom(TODAY, 3), {
      records,
      purchases: [purchase({ record_id: "cow", date: "2026-02-01" })],
      sales: [],
    });
    expect(rows).toEqual([]);
    expect(totals.spent).toBe(0);
  });

  it("ignores a soft-deleted purchase or sale", () => {
    const { totals } = moneyBySpecies(YEAR, {
      records,
      purchases: [purchase({ record_id: "cow", deleted_at: "2026-06-01T00:00:00Z" })],
      sales: [sale({ record_id: "cow", deleted_at: "2026-06-01T00:00:00Z" })],
    });
    expect(totals).toMatchObject({ spent: 0, earned: 0, bought: 0, sold: 0 });
  });

  /**
   * The species rows must always add up to the farm total, or say why not.
   * A table of money that quietly does not tie out is worse than one that
   * names its remainder.
   */
  it("keeps money whose record cannot be found rather than dropping it", () => {
    const { rows, totals, unattributed } = moneyBySpecies(YEAR, {
      records: [record({ id: "cow" })],
      purchases: [purchase({ id: "p1", record_id: "vanished", price: 700_000 })],
      sales: [],
    });
    expect(rows).toEqual([]);
    expect(totals.spent).toBe(700_000);
    expect(unattributed.spent).toBe(700_000);
  });

  it("ties the species rows to the farm total when nothing is unattributed", () => {
    const { rows, totals, unattributed } = moneyBySpecies(YEAR, {
      records,
      purchases: [
        purchase({ id: "p1", record_id: "cow", price: 1_000_000 }),
        purchase({ id: "p2", record_id: "flock", price: 400_000 }),
      ],
      sales: [sale({ id: "s1", record_id: "flock", price: 900_000 })],
    });
    expect(rows.reduce((sum, r) => sum + r.spent, 0)).toBe(totals.spent);
    expect(rows.reduce((sum, r) => sum + r.earned, 0)).toBe(totals.earned);
    expect(unattributed).toEqual({ spent: 0, earned: 0 });
  });
});
