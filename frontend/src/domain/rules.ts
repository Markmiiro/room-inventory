import type { Move, Record_, Room, ScheduleSpecies, Species } from "../db/types";

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

export type RoomTypeLabel = "Empty" | "Mixed" | "Birds" | "Isolation" | Capitalised<Species>;
type Capitalised<T extends string> = Capitalize<T>;

/**
 * SPEC 18 — every species, in the one order they are shown in.
 *
 * This is the only species list in the app. Five screens each carried their own
 * copy before, which is five places to forget when the enum changes and exactly
 * how a filter row ends up missing a species that records can still be created
 * with. Screens import this.
 *
 * Mammals first, then birds, each group in the order the spec names them.
 */
export const ALL_SPECIES: Species[] = [
  "cattle",
  "goats",
  "sheep",
  "pigs",
  "hens",
  "ducks",
  "geese",
  "turkeys",
];

/**
 * The birds, as a set.
 *
 * They are grouped for two reasons that are not presentation. A treatment
 * schedule can be written against all four at once (`ScheduleSpecies`), and a
 * room holding only birds is not a *mixed* room in any sense a farmer means —
 * see `roomType`.
 */
export const BIRD_SPECIES: Species[] = ["hens", "ducks", "geese", "turkeys"];

const BIRDS = new Set<Species>(BIRD_SPECIES);

/** Everything that is not a bird. Derived, so adding a species to `ALL_SPECIES`
 *  cannot leave this behind. */
export const MAMMAL_SPECIES: Species[] = ALL_SPECIES.filter((s) => !BIRDS.has(s));

export function isBird(species: Species): boolean {
  return BIRDS.has(species);
}

const SPECIES_LABEL: Record<Species, string> = {
  cattle: "Cattle",
  goats: "Goats",
  sheep: "Sheep",
  pigs: "Pigs",
  hens: "Hens",
  ducks: "Ducks",
  geese: "Geese",
  turkeys: "Turkeys",
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
  if (present.size === 1) return SPECIES_LABEL[[...present][0] as Species];
  /**
   * SPEC 18 — a room of birds is not a mixed room.
   *
   * Splitting `poultry` into four species would otherwise have quietly
   * relabelled rooms: a room that read "Poultry" yesterday holds hens and ducks
   * today and would read "Mixed", which is the label for a room mixing cattle
   * with goats. The word is meant to warn that unlike animals are sharing a
   * room; four kinds of bird together is the ordinary case it was never about.
   *
   * Mixed still means mixed for everything else, including one bird species
   * housed with any mammal.
   */
  if ([...present].every((s) => isBird(s as Species))) return "Birds";
  return "Mixed";
}

export function speciesLabel(species: Species): string {
  return SPECIES_LABEL[species];
}

/**
 * The label for what a treatment schedule covers (SPEC 13.6, 18).
 *
 * `birds` is worded "All birds" rather than "Birds" so a row on the manage
 * screen reads as a rule about a group rather than as a species alongside
 * Hens — the distinction matters there, because the four birds are also
 * choosable individually.
 */
export function scheduleSpeciesLabel(scope: ScheduleSpecies): string {
  if (scope === "all") return "Every species";
  if (scope === "birds") return "All birds";
  return SPECIES_LABEL[scope];
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
