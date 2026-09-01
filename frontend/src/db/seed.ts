import { db, META, getMeta, setMeta } from "./schema";
import type { Room } from "./types";

/**
 * SPEC 6.10 — first open, no data.
 *
 * The ten rooms exist from the start: no blank screen, no setup wizard, no
 * sample data. Seeding happens locally so it works with no signal at all.
 *
 * The IDs are fixed constants, and must stay identical to those in
 * backend/alembic/versions/0002_seed_rooms.py. Two devices that each seed
 * offline have to arrive at the same ten rooms, or the first sync would produce
 * twenty. Because the IDs agree, the seeds *are* the same rows, and any
 * renaming merges by the ordinary field rules.
 */
const ROOM_ID_PREFIX = "0000000000000000000000R0";

const SEED_ROOMS = [
  { code: "R1", name: "Room 1" },
  { code: "R2", name: "Room 2" },
  { code: "R3", name: "Room 3" },
  { code: "R4", name: "Room 4" },
  { code: "R5", name: "Room 5" },
  { code: "R6", name: "Room 6" },
  { code: "R7", name: "Room 7" },
  { code: "R8", name: "Room 8" },
  { code: "R9", name: "Room 9" },
  { code: "R10", name: "Room 10" },
];

const ISOLATION_CODE = "R4";
const DEFAULT_CAPACITY = 20;

export function seedRoomId(index: number): string {
  return `${ROOM_ID_PREFIX}${String(index).padStart(2, "0")}`;
}

export async function seedRoomsIfEmpty(): Promise<void> {
  if (await getMeta(META.seeded, false)) return;

  const at = new Date(0).toISOString();
  const rooms: Room[] = SEED_ROOMS.map((room, i) => ({
    id: seedRoomId(i + 1),
    // Backdated deliberately. A seeded name must lose to any real edit, whether
    // that edit was made on this device or another one.
    created_at: at,
    updated_at: at,
    device_id: "seed",
    deleted_at: null,
    code: room.code,
    name: room.name,
    capacity: DEFAULT_CAPACITY,
    is_isolation: room.code === ISOLATION_CODE,
    notes: null,
  }));

  await db.transaction("rw", db.rooms, db.meta, async () => {
    // `bulkPut` rather than `bulkAdd`: if a pull already delivered the real
    // rooms, the seed must not clobber them — so only rooms this device has
    // never seen are written.
    const existing = new Set((await db.rooms.bulkGet(rooms.map((r) => r.id))).filter(Boolean).map((r) => r!.id));
    const missing = rooms.filter((r) => !existing.has(r.id));
    if (missing.length > 0) await db.rooms.bulkAdd(missing);
    await setMeta(META.seeded, true);
  });
}
