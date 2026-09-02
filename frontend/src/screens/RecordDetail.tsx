import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { MoveIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { updateRecord, type RecordEdit } from "../db/mutations";
import {
  activeRecords,
  allSchedules,
  childRecords,
  healthForRecord,
  liveRooms,
  movesForRecord,
} from "../db/queries";
import { db } from "../db/schema";
import type {
  HealthRecord,
  Move,
  MoveReason,
  Record_,
  Room,
  Sex,
  TreatmentSchedule,
} from "../db/types";
import { AGE_UNKNOWN_CHIP, AGE_UNKNOWN_DETAIL, isAgeUnknown } from "../domain/age";
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
  const parent = useLiveQuery(
    () => (record?.parent_record_id ? db.records.get(record.parent_record_id) : undefined),
    [record?.parent_record_id],
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
          </>
        )}
        <Fact label="Source" value={SOURCE_LABEL[record.source]} />
        {!isGroup && (
          <Fact
            // SPEC 3.4 — offspring is meaningful for females; on a male it is
            // what he sired, which is a different number and needs saying.
            label={record.sex === "male" ? "Offspring sired" : "Offspring"}
            value={
              record.offspring_count === null ? null : (
                <>
                  {record.offspring_count}{" "}
                  {record.offspring_updated_at && (
                    // Always beside the number, so a stale figure looks stale.
                    <span className="font-sans text-body-md text-text-muted">
                      (updated {formatDate(record.offspring_updated_at)})
                    </span>
                  )}
                </>
              )
            }
          />
        )}
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
          {health.length > 0 && <span className="text-text-muted font-normal"> · {health.length}</span>}
        </h2>
        <Link to="/health" className="btn-quiet">
          Log treatment
        </Link>
      </div>

      {/* SPEC 13.6 — what this record is due for, before what it has had. What
          is coming is the actionable half; the history below is the record. */}
      <UpcomingSection record={record} schedules={schedules} health={health} />

      {health.length === 0 ? (
        <p className="card p-6 mt-3 text-body-md text-text-muted text-center">
          Nothing has been given to {record.tag} yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {health.map((treatment) => (
            <li key={treatment.id}>
              <TreatmentRow treatment={treatment} />
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

function TreatmentRow({ treatment }: { treatment: HealthRecord }) {
  const today = todayInEAT();
  const end = withdrawalEnd(treatment);
  const overdue = treatment.next_due !== null && treatment.next_due < today;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body-lg font-semibold truncate">
          {treatment.product ?? typeLabel(treatment.type)}
        </p>
        <span className="data-label shrink-0">{formatDate(treatment.date)}</span>
      </div>

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
    record.offspring_count === null ? "" : String(record.offspring_count),
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
    if (isGroup) {
      changes.arrival_date = arrival || null;
    } else {
      changes.sex = sex;
      changes.date_of_birth = dob || null;
      changes.offspring_count = offspringCount;
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

        {isGroup ? (
          <>
            <label className="data-label block mt-4 mb-1" htmlFor="edit-arrival">Arrived</label>
            <input
              id="edit-arrival" type="date" className="field font-mono" value={arrival}
              max={todayInEAT()} onChange={(e) => setArrival(e.target.value)}
            />
          </>
        ) : (
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
            <label className="data-label block mt-4 mb-1" htmlFor="edit-offspring">
              {sex === "male" ? "Offspring sired" : "Offspring"}
            </label>
            <input
              id="edit-offspring" className="field font-mono" value={offspring} inputMode="numeric"
              onChange={(e) => setOffspring(e.target.value)} placeholder="Leave blank if unknown"
            />
            <p className="text-body-md text-text-muted mt-1">
              Typed by hand, never counted for you. The date it was last changed is
              shown beside it.
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

