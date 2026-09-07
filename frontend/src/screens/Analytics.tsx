import { useMemo } from "react";

import { SpeciesLabel } from "../components/SpeciesLabel";
import { todayInEAT } from "../db/ids";
import {
  allDeaths,
  allMoves,
  allProduceTypes,
  allPurchases,
  allSales,
  allStockEvents,
} from "../db/queries";
import { db } from "../db/schema";
import type { Death, Move, ProduceType, Purchase, Record_, Sale } from "../db/types";
import { censusAsAt } from "../domain/census";
import { formatUGX, plural } from "../domain/format";
import { moneyBySpecies, produceMoney } from "../domain/money";
import { type Period, periodLabel } from "../domain/period";
import { speciesLabel } from "../domain/rules";
import { balancesAsAt, type StockInput } from "../domain/stores";
import { useLiveQuery } from "../sync/useSync";
import { formatKg } from "./Stores";

const NO_STOCK: StockInput = { intakes: [], outtakes: [], counts: [] };

/**
 * Analytics — SPEC 19.
 *
 * Answers two questions the Money summary does not: what the farm holds, and
 * what each species has cost and earned. It is the second tab of Money rather
 * than a sixth destination, because SPEC 11 fixes five and means it.
 *
 * Every calculation here comes from `domain/`. Nothing is summed in this file
 * — the census, the per-species money and the period are all shared with the
 * summary tab, which is the only way the two tabs can be relied on to agree.
 */
