import type { ProduceType, StockCount, StockIntake, StockOuttake, Store } from "../db/types";

/**
 * SPEC 20.8 — what is in a store, as at a date.
 *
 * **The balance is derived from events, never stored**, and this is deliberately
 * the same rule as `head_count` (SPEC 3.4, `backend/app/domain/reconcile.py`,
 * and `domain/census.ts` for the dated form). Two devices selling from the same
 * store offline would otherwise each push their own arithmetic, and the later
 * one would erase a real sale.
 *
 * As with the census, "right now" is this function asked for today rather than
 * a second and simpler version of it. One counting rule, not two.
 *
 * What differs from head count is the **stock count**, which does not subtract
 * but *resets*: from its date onward the balance starts again from what was
 * physically counted (SPEC 20.7). That is why the fold below walks one ordered
 * stream of all three event kinds rather than summing three separate totals — a
 * reset only means anything relative to the events around it.
 *
 * **Sacks and kilograms are tracked independently and neither is derived from
 * the other** (SPEC 20.8). A sack of coffee and a sack of maize weigh different
 * amounts, and two sacks of the same coffee are not identical. The average sack
 * weight below is offered as information only and never computes a balance.
 */

export interface StockInput {
  intakes: StockIntake[];
  outtakes: StockOuttake[];
  counts: StockCount[];
}

export interface Balance {
  store_id: string;
  produce_type_id: string;
  kg: number;
  sacks: number;
  /**
   * True when at least one event in this series left `sacks` empty, so the sack
   * figure is a floor rather than a total (SPEC 20.8, 20.14.3). Kilograms stay
   * exact regardless — `kg` is required on every event.
   */
  sacksPartial: boolean;
  /**
   * True when the running total dipped below zero at any point.
   *
   * SPEC 20.14.1 and 20.14.2: an outtake larger than the balance is warned
   * about but allowed, and two devices selling the same stock offline both keep
   * their outtake. The balance clamps rather than going negative, so without
   * this flag the overdraw would vanish silently — and it is what the Urgent
   * alert reads.
   */
  wentNegative: boolean;
  /** Information only, and only when the sack figure is complete and non-zero.
   *  Never used to derive one quantity from the other. */
  averageSackKg: number | null;
}

type StepKind = "in" | "out" | "count";

interface Step {
  kind: StepKind;
  date: string;
  created_at: string;
  kg: number;
  sacks: number | null;
}

function key(store_id: string, produce_type_id: string): string {
  return `${store_id} ${produce_type_id}`;
}

/** Kilograms to the nearest gram. See the note in `fold`. */
function roundKg(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}

/**
 * Group every event by the store and produce type it belongs to.
 *
 * Grouped once rather than re-scanned per pair: over a harvest's worth of rows
 * the naive version is quadratic (SPEC 6.13).
 */
function stream(input: StockInput): Map<string, Step[]> {
  const steps = new Map<string, Step[]>();

  const push = (store_id: string, produce_type_id: string, step: Step) => {
    const k = key(store_id, produce_type_id);
    const list = steps.get(k);
    if (list) list.push(step);
    else steps.set(k, [step]);
  };

  for (const row of input.intakes) {
    if (row.deleted_at) continue;
    push(row.store_id, row.produce_type_id, {
      kind: "in",
      date: row.date,
      created_at: row.created_at,
      kg: row.kg,
      sacks: row.sacks,
    });
  }
  for (const row of input.outtakes) {
    if (row.deleted_at) continue;
    push(row.store_id, row.produce_type_id, {
      kind: "out",
      date: row.date,
      created_at: row.created_at,
      kg: row.kg,
      sacks: row.sacks,
    });
  }
  for (const row of input.counts) {
    if (row.deleted_at) continue;
    push(row.store_id, row.produce_type_id, {
      kind: "count",
      date: row.date,
      created_at: row.created_at,
      kg: row.counted_kg,
      sacks: row.counted_sacks,
    });
  }

  return steps;
}

/**
 * Fold one series into a balance.
 *
 * Ordered by date then `created_at`, the ordering SPEC 4.1 uses everywhere
 * else. It is what decides a count and a delivery recorded on the same day: the
 * one written second happens second. Any other rule would make a count's
 * meaning depend on the time of day it was typed.
 */
