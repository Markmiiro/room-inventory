import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CheckIcon, SearchIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { recordDeath } from "../db/mutations";
import { activeRecords } from "../db/queries";
import type { DeathCause, Record_ } from "../db/types";
import { headUnit } from "../domain/format";
import { speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

const CAUSES: Array<{ value: DeathCause; label: string }> = [
  { value: "illness", label: "Illness" },
  { value: "injury", label: "Injury" },
  { value: "predator", label: "Predator" },
  { value: "age", label: "Age" },
  { value: "stillbirth", label: "Stillbirth" },
  { value: "unknown", label: "Unknown" },
];

/**
 * Log death.
 *
 * The same shape as Sell without the money or the withdrawal warning, and with
 * the same two rules underneath: part of a group can go without creating a new
 * record (SPEC 4.3), and the count is clamped locally and derived on the server
 * from the deaths themselves rather than pushed (SPEC 3.4, 6.7).
 *
 * "Unknown" is offered as a cause on purpose. Animals die without explanation,
 * and a form that will not accept that gets a wrong cause recorded instead.
 */
export function LogDeathScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const records = useLiveQuery(activeRecords, [], [] as Record_[]);

  const [selectedId, setSelectedId] = useState<string | null>(params.get("record"));
  const [search, setSearch] = useState("");
  const [count, setCount] = useState("");
  const [cause, setCause] = useState<DeathCause>("illness");
  const [date, setDate] = useState(todayInEAT());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const record = records.find((r) => r.id === selectedId) ?? null;
  const today = todayInEAT();
  const headLost = record
    ? Math.min(Math.max(1, Number(count) || record.head_count), record.head_count)
    : 0;

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
    if (date > today) return setError("A death cannot be dated in the future.");

    setSaving(true);
    setError(null);
    try {
      await recordDeath({
        record_id: record.id,
        date,
        cause,
        count: headLost,
        notes: notes.trim() || null,
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
          <h2 className="text-headline-sm text-primary">Which animal died?</h2>
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
                Nothing to record against.
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
              }}
            >
              Change
            </button>
          </div>

          {record.kind === "group" && (
            <Labelled label="How many" htmlFor="death-count" hint={`Of ${record.head_count} in the group.`}>
              <input
                id="death-count" className="field font-mono" value={count} inputMode="numeric"
                placeholder={String(record.head_count)}
                onChange={(e) => setCount(e.target.value)}
              />
            </Labelled>
          )}

          <fieldset className="mt-4">
            <legend className="data-label mb-2">Cause</legend>
            <div className="flex flex-wrap gap-2">
              {CAUSES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setCause(option.value)}
                  className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                    cause === option.value
                      ? "bg-primary-container text-white border-primary-container"
                      : "bg-card text-text border-border"
                  }`}
                >
                  {cause === option.value && <CheckIcon className="w-4 h-4" />}
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <Labelled label="Died on" htmlFor="death-date">
            <input
              id="death-date" type="date" className="field font-mono" value={date}
              max={today} onChange={(e) => setDate(e.target.value)}
            />
          </Labelled>

          <Labelled label="Notes" htmlFor="death-notes">
            <textarea
              id="death-notes" className="field h-auto py-3" rows={2} value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Labelled>

          {record.kind === "group" && headLost < record.head_count && (
            <p className="card p-3 mt-4 text-body-md text-text-muted">
              {record.head_count - headLost} {headUnit(record.head_count - headLost)} will stay in{" "}
              {record.tag}.
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
              {saving ? "Recording…" : `Record ${headLost} ${headUnit(headLost)}`}
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