export function AnalyticsScreen({ period }: { period: Period }) {
  const today = todayInEAT();

  // Every record, not just the active ones: a group sold out last month held
  // head on a past date, and the money it earned belongs in this period.
  const records = useLiveQuery(() => db.records.toArray(), [], [] as Record_[]);
  const moves = useLiveQuery(allMoves, [], [] as Move[]);
  const sales = useLiveQuery(allSales, [], [] as Sale[]);
  const purchases = useLiveQuery(allPurchases, [], [] as Purchase[]);
  const deaths = useLiveQuery(allDeaths, [], [] as Death[]);
  // SPEC 20.10 — produce joins both halves of this screen.
  const produceTypes = useLiveQuery(allProduceTypes, [], [] as ProduceType[]);
  const stock = useLiveQuery(allStockEvents, [], NO_STOCK);

  // SPEC 19.1 — "right now" is the one census function asked for today. There
  // is no separate live count that could drift away from it.
  const census = useMemo(
    () => censusAsAt(today, { records, moves, sales, deaths }),
    [today, records, moves, sales, deaths],
  );

  const money = useMemo(
    () => moneyBySpecies(period, { records, sales, purchases }),
    [period, records, sales, purchases],
  );

  /**
   * SPEC 20.10 — produce in the census, from the same date-bounded replay the
   * Stores screen uses. One counting rule, not two: a census that derived its
   * own produce figures could disagree with the store card they came from.
   */
  const produceHeld = useMemo(() => {
    const totals = new Map<string, { kg: number; partial: boolean }>();
    for (const balance of balancesAsAt(today, stock)) {
      const held = totals.get(balance.produce_type_id) ?? { kg: 0, partial: false };
      held.kg += balance.kg;
      held.partial = held.partial || balance.sacksPartial;
      totals.set(balance.produce_type_id, held);
    }
    return [...totals.entries()]
      .map(([id, held]) => ({
        id,
        name: produceTypes.find((t) => t.id === id)?.name ?? "Unknown",
        ...held,
      }))
      .filter((row) => row.kg > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [today, stock, produceTypes]);

  const produce = useMemo(
    () => produceMoney(period, { produceTypes, intakes: stock.intakes, outtakes: stock.outtakes }),
    [period, produceTypes, stock],
  );

  return (
    <div className="pb-8">
      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">What the farm holds</h2>
        <p className="data-label mt-1">Today</p>

        {census.bySpecies.length === 0 ? (
          <p className="text-body-md text-text-muted mt-3">
            No animals or groups are on the farm today.
          </p>
        ) : (
          <>
            {/* SPEC 4.2 — head counts, never percentages, and animals and
                groups are both counted by head: one cow is one head, a flock of
                240 hens is 240. */}
            <ul className="mt-3 flex flex-col gap-2">
              {census.bySpecies.map((row) => (
                <li key={row.species} className="flex items-center justify-between gap-3">
                  <span className="text-body-md truncate">{speciesLabel(row.species)}</span>
                  <span className="flex items-baseline gap-2 shrink-0">
                    <span className="data-value font-bold">{row.head}</span>
                    {/* One flock of 240 and 240 single birds are the same
                        headcount and a very different farm. */}
                    <span className="data-label">
                      {row.records} {plural(row.records, "record")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-border">
              <span className="text-body-md font-semibold">Whole farm</span>
              <span className="data-value font-bold">{census.total} head</span>
            </div>
          </>
        )}
      </section>

      {/* SPEC 20.10 — produce alongside the headcount, as at today, from the
          same replay the Stores screen reads. Head and kilograms are never
          added together: they are different quantities and a farm total across
          both would mean nothing. */}
      {produceHeld.length > 0 && (
        <section className="card p-4 mt-4">
          <h2 className="text-headline-sm text-primary">What the stores hold</h2>
          <p className="data-label mt-1">Today</p>
          <ul className="mt-3 flex flex-col gap-2">
            {produceHeld.map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3">
                <span className="text-body-md truncate">{row.name}</span>
                <span className="data-value font-bold shrink-0">{formatKg(row.kg)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">Spent and earned by species</h2>
        <p className="data-label mt-1">{periodLabel(period)}</p>

        {money.rows.length === 0 && money.totals.spent === 0 && money.totals.earned === 0 ? (
          <p className="text-body-md text-text-muted mt-3">
            Nothing was bought or sold in this period.
          </p>
        ) : (
          <>
            {/*
              A list, not a table.

              Four columns — species, spent, earned, difference — measured 462px
              of content in a 358px box on a 390px screen, which put Difference
              off the right edge behind an inner scrollbar. That is the one
              figure a farmer opens this to see, and a horizontal scroll nobody
              knows is there is the same as not showing it. Stacking gives the
              difference the right-hand position on its own line, with the two
              figures it came from beneath it, and needs no scrolling at all.
            */}
            <ul className="mt-3 flex flex-col">
              {money.rows.map((row) => (
                <li key={row.species} className="py-3 border-t border-border">
                  <SpeciesRow
                    label={<SpeciesLabel species={row.species} />}
                    row={row}
                  />
                </li>
              ))}

              <li className="py-3 border-t-2 border-border">
                <SpeciesRow
                  label={<span className="text-body-md font-semibold">Whole farm</span>}
                  row={money.totals}
                />
              </li>
            </ul>

            {/*
              The difference is not profit, and saying so is not a caveat that
              can be left to the reader. It carries no expenses, no treatment
              costs and no call-out fees, because none of those can be pinned on
              a species exactly (SPEC 4.4). A farmer reading "+2,400,000" beside
              Hens and taking it as what the hens made would be wrong by the
              whole feed bill.
            */}
            <p className="text-body-md text-text-muted mt-4">
              Difference is <strong className="text-text">earned less spent</strong>, and is not
              profit. It leaves out feed and other expenses, treatments and vet call-out fees,
              because those belong to a room or to the whole farm rather than to one species.
              The Summary tab has the exact farm profit and the estimated figures per record.
            </p>

            {(money.unattributed.spent > 0 || money.unattributed.earned > 0) && (
              // Should never happen — records are only ever soft-deleted (SPEC
              // 4.8) — but a table of money that quietly does not add up is
              // worse than one that names its remainder.
              <p className="text-body-md text-text-muted mt-3">
                {formatUGX(money.unattributed.spent + money.unattributed.earned)} could not be
                matched to a species, because the record it was recorded against is no longer
                on this device. It is counted in the farm row above.
              </p>
            )}
          </>
        )}
      </section>

      {/* SPEC 20.10 — the produce section, beside the species. */}
      {produce.rows.length > 0 && (
        <section className="card p-4 mt-4">
          <h2 className="text-headline-sm text-primary">Produce, spent and earned</h2>
          <p className="data-label mt-1">{periodLabel(period)}</p>

          <ul className="mt-3 flex flex-col">
            {produce.rows.map((row) => (
              <li key={row.produce_type_id} className="py-3 border-t border-border">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-body-md font-semibold min-w-0 truncate">{row.name}</span>
                  <span
                    className={`data-value font-bold shrink-0 ${
                      row.difference < 0 ? "text-alert" : "text-primary"
                    }`}
                  >
                    {row.difference >= 0 ? "+" : ""}
                    {formatUGX(row.difference)}
                  </span>
                </div>
                {/* Weight is the thing a farm actually sells, so it sits beside
                    the money rather than under it: "UGX 2.6M of coffee" says
                    nothing until you know how much left the store to earn it. */}
                <p className="data-label mt-1">
                  {formatKg(row.kgIn)} in · {formatKg(row.kgOut)} out · {row.bought} bought,{" "}
                  {row.sold} sold
                </p>
                <p className="text-body-md text-text-muted mt-1">
                  Spent {formatUGX(row.spent)} · earned {formatUGX(row.earned)}
                </p>
                {/* SPEC 20.10 — spoilage in particular is a real loss the farm
                    should be able to see. */}
                {row.takenWithoutSaleKg > 0 && (
                  <p className="text-body-md text-text-muted mt-1">
                    {formatKg(row.takenWithoutSaleKg)} left without being sold
                    {row.spoiledKg > 0 && `, ${formatKg(row.spoiledKg)} of it spoiled`}
                    {row.takenWithoutSaleValue !== null
                      ? ` — about ${formatUGX(row.takenWithoutSaleValue)} at what it cost.`
                      : "."}
                  </p>
                )}
              </li>
            ))}

            <li className="py-3 border-t-2 border-border">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body-md font-semibold">All produce</span>
                <span
                  className={`data-value font-bold shrink-0 ${
                    produce.totals.difference < 0 ? "text-alert" : "text-primary"
                  }`}
                >
                  {produce.totals.difference >= 0 ? "+" : ""}
                  {formatUGX(produce.totals.difference)}
                </span>
              </div>
              <p className="data-label mt-1">
                {formatKg(produce.totals.kgIn)} in · {formatKg(produce.totals.kgOut)} out ·{" "}
                {produce.totals.bought} bought, {produce.totals.sold} sold
              </p>
              <p className="text-body-md text-text-muted mt-1">
                Spent {formatUGX(produce.totals.spent)} · earned {formatUGX(produce.totals.earned)}
              </p>
            </li>
          </ul>

          {/*
            SPEC 20.9 — said in words wherever a produce value appears. Without
            it the difference reads as what growing the coffee was worth, and it
            is not: the growing was paid for under Expenses.
          */}
          <p className="text-body-md text-text-muted mt-4">
            Produce grown here enters at <strong className="text-text">no cost</strong>, because
            seed, labour and fertiliser are already recorded under Expenses. So this difference is
            not what the crop was worth to grow — and like the species figures above, it leaves out
            expenses entirely.
          </p>
        </section>
      )}

    </div>
  );
}

/**
 * One species' money, stacked for a narrow screen.
 *
 * The difference leads, on the right, because it is what the row is read for.
 * The counts sit under the name (SPEC 19.3) so a single large sale cannot be
 * mistaken for many, and the two exact figures it was derived from sit
 * underneath — subordinate to the answer, but present, because a difference
 * with no visible workings is a number nobody can check.
 */
function SpeciesRow({
  label,
  row,
}: {
  label: React.ReactNode;
  row: { spent: number; earned: number; difference: number; bought: number; sold: number };
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0">{label}</span>
        <span
          className={`data-value font-bold shrink-0 ${
            row.difference < 0 ? "text-alert" : "text-primary"
          }`}
        >
          {/* SPEC 4.5 — profit green, loss alert red, always signed. */}
          {row.difference >= 0 ? "+" : ""}
          {formatUGX(row.difference)}
        </span>
      </div>
      <p className="data-label mt-1">
        {row.bought} bought, {row.sold} sold
      </p>
      <p className="text-body-md text-text-muted mt-1">
        Spent {formatUGX(row.spent)} · earned {formatUGX(row.earned)}
      </p>
    </>
  );
}
