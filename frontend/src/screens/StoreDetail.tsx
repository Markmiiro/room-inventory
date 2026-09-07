import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { todayInEAT } from "../db/ids";
import { allProduceTypes, allStockEvents, liveStores } from "../db/queries";
import type { ProduceType, Store } from "../db/types";
import { formatDate, formatUGX, plural } from "../domain/format";
import { averageCostPerKg, balancesAsAt, type StockInput } from "../domain/stores";
import { useLiveQuery } from "../sync/useSync";
import { Quantity, formatKg } from "./Stores";

const NO_EVENTS: StockInput = { intakes: [], outtakes: [], counts: [] };

const REASON_LABEL: Record<string, string> = {
  sold: "Sold",
  home_use: "Home use",
  seed: "Seed",
  gift: "Gift",
  spoiled: "Spoiled",
  processing: "Processing",
  moved: "Moved",
  other: "Other",
};

/**
 * Store detail — SPEC 20.11.
 *
 * Two tabs. **Stock** is what is in here now, one row per produce type.
 * **History** is every intake, outtake and count in date order.
 *
 * One yellow button: **Take out**. Removing stock is the frequent action during
 * harvest, and SPEC's one-primary-button rule means the frequent one wins.
 */
export function StoreDetailScreen() {
  const { storeId = "" } = useParams();
  const today = todayInEAT();
  const [tab, setTab] = useState<"stock" | "history">("stock");

  const stores = useLiveQuery(liveStores, [], [] as Store[]);
  const types = useLiveQuery(allProduceTypes, [], [] as ProduceType[]);
  const events = useLiveQuery(allStockEvents, [], NO_EVENTS);

  const store = stores.find((s) => s.id === storeId);
  const nameOf = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const storeNameOf = useMemo(() => new Map(stores.map((s) => [s.id, s.name])), [stores]);

  const balances = useMemo(
    () => balancesAsAt(today, events).filter((b) => b.store_id === storeId),
    [today, events, storeId],
  );

  /** Every event in this store, newest first — the History tab. */
  const history = useMemo(() => {
    const rows: Array<{
      id: string;
      date: string;
      created_at: string;
      kind: "in" | "out" | "count";
      produce: string;
      kg: number;
      sacks: number | null;
      detail: string;
      money: number | null;
    }> = [];

    for (const row of events.intakes) {
      if (row.store_id !== storeId) continue;
      rows.push({
        id: row.id,
        date: row.date,
        created_at: row.created_at,
        kind: "in",
        produce: nameOf.get(row.produce_type_id) ?? "Unknown",
        kg: row.kg,
        sacks: row.sacks,
        detail:
          row.source === "bought"
            ? `Bought${row.seller ? ` from ${row.seller}` : ""}`
            : `From ${row.garden_name || "the garden"}`,
        money: row.cost,
      });
    }
    for (const row of events.outtakes) {
      if (row.store_id !== storeId) continue;
      rows.push({
        id: row.id,
        date: row.date,
        created_at: row.created_at,
        kind: "out",
        produce: nameOf.get(row.produce_type_id) ?? "Unknown",
        kg: row.kg,
        sacks: row.sacks,
        detail:
          row.reason === "moved" && row.to_store_id
            ? `Moved to ${storeNameOf.get(row.to_store_id) ?? "another store"}`
            : (REASON_LABEL[row.reason] ?? row.reason),
        money: row.total_price,
      });
    }
    for (const row of events.counts) {
      if (row.store_id !== storeId) continue;
      rows.push({
        id: row.id,
        date: row.date,
        created_at: row.created_at,
        kind: "count",
        produce: nameOf.get(row.produce_type_id) ?? "Unknown",
        kg: row.counted_kg,
        sacks: row.counted_sacks,
        detail: "Stock count",
        money: null,
      });
    }

    return rows.sort((a, b) =>
      a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date),
    );
  }, [events, storeId, nameOf, storeNameOf]);

  if (!store) {
    return <p className="card p-6 mt-4 text-body-md text-text-muted text-center">No such store.</p>;
  }

  return (
    <div className="pb-40 md:pb-24">
      <div className="flex items-baseline gap-2">
        <span className="data-value font-mono">{store.code}</span>
        <h1 className="text-headline-sm text-primary truncate">{store.name}</h1>
      </div>

      <div className="flex gap-2 mt-3" role="tablist" aria-label="Store">
        <Tab active={tab === "stock"} onClick={() => setTab("stock")}>
          Stock
        </Tab>
        <Tab active={tab === "history"} onClick={() => setTab("history")}>
          History
        </Tab>
      </div>

      {tab === "stock" ? (
        balances.length === 0 ? (
          <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
            Nothing in this store.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {balances.map((balance) => {
              const cost = averageCostPerKg(storeId, balance.produce_type_id, events.intakes);
              return (
                <li key={balance.produce_type_id} className="card p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-body-md font-semibold truncate">
                      {nameOf.get(balance.produce_type_id) ?? "Unknown"}
                    </span>
                    <span className="data-value font-bold shrink-0">
                      <Quantity
                        kg={balance.kg}
                        sacks={balance.sacks}
                        partial={balance.sacksPartial}
                      />
                    </span>
                  </div>

                  {/* SPEC 20.8 — offered as information, never used to derive
                      one quantity from the other. */}
                  {balance.averageSackKg !== null && (
                    <p className="data-label mt-1">
                      About {Math.round(balance.averageSackKg)} kg a sack
                    </p>
                  )}

                  {/* SPEC 20.14.3 — a sack figure assembled from events that did
                      not all carry one is a floor, and says so. */}
                  {balance.sacksPartial && (
                    <p className="text-body-md text-text-muted mt-1">
                      Some entries did not record sacks, so the sack count is at least this,
                      not exactly this. The weight is exact.
                    </p>
                  )}

                  {/* SPEC 20.9 — labelled as an estimate in words, because a
                      figure that looks like a valuation but is not one is
                      exactly the failure SPEC 4.4 exists to avoid. */}
                  {cost !== null && (
                    <p className="text-body-md text-text-muted mt-2">
                      Worth about {formatUGX(Math.round(cost * balance.kg))} at an{" "}
                      <strong className="text-text">estimated</strong> {formatUGX(Math.round(cost))}{" "}
                      a kilogram. Produce grown here is counted at no cost, because growing it is
                      already recorded under Expenses.
                    </p>
                  )}

                  {/* SPEC 20.14.1 — the overdraw is named rather than left to
                      be inferred from a zero. */}
                  {balance.wentNegative && (
                    <p className="text-body-md text-alert-text mt-2">
                      More has been taken out than was recorded going in. The balance stops at
                      zero; a stock count will set it straight.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : history.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          Nothing has come in or gone out of this store yet.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {history.map((row) => (
            <li key={row.id} className="card p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body-md font-semibold truncate">{row.produce}</span>
                <span
                  className={`data-value shrink-0 ${
                    row.kind === "out" ? "text-alert" : row.kind === "in" ? "text-primary" : ""
                  }`}
                >
                  {/* The sign says which way it went, so the direction does not
                      rest on colour alone (SPEC 4.6). */}
                  {row.kind === "in" ? "+" : row.kind === "out" ? "−" : ""}
                  {formatKg(row.kg)}
                </span>
              </div>
              <p className="data-label mt-1">
                {formatDate(row.date)} · {row.detail}
                {row.sacks !== null && ` · ${row.sacks} ${plural(row.sacks, "sack")}`}
              </p>
              {row.money !== null && row.money > 0 && (
                <p className="text-body-md text-text-muted mt-1">{formatUGX(row.money)}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 mt-6">
        {/* SPEC 20.11 — one yellow button, and it is the frequent action. */}
        <Link to={`/stock/out?store=${store.id}`} className="btn-action w-full h-14 text-headline-sm">
          Take out
        </Link>
        <Link to={`/stock/in?store=${store.id}`} className="btn-secondary w-full">
          Add stock
        </Link>
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-semibold ${
        active
          ? "bg-primary-container text-white border-primary-container"
          : "bg-card text-text border-border"
      }`}
    >
      {children}
    </button>
  );
}
