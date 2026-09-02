import { db, META, getMeta, setMeta } from "./schema";
import type { Room, TreatmentSchedule } from "./types";

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


/**
 * SPEC 13.5 — the starter schedules.
 *
 * Same reasoning as the ten rooms, and the same mechanism. The IDs are fixed
 * constants and must stay identical to those in
 * backend/alembic/versions/0006_treatment_schedules.py. Two devices that each
 * seed offline have to arrive at the same eight schedules, or the first sync
 * would produce sixteen — and unlike duplicate rooms, duplicate schedules mean
 * every animal is told it is due for the same vaccination twice.
 *
 * These are suggestions, not veterinary advice. The screen says so; this is the
 * data half of that promise, which is why every one of them is editable and
 * archivable from the moment it appears.
 */
const SCHEDULE_ID_PREFIX = "0000000000000000000000S0";

interface SeedSchedule {
  name: string;
  species: TreatmentSchedule["species"];
  type: TreatmentSchedule["type"];
  first_due_age_days: number | null;
  repeat_every_days: number | null;
}

/** Months are written as 30 days and years as 365, consistently, so that
 *  "every 6 months" is one number the user can recognise and edit rather than
 *  a calendar calculation they cannot. */
const SEED_SCHEDULES: SeedSchedule[] = [
  { name: "Foot and mouth vaccination", species: "cattle", type: "vaccination", first_due_age_days: 120, repeat_every_days: 180 },
  { name: "Deworming", species: "cattle", type: "deworming", first_due_age_days: 60, repeat_every_days: 90 },
  { name: "PPR vaccination", species: "goats", type: "vaccination", first_due_age_days: 90, repeat_every_days: 365 },
  { name: "Deworming", species: "goats", type: "deworming", first_due_age_days: 30, repeat_every_days: 90 },
  { name: "Deworming", species: "sheep", type: "deworming", first_due_age_days: 30, repeat_every_days: 90 },
  { name: "Deworming", species: "pigs", type: "deworming", first_due_age_days: 60, repeat_every_days: 90 },
  { name: "Newcastle vaccination", species: "poultry", type: "vaccination", first_due_age_days: 7, repeat_every_days: 90 },
  // SPEC 13.5 lists Gumboro as one-off, so it has no interval: given once at
  // fourteen days and never again.
  { name: "Gumboro vaccination", species: "poultry", type: "vaccination", first_due_age_days: 14, repeat_every_days: null },
];

export function seedScheduleId(index: number): string {
  return `${SCHEDULE_ID_PREFIX}${String(index).padStart(2, "0")}`;
}

export async function seedSchedulesIfEmpty(): Promise<void> {
  if (await getMeta(META.schedulesSeeded, false)) return;

  const at = new Date(0).toISOString();
  const schedules: TreatmentSchedule[] = SEED_SCHEDULES.map((seed, i) => ({
    id: seedScheduleId(i + 1),
    // Backdated for the same reason the rooms are: a seeded interval must lose
    // to any real edit, whether it was made on this device or another one.
    created_at: at,
    updated_at: at,
    device_id: "seed",
    deleted_at: null,
    name: seed.name,
    species: seed.species,
    type: seed.type,
    first_due_age_days: seed.first_due_age_days,
    repeat_every_days: seed.repeat_every_days,
    // Every seeded schedule is about individual animals and groups alike: a pen
    // of broilers needs its Newcastle dose as much as a single bird does.
    applies_to: "both",
    default_product: null,
    default_withdrawal_days: null,
    is_active: true,
    notes: null,
  }));

  await db.transaction("rw", db.treatmentSchedules, db.meta, async () => {
    // `bulkAdd` of only the missing rows, exactly as the rooms do: a pull that
    // already delivered the real schedules — including any the user archived —
    // must not be clobbered by the seed.
    const existing = new Set(
      (await db.treatmentSchedules.bulkGet(schedules.map((s) => s.id)))
        .filter(Boolean)
        .map((s) => s!.id),
    );
    const missing = schedules.filter((s) => !existing.has(s.id));
    if (missing.length > 0) await db.treatmentSchedules.bulkAdd(missing);
    await setMeta(META.schedulesSeeded, true);
  });
}
