import { useMemo } from "react";
import { Link } from "react-router-dom";

import { ChevronIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { allProduceTypes, allStockEvents, liveStores } from "../db/queries";
import type { ProduceType, Store } from "../db/types";
import { plural } from "../domain/format";
import { type Balance, type StockInput, balancesAsAt } from "../domain/stores";
import { useLiveQuery } from "../sync/useSync";

const NO_EVENTS: StockInput = { intakes: [], outtakes: [], counts: [] };

/**
 * Stores — SPEC 20.11.
 *
 * The entry point to the produce inventory. Each store is a card listing what is
 * in it, one line per produce type, then a farm total per type across both
 * stores.
 *
 * Every figure here is derived by `balancesAsAt(today, …)` (SPEC 20.8) — the
 * same rule, asked for today. There is no separate "current balance" that could
 * drift away from the dated one.
 */
export function StoresScreen() {
  const today = todayInEAT();
  const stores = useLiveQuery(liveStores, [], [] as Store[]);
  const types = useLiveQuery(allProduceTypes, [], [] as ProduceType[]);
  const events = useLiveQuery(allStockEvents, [], NO_EVENTS);

  const balances = useMemo(() => balancesAsAt(today, events), [today, events]);
  const nameOf = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);

  /** The farm total per produce type, across every store. */
  const farmTotals = useMemo(() => {
    const totals = new Map<string, { kg: number; sacks: number; partial: boolean }>();
    for (const balance of balances) {
      const held = totals.get(balance.produce_type_id) ?? { kg: 0, sacks: 0, partial: false };
      held.kg += balance.kg;
      held.sacks += balance.sacks;
      // Partial anywhere means partial everywhere it is summed: a total built
      // from one complete store and one incomplete one is still a floor.
      held.partial = held.partial || balance.sacksPartial;
      totals.set(balance.produce_type_id, held);
    }
    return [...totals.entries()]
      .map(([id, held]) => ({ id, name: nameOf.get(id) ?? "Unknown", ...held }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [balances, nameOf]);

  return (
    <div className="pb-40 md:pb-24">
      <ul className="flex flex-col gap-3">
        {stores.map((store) => (
          <li key={store.id}>
            <StoreCard
              store={store}
              balances={balances.filter((b) => b.store_id === store.id)}
              nameOf={nameOf}
            />
          </li>
        ))}
      </ul>

      {farmTotals.length > 0 && (
        <section className="card p-4 mt-4">
          <h2 className="text-headline-sm text-primary">Across both stores</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {farmTotals.map((total) => (
              <li key={total.id} className="flex items-baseline justify-between gap-3">
                <span className="text-body-md truncate">{total.name}</span>
                <span className="data-value shrink-0">
                  <Quantity kg={total.kg} sacks={total.sacks} partial={total.partial} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link to="/stock/in" className="btn-action w-full mt-6 h-14 text-headline-sm">
        Add stock
      </Link>
    </div>
  );
}

function StoreCard({
  store,
  balances,
  nameOf,
}: {
  store: Store;
  balances: Balance[];
  nameOf: Map<string, string>;
}) {
  const sacks = balances.reduce((sum, b) => sum + b.sacks, 0);
  const over = store.capacity_sacks !== null && sacks > store.capacity_sacks;

  return (
    <Link to={`/stores/${store.id}`} className="card p-4 block">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="data-value font-mono shrink-0">{store.code}</span>
          <span className="text-headline-sm text-primary truncate">{store.name}</span>
        </span>
        <ChevronIcon className="w-5 h-5 shrink-0 text-text-muted" />
      </div>

      {/* SPEC 20.11 — a store holding nothing says so, rather than showing an
          empty card the reader has to interpret. */}
      {balances.length === 0 ? (
        <p className="text-body-md text-text-muted mt-2">Nothing in this store.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {balances.map((balance) => (
            <li
              key={balance.produce_type_id}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="text-body-md truncate">
                {nameOf.get(balance.produce_type_id) ?? "Unknown"}
              </span>
              <span className="data-value shrink-0">
                <Quantity kg={balance.kg} sacks={balance.sacks} partial={balance.sacksPartial} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* SPEC 20.12 — over capacity warns, never blocks. Stated in words as
          well as colour, because colour is never the only signal (SPEC 4.6). */}
      {over && (
        <p className="text-body-md text-alert-text mt-3">
          Over capacity — {sacks} {plural(sacks, "sack")} in a store that holds{" "}
          {store.capacity_sacks}.
        </p>
      )}
    </Link>
  );
}

/**
 * A quantity, in both units.
 *
 * Kilograms lead because weight is what gets sold and what carries value; sacks
 * are the physical check. Neither is computed from the other (SPEC 20.8).
 *
 * A partial sack figure is marked in words rather than quietly shown as
 * complete — it means some events did not record a sack count, so the number is
 * a floor. Kilograms are exact regardless, since `kg` is required on every
 * event.
 */
export function Quantity({
  kg,
  sacks,
  partial,
}: {
  kg: number;
  sacks: number;
  partial: boolean;
}) {
  return (
    <span className="whitespace-nowrap">
      {formatKg(kg)}
      {(sacks > 0 || !partial) && (
        <span className="data-label ml-2">
          {sacks} {plural(sacks, "sack")}
          {partial && " so far"}
        </span>
      )}
    </span>
  );
}

/** Weight to at most one decimal. Whole kilograms read as whole numbers rather
 *  than trailing a pointless ".0" down a column of them. */
export function formatKg(kg: number): string {
  const rounded = Math.round(kg * 10) / 10;
  return `${rounded.toLocaleString("en-UG")} kg`;
}
