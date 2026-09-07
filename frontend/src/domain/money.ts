import type {
  Expense,
  ProduceType,
  Purchase,
  Record_,
  Sale,
  StockIntake,
  StockOuttake,
  Species,
} from "../db/types";
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
  /** Every sale in the period — livestock and produce together. */
  sales: number;
  purchases: number;
  expenses: number;
  /** SPEC 4.5 — sales less purchases less expenses, over the period. Exact. */
  profit: number;
  /** The produce half of the two figures above, broken out (SPEC 20.10,
   *  20.16 Q3). Zero on a farm that keeps no produce. */
  produceSales: number;
  producePurchases: number;
}

/**
 * SPEC 4.5, extended by 20.10.
 *
 * **One farm total, with produce broken out.** A sold outtake is income and a
 * bought intake is a cost, exactly as an animal sale and an animal purchase
 * are, so both join the farm figure rather than sitting in a second one. During
 * harvest produce may dominate, and a headline that silently excluded it would
 * be wrong in the season it matters most (20.16 Q3).
 *
 * **Garden intakes are neither income nor cost.** They add stock at zero,
 * because what it cost to grow the produce is already recorded as Expenses and
 * counting it again here would understate the farm's profit (SPEC 20.9). One
 * consequence worth expecting: when garden produce is sold, the whole sale
 * price lands with no matching cost, so the farm figure swings sharply positive
 * at harvest. That is correct rather than double-counted, and the screen says so
 * in words.
 *
 * The stock arguments are optional so every existing caller and test keeps
 * working unchanged.
 */
