import type { Expense, Purchase, Record_, Sale, Species } from "../db/types";
import { type Period, rowsInPeriod } from "./period";
import { ALL_SPECIES } from "./rules";

/**
 * SPEC 4.5 and 19.2 — money over a period, for the farm and by species.
 *
 * These totals were worked out inside the Money screen before Analytics needed
 * the same ones (SPEC 19). Two screens each summing sales over "the last 12
 * months" is how they end up disagreeing under an identical label, so the sums
 * live here and both read them.
 *
 * Everything in this module is **exact**. It reads purchases and sales, which
 * belong to a record directly and carry their own price. Nothing here is
 * allocated or estimated, so none of it needs the "estimated" labelling SPEC
 * 4.4 requires — and the per-species difference below is deliberately not
 * called profit, because it is not one.
 */

export interface FarmMoney {
  sales: number;
  purchases: number;
  expenses: number;
  /** SPEC 4.5 — sales less purchases less expenses, over the period. Exact. */
  profit: number;
}

export function farmMoney(
  period: Period,
  data: { sales: Sale[]; purchases: Purchase[]; expenses: Expense[] },
): FarmMoney {
  const sales = rowsInPeriod(period, data.sales).reduce((sum, s) => sum + s.price, 0);
  const purchases = rowsInPeriod(period, data.purchases).reduce((sum, p) => sum + p.price, 0);
  const expenses = rowsInPeriod(period, data.expenses).reduce((sum, e) => sum + e.amount, 0);
  return { sales, purchases, expenses, profit: sales - purchases - expenses };
}

export interface SpeciesMoney {
  species: Species;
  /** Shillings paid out on purchases of this species in the period. */
  spent: number;
  /** Shillings taken in on sales of this species in the period. */
  earned: number;
  /**
   * `earned − spent`. **Not profit**: it carries no expenses, no treatment
   * costs and no call-out fees, because none of those can be attributed to a
   * species exactly (SPEC 4.4). It is the difference between two exact figures
   * and is labelled as such on screen.
   */
  difference: number;
  /**
   * How many purchases and sales those figures came from.
   *
   * SPEC 19.3: without these a single UGX 4M bull reads exactly like forty
   * hens at 100,000 each. The money alone cannot tell the difference, and the
   * two are entirely different pieces of news.
   */
  bought: number;
  sold: number;
  /** Head bought and sold, since a sale row can carry a count (SPEC 3.8). */
  boughtHead: number;
  soldHead: number;
}

export interface MoneyBySpecies {
  rows: SpeciesMoney[];
  /** The farm's totals for the same columns — the sum of every row that had a
   *  species, plus anything below that did not. */
  totals: Omit<SpeciesMoney, "species">;
  /**
   * Money on a purchase or sale whose record has since been hard-deleted, so
   * no species can be read off it.
   *
   * Records are only ever soft-deleted (SPEC 4.8), so this should always be
   * zero. It is surfaced rather than dropped because the alternative is a set
   * of species rows that quietly do not add up to the farm total, which is the
   * one thing a table of money must never do without saying why.
   */
  unattributed: { spent: number; earned: number };
}

export function moneyBySpecies(
  period: Period,
  data: { records: Record_[]; sales: Sale[]; purchases: Purchase[] },
): MoneyBySpecies {
  const speciesOf = new Map(data.records.map((record) => [record.id, record.species]));

  const blank = (): Omit<SpeciesMoney, "species"> => ({
    spent: 0,
    earned: 0,
    difference: 0,
    bought: 0,
    sold: 0,
    boughtHead: 0,
    soldHead: 0,
  });

  const bySpecies = new Map<Species, Omit<SpeciesMoney, "species">>();
  const unattributed = { spent: 0, earned: 0 };
  const totals = blank();

  const bucket = (species: Species) => {
    const held = bySpecies.get(species);
    if (held) return held;
    const fresh = blank();
    bySpecies.set(species, fresh);
    return fresh;
  };

  for (const purchase of rowsInPeriod(period, data.purchases)) {
    if (purchase.deleted_at) continue;
    totals.spent += purchase.price;
    totals.bought += 1;
    totals.boughtHead += purchase.count;
    const species = speciesOf.get(purchase.record_id);
    if (species === undefined) {
      unattributed.spent += purchase.price;
      continue;
    }
    const row = bucket(species);
    row.spent += purchase.price;
    row.bought += 1;
    row.boughtHead += purchase.count;
  }

  for (const sale of rowsInPeriod(period, data.sales)) {
    if (sale.deleted_at) continue;
    totals.earned += sale.price;
    totals.sold += 1;
    totals.soldHead += sale.count;
    const species = speciesOf.get(sale.record_id);
    if (species === undefined) {
      unattributed.earned += sale.price;
      continue;
    }
    const row = bucket(species);
    row.earned += sale.price;
    row.sold += 1;
    row.soldHead += sale.count;
  }

  totals.difference = totals.earned - totals.spent;

  // ALL_SPECIES order (SPEC 18), so the table reads in the same order as every
  // filter row and list section in the app.
  const rows = ALL_SPECIES.filter((species) => bySpecies.has(species)).map((species) => {
    const row = bySpecies.get(species)!;
    return { species, ...row, difference: row.earned - row.spent };
  });

  return { rows, totals, unattributed };
}
