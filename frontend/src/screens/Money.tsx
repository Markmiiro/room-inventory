import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { todayInEAT } from "../db/ids";
import {
  allDeaths,
  allExpenses,
  allHealth,
  allMoves,
  allPurchases,
  allSales,
  allVetVisits,
  allVisitNotes,
  liveCategories,
} from "../db/queries";
import { db } from "../db/schema";
import type {
  Death,
  Expense,
  ExpenseCategory,
  HealthRecord,
  Move,
  Purchase,
  Record_,
  Sale,
  VetVisit,
  VisitNote,
} from "../db/types";
import { departuresFrom, expenseShareFor } from "../domain/allocation";
import { callOutFeeFor, totalCallOutFees } from "../domain/visits";
import { formatUGX, formatUGXShort } from "../domain/format";
import { useLiveQuery } from "../sync/useSync";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Money summary — SPEC 4.5.
 *
 * Two figures live here and they do not agree with each other, on purpose:
 *
 * The **farm** figure uses actual expenses and is exact — sales less purchases
 * less expenses, over a period.
 *
 * The **per-record** figures are estimates, because the expense share behind
 * them is an estimate (SPEC 4.4). They will not sum to the farm total, and an
 * expense whose pool was empty is real money that belongs to no animal. SPEC
 * 4.5 says to say so plainly rather than hide it, so the difference is shown as
 * its own line instead of being spread around until the columns tie out.
 */
