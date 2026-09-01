import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CheckIcon, SearchIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { recordSale } from "../db/mutations";
import { activeRecords, allHealth } from "../db/queries";
import type { HealthRecord, Record_ } from "../db/types";
import { withdrawalEnd } from "../domain/alerts";
import { formatDate, formatUGX, headUnit } from "../domain/format";
import { speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

/**
 * Sell.
 *
 * Two rules shape this screen more than the mockup does:
 *
 * SPEC 6.6 — an animal inside a withdrawal period shows a red warning naming
 * the end date, and the sale still goes through if confirmed. It is the owner's
 * decision, not the app's.
 *
 * SPEC 6.7 — a partial sale takes head off the record and creates nothing new
 * (SPEC 4.3). The count is clamped locally and never pushed; the server derives
 * it from the sales themselves, which is what stops two offline devices from
 * overwriting each other's sale.
 */
export function SellScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const records = useLiveQuery(activeRecords, [], [] as Record_[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);

  const [selectedId, setSelectedId] = useState<string | null>(params.get("record"));
  const [search, setSearch] = useState("");
  const [count, setCount] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(todayInEAT());
  const [buyer, setBuyer] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmedWithdrawal, setConfirmedWithdrawal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const record = records.find((r) => r.id === selectedId) ?? null;
  const today = todayInEAT();

  const headToSell = record
    ? Math.min(Math.max(1, Number(count) || record.head_count), record.head_count)
    : 0;
  const shillings = price.trim() === "" ? null : Number(price.replace(/[,\s]/g, ""));

  // SPEC 6.6 — every treatment whose withdrawal has not run out yet.
  const withdrawals = useMemo(() => {
    if (!record) return [] as Array<{ treatment: HealthRecord; end: string }>;
    return health
      .filter((h) => h.record_id === record.id)
      .map((treatment) => ({ treatment, end: withdrawalEnd(treatment) }))
      .filter((w): w is { treatment: HealthRecord; end: string } => w.end !== null && w.end >= today);
  }, [health, record, today]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const pool = needle
      ? records.filter(
          (r) =>
            r.tag.toLowerCase().includes(needle) ||
            speciesLabel(r.species).toLowerCase().includes(needle),
        )
      : records;
    return pool.slice(0, 50);
  }, [records, search]);

  async function submit() {
    if (!record) return;
    if (shillings === null || !Number.isFinite(shillings) || shillings < 0) {
      return setError("A sale needs a price in whole shillings.");
    }
    if (date > today) return setError("A sale cannot be dated in the future.");
    if (withdrawals.length > 0 && !confirmedWithdrawal) {
      return setError("Confirm the withdrawal warning before recording this sale.");
    }

    setSaving(true);
    setError(null);
    try {
      await recordSale({
        record_id: record.id,
        date,
        price: shillings,
        count: headToSell,
        notes: [buyer.trim() ? `Sold to ${buyer.trim()}` : null, notes.trim() || null]
          .filter(Boolean)
          .join(" · ") || null,
      });
      navigate(`/records/${record.id}`, { replace: true });
    } catch (cause) {
      setError((cause as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="pb-44 md:pb-8 max-w-3xl">
      {!record ? (
        <>
          <h2 className="text-headline-sm text-primary">Choose what to sell</h2>
          <div className="relative mt-3">
            <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              className="field pl-12"
              placeholder="Search by tag or species"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {matches.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  className="card w-full text-left p-4 min-h-row"
                  onClick={() => setSelectedId(candidate.id)}
                >
                  <p className="data-value font-bold">{candidate.tag}</p>
                  <p className="text-body-md text-text-muted">
                    {speciesLabel(candidate.species)} · {candidate.head_count}{" "}
                    {headUnit(candidate.head_count)}
                  </p>
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="card p-6 text-body-md text-text-muted text-center">
                Nothing to sell yet.
              </li>
            )}
          </ul>
        </>
      ) : (
        <>
          <div className="card p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="data-value font-bold truncate">{record.tag}</p>
              <p className="text-body-md text-text-muted">
                {speciesLabel(record.species)} · {record.head_count} {headUnit(record.head_count)}
              </p>
            </div>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                setSelectedId(null);
                setCount("");
                setConfirmedWithdrawal(false);
              }}
            >
              Change
            </button>
          </div>

          {withdrawals.length > 0 && (
            // SPEC 6.6 — a warning, not a block. It names the date, and the
            // sale needs an explicit acknowledgement rather than a disabled
            // button that leaves no way through.
            <div className="mt-4 rounded-xl bg-alert-bg border-l-4 border-alert p-4">
              <p className="flex items-center gap-2 text-body-lg font-semibold text-alert-text">
                <WarningIcon className="w-5 h-5 shrink-0" />
                Withdrawal period is still running
              </p>
              {withdrawals.map(({ treatment, end }) => (
                <p key={treatment.id} className="text-body-md text-alert-text mt-1">
                  {treatment.product ?? "A treatment"} given {formatDate(treatment.date)} — withdrawal
                  ends {formatDate(end)}.
                </p>
              ))}
              <label className="mt-3 flex items-start gap-3 text-body-md text-alert-text">
                <input
                  type="checkbox"
                  className="mt-1 w-5 h-5"
                  checked={confirmedWithdrawal}
                  onChange={(e) => setConfirmedWithdrawal(e.target.checked)}
                />
                <span>I understand and want to record this sale anyway.</span>
              </label>
            </div>
          )}

          {record.kind === "group" && (
            <Labelled label="How many" htmlFor="sell-count" hint={`Of ${record.head_count} in the group.`}>
              <input
                id="sell-count" className="field font-mono" value={count} inputMode="numeric"
                placeholder={String(record.head_count)}
                onChange={(e) => setCount(e.target.value)}
              />
            </Labelled>
          )}

          <Labelled
            label="Price (UGX)"
            htmlFor="sell-price"
            hint={
              shillings !== null && Number.isFinite(shillings) && shillings > 0
                ? `${formatUGX(shillings)} for ${headToSell} ${headUnit(headToSell)} — the total, not per head.`
                : "The total for this sale, not the price per head."
            }
          >
            <input
              id="sell-price" className="field font-mono" value={price} inputMode="numeric"
              placeholder="1500000" onChange={(e) => setPrice(e.target.value)}
            />
          </Labelled>

          <Labelled label="Sold on" htmlFor="sell-date">
            <input
              id="sell-date" type="date" className="field font-mono" value={date}
              max={today} onChange={(e) => setDate(e.target.value)}
            />
          </Labelled>

          <Labelled label="Buyer" htmlFor="sell-buyer">
            <input
              id="sell-buyer" className="field" value={buyer} placeholder="Who bought it"
              onChange={(e) => setBuyer(e.target.value)}
            />
          </Labelled>

          <Labelled label="Notes" htmlFor="sell-notes">
            <textarea
              id="sell-notes" className="field h-auto py-3" rows={2} value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Labelled>

          {record.kind === "group" && headToSell < record.head_count && (
            <p className="card p-3 mt-4 text-body-md text-text-muted">
              {record.head_count - headToSell} {headUnit(record.head_count - headToSell)} will stay in{" "}
              {record.tag}. Selling part of a group does not create a new record.
            </p>
          )}

          {error && (
            <p className="mt-4 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
          )}

          <div className="fixed inset-x-0 bottom-0 z-30 bg-card shadow-card-up p-4 md:static md:bg-transparent md:shadow-none md:px-0">
            <button
              type="button"
              className="btn-action w-full text-headline-sm h-14 md:max-w-xs"
              disabled={saving}
              onClick={() => void submit()}
            >
              <CheckIcon className="w-6 h-6" />
              {saving
                ? "Recording…"
                : `Sell ${headToSell} ${headUnit(headToSell)}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Labelled({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4 scroll-mb-44">
      <label className="data-label block mb-1" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
