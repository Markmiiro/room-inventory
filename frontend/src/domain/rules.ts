import type { Move, Record_, Room, Species } from "../db/types";

/**
 * SPEC section 4 — the derived values.
 *
 * These are computed identically here and on the server. The client needs them
 * because it must render every screen offline; the server needs them for
 * reports. Keeping them in one small module on each side is the closest thing
 * to a guarantee that the two do not drift.
 */

/** SPEC 4.1 — a record's room is the destination of its most recent move,
 *  ordered by date then created_at. Never a stored truth. */
export function currentRoomId(moves: Move[]): string | null {
  const live = moves.filter((m) => !m.deleted_at);
  if (live.length === 0) return null;
  const latest = live.reduce((best, move) =>
    move.date === best.date
      ? move.created_at > best.created_at
        ? move
        : best
      : move.date > best.date
        ? move
        : best,
  );
  return latest.to_room_id;
}

/** SPEC 4.2 — occupancy is the sum of head_count across active records in the
 *  room. Shown as "45 of 53" and never as a percentage. */
export function occupancy(records: Record_[]): number {
  return records
    .filter((r) => r.status === "active" && !r.deleted_at)
    .reduce((total, r) => total + r.head_count, 0);
}

export type RoomTypeLabel = "Empty" | "Mixed" | "Isolation" | Capitalised<Species>;
type Capitalised<T extends string> = Capitalize<T>;

const SPECIES_LABEL: Record<Species, string> = {
  cattle: "Cattle",
  goats: "Goats",
  sheep: "Sheep",
  pigs: "Pigs",
  poultry: "Poultry",
};

/** SPEC 4.2 — type is derived, never stored. One species present gives that
 *  species; two or more gives Mixed; none gives Empty. An isolation room always
 *  reads Isolation regardless of what is in it. */
export function roomType(room: Room, records: Record_[]): string {
  if (room.is_isolation) return "Isolation";
  const present = new Set(
    records.filter((r) => r.status === "active" && !r.deleted_at).map((r) => r.species),
  );
  if (present.size === 0) return "Empty";
  if (present.size > 1) return "Mixed";
  return SPECIES_LABEL[[...present][0] as Species];
}

export function speciesLabel(species: Species): string {
  return SPECIES_LABEL[species];
}

/** SPEC 4.2 — over capacity warns, never blocks. The animals are physically
 *  there whether the app approves or not. */
export function isOverCapacity(room: Room, occupied: number): boolean {
  return occupied > room.capacity;
}

export function speciesBreakdown(records: Record_[]): Array<{ species: Species; head: number }> {
  const totals = new Map<Species, number>();
  for (const record of records) {
    if (record.status !== "active" || record.deleted_at) continue;
    totals.set(record.species, (totals.get(record.species) ?? 0) + record.head_count);
  }
  return [...totals.entries()]
    .map(([species, head]) => ({ species, head }))
    .sort((a, b) => b.head - a.head);
}

/** SPEC 6.5 — a tag in use by another *active* record on this device blocks
 *  entry, and the message names where. A tag freed by a sold or dead record may
 *  be reused. Across devices the server accepts both and raises an alert
 *  instead (SPEC 5.4). */
export function findTagClash(
  tag: string,
  records: Record_[],
  rooms: Room[],
  excludeId?: string,
): { record: Record_; roomCode: string | null } | null {
  const normalised = tag.trim().toLowerCase();
  const clash = records.find(
    (r) =>
      r.id !== excludeId &&
      r.status === "active" &&
      !r.deleted_at &&
      r.tag.trim().toLowerCase() === normalised,
  );
  if (!clash) return null;
  const room = rooms.find((r) => r.id === clash.current_room_id);
  return { record: clash, roomCode: room?.code ?? null };
}

/** SPEC 6.8 — moves, sales, deaths and expenses cannot be dated in the future.
 *  SPEC 6.9 — backdating is allowed, up to today. */
export function isFutureDate(date: string, today: string): boolean {
  return date > today;
}
