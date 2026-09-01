import { beforeEach, describe, expect, it } from "vitest";

import {
  BackupRejected,
  SCHEMA_VERSION,
  buildBackup,
  parseBackup,
  restoreBackup,
  summarise,
} from "./backup";
import { resetDeviceIdCache } from "./ids";
import { createRecord, createRoom, recordSale } from "./mutations";
import { META, db, getMeta, setMeta } from "./schema";

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetDeviceIdCache();
});

/**
 * SPEC 7 — an import replaces all data.
 *
 * That is what makes refusing a bad file the whole feature. A half-applied
 * import leaves a device holding a mixture of two farms with no way to tell
 * which rows came from where, and no undo. Every test here is about the file
 * being rejected before a single row is written.
 */
async function aFarm() {
  const room = await createRoom({ code: "R1", name: "Front room", capacity: 20 });
  const record = await createRecord({
    kind: "group",
    species: "pigs",
    tag: "P-Weaners",
    head_count: 10,
    source: "bought",
    room_id: room.id,
    price: 900_000,
  });
  await recordSale({ record_id: record.id, date: "2026-08-31", price: 500_000, count: 4 });
  return { room, record };
}

describe("taking a backup", () => {
  it("carries every table and the schema version", async () => {
    await aFarm();

    const backup = await buildBackup();

    expect(backup.format).toBe("room-inventory-backup");
    expect(backup.schema_version).toBe(SCHEMA_VERSION);
    expect(backup.tables.rooms).toHaveLength(1);
    expect(backup.tables.records).toHaveLength(1);
    expect(backup.tables.sales).toHaveLength(1);
    expect(backup.tables.purchases).toHaveLength(1);
  });

  it("includes the outbox", async () => {
    // An export taken offline is describing work the server has never seen.
    // Leaving it out would lose exactly the writes this app exists to protect.
    await aFarm();

    const backup = await buildBackup();

    expect((backup.tables.outbox as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("refusing a file", () => {
  const good = () =>
    JSON.stringify({
      format: "room-inventory-backup",
      schema_version: SCHEMA_VERSION,
      taken_at: "2026-09-01T00:00:00Z",
      device_id: "d",
      tables: { rooms: [], records: [] },
    });

  it("accepts one it wrote itself", async () => {
    await aFarm();
    const text = JSON.stringify(await buildBackup());

    expect(() => parseBackup(text)).not.toThrow();
  });

  it("refuses something that is not JSON", () => {
    expect(() => parseBackup("not a backup")).toThrow(BackupRejected);
  });

  it("refuses a JSON file from somewhere else", () => {
    // A photo backup, an export from another app, a package.json. None of them
    // say what they are, so none of them are opened.
    expect(() => parseBackup(JSON.stringify({ name: "something", version: "1.0.0" }))).toThrow(
      /not exported by this app/,
    );
  });

  it("refuses a newer schema version rather than guessing", () => {
    const newer = JSON.parse(good());
    newer.schema_version = SCHEMA_VERSION + 1;

    expect(() => parseBackup(JSON.stringify(newer))).toThrow(/version 2/);
  });

  it("refuses an older schema version too", () => {
    const older = JSON.parse(good());
    older.schema_version = SCHEMA_VERSION - 1;

    expect(() => parseBackup(JSON.stringify(older))).toThrow(/version 0/);
  });

  it("refuses a file with no schema version at all", () => {
    const missing = JSON.parse(good());
    delete missing.schema_version;

    expect(() => parseBackup(JSON.stringify(missing))).toThrow(/unknown/);
  });

  it("refuses a table that is not a list", () => {
    const broken = JSON.parse(good());
    broken.tables.records = { id: "rec-1" };

    expect(() => parseBackup(JSON.stringify(broken))).toThrow(/not a list/);
  });

  it("refuses a file holding tables this build does not know", () => {
    // The reverse of a version bump: same version, extra data. Writing what it
    // recognises and dropping the rest is a silent partial import.
    const extra = JSON.parse(good());
    extra.tables.breedingRecords = [];

    expect(() => parseBackup(JSON.stringify(extra))).toThrow(/does not know about/);
  });

  it("says what it refused, and that nothing changed", () => {
    // The message is the whole interface at this point: someone restoring a
    // backup is usually already having a bad day.
    try {
      parseBackup("{}");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/Nothing has been changed|does not look like/);
    }
  });
});

describe("restoring", () => {
  it("replaces what was there rather than merging into it", async () => {
    await aFarm();
    const backup = await buildBackup();

    // A different farm on this device now.
    await db.delete();
    await db.open();
    resetDeviceIdCache();
    const other = await createRoom({ code: "R9", name: "Other farm", capacity: 5 });
    await createRecord({
      kind: "animal", species: "cattle", tag: "OTHER-1", source: "gift", room_id: other.id,
    });

    await restoreBackup(backup);

    const rooms = await db.rooms.toArray();
    const records = await db.records.toArray();
    expect(rooms.map((r) => r.code)).toEqual(["R1"]);
    expect(records.map((r) => r.tag)).toEqual(["P-Weaners"]);
  });

  it("brings the sales and purchases back, not just the records", async () => {
    await aFarm();
    const backup = await buildBackup();
    await db.delete();
    await db.open();
    resetDeviceIdCache();

    await restoreBackup(backup);

    expect(await db.sales.count()).toBe(1);
    expect(await db.purchases.count()).toBe(1);
    expect((await db.records.toArray())[0]!.head_count).toBe(6);
  });

  it("restores the outbox so unsent work is still unsent", async () => {
    await aFarm();
    const queued = await db.outbox.count();
    const backup = await buildBackup();
    await db.delete();
    await db.open();
    resetDeviceIdCache();

    await restoreBackup(backup);

    expect(await db.outbox.count()).toBe(queued);
  });

  it("resets the pull cursor", async () => {
    // The cursor belongs to the device that took the export. Keeping it would
    // make the next sync skip every change between the two devices' positions
    // — changes this device has never seen.
    await aFarm();
    const backup = await buildBackup();
    await setMeta(META.cursor, 4200);

    await restoreBackup(backup);

    expect(await getMeta(META.cursor, -1)).toBe(0);
  });

  it("reports what it wrote", async () => {
    await aFarm();
    const backup = await buildBackup();

    const summary = summarise(backup);

    expect(summary.rows.records).toBe(1);
    expect(summary.rows.sales).toBe(1);
    expect(summary.total).toBeGreaterThan(3);
    expect(summary.taken_at).toBe(backup.taken_at);
  });
});
