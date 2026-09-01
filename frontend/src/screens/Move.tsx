import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CheckIcon, MoveIcon, SearchIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { recordMove } from "../db/mutations";
import { activeRecords, activeRecordsByRoom, liveRooms } from "../db/queries";
import type { MoveReason, Record_, Room } from "../db/types";
import { headUnit } from "../domain/format";
import { occupancy, speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

const REASONS: Array<{ value: MoveReason; label: string }> = [
  { value: "routine", label: "Routine" },
  { value: "weaning", label: "Weaning" },
  { value: "sick", label: "Sick" },
  { value: "isolation", label: "Isolation" },
  { value: "new_arrival", label: "New arrival" },
  { value: "breeding", label: "Breeding" },
];

/**
 * Move.
 *
 * The action the whole app exists to make possible while standing next to the
 * animal. It writes locally and returns; nothing here waits on a network.
 *
 * SPEC 6.3 — moving into a full room is allowed, with a red warning naming how
 * far over it will go. SPEC 6.4 — the current room is dimmed, labelled
 * "Current", and cannot be chosen.
 */
export function MoveScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const records = useLiveQuery(activeRecords, [], [] as Record_[]);
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const byRoom = useLiveQuery(activeRecordsByRoom, [], new Map<string, Record_[]>());

  const [selectedId, setSelectedId] = useState<string | null>(params.get("record"));
  const [destination, setDestination] = useState<string | null>(null);
  const [reason, setReason] = useState<MoveReason>("routine");
  const [count, setCount] = useState<string>("");
  const [date, setDate] = useState(todayInEAT());
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const record = records.find((r) => r.id === selectedId) ?? null;
  const headToMove = record
    ? Math.min(Math.max(1, Number(count) || record.head_count), record.head_count)
    : 0;

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const pool = needle
      ? records.filter(
          (r) => r.tag.toLowerCase().includes(needle) || speciesLabel(r.species).toLowerCase().includes(needle),
        )
      : records;
    // SPEC 6.13 — lists assume thousands of rows, so this one is capped and
    // searchable rather than rendered whole.
    return pool.slice(0, 50);
  }, [records, search]);

  async function submit() {
    if (!record || !destination) return;
    if (date > todayInEAT()) return setError("A move cannot be dated in the future.");

    setSaving(true);
    setError(null);
    try {
      await recordMove({
        record_id: record.id,
        to_room_id: destination,
        date,
        reason,
        note: note.trim() || null,
        count: headToMove,
      });
      // The write is already on the device. Sync happens in the background.
      navigate(`/rooms/${destination}`);
    } catch (cause) {
      setError((cause as Error).message);
      setSaving(false);
    }
  }

  const destinationRoom = rooms.find((r) => r.id === destination) ?? null;
  const overBy = destinationRoom
    ? occupancy(byRoom.get(destinationRoom.id) ?? []) + headToMove - destinationRoom.capacity
    : 0;

  return (
    <div className="pb-44 md:pb-28">
      <h2 className="text-headline-sm text-primary">Choose what to move</h2>

      {record ? (
        <div className="card mt-3 p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="data-value font-bold truncate">{record.tag}</p>
            <p className="text-body-md text-text-muted truncate">
              {speciesLabel(record.species)}
              {record.kind === "group" ? ` · Group of ${record.head_count}` : ""}
            </p>
          </div>
          <button type="button" className="btn-quiet" onClick={() => { setSelectedId(null); setCount(""); }}>
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative mt-3">
            <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              className="field pl-12"
              placeholder="Search by tag or species"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search records"
            />
          </div>

          {matches.length === 0 ? (
            <p className="card p-6 mt-3 text-body-md text-text-muted text-center">
              {records.length === 0
                ? "There is nothing to move yet. Add an animal to a room first."
                : "No record matches that search."}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {matches.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(candidate.id)}
                    className="card w-full text-left p-4 min-h-row flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="data-value font-bold truncate">{candidate.tag}</p>
                      <p className="text-body-md text-text-muted truncate">
                        {speciesLabel(candidate.species)}
                        {candidate.kind === "group" ? " · Group" : ""}
                      </p>
                    </div>
                    <span className="data-value shrink-0">
                      {candidate.head_count} <span className="text-text-muted">{headUnit(candidate.head_count)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {record?.kind === "group" && record.head_count > 1 && (
        <section className="mt-6">
          <h2 className="text-headline-sm text-primary">How many</h2>
          <div className="card mt-3 p-4 flex items-center gap-3">
            <input
              className="field w-24 font-mono text-center"
              inputMode="numeric"
              value={count}
              placeholder={String(record.head_count)}
              onChange={(e) => setCount(e.target.value)}
              aria-label="Head to move"
            />
            <span className="text-body-md text-text-muted">of {record.head_count}</span>
          </div>
          {headToMove < record.head_count && (
            <p className="mt-2 text-body-md text-text-muted">
              Moving part of a group splits it. The head that moves becomes its own record with
              its own history, and {record.tag} keeps the remaining {record.head_count - headToMove}.
            </p>
          )}
        </section>
      )}

      {record && (
        <>
          <section className="mt-6">
            <h2 className="text-headline-sm text-primary">Destination room</h2>
            <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
              {rooms.map((room) => (
                <RoomTile
                  key={room.id}
                  room={room}
                  occupied={occupancy(byRoom.get(room.id) ?? [])}
                  isCurrent={room.id === record.current_room_id}
                  isSelected={room.id === destination}
                  onSelect={() => setDestination(room.id)}
                />
              ))}
            </div>
          </section>

          {destinationRoom && overBy > 0 && (
            // SPEC 6.3 — allowed, but the warning names how far over it goes.
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-alert-bg text-alert-text p-4 text-body-md font-semibold">
              <WarningIcon className="w-5 h-5 shrink-0 mt-0.5" />
              This move puts {destinationRoom.code} {overBy} {headUnit(overBy)} over capacity.
              You can still make it.
            </p>
          )}

          <section className="mt-6">
            <h2 className="text-headline-sm text-primary">Reason</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {REASONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setReason(option.value)}
                  className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                    reason === option.value
                      ? "bg-primary-container text-white border-primary-container"
                      : "bg-card text-text border-border"
                  }`}
                >
                  {reason === option.value && <CheckIcon className="w-4 h-4" />}
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-6 grid sm:grid-cols-2 gap-4">
            <div>
              <label className="data-label block mb-1" htmlFor="move-date">Date</label>
              <input
                id="move-date" type="date" className="field font-mono" value={date}
                max={todayInEAT()} onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <label className="data-label block mb-1" htmlFor="move-note">Note (optional)</label>
              <input
                id="move-note" className="field" value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </section>
        </>
      )}

      {error && (
        <p className="mt-4 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
      )}

      {record && destination && (
        <div className="fixed inset-x-0 bottom-0 md:left-56 z-40 bg-card shadow-card-up p-4
                        pb-[calc(1rem+env(safe-area-inset-bottom))] flex flex-col sm:flex-row
                        sm:items-center gap-3 justify-between">
          <p className="data-value text-text-muted">
            {headToMove} {headUnit(headToMove)} ·{" "}
            {rooms.find((r) => r.id === record.current_room_id)?.code ?? "Nowhere"} to{" "}
            {destinationRoom?.code}
          </p>
          {/* The one action-yellow button on this screen. */}
          <button
            type="button"
            className="btn-action h-input sm:w-auto w-full text-headline-sm"
            onClick={() => void submit()}
            disabled={saving}
          >
            <MoveIcon className="w-6 h-6" />
            {saving ? "Moving…" : `Move ${headToMove} ${headUnit(headToMove)}`}
          </button>
        </div>
      )}
    </div>
  );
}

function RoomTile({
  room,
  occupied,
  isCurrent,
  isSelected,
  onSelect,
}: {
  room: Room;
  occupied: number;
  isCurrent: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const full = occupied >= room.capacity;

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      aria-label={`Room ${room.code}, ${room.name}, ${occupied} of ${room.capacity}${
        isCurrent ? ", current room" : ""
      }`}
      className={`rounded-xl p-4 min-h-[96px] text-left flex flex-col gap-1 border-2 ${
        isCurrent
          ? "bg-background border-transparent opacity-60 cursor-not-allowed"
          : isSelected
            ? "bg-card border-primary-container shadow-card"
            : "bg-card border-border shadow-card"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="data-value font-bold">{room.code}</span>
        {isSelected && <CheckIcon className="w-5 h-5 text-primary-container" />}
      </span>
      <span className="text-body-md text-text-muted truncate">{room.name}</span>
      <span className={`data-label ${full && !isCurrent ? "text-alert" : "text-text-muted"}`}>
        {occupied} of {room.capacity}
      </span>
      {/* SPEC 6.4 — the label says "Current" in words, not just by dimming. */}
      {isCurrent && <span className="data-label font-bold text-text-muted">Current</span>}
      {full && !isCurrent && <span className="data-label font-bold text-alert">Full</span>}
    </button>
  );
}
