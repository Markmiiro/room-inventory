import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { PlusIcon, MoveIcon, WarningIcon } from "../components/Icons";
import { SpeciesLabel } from "../components/SpeciesLabel";
import { createRoom } from "../db/mutations";
import { activeRecordsByRoom, liveRooms } from "../db/queries";
import { useAlerts } from "../db/useAlerts";
import type { Record_, Room } from "../db/types";
import { isOverCapacity, occupancy, roomType, speciesBreakdown } from "../domain/rules";
import { plural } from "../domain/format";
import { useLiveQuery } from "../sync/useSync";

/**
 * Rooms — the home screen.
 *
 * Occupancy reads "45 of 53" and never as a percentage; percentages do not
 * appear anywhere in this app (SPEC 4.2). Over capacity warns in words, in a
 * chip and in colour together, because colour never carries meaning alone.
 */
export function RoomsScreen() {
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const byRoom = useLiveQuery(activeRecordsByRoom, [], new Map<string, Record_[]>());
  const [adding, setAdding] = useState(false);
  // SPEC 4.6 — the same computed conditions Alerts and Room detail read. The
  // banner used to re-derive over-capacity here, which meant three screens each
  // had their own idea of what counted as one.
  const alerts = useAlerts();

  const totalHead = [...byRoom.values()].flat().reduce((n, r) => n + r.head_count, 0);
  const roomsInUse = rooms.filter((room) => (byRoom.get(room.id) ?? []).length > 0).length;
  const urgent = alerts.filter((alert) => alert.priority === "urgent");

  return (
    <div className="pb-40 md:pb-28">
      <section className="card p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Stat label="Total animals" value={totalHead.toLocaleString("en-US")} />
        <Divider />
        <Stat label="Rooms in use" value={`${roomsInUse} of ${rooms.length}`} />
        {alerts.length > 0 && (
          <>
            <Divider />
            <span className="flex items-center gap-2 text-alert">
              <WarningIcon className="w-5 h-5" />
              <Link to="/alerts" className="text-body-md font-semibold underline">
                {alerts.length} {plural(alerts.length, "alert")}
              </Link>
            </span>
          </>
        )}
      </section>

      {urgent.map((alert) => (
        <Link
          key={alert.id}
          to={alert.roomId ? `/rooms/${alert.roomId}` : "/alerts"}
          role="status"
          className="mt-4 flex items-center gap-3 rounded-xl bg-alert-bg
                     border-l-4 border-alert p-4"
        >
          <WarningIcon className="w-5 h-5 text-alert-text shrink-0" />
          <p className="text-body-md font-semibold text-alert-text">
            {alert.title}
          </p>
        </Link>
      ))}

      <div className="mt-6 flex items-center justify-between gap-4">
        <h2 className="text-headline-sm text-primary">All rooms</h2>
        <button type="button" className="btn-quiet" onClick={() => setAdding(true)}>
          <PlusIcon className="w-5 h-5" />
          Add room
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {rooms.map((room) => (
          <RoomCard key={room.id} room={room} records={byRoom.get(room.id) ?? []} />
        ))}
      </div>

      {adding && <AddRoomDialog existing={rooms} onClose={() => setAdding(false)} />}

      <MoveFab />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="data-label">{label}</span>
      <span className="data-value">{value}</span>
    </div>
  );
}

function Divider() {
  return <span className="hidden sm:block w-px h-8 bg-border" aria-hidden="true" />;
}

function RoomCard({ room, records }: { room: Room; records: Record_[] }) {
  const occupied = occupancy(records);
  const over = isOverCapacity(room, occupied);
  const type = roomType(room, records);
  const breakdown = speciesBreakdown(records);
  // The bar is a proportion drawn on screen, not a figure shown to the user —
  // SPEC 4.2 bans percentages from the interface, not from the rendering.
  const fill = room.capacity > 0 ? Math.min(occupied / room.capacity, 1) * 100 : 0;

  return (
    <Link
      to={`/rooms/${room.id}`}
      className={`card p-4 flex flex-col gap-3 min-h-[168px] ${
        over ? "border-l-4 border-alert" : ""
      }`}
    >
      <div className="flex flex-col gap-1">
        <h3 className="data-value font-bold flex items-center gap-1.5">
          <span>{room.code}</span>
          <span className="font-sans font-normal text-text-muted truncate">({room.name})</span>
          {over && <WarningIcon className="w-4 h-4 text-alert shrink-0" />}
        </h3>
        <p className="text-body-md text-text-muted">{type}</p>
        <p className={`data-value mt-1 ${over ? "text-alert font-bold" : ""}`}>
          {occupied} <span className="text-text-muted font-normal">of {room.capacity}</span>
        </p>
      </div>

      {over && (
        <span className="chip bg-alert-bg text-alert-text w-fit font-bold">Over capacity</span>
      )}

      <div className={`h-2 rounded-full overflow-hidden ${over ? "bg-alert-bg" : "bg-background"}`}>
        <div
          className={`h-full rounded-full ${over ? "bg-alert" : "bg-primary-container"}`}
          style={{ width: `${fill}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-2 mt-auto">
        {breakdown.length === 0 ? (
          <span className="chip bg-background text-text-muted">Empty</span>
        ) : (
          breakdown.map(({ species, head }) => (
            <SpeciesLabel key={species} species={species} count={head} />
          ))
        )}
      </div>
    </Link>
  );
}

/** TOKENS.md: the action yellow appears once per screen, on the primary
 *  button — so this is the only yellow on Rooms. */
function MoveFab() {
  return (
    <Link
      to="/move"
      className="btn-action fixed right-4 bottom-24 md:bottom-8 z-30 text-headline-sm h-14"
    >
      <MoveIcon className="w-6 h-6" />
      Move
    </Link>
  );
}

function AddRoomDialog({ existing, onClose }: { existing: Room[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("20");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmedCode = code.trim().toUpperCase();
    const trimmedName = name.trim();

    if (!trimmedCode) return setError("Give the room a code, such as R11.");
    if (!trimmedName) return setError("Give the room a name.");
    if (existing.some((room) => room.code.toUpperCase() === trimmedCode)) {
      return setError(`Room code ${trimmedCode} is already in use.`);
    }
    const size = Number(capacity);
    if (!Number.isInteger(size) || size < 1) return setError("Capacity must be 1 or more.");

    const room = await createRoom({ code: trimmedCode, name: trimmedName, capacity: size });
    onClose();
    navigate(`/rooms/${room.id}`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-4 sm:p-6" role="dialog" aria-label="Add room">
        <h2 className="text-headline-sm text-primary">Add room</h2>

        <label className="data-label block mt-4 mb-1" htmlFor="room-code">Code</label>
        <input
          id="room-code" className="field font-mono" value={code} placeholder="R11"
          onChange={(e) => setCode(e.target.value)} autoFocus
        />

        <label className="data-label block mt-4 mb-1" htmlFor="room-name">Name</label>
        <input
          id="room-name" className="field" value={name} placeholder="Front room"
          onChange={(e) => setName(e.target.value)}
        />

        <label className="data-label block mt-4 mb-1" htmlFor="room-capacity">Capacity</label>
        <input
          id="room-capacity" className="field font-mono" value={capacity} inputMode="numeric"
          onChange={(e) => setCapacity(e.target.value)}
        />

        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-quiet flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-secondary flex-1" onClick={() => void submit()}>
            Add room
          </button>
        </div>
      </div>
    </div>
  );
}