function fold(steps: Step[], asAt: string): Omit<Balance, "store_id" | "produce_type_id"> {
  const ordered = steps
    .filter((step) => step.date <= asAt)
    .sort((a, b) =>
      a.date === b.date ? a.created_at.localeCompare(b.created_at) : a.date < b.date ? -1 : 1,
    );

  let kg = 0;
  let sacks = 0;
  let sacksPartial = false;
  let wentNegative = false;

  for (const step of ordered) {
    if (step.kind === "count") {
      // A reset, not an adjustment. Everything before it is superseded by what
      // was physically in the store — including any partial sack history, since
      // the counted figure is complete on its own terms.
      kg = step.kg;
      if (step.sacks === null) {
        sacks = 0;
        sacksPartial = true;
      } else {
        sacks = step.sacks;
        sacksPartial = false;
      }
      continue;
    }

    const sign = step.kind === "in" ? 1 : -1;
    kg += sign * step.kg;
    if (step.sacks === null) sacksPartial = true;
    else sacks += sign * step.sacks;

    // Recorded as it happens rather than inferred from the final total, because
    // a later intake would otherwise paper over it (SPEC 20.14.1).
    if (kg < 0 || sacks < 0) wentNegative = true;
  }

  // Clamped exactly as `head_count` is: both events are kept and the total
  // floors at zero rather than going negative.
  //
  // Rounded to grams on the way out because kilograms are the one quantity in
  // this app that is not an integer. Money is whole shillings and head are
  // whole animals, but produce is weighed, so a balance is a sum of decimals
  // and binary floating point does not add them cleanly: 620.1 less 248.3 is
  // 371.79999999999995 before this. A gram is far below anything a farm scale
  // resolves, so nothing real is lost and the figure on screen stops depending
  // on the order the deliveries were entered in.
  const finalKg = Math.max(roundKg(kg), 0);
  const finalSacks = Math.max(sacks, 0);

  return {
    kg: finalKg,
    sacks: finalSacks,
    sacksPartial,
    wentNegative,
    averageSackKg: !sacksPartial && finalSacks > 0 ? finalKg / finalSacks : null,
  };
}

/**
 * Every non-empty balance as at a date.
 *
 * A pair holding nothing is left out rather than listed as zero, for the same
 * reason the census omits a species the farm does not keep: a store that has
 * never held beans should not have to say so, and one that sold its last sack
 * is told by the line's absence. An overdrawn series is kept even at zero,
 * because that is a correction waiting to be made rather than an empty shelf.
 */
export function balancesAsAt(asAt: string, input: StockInput): Balance[] {
  const out: Balance[] = [];
  for (const [k, steps] of stream(input)) {
    const [store_id, produce_type_id] = k.split(" ") as [string, string];
    const balance = fold(steps, asAt);
    if (balance.kg === 0 && balance.sacks === 0 && !balance.wentNegative) continue;
    out.push({ store_id, produce_type_id, ...balance });
  }
  return out;
}

/** One pair's balance, including an all-zero one — what a form needs when it is
 *  about to take stock out of a store that may hold nothing. */
export function balanceFor(
  asAt: string,
  store_id: string,
  produce_type_id: string,
  input: StockInput,
): Balance {
  const steps = stream(input).get(key(store_id, produce_type_id)) ?? [];
  return { store_id, produce_type_id, ...fold(steps, asAt) };
}

/** Every balance in one store, ready to render as a store card. */
export function balancesInStore(asAt: string, store_id: string, input: StockInput): Balance[] {
  return balancesAsAt(asAt, input).filter((balance) => balance.store_id === store_id);
}

/**
 * SPEC 20.9 — weighted average cost per kilogram, per store per produce type.
 *
 * **Garden produce enters at zero cost.** Growing it cost real money, but that
 * money is already recorded as Expenses, and giving it a second notional cost
 * here would count the same shillings twice and understate the farm's profit.
 *
 * Null when nothing has been bought, rather than zero: "no purchase cost on
 * record" and "it cost nothing" are different statements, and zero shillings a
 * kilogram reads as the second.
 */
export function averageCostPerKg(
  store_id: string,
  produce_type_id: string,
  intakes: StockIntake[],
): number | null {
  let cost = 0;
  let kg = 0;
  for (const intake of intakes) {
    if (intake.deleted_at) continue;
    if (intake.store_id !== store_id || intake.produce_type_id !== produce_type_id) continue;
    kg += intake.kg;
    cost += intake.cost ?? 0;
  }
  if (kg === 0 || cost === 0) return null;
  return cost / kg;
}

/** Ordering for display: stores by code, produce types by name. Stable
 *  everywhere, so a balance never moves between screens. */
export function byCode(a: Store, b: Store): number {
  return a.code.localeCompare(b.code, undefined, { numeric: true });
}

export function byName(a: ProduceType, b: ProduceType): number {
  return a.name.localeCompare(b.name);
}
