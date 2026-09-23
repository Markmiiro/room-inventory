import { beforeEach, describe, expect, it } from "vitest";

import { createRecord, recordBirth, recordSale, recordIntake } from "./mutations";
import { clearDeviceData, clearedTables, pendingChangeCount, totalCleared } from "./clear";
import { resetDeviceIdCache } from "./ids";
import { META, db, getMeta } from "./schema";
import {
  SEED_PRODUCE_TYPE_COUNT,
  SEED_ROOM_COUNT,
  SEED_SCHEDULE_COUNT,
  SEED_STORE_COUNT,
  seedProduceTypeId,
  seedRoomId,
  seedRoomsIfEmpty,
  seedSchedulesIfEmpty,
  seedStoresIfEmpty,
} from "./seed";

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetDeviceIdCache();
  localStorage.clear();
  await seedRoomsIfEmpty();
  await seedSchedulesIfEmpty();
  await seedStoresIfEmpty();
});

/**
 * SPEC 23 — clearing a device.
 *
 * The same two hazards as the server-side reset, and one more that only exists
 * here: a device keeps its own identity, because `device_id` is what breaks
 * ties when two devices disagree (SPEC 5.4).
 */
async function aFarm() {
  const dam = await createRecord({
    kind: "animal", species: "cattle", tag: "C-084", sex: "female",
    date_of_birth: "2023-05-01", source: "bought", room_id: seedRoomId(3),
  });
  await recordBirth({
    dam_record_id: dam.id, date: "2026-09-01", born_count: 1, surviving_count: 1,
    offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
  });
  await recordSale({ record_id: dam.id, date: "2026-09-10", price: 2_400_000 });
  await recordIntake({
    store_id: "0000000000000000000000T001",
    produce_type_id: seedProduceTypeId(2),
    date: "2026-09-03",
    kg: 620,
    source: "garden",
  });
  return dam;
}

describe("clearing a device", () => {
  it("deletes every recorded row", async () => {
    await aFarm();
    expect(await db.records.count()).toBeGreaterThan(0);

    await clearDeviceData();

    expect(await db.records.count()).toBe(0);
    expect(await db.moves.count()).toBe(0);
    expect(await db.births.count()).toBe(0);
    expect(await db.sales.count()).toBe(0);
    expect(await db.stockIntakes.count()).toBe(0);
  });

  it("keeps the seeded rows at their fixed ids", async () => {
    await aFarm();
    await clearDeviceData();

    // Deleting these would not lose data; it would produce a second set of ten
    // rooms on the next sync (SPEC 6.10).
    expect(await db.rooms.count()).toBe(SEED_ROOM_COUNT);
    expect(await db.treatmentSchedules.count()).toBe(SEED_SCHEDULE_COUNT);
    expect(await db.stores.count()).toBe(SEED_STORE_COUNT);
    expect(await db.produceTypes.count()).toBe(SEED_PRODUCE_TYPE_COUNT);
    expect(await db.rooms.get(seedRoomId(3))).toBeDefined();
  });

  it("deletes a room the user added, and keeps the ten", async () => {
    await db.rooms.add({
      id: "01MINE00000000000000000000",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      device_id: "d1",
      deleted_at: null,
      code: "R99",
      name: "A room somebody added",
      capacity: 20,
      is_isolation: false,
      notes: null,
    });

    const summary = await clearDeviceData();

    expect(summary.rooms).toBe(1);
    expect(await db.rooms.count()).toBe(SEED_ROOM_COUNT);
  });

  it("discards the outbox, and says how much was in it first", async () => {
    await aFarm();
    const waiting = await pendingChangeCount();
    expect(waiting).toBeGreaterThan(0);

    await clearDeviceData();

    // Unsent work is the one part that cannot come back from the server, which
    // is why the confirmation names the count before anything happens.
    expect(await db.outbox.count()).toBe(0);
  });

  it("puts the pull cursor back to zero", async () => {
    await aFarm();
    await db.meta.put({ key: META.cursor, value: 4242 });

    await clearDeviceData();

    // Left where it was, the device would never re-pull what it just deleted,
    // and the two sides would disagree for ever with nothing saying so.
    expect(await getMeta(META.cursor, -1)).toBe(0);
  });

  it("keeps this device's identity", async () => {
    await aFarm();
    const before = await getMeta<string | null>(META.deviceId, null);
    expect(before).not.toBeNull();

    await clearDeviceData();

    // `device_id` breaks ties in conflict resolution (SPEC 5.4). A device that
    // changed identity on every clear would merge unpredictably.
    expect(await getMeta<string | null>(META.deviceId, null)).toBe(before);
  });

  it("forgets the tokens, since the session belonged to the old state", async () => {
    localStorage.setItem("access_token", "a");
    localStorage.setItem("refresh_token", "r");
    localStorage.setItem("auth_state", "required");

    await clearDeviceData();

    expect(localStorage.getItem("access_token")).toBeNull();
    expect(localStorage.getItem("refresh_token")).toBeNull();
    expect(localStorage.getItem("auth_state")).toBeNull();
  });

  it("reports what it deleted, by table", async () => {
    await aFarm();
    const summary = await clearDeviceData();

    expect(summary.records).toBe(2); // the dam and her calf
    expect(summary.births).toBe(1);
    expect(summary.sales).toBe(1);
    expect(summary.stockIntakes).toBe(1);
    expect(totalCleared(summary)).toBeGreaterThan(4);

    const named = clearedTables(summary).map(([table]) => table);
    expect(named).toContain("records");
    // Tables that lost nothing are left out of the report rather than listed
    // as zeros.
    expect(named).not.toContain("deaths");
  });

  it("covers every table Dexie knows about, so a new one cannot be missed", async () => {
    const summary = await clearDeviceData();
    const reported = new Set(Object.keys(summary));
    const expected = db.tables.map((t) => t.name).filter((name) => name !== "meta");

    for (const name of expected) {
      expect(reported.has(name)).toBe(true);
    }
  });

  it("leaves the app usable straight afterwards", async () => {
    await aFarm();
    await clearDeviceData();

    // The ten rooms are still there, so a record can be added and placed
    // immediately — no blank screen, no setup wizard (SPEC 6.10).
    const fresh = await createRecord({
      kind: "animal", species: "goats", tag: "G-001", sex: "female",
      source: "gift", room_id: seedRoomId(1),
    });
    expect(fresh.current_room_id).toBe(seedRoomId(1));
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });
});