export function farmMoney(
  period: Period,
  data: {
    sales: Sale[];
    purchases: Purchase[];
    expenses: Expense[];
    intakes?: StockIntake[];
    outtakes?: StockOuttake[];
  },
): FarmMoney {
  const animalSales = rowsInPeriod(period, data.sales).reduce((sum, s) => sum + s.price, 0);
  const animalPurchases = rowsInPeriod(period, data.purchases).reduce((sum, p) => sum + p.price, 0);
  const expenses = rowsInPeriod(period, data.expenses).reduce((sum, e) => sum + e.amount, 0);

  // Only a sold outtake carries money. Home use, seed, gift, spoilage,
  // processing and moves earn nothing (SPEC 20.10), and a move is not even a
  // departure from the farm — it is the same sacks in a different store.
  const produceSales = rowsInPeriod(period, data.outtakes ?? [])
    .filter((o) => !o.deleted_at && o.reason === "sold")
    .reduce((sum, o) => sum + (o.total_price ?? 0), 0);

  const producePurchases = rowsInPeriod(period, data.intakes ?? [])
    .filter((i) => !i.deleted_at && i.source === "bought")
    .reduce((sum, i) => sum + (i.cost ?? 0), 0);

  const sales = animalSales + produceSales;
  const purchases = animalPurchases + producePurchases;

  return {
    sales,
    purchases,
    expenses,
    profit: sales - purchases - expenses,
    produceSales,
    producePurchases,
  };
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


/**
 * SPEC 20.10 — money and weight by produce type, for the period.
 *
 * The produce counterpart to `moneyBySpecies`, and deliberately the same shape:
 * spent, earned, the difference, and the counts behind them. It adds the two
 * figures money alone cannot carry — **kilograms in and kilograms out** — because
 * a farm sells weight, and "UGX 2.6M of coffee" says nothing about whether that
 * was a good year until you know how much left the store to earn it.
 */
export interface ProduceMoney {
  produce_type_id: string;
  name: string;
  /** Weight that arrived in the period, from the garden and bought together. */
  kgIn: number;
  /** Weight that left, for any reason — sold, eaten, spoiled or given away. */
  kgOut: number;
  /** Of that, the weight actually sold. */
  kgSold: number;
  spent: number;
  earned: number;
  /**
   * `earned − spent`. **Not profit**, for the same reason the species figure is
   * not: it carries no expenses, and garden produce entered at zero cost
   * (SPEC 20.9), so this is not what growing it was worth.
   */
  difference: number;
  bought: number;
  sold: number;
  /**
   * What left without earning anything, valued at the weighted average cost
   * per kilogram (SPEC 20.10).
   *
   * Home use, seed, gifts and spoilage are real losses the farm should be able
   * to see — spoilage in particular. Null when nothing was ever bought, because
   * then the average cost is unknown rather than zero, and a loss reported as
   * "UGX 0" reads as no loss at all.
   */
  takenWithoutSaleKg: number;
  spoiledKg: number;
  takenWithoutSaleValue: number | null;
}

export interface ProduceMoneyTotals {
  kgIn: number;
  kgOut: number;
  kgSold: number;
  spent: number;
  earned: number;
  difference: number;
  bought: number;
  sold: number;
}

/** Reasons that earn nothing. A move is excluded on top of these: it is the
 *  same sacks in a different store, not produce leaving the farm. */
const UNSOLD_REASONS = new Set(["home_use", "seed", "gift", "spoiled", "processing", "other"]);

export function produceMoney(
  period: Period,
  data: { produceTypes: ProduceType[]; intakes: StockIntake[]; outtakes: StockOuttake[] },
): { rows: ProduceMoney[]; totals: ProduceMoneyTotals } {
  const nameOf = new Map(data.produceTypes.map((t) => [t.id, t.name]));

  /**
   * Weighted average cost per kilogram, across every store and the whole of
   * history rather than the period alone.
   *
   * Deliberately not period-bounded: produce bought last year and eaten this
   * year cost what it cost, and re-deriving the average from one period's
   * purchases would value this year's spoilage at a price that has nothing to
   * do with the sacks that spoiled.
   */
  const cost = new Map<string, { cost: number; kg: number }>();
  for (const intake of data.intakes) {
    if (intake.deleted_at) continue;
    const held = cost.get(intake.produce_type_id) ?? { cost: 0, kg: 0 };
    held.cost += intake.cost ?? 0;
    held.kg += intake.kg;
    cost.set(intake.produce_type_id, held);
  }
  const averageCost = (id: string): number | null => {
    const held = cost.get(id);
    if (!held || held.kg === 0 || held.cost === 0) return null;
    return held.cost / held.kg;
  };

  const rows = new Map<string, ProduceMoney>();
  const blank = (id: string): ProduceMoney => ({
    produce_type_id: id,
    name: nameOf.get(id) ?? "Unknown",
    kgIn: 0,
    kgOut: 0,
    kgSold: 0,
    spent: 0,
    earned: 0,
    difference: 0,
    bought: 0,
    sold: 0,
    takenWithoutSaleKg: 0,
    spoiledKg: 0,
    takenWithoutSaleValue: null,
  });
  const bucket = (id: string) => {
    const held = rows.get(id);
    if (held) return held;
    const fresh = blank(id);
    rows.set(id, fresh);
    return fresh;
  };

  for (const intake of rowsInPeriod(period, data.intakes)) {
    if (intake.deleted_at) continue;
    const row = bucket(intake.produce_type_id);
    row.kgIn += intake.kg;
    if (intake.source === "bought") {
      row.spent += intake.cost ?? 0;
      row.bought += 1;
    }
  }

  for (const outtake of rowsInPeriod(period, data.outtakes)) {
    if (outtake.deleted_at) continue;
    // A move is not produce leaving the farm, and counting it as an outtake
    // would double the weight out — the mirrored intake already added it back.
    if (outtake.reason === "moved") continue;

    const row = bucket(outtake.produce_type_id);
    row.kgOut += outtake.kg;
    if (outtake.reason === "sold") {
      row.kgSold += outtake.kg;
      row.earned += outtake.total_price ?? 0;
      row.sold += 1;
    } else if (UNSOLD_REASONS.has(outtake.reason)) {
      row.takenWithoutSaleKg += outtake.kg;
      if (outtake.reason === "spoiled") row.spoiledKg += outtake.kg;
    }
  }

  const list = [...rows.values()]
    .map((row) => {
      const perKg = averageCost(row.produce_type_id);
      return {
        ...row,
        kgIn: round(row.kgIn),
        kgOut: round(row.kgOut),
        kgSold: round(row.kgSold),
        takenWithoutSaleKg: round(row.takenWithoutSaleKg),
        spoiledKg: round(row.spoiledKg),
        difference: row.earned - row.spent,
        takenWithoutSaleValue:
          perKg === null || row.takenWithoutSaleKg === 0
            ? null
            : Math.round(perKg * row.takenWithoutSaleKg),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = list.reduce<ProduceMoneyTotals>(
    (sum, row) => ({
      kgIn: round(sum.kgIn + row.kgIn),
      kgOut: round(sum.kgOut + row.kgOut),
      kgSold: round(sum.kgSold + row.kgSold),
      spent: sum.spent + row.spent,
      earned: sum.earned + row.earned,
      difference: sum.difference + row.difference,
      bought: sum.bought + row.bought,
      sold: sum.sold + row.sold,
    }),
    { kgIn: 0, kgOut: 0, kgSold: 0, spent: 0, earned: 0, difference: 0, bought: 0, sold: 0 },
  );

  return { rows: list, totals };
}

/** Kilograms to the nearest gram, for the same reason `domain/stores.ts`
 *  rounds: a weight is a sum of decimals and binary floating point does not add
 *  them cleanly. */
function round(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}