export function MoneyScreen() {
  const today = todayInEAT();
  const [months, setMonths] = useState(12);

  const records = useLiveQuery(() => db.records.toArray(), [], [] as Record_[]);
  const moves = useLiveQuery(allMoves, [], [] as Move[]);
  const purchases = useLiveQuery(allPurchases, [], [] as Purchase[]);
  const sales = useLiveQuery(allSales, [], [] as Sale[]);
  const deaths = useLiveQuery(allDeaths, [], [] as Death[]);
  const expenses = useLiveQuery(allExpenses, [], [] as Expense[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);
  // SPEC 14.3 — call-out fees are a direct cost alongside treatment costs.
  const visits = useLiveQuery(allVetVisits, [], [] as VetVisit[]);
  const visitNotes = useLiveQuery(allVisitNotes, [], [] as VisitNote[]);
  const categories = useLiveQuery(liveCategories, [], [] as ExpenseCategory[]);

  const since = useMemo(() => {
    const [y, m] = today.split("-").map(Number);
    return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 - (months - 1), 1)).toISOString().slice(0, 10);
  }, [today, months]);

  const inPeriod = <T extends { date: string }>(rows: T[]) =>
    rows.filter((row) => row.date >= since && row.date <= today);

  const salesTotal = inPeriod(sales).reduce((sum, s) => sum + s.price, 0);
  const purchaseTotal = inPeriod(purchases).reduce((sum, p) => sum + p.price, 0);
  const expenseTotal = inPeriod(expenses).reduce((sum, e) => sum + e.amount, 0);
  const healthTotal = inPeriod(health).reduce((sum, h) => sum + (h.cost ?? 0), 0);
  // Only completed visits: a planned one is a journey nobody has made yet.
  const calloutTotal = totalCallOutFees(inPeriod(visits));
  const farmProfit = salesTotal - purchaseTotal - expenseTotal;

  // SPEC 4.4 — the departure dates are what stop a sold animal carrying a full
  // month of feed it was not there for.
  const departures = useMemo(
    () => departuresFrom(records, sales, deaths),
    [records, sales, deaths],
  );

  const perRecord = useMemo(() => {
    const periodExpenses = expenses.filter((e) => e.date >= since && e.date <= today);
    const periodVisits = visits.filter((v) => v.date >= since && v.date <= today);
    return records
      .filter((r) => !r.deleted_at)
      .map((record) => {
        const sold = sales
          .filter((s) => s.record_id === record.id && !s.deleted_at)
          .reduce((sum, s) => sum + s.price, 0);
        const bought = purchases
          .filter((p) => p.record_id === record.id && !p.deleted_at)
          .reduce((sum, p) => sum + p.price, 0);
        const treated = health
          .filter((h) => h.record_id === record.id && !h.deleted_at)
          .reduce((sum, h) => sum + (h.cost ?? 0), 0);
        const share = expenseShareFor(record.id, periodExpenses, records, moves, departures);
        // SPEC 14.3 — a direct cost, split evenly across the animals the visit
        // saw, not spread by head-days the way feed is. A call-out is paid per
        // journey, not per day of feeding.
        const callout = callOutFeeFor(record.id, periodVisits, health, visitNotes);
        return {
          record,
          sold,
          bought,
          treated,
          callout,
          share,
          profit: sold - bought - treated - callout - share,
        };
      })
      .filter((row) => row.sold || row.bought || row.treated || row.callout || row.share)
      .sort((a, b) => b.profit - a.profit);
  }, [
    records,
    sales,
    purchases,
    health,
    expenses,
    visits,
    visitNotes,
    moves,
    departures,
    since,
    today,
  ]);

  const allocated = perRecord.reduce((sum, row) => sum + row.share, 0);
  const unallocated = expenseTotal - allocated;

  const byCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const expense of inPeriod(expenses)) {
      totals.set(expense.category_id, (totals.get(expense.category_id) ?? 0) + expense.amount);
    }
    return [...totals.entries()]
      .map(([id, amount]) => ({
        name: categories.find((c) => c.id === id)?.name ?? "Uncategorised",
        amount,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [expenses, categories, since, today]);

  return (
    <div className="pb-8">
      <div className="flex gap-2" role="group" aria-label="Period">
        {[3, 12, 60].map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={months === option}
            onClick={() => setMonths(option)}
            className={`flex-1 min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
              months === option
                ? "bg-primary-container text-white border-primary-container"
                : "bg-card text-text border-border"
            }`}
          >
            {option === 3 ? "3 months" : option === 12 ? "12 months" : "5 years"}
          </button>
        ))}
      </div>

      <section className="card p-4 mt-4">
        <p className="data-label">The farm, {periodLabel(since, today)}</p>
        <p
          className={`mt-2 text-headline-lg-mobile md:text-headline-lg font-mono ${
            farmProfit < 0 ? "text-alert" : "text-primary"
          }`}
        >
          {/* SPEC 4.5 — profit in green, loss in alert red, always signed. */}
          {farmProfit >= 0 ? "+" : ""}
          {formatUGX(farmProfit)}
        </p>
        <p className="text-body-md text-text-muted mt-1">
          This figure is exact: it uses what was actually spent and received.
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-3">
          <Line label="Sales" value={salesTotal} />
          <Line label="Purchases" value={-purchaseTotal} />
          <Line label="Expenses" value={-expenseTotal} />
        </dl>

        {calloutTotal > 0 && (
          // SPEC 14.3 — the fee counts in the farm total, and the part of it
          // that reached no animal is why the per-record figures below will not
          // sum to it. Stated beside the total for the same reason treatments
          // are: it is charged to records, not to the farm line.
          <p className="text-body-md text-text-muted mt-3">
            {formatUGX(calloutTotal)} of vet call-out fees was recorded over this
            period, split evenly across the animals each visit saw. A visit with
            no animals attached leaves its fee unallocated.
          </p>
        )}

        {healthTotal > 0 && (
          // SPEC 4.5's farm figure is sales less purchases less expenses.
          // Treatment costs belong to a record directly and are not in it, so
          // they are stated beside the total rather than inside it — a line in
          // that breakdown would read as though it had been subtracted.
          <p className="text-body-md text-text-muted mt-3">
            {formatUGX(healthTotal)} of treatments was recorded over this period.
            That is a cost against particular animals, so it is counted in their
            estimated profit below rather than in the farm figure above.
          </p>
        )}
      </section>

      {byCategory.length > 0 && (
        <section className="card p-4 mt-4">
          <h2 className="text-headline-sm text-primary">Where it went</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {byCategory.map((row) => (
              <li key={row.name} className="flex items-center justify-between gap-3">
                <span className="text-body-md truncate">{row.name}</span>
                <span className="data-value shrink-0">{formatUGX(row.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="text-headline-sm text-primary mt-6">Estimated profit per record</h2>

      {/* SPEC 4.4 and 4.5 both require the word in words, not implied by
          styling. It sits above the numbers rather than under them. */}
      <p className="card p-4 mt-3 text-body-md text-text-muted">
        These are <strong className="text-text">estimates</strong>. An expense belongs
        to a room or to the whole farm, not to one animal, so each record carries a
        share of it worked out from how many head it had and how many days it was
        there. The shares below <strong className="text-text">will not add up to the
        farm total above</strong>, and that difference is not an error — it is money
        that was really spent and cannot honestly be pinned on any one animal.
      </p>

      {expenseTotal > 0 && (
        <dl className="card p-4 mt-2 grid grid-cols-2 gap-3">
          <Line label="Expenses, actual" value={expenseTotal} />
          <Line label="Shared out across records" value={allocated} />
          <Line
            label="Left unattributed"
            value={unallocated}
            hint="Spent while the room or species it was tagged to held nothing."
          />
        </dl>
      )}

      {perRecord.length === 0 ? (
        <p className="card p-6 mt-3 text-body-md text-text-muted text-center">
          No money has been recorded against any record yet.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 md:grid-cols-2">
          {perRecord.map((row) => (
            <li key={row.record.id}>
              <Link to={`/records/${row.record.id}`} className="card p-4 block h-full">
                <div className="flex items-center justify-between gap-3">
                  <span className="data-value font-bold truncate">{row.record.tag}</span>
                  <span
                    className={`data-value font-bold shrink-0 ${
                      row.profit < 0 ? "text-alert" : "text-primary"
                    }`}
                  >
                    {row.profit >= 0 ? "+" : ""}
                    {formatUGXShort(row.profit)}
                  </span>
                </div>
                <p className="text-body-md text-text-muted mt-1">
                  Sold {formatUGXShort(row.sold)} · bought {formatUGXShort(row.bought)} · treatments{" "}
                  {formatUGXShort(row.treated)}
                  {row.callout > 0 && <> · call-outs {formatUGXShort(row.callout)}</>} · estimated
                  share {formatUGXShort(row.share)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link to="/expenses" className="btn-secondary w-full mt-6">
        Expenses
      </Link>
    </div>
  );
}

function Line({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <dt className="data-label">{label}</dt>
      <dd className={`data-value mt-1 ${value < 0 ? "text-alert" : ""}`}>{formatUGX(value)}</dd>
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

function periodLabel(since: string, today: string): string {
  const [sy, sm] = since.split("-").map(Number);
  const [ty, tm] = today.split("-").map(Number);
  return `${MONTHS[(sm ?? 1) - 1]} ${sy} to ${MONTHS[(tm ?? 1) - 1]} ${ty}`;
}
