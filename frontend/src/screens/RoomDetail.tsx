import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { MoveIcon, PlusIcon, WarningIcon } from "../components/Icons";
import { SpeciesLabel } from "../components/SpeciesLabel";
import { createRecord } from "../db/mutations";
import { liveRooms, movesForRoom, recordsInRoom } from "../db/queries";
import { useAlerts } from "../db/useAlerts";
import { db } from "../db/schema";
import type { Move, Record_, RecordKind, Room, Sex, Source, Species } from "../db/types";
import { alertsForRecord, type Alert } from "../domain/alerts";
import { formatAge, formatDate, headUnit } from "../domain/format";
import { findTagClash, isOverCapacity, occupancy, roomType, speciesBreakdown, speciesLabel } from "../domain/rules";
import { todayInEAT } from "../db/ids";
import { useLiveQuery } from "../sync/useSync";

const SPECIES: Species[] = ["cattle", "goats", "sheep", "pigs", "poultry"];

/**
 * Room detail — what is in this room, its move log, and the two things you can
 * do from here.
 *
 * Laid out against `screenshots/02-room-detail.png`: the room's name leads and
 * the code is a chip beside it, occupancy reads "45 of 53 spaces used" over a
 * bar, and the records and the move log are two tabs rather than one long page.
 *
 * The mockup's own top bar is not reproduced — it invented one, which SPEC 12
 * calls an artefact of generating each screen separately. The shared bar stays.
 */
