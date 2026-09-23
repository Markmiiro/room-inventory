import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { MoveIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { updateRecord, type RecordEdit } from "../db/mutations";
import {
  activeRecords,
  allSchedules,
  birthsForDam,
  childRecords,
  healthForRecord,
  liveRooms,
  movesForRecord,
  offspringOf,
  visitNotesForRecord,
} from "../db/queries";
import { db } from "../db/schema";
import type {
  Birth,
  HealthRecord,
  Move,
  MoveReason,
  Record_,
  Room,
  Sex,
  TreatmentSchedule,
  Vet,
  VetVisit,
  VisitNote,
} from "../db/types";
import { AGE_UNKNOWN_CHIP, AGE_UNKNOWN_DETAIL, isAgeUnknown } from "../domain/age";
import { canBeDam, describeOffspringParts, offspringTotal } from "../domain/births";
import { formatDate, formatUGX, headUnit, plural } from "../domain/format";
import { typeLabel, withdrawalEnd } from "../domain/alerts";
import { scheduleDueItems, type DueItem } from "../domain/schedules";
import { findTagClash, speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

const REASON_LABEL: Record<MoveReason, string> = {
  routine: "Routine",
  weaning: "Weaning",
  sick: "Sick",
  isolation: "Isolation",
  new_arrival: "New arrival",
  breeding: "Breeding",
};

const SOURCE_LABEL = {
  born_here: "Born here",
  bought: "Bought",
  gift: "Gift",
} as const;

const STATUS_CHIP = {
  active: "bg-success text-success-text",
  sold: "bg-primary-container text-white",
  dead: "bg-alert-bg text-alert-text",
} as const;

/**
 * Record detail — everything known about one animal or group, and the way to
 * act on it.
 *
 * The mockup carries three tabs: History, Health and Money. Only History has
 * data behind it in this slice. HealthRecord, Purchase and Expense do not exist
 * yet, and a tab that opens onto an empty panel reads as "nothing has happened
 * to this animal" rather than "this is not built" — on a health record that is
 * a dangerous thing to imply. So the two are named as missing instead of drawn
 * empty, the same call TOKENS.md makes about species icons.
 */
export function RecordDetailScreen() {
  const { recordId = "" } = useParams();

  // Dexie answers `undefined` both while the query is in flight and when the
  // row does not exist. Collapsing the two would render a blank screen forever
  // for a record that is genuinely gone, so a miss is mapped to null and
  // `undefined` is left to mean "still loading".
  const record = useLiveQuery(
    () => db.records.get(recordId).then((found) => found ?? null),
    [recordId],
    undefined,
  );
  const moves = useLiveQuery(() => movesForRecord(recordId), [recordId], [] as Move[]);
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const children = useLiveQuery(() => childRecords(recordId), [recordId], [] as Record_[]);
  const health = useLiveQuery(() => healthForRecord(recordId), [recordId], [] as HealthRecord[]);
  const schedules = useLiveQuery(allSchedules, [], [] as TreatmentSchedule[]);
  // SPEC 14.5 — this record's observations, and the visits behind its
  // treatments so each can be shown with the vet's name.
  const visitNotes = useLiveQuery(
    () => visitNotesForRecord(recordId),
    [recordId],
    [] as VisitNote[],
  );
  const visits = useLiveQuery(() => db.vetVisits.toArray(), [], [] as VetVisit[]);
  const vets = useLiveQuery(() => db.vets.toArray(), [], [] as Vet[]);
  const parent = useLiveQuery(
    () => (record?.parent_record_id ? db.records.get(record.parent_record_id) : undefined),
    [record?.parent_record_id],
    undefined,
  );
  // SPEC 22 — her births, her offspring, and her own parents.
  const births = useLiveQuery(() => birthsForDam(recordId), [recordId], [] as Birth[]);
  const offspring = useLiveQuery(() => offspringOf(recordId), [recordId], [] as Record_[]);
  const dam = useLiveQuery(
    () => (record?.dam_record_id ? db.records.get(record.dam_record_id) : undefined),
    [record?.dam_record_id],
    undefined,
  );
  const sire = useLiveQuery(
    () => (record?.sire_record_id ? db.records.get(record.sire_record_id) : undefined),
    [record?.sire_record_id],
    undefined,
  );
  const birth = useLiveQuery(
    () => (record?.birth_id ? db.births.get(record.birth_id) : undefined),
    [record?.birth_id],
    undefined,
  );

  const [editing, setEditing] = useState(false);

  if (record === undefined) return null;
  if (!record || record.deleted_at) {
    return (
      <div className="card p-6 text-center">
        <p className="text-headline-sm text-primary">This record is no longer here.</p>
        <Link to="/" className="btn-secondary mt-4 inline-flex">
          Back to Rooms
        </Link>
      </div>
    );
  }

  const roomOf = (id: string | null) => rooms.find((room) => room.id === id) ?? null;
  const room = roomOf(record.current_room_id);
  const isGroup = record.kind === "group";

  return (
    <div className="pb-24 md:pb-8">
      <section className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="data-value text-headline-sm font-bold text-primary truncate">{record.tag}</p>
            <p className="text-body-md text-text-muted">
              {speciesLabel(record.species)} · {isGroup ? "Group" : "Single animal"}
            </p>
          </div>
          <span className={`chip shrink-0 ${STATUS_CHIP[record.status]}`}>{record.status}</span>
        </div>

        {/* SPEC 13.4 — in words, on the record itself. Without this the record
            simply never appears on a due list, and nothing on screen explains
            why. */}
        {record.status === "active" && isAgeUnknown(record) && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">
            <span className="font-semibold">{AGE_UNKNOWN_CHIP}</span>
            <br />
            {AGE_UNKNOWN_DETAIL} Add {record.kind === "animal" ? "a date of birth" : "an arrival date"}{" "}
            with Edit below.
          </p>
        )}

        <div className="mt-4 flex items-baseline gap-2">
          <p className="data-value text-headline-sm font-bold">{record.head_count}</p>
          <p className="text-body-md text-text-muted">
            {headUnit(record.head_count)} in this record
          </p>
        </div>
        {isGroup && record.head_count !== record.initial_head_count && (
          <p className="data-label mt-1">Started at {record.initial_head_count}</p>
        )}

        {room ? (
          <Link
            to={`/rooms/${room.id}`}
            className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-primary p-3 min-h-touch"
          >
            <span className="data-label">Room</span>
            <span className="data-value font-bold text-primary truncate">
              {room.code} · {room.name}
            </span>
          </Link>
        ) : (
          <p className="mt-4 flex items-center gap-2 rounded-lg bg-alert-bg text-alert-text p-3 text-body-md">
            <WarningIcon className="w-5 h-5 shrink-0" />
            Not in a room yet. Move it to place it.
          </p>
        )}

        {/* SPEC 6.2 — on a sold or dead record these are hidden, not disabled. */}
        {record.status === "active" && (
          <>
            <Link to={`/move?record=${record.id}`} className="btn-action mt-4 w-full">
              <MoveIcon className="w-6 h-6" />
              Move
            </Link>
            <div className="mt-3 flex gap-3">
              <Link to={`/sell?record=${record.id}`} className="btn-secondary flex-1 px-3">
                Sell
              </Link>
              <Link to={`/death?record=${record.id}`} className="btn-quiet flex-1 px-3">
                Log death
              </Link>
            </div>
            {/* SPEC 22 — offered on female animals and on groups, which is
                where a hatch is recorded. A male is not offered it: he did not
                give birth, and the useful thing to do with a sire is name him
                on the birth itself. */}
            {canBeDam(record) && (
              <Link to={`/birth?record=${record.id}`} className="btn-secondary w-full mt-3">
                Log birth
              </Link>
            )}
          </>
        )}
      </section>

      <div className="mt-4 flex items-center justify-between gap-3">
        <h2 className="text-headline-sm text-primary">Details</h2>
        <button type="button" className="btn-quiet" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Fact label="Species" value={speciesLabel(record.species)} />
        <Fact label="Breed" value={record.breed} />
        {isGroup ? (
          <Fact label="Arrived" value={record.arrival_date && formatDate(record.arrival_date)} />
        ) : (
          <>
            <Fact label="Sex" value={record.sex === "male" ? "Male" : record.sex ? "Female" : null} />
            <Fact label="Date of birth" value={record.date_of_birth && formatDate(record.date_of_birth)} />
            {/* Shown for an animal as well as a group. It is when this animal
                joined the farm, not how old it is — an animal's age comes from
                its date of birth alone (SPEC 13.3). */}
            <Fact label="Arrived" value={record.arrival_date && formatDate(record.arrival_date)} />
          </>
        )}
        <Fact label="Source" value={SOURCE_LABEL[record.source]} />
        {!isGroup && <OffspringFact record={record} births={births} />}
      </dl>

      {record.notes && (
        <section className="card p-4 mt-2">
          <p className="data-label">Notes</p>
          <p className="text-body-md mt-1 whitespace-pre-wrap">{record.notes}</p>
        </section>
      )}

      {(parent || children.length > 0) && (
        <section className="card p-4 mt-2">
          <p className="data-label">Split history</p>
          {parent && (
            <p className="text-body-md mt-2">
              Split from{" "}
              <Link to={`/records/${parent.id}`} className="data-value font-bold text-primary underline">
                {parent.tag}
              </Link>
            </p>
          )}
          {children.length > 0 && (
            <p className="text-body-md mt-2">
              Split into{" "}
              {children.map((child, index) => (
                <span key={child.id}>
                  {index > 0 && ", "}
                  <Link to={`/records/${child.id}`} className="data-value font-bold text-primary underline">
                    {child.tag}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </section>
      )}

      {/* SPEC 22 — where this animal came from, tappable. */}
      {/* Only once something has actually been read back. Gating on
          `record.birth_id` instead rendered an empty card headed "Born here"
          while the mother was still being fetched — and permanently, for an
          offspring whose dam has since been deleted. */}
      {(dam || sire || birth) && (
        <section className="card p-4 mt-2">
          <p className="data-label">Born here</p>
          {dam && (
            <p className="text-body-md mt-2">
              Mother{" "}
              <Link to={`/records/${dam.id}`} className="data-value font-bold text-primary underline">
                {dam.tag}
              </Link>
            </p>
          )}
          {sire ? (
            <p className="text-body-md mt-2">
              Father{" "}
              <Link to={`/records/${sire.id}`} className="data-value font-bold text-primary underline">
                {sire.tag}
              </Link>
            </p>
          ) : (
            birth?.sire_name && (
              // An outside sire is free text and has no record to open.
              <p className="text-body-md mt-2">Father {birth.sire_name} — not a record on this farm</p>
            )
          )}
          {birth && (
            <p className="data-label mt-2">
              Born {formatDate(birth.date)}
              {birth.born_count > 1 &&
                ` · one of ${birth.born_count}, ${birth.surviving_count} surviving`}
            </p>
          )}
        </section>
      )}

      {/* SPEC 22 — her offspring, each tappable. Sold and dead ones included:
          they are still hers, and leaving them out would disagree with the
          total shown above. */}
      {offspring.length > 0 && (
        <section className="mt-4">
          <h2 className="text-headline-sm text-primary">
            Offspring
            <span className="text-text-muted font-normal"> · {offspring.length}</span>
          </h2>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {offspring.map((child) => (
              <li key={child.id}>
                <Link to={`/records/${child.id}`} className="card block p-4 min-h-row">
                  <div className="flex items-center justify-between gap-3">
                    <p className="data-value font-bold truncate">{child.tag}</p>
                    <span className={`chip shrink-0 ${STATUS_CHIP[child.status]}`}>
                      {child.status}
                    </span>
                  </div>
                  <p className="text-body-md text-text-muted mt-1">
                    {child.kind === "group"
                      ? `Group · ${child.head_count} ${headUnit(child.head_count)}`
                      : child.sex === "male"
                        ? "Male"
                        : child.sex === "female"
                          ? "Female"
                          : "Sex not recorded"}
                    {child.date_of_birth ? ` · born ${formatDate(child.date_of_birth)}` : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="text-headline-sm text-primary mt-6">
        History
        {moves.length > 0 && <span className="text-text-muted font-normal"> · {moves.length}</span>}
      </h2>

      {moves.length === 0 ? (
        <p className="card p-6 mt-3 text-body-md text-text-muted text-center">
          No moves recorded yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {moves.map((move) => {
            const from = roomOf(move.from_room_id);
            const to = roomOf(move.to_room_id);
            return (
              <li key={move.id} className="card p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="data-value font-bold truncate">
                    {/* An initial placement has no origin (SPEC 3.5). */}
                    {from ? `${from.code} → ` : "Placed in "}
                    {to?.code ?? "an unknown room"}
                  </p>
                  <span className="data-label shrink-0">{formatDate(move.date)}</span>
                </div>
                <p className="text-body-md text-text-muted mt-1">
                  {REASON_LABEL[move.reason]}
                  {isGroup && ` · ${move.count} ${headUnit(move.count)}`}
                </p>
                {move.note && <p className="text-body-md mt-2 whitespace-pre-wrap">{move.note}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <h2 className="text-headline-sm text-primary">
          Health
          {health.length + visitNotes.length > 0 && (
            <span className="text-text-muted font-normal">
              {" "}
              · {health.length + visitNotes.length}
            </span>
          )}
        </h2>
        <Link to="/health" className="btn-quiet">
          Log treatment
        </Link>
      </div>

      {/* SPEC 13.6 — what this record is due for, before what it has had. What
          is coming is the actionable half; the history below is the record. */}
      <UpcomingSection record={record} schedules={schedules} health={health} />

      {/* SPEC 14.5 — treatments and the vet's observations in one history,
          ordered by date. They are two different things and are drawn
          differently, but they happened to the same animal on the same
          timeline, and splitting them into two lists would hide that the vet
          who looked at this animal in March is the one who treated it in May. */}
      {health.length === 0 && visitNotes.length === 0 ? (
        <p className="card p-6 mt-3 text-body-md text-text-muted text-center">
          Nothing has been given to {record.tag} yet, and no vet has noted anything
          about it.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {healthTimeline(health, visitNotes, visits).map((entry) => (
            <li key={entry.key}>
              {entry.kind === "treatment" ? (
                <TreatmentRow
                  treatment={entry.treatment}
                  visit={entry.visit}
                  vets={vets}
                />
              ) : (
                <ObservationRow note={entry.note} visit={entry.visit} vets={vets} />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="card p-4 mt-6 text-body-md text-text-muted">
        This record&rsquo;s estimated profit is on the{" "}
        <Link to="/money" className="text-primary font-semibold underline">
          Money summary
        </Link>
        . It is an estimate: an expense belongs to a room or to the whole farm, so
        each record only carries a share of one, worked out from how long it was
        there.
      </p>

      {editing && <EditRecordDialog record={record} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TreatmentRow({
  treatment,
  visit,
  vets,
}: {
  treatment: HealthRecord;
  visit: VetVisit | null;
  vets: Vet[];
}) {
  const today = todayInEAT();
  const end = withdrawalEnd(treatment);
  const overdue = treatment.next_due !== null && treatment.next_due < today;
  // The vet named on the visit, falling back to the one named on the treatment
  // itself for a dose given without a visit.
  const vetId = visit?.vet_id ?? treatment.vet_id;
  const vetName = vets.find((v) => v.id === vetId)?.name ?? null;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body-lg font-semibold truncate">
          {treatment.product ?? typeLabel(treatment.type)}
        </p>
        <span className="data-label shrink-0">{formatDate(treatment.date)}</span>
      </div>

      {/* SPEC 14.5 — a visit-linked treatment shows the vet's name, so a dose
          somebody gave themselves and one a vet gave are told apart. */}
      {visit && (
        <p className="text-body-md mt-1">
          <Link to={`/visits/${visit.id}`} className="text-primary font-semibold underline">
            {vetName ? `${vetName}'s visit` : "Vet visit"}
          </Link>
        </p>
      )}
      <p className="text-body-md text-text-muted mt-1">
        {typeLabel(treatment.type)}
        {treatment.dose ? ` · ${treatment.dose}` : ""}
        {treatment.cost != null ? ` · ${formatUGX(treatment.cost)}` : ""}
      </p>
      {treatment.next_due && (
        <p className={`text-body-md mt-1 ${overdue ? "text-alert font-semibold" : "text-text-muted"}`}>
          {overdue ? "Was due" : "Next due"} {formatDate(treatment.next_due)}
        </p>
      )}
      {end && end >= today && (
        <p className="mt-2 rounded-lg bg-alert-bg text-alert-text text-body-md p-2">
          Withdrawal until {formatDate(end)}. Selling before then needs confirming.
        </p>
      )}
      {treatment.notes && <p className="text-body-md mt-2 whitespace-pre-wrap">{treatment.notes}</p>}
    </div>
  );
}

/**
 * SPEC 22 — the offspring figure, as a total and what it is made of.
 *
 * Full width rather than half, because the breakdown is a sentence and a
 * sentence in a half-width mono cell wraps into something nobody reads. The
 * total gets the weight; the line under it says where each part came from,
 * since the two halves have different origins and one of them is somebody's
 * memory. Summing them silently would make that half unfalsifiable.
 */
function OffspringFact({ record, births }: { record: Record_; births: Birth[] }) {
  const count = offspringTotal(record, births);
  const parts = describeOffspringParts(
    count,
    record.offspring_baseline_updated_at
      ? formatDate(record.offspring_baseline_updated_at)
      : null,
  );

  return (
    <div className="card p-3 col-span-2">
      {/* SPEC 3.4 — offspring is meaningful for females; on a male it is what
          he sired, which is a different number and needs saying. */}
      <dt className="data-label">{record.sex === "male" ? "Offspring sired" : "Offspring"}</dt>
      <dd className="mt-1">
        {parts === null ? (
          <span className="data-value text-text-muted">Not recorded</span>
        ) : (
          <>
            <span className="data-value font-bold">{count.total}</span>
            <span className="block text-body-md text-text-muted mt-0.5">{parts}</span>
          </>
        )}
      </dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="card p-3">
      <dt className="data-label">{label}</dt>
      <dd className="data-value mt-1 break-words">
        {value === null || value === undefined || value === "" ? (
          <span className="text-text-muted">Not recorded</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/**
 * The hand-typed fields.
 *
 * Head count is not among them and cannot be: it is derived from sales, deaths
 * and splits on the server (SPEC 6.7). Nor is the room — that is a move, which
 * has its own screen and leaves a history behind it.
 */
function EditRecordDialog({ record, onClose }: { record: Record_; onClose: () => void }) {
  const isGroup = record.kind === "group";
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const others = useLiveQuery(activeRecords, [], [] as Record_[]);

  const [tag, setTag] = useState(record.tag);
  const [breed, setBreed] = useState(record.breed ?? "");
  const [sex, setSex] = useState<Sex>(record.sex ?? "female");
  const [dob, setDob] = useState(record.date_of_birth ?? "");
  const [arrival, setArrival] = useState(record.arrival_date ?? "");
  const [offspring, setOffspring] = useState(
    record.offspring_baseline === null ? "" : String(record.offspring_baseline),
  );
  const [notes, setNotes] = useState(record.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = tag.trim();
    if (!trimmed) return setError("Every record needs a tag or a group name.");

    // SPEC 6.5 — the record's own tag is excluded, or renaming it to itself
    // would clash with itself.
    const clash = findTagClash(trimmed, others, rooms, record.id);
    if (clash) {
      return setError(
        clash.roomCode
          ? `This tag is already used by an animal in ${clash.roomCode}.`
          : "This tag is already used by another active record.",
      );
    }

    const today = todayInEAT();
    if (dob && dob > today) return setError("A date of birth cannot be in the future.");
    if (arrival && arrival > today) return setError("An arrival cannot be dated in the future.");

    let offspringCount: number | null = null;
    if (offspring.trim() !== "") {
      offspringCount = Number(offspring);
      if (!Number.isInteger(offspringCount) || offspringCount < 0) {
        return setError("Offspring must be a whole number, or left blank.");
      }
    }

    const changes: RecordEdit = {
      tag: trimmed,
      breed: breed.trim() || null,
      notes: notes.trim() || null,
    };
    // Arrival applies to both kinds. For a group it is also what its age is
    // counted from; for an animal it is only a record of when it got here.
    changes.arrival_date = arrival || null;
    if (!isGroup) {
      changes.sex = sex;
      changes.date_of_birth = dob || null;
      changes.offspring_baseline = offspringCount;
    }

    await updateRecord(record.id, changes);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto">
      <div
        className="card w-full max-w-lg p-4 sm:p-6 max-h-[92vh] overflow-y-auto"
        role="dialog"
        aria-label="Edit record"
      >
        <h2 className="text-headline-sm text-primary">Edit {record.tag}</h2>

        <label className="data-label block mt-4 mb-1" htmlFor="edit-tag">
          {isGroup ? "Group name" : "Tag"}
        </label>
        <input
          id="edit-tag" className="field font-mono" value={tag}
          onChange={(e) => setTag(e.target.value)}
        />

        <label className="data-label block mt-4 mb-1" htmlFor="edit-breed">Breed</label>
        <input
          id="edit-breed" className="field" value={breed}
          onChange={(e) => setBreed(e.target.value)} placeholder="Friesian"
        />

        <label className="data-label block mt-4 mb-1" htmlFor="edit-arrival">Arrived</label>
        <input
          id="edit-arrival" type="date" className="field font-mono" value={arrival}
          max={todayInEAT()} onChange={(e) => setArrival(e.target.value)}
        />

        {!isGroup && (
          <>
            <fieldset className="mt-4">
              <legend className="data-label mb-2">Sex</legend>
              <div className="flex gap-2">
                {(["female", "male"] as Sex[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setSex(option)}
                    className={`flex-1 min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
                      sex === option
                        ? "bg-primary-container text-white border-primary-container"
                        : "bg-card text-text border-border"
                    }`}
                  >
                    {option === "female" ? "Female" : "Male"}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="data-label block mt-4 mb-1" htmlFor="edit-dob">Date of birth</label>
            <input
              id="edit-dob" type="date" className="field font-mono" value={dob}
              max={todayInEAT()} onChange={(e) => setDob(e.target.value)}
            />
            {/* SPEC 13.4 — the one field that decides whether this animal gets a
                treatment schedule at all, so the form says so rather than
                leaving it as another optional box. The arrival date above does
                not stand in for it: an animal bought at two years old arrived
                recently and is not new-born. */}
            <p className="text-body-md text-text-muted mt-1">
              {dob
                ? "Treatment schedules and sale readiness are worked out from this."
                : "Without this, no treatment schedule runs for this animal and no sale readiness is shown. The arrival date is not used instead — it says when it got here, not how old it is."}
            </p>

            <label className="data-label block mt-4 mb-1" htmlFor="edit-offspring">
              {sex === "male" ? "Offspring sired before records" : "Offspring before records"}
            </label>
            <input
              id="edit-offspring" className="field font-mono" value={offspring} inputMode="numeric"
              onChange={(e) => setOffspring(e.target.value)} placeholder="Leave blank if unknown"
            />
            {/* SPEC 22 — what this field is *now*. It used to be the only
                answer; recorded births are counted separately and added to it,
                and nothing the app does ever writes over what is typed here. */}
            <p className="text-body-md text-text-muted mt-1">
              What happened before births were recorded in the app. Typed by hand,
              never counted for you, and never changed by a birth — recorded
              births are counted separately and added to this.
            </p>
          </>
        )}

        <label className="data-label block mt-4 mb-1" htmlFor="edit-notes">Notes</label>
        <textarea
          id="edit-notes" className="field h-auto py-3" rows={3} value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-quiet flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-secondary flex-1" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * What this record is due for, from its schedules.
 *
 * Reads `scheduleDueItems` rather than working the dates out again, so a date
 * shown here is the same date Health and Alerts show. A record whose age is
 * unknown produces nothing, and says so — the chip at the top of the screen
 * carries the reason, so this only needs to explain the empty list.
 */
function UpcomingSection({
  record,
  schedules,
  health,
}: {
  record: Record_;
  schedules: TreatmentSchedule[];
  health: HealthRecord[];
}) {
  const today = todayInEAT();
  const items: DueItem[] = scheduleDueItems({
    records: [record],
    schedules,
    health,
    today,
  });

  if (record.status !== "active") return null;

  if (items.length === 0) {
    return (
      <p className="card p-4 mt-3 text-body-md text-text-muted">
        {isAgeUnknown(record)
          ? "Nothing is scheduled, because this record has no age to count from."
          : "No schedule currently applies to this record."}
      </p>
    );
  }

  return (
    <section className="mt-3">
      <p className="data-label">Upcoming</p>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id} className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-body-lg font-semibold truncate">
                {item.schedule.default_product ?? item.schedule.name}
              </p>
              <span
                className={`chip shrink-0 ${
                  item.days < 0
                    ? "bg-alert-bg text-alert-text"
                    : "bg-background text-text-muted border border-border"
                }`}
              >
                {item.days < 0
                  ? `${-item.days} ${plural(-item.days, "day")} overdue`
                  : item.days === 0
                    ? "Due today"
                    : `In ${item.days} ${plural(item.days, "day")}`}
              </span>
            </div>
            <p className="text-body-md text-text-muted mt-1">
              {typeLabel(item.schedule.type)} · {formatDate(item.dueDate)}
            </p>
            <p className="data-label mt-1">
              From {item.schedule.name}
              {item.lastGiven
                ? ` · counted from the dose given ${formatDate(item.lastGiven.date)}`
                : " · first dose, counted from birth or arrival"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}


/**
 * SPEC 14.4 — an observation, drawn so it cannot be read as a treatment.
 *
 * "The vet looked at this one and said watch it" is a real event in an animal's
 * health history, and it is emphatically not a dose. Nothing was given, so
 * there is no product, no withdrawal and no next due — and the row says
 * "looked at" rather than leaving those simply absent, which would read as a
 * treatment somebody forgot to fill in.
 */
function ObservationRow({
  note,
  visit,
  vets,
}: {
  note: VisitNote;
  visit: VetVisit | null;
  vets: Vet[];
}) {
  const vetName = vets.find((v) => v.id === visit?.vet_id)?.name ?? null;

  return (
    <div className="card border-l-4 border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 min-w-0">
          <span className="chip bg-background text-text-muted border border-border">looked at</span>
          <span className="text-body-md text-text-muted truncate">
            {vetName ? `${vetName} — nothing given` : "Nothing given"}
          </span>
        </p>
        {visit && <span className="data-label shrink-0">{formatDate(visit.date)}</span>}
      </div>
      <p className="text-body-md mt-2 whitespace-pre-wrap">{note.note}</p>
      {visit && (
        <Link
          to={`/visits/${visit.id}`}
          className="text-body-md font-semibold text-primary underline mt-2 inline-block"
        >
          Open the visit
        </Link>
      )}
    </div>
  );
}

type TimelineEntry =
  | { kind: "treatment"; key: string; date: string; treatment: HealthRecord; visit: VetVisit | null }
  | { kind: "observation"; key: string; date: string; note: VisitNote; visit: VetVisit | null };

/**
 * Treatments and observations on one timeline, newest first.
 *
 * A note carries no date of its own — it belongs to a visit, and the visit's
 * date is the day it happened. A note whose visit is missing falls back to when
 * it was written, so it still lands somewhere sensible rather than at the epoch.
 */
function healthTimeline(
  health: HealthRecord[],
  notes: VisitNote[],
  visits: VetVisit[],
): TimelineEntry[] {
  const visitById = new Map(visits.filter((v) => !v.deleted_at).map((v) => [v.id, v]));

  const entries: TimelineEntry[] = [
    ...health.map((treatment) => ({
      kind: "treatment" as const,
      key: `t:${treatment.id}`,
      date: treatment.date,
      treatment,
      visit: treatment.visit_id ? visitById.get(treatment.visit_id) ?? null : null,
    })),
    ...notes.map((note) => {
      const visit = visitById.get(note.visit_id) ?? null;
      return {
        kind: "observation" as const,
        key: `n:${note.id}`,
        date: visit?.date ?? note.created_at.slice(0, 10),
        note,
        visit,
      };
    }),
  ];

  return entries.sort((a, b) =>
    a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date),
  );
}
