import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { PlusIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { createVetVisit } from "../db/mutations";
import { allHealth, allVetVisits, allVisitNotes } from "../db/queries";
import { db } from "../db/schema";
import type { HealthRecord, Vet, VetVisit, VisitNote, VisitStatus } from "../db/types";
import { daysBetween, formatDate, formatUGX, plural } from "../domain/format";
import { summariseVisits } from "../domain/visits";
import { useLiveQuery } from "../sync/useSync";

/**
 * Vet visits — SPEC 14.5.
 *
 * "A list by date, planned visits first." Planned first because they are the
 * only ones anything can still be done about: a completed visit is a record, a
 * planned one is a commitment.
 *
 * The screen supports both of the farm's working patterns (SPEC 14.2). A
 * call-out is created as already completed and has treatments added to it as
 * they happen; a scheduled visit is created planned, for a future date, and is
 * marked completed when it happens. Neither is the primary one.
 */
export function VetVisitsScreen() {
  const visits = useLiveQuery(allVetVisits, [], [] as VetVisit[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);
  const notes = useLiveQuery(allVisitNotes, [], [] as VisitNote[]);
  const vets = useLiveQuery(() => db.vets.toArray(), [], [] as Vet[]);

  const [adding, setAdding] = useState(false);
  const today = todayInEAT();

  const rows = summariseVisits(visits, health, notes);
  const vetName = new Map(vets.filter((v) => !v.deleted_at).map((v) => [v.id, v.name]));

  const planned = rows.filter((r) => r.visit.status === "planned");
  const completed = rows.filter((r) => r.visit.status === "completed");

  return (
    <div className="pb-40 md:pb-24">
      {rows.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          No visits yet. Record one when the vet comes out, or plan one for a date
          ahead. A treatment you give yourself does not need a visit.
        </p>
      ) : (
        <>
          <Section title="Planned" rows={planned} vetName={vetName} today={today} />
          <Section title="Completed" rows={completed} vetName={vetName} today={today} />
        </>
      )}

      <button
        type="button"
        aria-label="Add a visit"
        className="btn-action fixed right-4 bottom-24 md:bottom-8 z-30 h-14 w-14 !px-0 rounded-xl"
        onClick={() => setAdding(true)}
      >
        <PlusIcon className="w-7 h-7" />
      </button>

      {adding && <NewVisitDialog vets={vets} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Section({
  title,
  rows,
  vetName,
  today,
}: {
  title: string;
  rows: ReturnType<typeof summariseVisits>;
  vetName: Map<string, string>;
  today: string;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-headline-sm text-primary">
        {title} <span className="text-text-muted font-normal">· {rows.length}</span>
      </h2>
      <ul className="mt-2 grid gap-2 md:grid-cols-2">
        {rows.map(({ visit, seenCount, fee }) => {
          // A planned visit whose date has gone by either happened and was
          // never recorded, or did not happen and was never rebooked. Both need
          // a person, so the row says so rather than sitting quietly in a list.
          const overdue = visit.status === "planned" && visit.date < today;
          const days = daysBetween(today, visit.date);

          return (
            <li key={visit.id}>
              <Link
                to={`/visits/${visit.id}`}
                className={`card p-4 h-full block ${overdue ? "border-l-4 border-alert" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-body-lg font-semibold truncate">
                    {(visit.vet_id && vetName.get(visit.vet_id)) || "Vet not recorded"}
                  </p>
                  <span className="data-label shrink-0">{formatDate(visit.date)}</span>
                </div>

                {visit.status === "planned" && (
                  <p className="mt-1">
                    <span
                      className={`chip ${
                        overdue ? "bg-alert-bg text-alert-text" : "bg-action text-action-text"
                      }`}
                    >
                      {overdue
                        ? `${-days} ${plural(-days, "day")} ago, still planned`
                        : days === 0
                          ? "Planned for today"
                          : `Planned, in ${days} ${plural(days, "day")}`}
                    </span>
                  </p>
                )}

                {visit.reason && (
                  <p className="text-body-md text-text-muted mt-1 truncate">{visit.reason}</p>
                )}

                <p className="text-body-md text-text-muted mt-2">
                  {seenCount} {plural(seenCount, "animal")} seen
                  {fee > 0 ? ` · ${formatUGX(fee)} call-out` : " · no call-out fee"}
                </p>

                {/* SPEC 14.3 — a fee with nobody attached is money that reaches
                    no animal. Said here rather than only on the Money screen,
                    because this is where it can be fixed. */}
                {fee > 0 && seenCount === 0 && (
                  <p className="mt-2 flex items-start gap-2 text-body-md text-alert-text">
                    <WarningIcon className="w-5 h-5 shrink-0" />
                    Nobody is attached, so this fee is not charged to any animal.
                  </p>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Create a visit.
 *
 * The status choice is the whole shape of the screen, so it is first and it is
 * words rather than a checkbox: "the vet came out" and "the vet is coming" are
 * two different things to be recording, and the date rules differ between them.
 */
function NewVisitDialog({ vets, onClose }: { vets: Vet[]; onClose: () => void }) {
  const today = todayInEAT();
  const [status, setStatus] = useState<VisitStatus>("completed");
  const [date, setDate] = useState(today);
  const [vetId, setVetId] = useState("");
  const [fee, setFee] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const liveVets = vets.filter((v) => !v.deleted_at);

  async function save() {
    // SPEC 14.2 — a planned visit "may be in the future"; a completed one is
    // something that has happened, so SPEC 6.8's no-future-dates rule applies.
    if (status === "completed" && date > today) {
      return setError("A completed visit cannot be dated in the future. Plan it instead.");
    }

    const shillings = fee.trim() === "" ? null : Number(fee.replace(/[,\s]/g, ""));
    if (shillings !== null && (!Number.isFinite(shillings) || shillings < 0)) {
      return setError("A call-out fee must be a whole number of shillings, or left blank.");
    }

    await createVetVisit({
      date,
      status,
      vet_id: vetId || null,
      call_out_fee: shillings === null ? null : Math.round(shillings),
      reason: reason || null,
      notes: notes || null,
    });
    onClose();
  }

  return (
    <Dialog label="Add a visit" onClose={onClose}>
      <h2 className="text-headline-sm text-primary">Add a visit</h2>

      <fieldset className="mt-4">
        <legend className="data-label mb-2">Which is this?</legend>
        <div className="flex flex-col gap-2">
          <Choice
            active={status === "completed"}
            onClick={() => {
              setStatus("completed");
              if (date > today) setDate(today);
            }}
            title="The vet came out"
            detail="Record what happened, and add treatments to it."
          />
          <Choice
            active={status === "planned"}
            onClick={() => setStatus("planned")}
            title="The vet is coming"
            detail="A planned visit. It appears on the Calendar and in Alerts as it approaches."
          />
        </div>
      </fieldset>

      <Labelled label="Date" htmlFor="vv-date">
        <input
          id="vv-date" type="date" className="field font-mono" value={date}
          // Only a completed visit is capped at today.
          max={status === "completed" ? today : undefined}
          onChange={(e) => setDate(e.target.value)}
        />
      </Labelled>

      <Labelled label="Vet" htmlFor="vv-vet" hint="Leave blank if it is not decided yet.">
        <select
          id="vv-vet" className="field" value={vetId}
          onChange={(e) => setVetId(e.target.value)}
        >
          <option value="">Not recorded</option>
          {liveVets.map((vet) => (
            <option key={vet.id} value={vet.id}>
              {vet.name}
            </option>
          ))}
        </select>
      </Labelled>
      {liveVets.length === 0 && (
        <p className="text-body-md text-text-muted mt-1">
          No vets saved yet.{" "}
          <Link to="/vets" className="text-primary font-semibold underline">
            Add one
          </Link>
          .
        </p>
      )}

      <Labelled
        label="Call-out fee (UGX)"
        htmlFor="vv-fee"
        hint="The fee for the journey, split evenly across the animals seen. Treatment costs are recorded separately, on each treatment."
      >
        <input
          id="vv-fee" className="field font-mono" value={fee} inputMode="numeric"
          onChange={(e) => setFee(e.target.value)}
        />
      </Labelled>

      <Labelled label="Reason" htmlFor="vv-reason">
        <input
          id="vv-reason" className="field" value={reason} placeholder="Calf not feeding"
          onChange={(e) => setReason(e.target.value)}
        />
      </Labelled>

      <Labelled
        label="Notes"
        htmlFor="vv-notes"
        hint="What the vet said, including advice about animals that were not treated."
      >
        <textarea
          id="vv-notes" className="field h-auto py-3" rows={3} value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Labelled>

      {error && <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>}

      <div className="mt-6 flex gap-3">
        <button type="button" className="btn-quiet flex-1" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-secondary flex-1" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

export function Choice({
  active,
  onClick,
  title,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`text-left rounded-lg border p-3 min-h-touch ${
        active
          ? "bg-primary-container text-white border-primary-container"
          : "bg-card text-text border-border"
      }`}
    >
      <span className="block text-body-lg font-semibold">{title}</span>
      <span className={`block text-body-md ${active ? "text-white/80" : "text-text-muted"}`}>
        {detail}
      </span>
    </button>
  );
}

export function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-4 sm:p-6 max-h-[92vh] overflow-y-auto"
        role="dialog"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function Labelled({
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
    <div className="mt-4">
      <label className="data-label block mb-1" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