export function RoomDetailScreen() {
  const { roomId = "" } = useParams();
  const room = useLiveQuery(() => db.rooms.get(roomId).then((r) => r ?? null), [roomId], undefined);
  const records = useLiveQuery(() => recordsInRoom(roomId), [roomId], [] as Record_[]);
  const moves = useLiveQuery(() => movesForRoom(roomId), [roomId], [] as Move[]);
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const alerts = useAlerts();
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"records" | "log">("records");

  // `undefined` is still loading; `null` is a room that is genuinely gone.
  if (room === undefined) return null;
  if (!room) {
    return <p className="text-body-md text-text-muted">This room is no longer here.</p>;
  }

  const occupied = occupancy(records);
  const over = isOverCapacity(room, occupied);
  const breakdown = speciesBreakdown(records);
  const fill = room.capacity > 0 ? Math.min(occupied / room.capacity, 1) * 100 : 0;

  return (
    <div className="pb-8">
      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-headline-md text-primary">{room.name}</h2>
          <span className="chip bg-background text-text-muted border border-border">{room.code}</span>
          <span
            className={`chip ${
              room.is_isolation ? "bg-alert-bg text-alert-text" : "bg-success text-success-text"
            }`}
          >
            {roomType(room, records)}
          </span>
        </div>

        <p className={`data-value mt-4 ${over ? "text-alert font-bold" : "text-text-muted"}`}>
          <span className={`text-headline-sm font-bold ${over ? "text-alert" : "text-text"}`}>
            {occupied}
          </span>{" "}
          of {room.capacity} spaces used
        </p>

        <div className={`mt-2 h-2 rounded-full overflow-hidden ${over ? "bg-alert-bg" : "bg-background"}`}>
          <div
            className={`h-full rounded-full ${over ? "bg-alert" : "bg-primary-container"}`}
            style={{ width: `${fill}%` }}
          />
        </div>

        {over && (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-alert-bg text-alert-text p-3 text-body-md font-semibold">
            <WarningIcon className="w-5 h-5 shrink-0" />
            Over capacity by {occupied - room.capacity} {headUnit(occupied - room.capacity)}.
            The animals are here either way — this is a warning, not a block.
          </p>
        )}

        {breakdown.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {breakdown.map(({ species, head }) => (
              <SpeciesLabel key={species} species={species} count={head} />
            ))}
          </div>
        )}
      </section>

      <div className="mt-6 flex border-b border-border" role="tablist">
        <Tab active={tab === "records"} onClick={() => setTab("records")}>
          In this room{records.length > 0 && ` · ${records.length}`}
        </Tab>
        <Tab active={tab === "log"} onClick={() => setTab("log")}>
          Move log{moves.length > 0 && ` · ${moves.length}`}
        </Tab>
      </div>

      {tab === "records" ? (
        records.length === 0 ? (
          <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
            Nothing is in {room.code} yet. Add the first animal or group below.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2 md:grid-cols-2">
            {records.map((record) => (
              <li key={record.id}>
                <RecordRow record={record} alerts={alertsForRecord(alerts, record.id)} />
              </li>
            ))}
          </ul>
        )
      ) : moves.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          Nothing has moved in or out of {room.code} yet.
        </p>
      ) : (
        <ul className="mt-4 grid gap-2 md:grid-cols-2">
          {moves.map((move) => (
            <li key={`${move.id}-${move.to_room_id === room.id ? "in" : "out"}`}>
              <MoveRow move={move} room={room} rooms={rooms} />
            </li>
          ))}
        </ul>
      )}

      {/* In flow, as the mockup has them: a bar fixed to the bottom would stack
          with the navigation, which is also `fixed bottom-0`. Move is reachable
          from every record's own screen too. */}
      <div className="mt-6 flex gap-3 max-w-xl">
        <Link to="/move" className="btn-action flex-1 px-3 sm:px-6">
          <MoveIcon className="w-6 h-6" />
          Move animals
        </Link>
        <button type="button" className="btn-secondary flex-1 px-3 sm:px-6" onClick={() => setAdding(true)}>
          <PlusIcon className="w-6 h-6" />
          Add animal
        </button>
      </div>

      {adding && <AddRecordDialog room={room} onClose={() => setAdding(false)} />}
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
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 min-h-touch md:min-h-touch-desktop text-headline-sm border-b-2 -mb-px ${
        active ? "border-primary text-primary" : "border-transparent text-text-muted"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One record in the room.
 *
 * The subtitle follows the mockup — breed, sex and age for an animal, head and
 * age for a group — because those are what tell two similar animals apart when
 * you are looking at the row and the animal at the same time.
 */
function RecordRow({ record, alerts }: { record: Record_; alerts: Alert[] }) {
  const since = record.date_of_birth ?? record.arrival_date;
  const age = since ? formatAge(since, todayInEAT()) : null;

  const detail = [
    record.breed,
    record.kind === "animal" ? (record.sex === "male" ? "M" : record.sex ? "F" : null) : null,
    record.kind === "group" ? `${record.head_count} ${headUnit(record.head_count)}` : null,
    age,
  ].filter(Boolean);

  // SPEC 4.6 — the mockup marks a row that needs attention. What counts is
  // decided by the shared rules, so this row and the Alerts screen can never
  // disagree about which animal is flagged.
  const urgent = alerts.some((alert) => alert.priority === "urgent");

  return (
    <Link
      to={`/records/${record.id}`}
      className={`card flex items-center justify-between gap-3 p-4 min-h-row ${
        alerts.length > 0 ? `border-l-4 ${urgent ? "border-alert" : "border-action"}` : ""
      }`}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2">
          <span className="chip bg-background text-text-muted">{record.kind}</span>
          <span className="data-value font-bold truncate">{record.tag}</span>
        </p>
        <p className="text-body-md text-text-muted truncate mt-1">
          {detail.length > 0 ? detail.join(" • ") : speciesLabel(record.species)}
        </p>
        {/* Colour is never the only signal: the reason is spelled out. */}
        {alerts.length > 0 && (
          <p
            className={`text-body-md font-semibold mt-1 flex items-start gap-1.5 ${
              urgent ? "text-alert" : "text-text"
            }`}
          >
            <WarningIcon className="w-4 h-4 shrink-0 mt-1" />
            <span className="truncate">
              {alerts.length === 1 ? alerts[0]!.title : `${alerts.length} things need attention`}
            </span>
          </p>
        )}
      </div>
      {record.kind === "group" && (
        <p className="data-value font-bold shrink-0">{record.head_count}</p>
      )}
    </Link>
  );
}

function MoveRow({ move, room, rooms }: { move: Move; room: Room; rooms: Room[] }) {
  const record = useLiveQuery(() => db.records.get(move.record_id), [move.record_id], undefined);
  const other = rooms.find(
    (r) => r.id === (move.to_room_id === room.id ? move.from_room_id : move.to_room_id),
  );
  const arriving = move.to_room_id === room.id;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="data-value font-bold truncate">{record?.tag ?? "A record"}</p>
        <span className="data-label shrink-0">{formatDate(move.date)}</span>
      </div>
      <p className="text-body-md text-text-muted mt-1">
        {arriving
          ? other
            ? `In from ${other.code}`
            : "Placed here"
          : `Out to ${other?.code ?? "another room"}`}
        {" · "}
        {move.count} {headUnit(move.count)}
      </p>
    </div>
  );
}

