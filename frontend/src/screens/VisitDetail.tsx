import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { CheckIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { recordHealth, recordVisitNote, updateVetVisit } from "../db/mutations";
import { activeRecords, allHealth, allVisitNotes } from "../db/queries";
import { db } from "../db/schema";
import type {
  HealthRecord,
  HealthType,
  Record_,
  Vet,
  VetVisit,
  VisitNote,
} from "../db/types";
import { typeLabel } from "../domain/alerts";
import { formatDate, formatUGX, plural } from "../domain/format";
import { recordsSeen, splitCallOutFee } from "../domain/visits";
import { useLiveQuery } from "../sync/useSync";
import { Choice, Dialog, Labelled } from "./VetVisits";

const TYPES: HealthType[] = ["vaccination", "deworming", "treatment", "vitamin", "other"];

/**
 * Visit detail — SPEC 14.5.
 *
 * "The vet, date, reason, fee, notes, and the list of animals seen. Add a
 * treatment or a note against any animal from here. One yellow button: Add
 * treatment."
 *
 * The screen's real job is the distinction in SPEC 14.4: an animal the vet
 * looked at and an animal the vet treated are both *seen*, and both take a
 * share of the call-out fee, but only one of them had a product go into it.
 * Recording a look as a treatment would put a dose in a health record that
 * never happened, which on a withdrawal period is a genuinely dangerous lie.
 * So the two are separate actions here, and read differently in the list.
 */
export function VisitDetailScreen() {
  const { visitId = "" } = useParams();

  const visit = useLiveQuery(
    () => db.vetVisits.get(visitId).then((found) => found ?? null),
    [visitId],
    undefined,
  );
  const records = useLiveQuery(activeRecords, [], [] as Record_[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);
  const notes = useLiveQuery(allVisitNotes, [], [] as VisitNote[]);
  const vets = useLiveQuery(() => db.vets.toArray(), [], [] as Vet[]);

  const [treating, setTreating] = useState(false);
  const [noting, setNoting] = useState(false);
  const [editing, setEditing] = useState(false);

  const split = useMemo(
    () => (visit ? splitCallOutFee({ visit, health, notes }) : null),
    [visit, health, notes],
  );

  if (visit === undefined) return null;
  if (!visit || visit.deleted_at) {
    return (
      <div className="card p-6 text-center">
        <p className="text-headline-sm text-primary">This visit is no longer here.</p>
        <Link to="/visits" className="btn-secondary mt-4 inline-flex">
          Back to visits
        </Link>
      </div>
    );
  }

  const recordById = new Map(records.map((r) => [r.id, r]));
  const vetName = vets.find((v) => v.id === visit.vet_id)?.name ?? null;
  const seen = recordsSeen({ visit, health, notes });
  const visitHealth = health.filter((h) => h.visit_id === visit.id && !h.deleted_at);
  const visitNotes = notes.filter((n) => n.visit_id === visit.id && !n.deleted_at);
  const today = todayInEAT();
  const planned = visit.status === "planned";

  return (
    <div className="pb-24 md:pb-8">
      <section className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="data-value text-headline-sm font-bold text-primary truncate">
              {vetName ?? "Vet not recorded"}
            </p>
            <p className="text-body-md text-text-muted">{formatDate(visit.date)}</p>
          </div>
          <span
            className={`chip shrink-0 ${
              planned ? "bg-action text-action-text" : "bg-success text-success-text"
            }`}
          >
            {planned ? "planned" : "completed"}
          </span>
        </div>

        {planned && visit.date < today && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">
            <WarningIcon className="w-5 h-5 shrink-0" />
            This was planned for {formatDate(visit.date)} and is still marked planned.
            If it happened, mark it completed so its fee counts.
          </p>
        )}

        {visit.reason && (
          <p className="text-body-md mt-3">
            <span className="data-label block">Reason</span>
            {visit.reason}
          </p>
        )}

        {/* SPEC 14.2 — "what the vet said, including advice about animals not
            treated". Shown in full rather than truncated: it is the part of a
            visit that is easiest to lose and hardest to reconstruct. */}
        {visit.notes && (
          <div className="mt-3">
            <span className="data-label block">What the vet said</span>
            <p className="text-body-md whitespace-pre-wrap">{visit.notes}</p>
          </div>
        )}

        <FeePanel visit={visit} split={split!} />

        {/* SPEC 14.5 — one yellow button. */}
        <button type="button" className="btn-action mt-4 w-full" onClick={() => setTreating(true)}>
          Add treatment
        </button>
        <div className="mt-3 flex gap-3">
          <button type="button" className="btn-secondary flex-1 px-3" onClick={() => setNoting(true)}>
            Add a note
          </button>
          <button type="button" className="btn-quiet flex-1 px-3" onClick={() => setEditing(true)}>
            Edit visit
          </button>
        </div>

        {planned && (
          <button
            type="button"
            className="btn-secondary w-full mt-3"
            onClick={() => void updateVetVisit(visit.id, { status: "completed" })}
          >
            <CheckIcon className="w-6 h-6" />
            Mark completed
          </button>
        )}
      </section>

      <h2 className="text-headline-sm text-primary mt-6">
        Animals seen
        {seen.length > 0 && <span className="text-text-muted font-normal"> · {seen.length}</span>}
      </h2>

      {seen.length === 0 ? (
        <p className="card p-6 mt-3 text-body-md text-text-muted text-center">
          Nobody is attached to this visit yet. Add a treatment, or a note for an
          animal the vet only looked at.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {seen.map((recordId) => (
            <li key={recordId} className="card p-4">
              <div className="flex items-center justify-between gap-3">
                <Link
                  to={`/records/${recordId}`}
                  className="data-value font-bold truncate underline"
                >
                  {recordById.get(recordId)?.tag ?? "A record"}
                </Link>
                {split!.perRecord.has(recordId) && (
                  <span className="data-label shrink-0">
                    {formatUGX(split!.perRecord.get(recordId)!)} of the call-out
                  </span>
                )}
              </div>

              {visitHealth
                .filter((h) => h.record_id === recordId)
                .map((treatment) => (
                  <p key={treatment.id} className="text-body-md mt-2">
                    <span className="chip bg-success text-success-text">treated</span>{" "}
                    {treatment.product ?? typeLabel(treatment.type)}
                    <span className="text-text-muted">
                      {" "}
                      · {typeLabel(treatment.type)}
                      {treatment.cost != null ? ` · ${formatUGX(treatment.cost)}` : ""}
                    </span>
                  </p>
                ))}

              {/* SPEC 14.4 — an observation, visually distinct from a
                  treatment, because it is not one. */}
              {visitNotes
                .filter((n) => n.record_id === recordId)
                .map((note) => (
                  <p key={note.id} className="text-body-md mt-2">
                    <span className="chip bg-background text-text-muted border border-border">
                      looked at
                    </span>{" "}
                    <span className="whitespace-pre-wrap">{note.note}</span>
                  </p>
                ))}
            </li>
          ))}
        </ul>
      )}

      {treating && (
        <AttachDialog
          kind="treatment"
          visit={visit}
          records={records}
          onClose={() => setTreating(false)}
        />
      )}
      {noting && (
        <AttachDialog kind="note" visit={visit} records={records} onClose={() => setNoting(false)} />
      )}
      {editing && <EditVisitDialog visit={visit} vets={vets} onClose={() => setEditing(false)} />}
    </div>
  );
}

/**
 * The fee, and who is carrying it.
 *
 * SPEC 14.3 — split evenly across the animals seen, and a visit with a fee but
 * no animals leaves it unallocated. The unallocated case is stated in words
 * because it is the one that makes the Money summary's totals stop tying out,
 * and a number that silently reaches nobody is worse than one that says so.
 */
function FeePanel({
  visit,
  split,
}: {
  visit: VetVisit;
  split: ReturnType<typeof splitCallOutFee>;
}) {
  if (!visit.call_out_fee) {
    return <p className="data-label mt-4">No call-out fee recorded</p>;
  }

  return (
    <div className="mt-4 rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="data-label">Call-out fee</span>
        <span className="data-value font-bold">{formatUGX(split.total)}</span>
      </div>
      {split.seenCount > 0 ? (
        <p className="text-body-md text-text-muted mt-1">
          Split evenly across {split.seenCount} {plural(split.seenCount, "animal")} seen —{" "}
          about {formatUGX(Math.floor(split.total / split.seenCount))} each. Paid per
          journey, so it is not spread by how long each animal has been here.
        </p>
      ) : (
        <p className="text-body-md text-alert-text mt-1">
          Nobody is attached to this visit, so none of this fee is charged to an
          animal. It still counts in the farm total.
        </p>
      )}
      {visit.status === "planned" && (
        <p className="text-body-md text-text-muted mt-1">
          The visit is still planned, so this fee is not counted anywhere yet.
        </p>
      )}
    </div>
  );
}

/**
 * Attach a record to this visit, as a treatment or as an observation.
 *
 * One dialog for both because the first half — choosing the animal — is
 * identical, and because the choice between them is the thing worth making
 * obvious rather than hiding behind two separate entry points.
 */
function AttachDialog({
  kind,
  visit,
  records,
  onClose,
}: {
  kind: "treatment" | "note";
  visit: VetVisit;
  records: Record_[];
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record_ | null>(null);

  const [type, setType] = useState<HealthType>("treatment");
  const [product, setProduct] = useState("");
  const [dose, setDose] = useState("");
  const [cost, setCost] = useState("");
  const [withdrawal, setWithdrawal] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const matches = records
    .filter((r) => r.tag.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 50);

  async function save() {
    if (!picked) return;

    if (kind === "note") {
      if (!note.trim()) return setError("A note needs something in it.");
      await recordVisitNote({ visit_id: visit.id, record_id: picked.id, note });
      return onClose();
    }

    const days = withdrawal.trim() === "" ? null : Number(withdrawal);
    if (days !== null && (!Number.isInteger(days) || days < 0)) {
      return setError("Withdrawal must be a whole number of days, or left blank.");
    }
    const shillings = cost.trim() === "" ? null : Number(cost.replace(/[,\s]/g, ""));
    if (shillings !== null && (!Number.isFinite(shillings) || shillings < 0)) {
      return setError("A cost must be a whole number of shillings, or left blank.");
    }

    await recordHealth({
      record_id: picked.id,
      type,
      product: product || null,
      dose: dose || null,
      // The treatment happened on the day of the visit, not today: a visit
      // written up the next morning must not date its doses a day late.
      date: visit.date,
      withdrawal_days: days,
      cost: shillings,
      // SPEC 14.2 — what links the dose to the visit, and what counts this
      // animal as seen for the fee split.
      visit_id: visit.id,
      // Given during a visit rather than against a schedule's due item, so it
      // satisfies no schedule (SPEC 13.3).
      vet_id: visit.vet_id,
    });
    onClose();
  }

  return (
    <Dialog label={kind === "treatment" ? "Add a treatment" : "Add a note"} onClose={onClose}>
      <h2 className="text-headline-sm text-primary">
        {kind === "treatment" ? "Add a treatment" : "Add a note"}
      </h2>

      {!picked ? (
        <>
          <p className="text-body-md text-text-muted mt-2">
            {kind === "treatment"
              ? "Which animal was treated?"
              : "Which animal did the vet look at?"}
          </p>
          <input
            className="field mt-3"
            placeholder="Search by tag"
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="mt-3 flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
            {matches.map((record) => (
              <li key={record.id}>
                <button
                  type="button"
                  className="card w-full text-left p-3 min-h-row"
                  onClick={() => setPicked(record)}
                >
                  <span className="data-value font-bold">{record.tag}</span>
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="text-body-md text-text-muted p-3">Nothing matches that search.</li>
            )}
          </ul>
        </>
      ) : (
        <>
          <p className="text-body-md mt-2">
            <span className="data-value font-bold">{picked.tag}</span>{" "}
            <button
              type="button"
              className="text-primary font-semibold underline"
              onClick={() => setPicked(null)}
            >
              change
            </button>
          </p>

          {kind === "note" ? (
            <Labelled
              label="What the vet said"
              htmlFor="vn-note"
              hint="An observation, not a treatment. Nothing was given."
            >
              <textarea
                id="vn-note" className="field h-auto py-3" rows={3} value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Watch the front left leg for a week"
              />
            </Labelled>
          ) : (
            <>
              <fieldset className="mt-4">
                <legend className="data-label mb-2">Type</legend>
                <div className="flex flex-wrap gap-2">
                  {TYPES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setType(option)}
                      className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                        type === option
                          ? "bg-primary-container text-white border-primary-container"
                          : "bg-card text-text border-border"
                      }`}
                    >
                      {type === option && <CheckIcon className="w-4 h-4" />}
                      {typeLabel(option)}
                    </button>
                  ))}
                </div>
              </fieldset>

              <Labelled label="Product" htmlFor="vt-product">
                <input
                  id="vt-product" className="field" value={product}
                  onChange={(e) => setProduct(e.target.value)}
                />
              </Labelled>
              <Labelled label="Dose" htmlFor="vt-dose">
                <input
                  id="vt-dose" className="field" value={dose}
                  onChange={(e) => setDose(e.target.value)}
                />
              </Labelled>
              <Labelled
                label="Withdrawal (days)"
                htmlFor="vt-withdrawal"
                hint="Selling inside this period will warn, not block."
              >
                <input
                  id="vt-withdrawal" className="field font-mono" value={withdrawal}
                  inputMode="numeric" onChange={(e) => setWithdrawal(e.target.value)}
                />
              </Labelled>
              <Labelled
                label="Cost (UGX)"
                htmlFor="vt-cost"
                hint="What this treatment cost. The call-out fee is on the visit, not here."
              >
                <input
                  id="vt-cost" className="field font-mono" value={cost} inputMode="numeric"
                  onChange={(e) => setCost(e.target.value)}
                />
              </Labelled>
              <p className="text-body-md text-text-muted mt-3">
                Dated {formatDate(visit.date)}, the day of the visit.
              </p>
            </>
          )}
        </>
      )}

      {error && <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>}

      <div className="mt-6 flex gap-3">
        <button type="button" className="btn-quiet flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-secondary flex-1"
          disabled={!picked}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}

function EditVisitDialog({
  visit,
  vets,
  onClose,
}: {
  visit: VetVisit;
  vets: Vet[];
  onClose: () => void;
}) {
  const today = todayInEAT();
  const [status, setStatus] = useState(visit.status);
  const [date, setDate] = useState(visit.date);
  const [vetId, setVetId] = useState(visit.vet_id ?? "");
  const [fee, setFee] = useState(visit.call_out_fee == null ? "" : String(visit.call_out_fee));
  const [reason, setReason] = useState(visit.reason ?? "");
  const [notes, setNotes] = useState(visit.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (status === "completed" && date > today) {
      return setError("A completed visit cannot be dated in the future.");
    }
    const shillings = fee.trim() === "" ? null : Number(fee.replace(/[,\s]/g, ""));
    if (shillings !== null && (!Number.isFinite(shillings) || shillings < 0)) {
      return setError("A call-out fee must be a whole number of shillings, or left blank.");
    }

    await updateVetVisit(visit.id, {
      date,
      status,
      vet_id: vetId || null,
      call_out_fee: shillings === null ? null : Math.round(shillings),
      reason: reason.trim() || null,
      notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog label="Edit visit" onClose={onClose}>
      <h2 className="text-headline-sm text-primary">Edit visit</h2>

      <fieldset className="mt-4">
        <legend className="data-label mb-2">Status</legend>
        <div className="flex flex-col gap-2">
          <Choice
            active={status === "completed"}
            onClick={() => setStatus("completed")}
            title="Completed"
            detail="It happened. Its call-out fee counts."
          />
          <Choice
            active={status === "planned"}
            onClick={() => setStatus("planned")}
            title="Planned"
            detail="Still to happen. Nothing is counted yet."
          />
        </div>
      </fieldset>

      <Labelled label="Date" htmlFor="ev-date">
        <input
          id="ev-date" type="date" className="field font-mono" value={date}
          max={status === "completed" ? today : undefined}
          onChange={(e) => setDate(e.target.value)}
        />
      </Labelled>

      <Labelled label="Vet" htmlFor="ev-vet">
        <select id="ev-vet" className="field" value={vetId} onChange={(e) => setVetId(e.target.value)}>
          <option value="">Not recorded</option>
          {vets
            .filter((v) => !v.deleted_at)
            .map((vet) => (
              <option key={vet.id} value={vet.id}>
                {vet.name}
              </option>
            ))}
        </select>
      </Labelled>

      <Labelled label="Call-out fee (UGX)" htmlFor="ev-fee">
        <input
          id="ev-fee" className="field font-mono" value={fee} inputMode="numeric"
          onChange={(e) => setFee(e.target.value)}
        />
      </Labelled>

      <Labelled label="Reason" htmlFor="ev-reason">
        <input id="ev-reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Labelled>

      <Labelled label="What the vet said" htmlFor="ev-notes">
        <textarea
          id="ev-notes" className="field h-auto py-3" rows={3} value={notes}
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