/**
 * A cut-down Add form: enough for a record to exist in a room, with the rules
 * that protect the data — an animal is one head, a duplicate tag is blocked and
 * says where the tag is in use (SPEC 6.5), and a date cannot be in the future
 * (SPEC 6.8). The full Add or purchase screen comes later.
 */
function AddRecordDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const navigate = useNavigate();
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const allRecords = useLiveQuery(() => db.records.toArray(), [], [] as Record_[]);

  const [kind, setKind] = useState<RecordKind>("animal");
  const [species, setSpecies] = useState<Species>("cattle");
  const [tag, setTag] = useState("");
  const [breed, setBreed] = useState("");
  const [sex, setSex] = useState<Sex>("female");
  const [source, setSource] = useState<Source>("bought");
  const [headCount, setHeadCount] = useState("1");
  const [date, setDate] = useState(todayInEAT());
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = tag.trim();
    if (!trimmed) return setError("Every record needs a tag or a group name.");

    const clash = findTagClash(trimmed, allRecords, rooms);
    if (clash) {
      return setError(
        clash.roomCode
          ? `This tag is already used by an animal in ${clash.roomCode}.`
          : "This tag is already used by another active record.",
      );
    }

    const head = kind === "animal" ? 1 : Number(headCount);
    if (kind === "group" && (!Number.isInteger(head) || head < 1)) {
      return setError("A group needs a head count of 1 or more.");
    }
    if (date > todayInEAT()) return setError("An arrival cannot be dated in the future.");

    const record = await createRecord({
      kind,
      species,
      tag: trimmed,
      breed: breed.trim() || null,
      sex: kind === "animal" ? sex : null,
      arrival_date: kind === "group" ? date : null,
      head_count: head,
      source,
      room_id: room.id,
      date,
    });
    onClose();
    navigate(`/records/${record.id}`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto">
      <div className="card w-full max-w-lg p-4 sm:p-6 max-h-[92vh] overflow-y-auto" role="dialog" aria-label="Add to room">
        <h2 className="text-headline-sm text-primary">Add to {room.code}</h2>

        <Segmented
          label="Kind"
          value={kind}
          options={[
            { value: "animal", label: "Single animal" },
            { value: "group", label: "Group" },
          ]}
          onChange={(v) => setKind(v as RecordKind)}
        />

        <fieldset className="mt-4">
          <legend className="data-label mb-2">Species</legend>
          <div className="flex flex-wrap gap-2">
            {SPECIES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSpecies(option)}
                className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                  species === option
                    ? "bg-primary-container text-white border-primary-container"
                    : "bg-card text-text border-border"
                }`}
              >
                {speciesLabel(option)}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="data-label block mt-4 mb-1" htmlFor="record-tag">
          {kind === "animal" ? "Tag" : "Group name"}
        </label>
        <input
          id="record-tag" className="field font-mono" value={tag} autoFocus
          placeholder={kind === "animal" ? "C-084" : "P-Weaners"}
          onChange={(e) => setTag(e.target.value)}
        />

        <label className="data-label block mt-4 mb-1" htmlFor="record-breed">Breed (optional)</label>
        <input
          id="record-breed" className="field" value={breed}
          onChange={(e) => setBreed(e.target.value)} placeholder="Friesian"
        />

        {kind === "animal" ? (
          <Segmented
            label="Sex"
            value={sex}
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
            ]}
            onChange={(v) => setSex(v as Sex)}
          />
        ) : (
          <>
            <label className="data-label block mt-4 mb-1" htmlFor="record-head">Head count</label>
            <input
              id="record-head" className="field font-mono" value={headCount} inputMode="numeric"
              onChange={(e) => setHeadCount(e.target.value)}
            />
          </>
        )}

        <Segmented
          label="Source"
          value={source}
          options={[
            { value: "bought", label: "Bought" },
            { value: "born_here", label: "Born here" },
            { value: "gift", label: "Gift" },
          ]}
          onChange={(v) => setSource(v as Source)}
        />

        <label className="data-label block mt-4 mb-1" htmlFor="record-date">Arrived</label>
        <input
          id="record-date" type="date" className="field font-mono" value={date}
          max={todayInEAT()} onChange={(e) => setDate(e.target.value)}
        />

        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-quiet flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-secondary flex-1" onClick={() => void submit()}>
            Add to {room.code}
          </button>
        </div>
      </div>
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="data-label mb-2">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 min-w-[120px] min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
              value === option.value
                ? "bg-primary-container text-white border-primary-container"
                : "bg-card text-text border-border"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
