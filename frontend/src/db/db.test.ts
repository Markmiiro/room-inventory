import { beforeEach, describe, expect, it } from "vitest";

import { ageBasis } from "../domain/age";
import { currentRoomId, findTagClash, occupancy, roomType } from "../domain/rules";
import { resetDeviceIdCache, todayInEAT } from "./ids";
import {
  createRecord,
  createRoom,
  recordDeath,
  recordMove,
  recordSale,
  updateRecord,
  updateRoom,
} from "./mutations";
import { db } from "./schema";
import { seedRoomId, seedRoomsIfEmpty } from "./seed";

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetDeviceIdCache();
});

/**
 * SPEC 5.1 — every mutation writes to IndexedDB and appends to the outbox, then
 * returns. These tests are the guarantee that no write can land in one without
 * the other, which is the failure that would silently lose data.
 */
describe("the outbox", () => {
  it("queues an operation for every local write", async () => {
    const room = await createRoom({ code: "R1", name: "Front room", capacity: 20 });

    expect(await db.rooms.get(room.id)).toBeDefined();
    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ entity: "room", op: "upsert", id: room.id });
  });

  it("keeps the order the user worked in", async () => {
    const room = await createRoom({ code: "R1", name: "Front room", capacity: 20 });
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      room_id: room.id,
    });
    await recordMove({
      record_id: record.id,
      to_room_id: seedRoomId(2),
      date: "2026-08-31",
      reason: "routine",
    });

    const entities = (await db.outbox.orderBy("queue_id").toArray()).map((o) => o.entity);
    expect(entities).toEqual(["room", "record", "move", "move"]);
  });

  it("pushes only the fields an update actually changed", async () => {
    // Sending the whole row would make untouched fields compete with another
    // device's genuine edits to them (SPEC 5.4).
    const room = await createRoom({ code: "R1", name: "Front room", capacity: 20 });
    await db.outbox.clear();

    await updateRoom(room.id, { capacity: 53 });

    const queued = await db.outbox.toArray();
    expect(Object.keys(queued[0]!.data)).toEqual(["capacity"]);
  });

  it("survives being reopened", async () => {
    await createRoom({ code: "R1", name: "Front room", capacity: 20 });
    db.close();
    await db.open();

    expect(await db.outbox.count()).toBe(1);
  });

  it("records an id the device generated itself", async () => {
    // SPEC 3.1/5.3 — client-minted ids are what make a retry idempotent.
    const record = await createRecord({
      kind: "animal",
      species: "goats",
      tag: "G-1",
      source: "gift",
    });
    expect(record.id).toHaveLength(26);
    const queued = await db.outbox.toArray();
    expect(queued[0]!.id).toBe(record.id);
  });
});

describe("creating a record", () => {
  it("writes its starting room as a move rather than a field", async () => {
    // SPEC 3.4 — room_id is not a stored field on a record.
    await seedRoomsIfEmpty();
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      room_id: seedRoomId(1),
    });

    const moves = await db.moves.where("record_id").equals(record.id).toArray();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from_room_id: null, to_room_id: seedRoomId(1), reason: "new_arrival" });
  });

  /**
   * The arrival date used to be kept only for groups, so for an animal the date
   * typed on the add form was dropped on the way into the database. It is a
   * separate fact from age: SPEC 13.3 still counts an animal's age from its
   * date of birth alone, and this field does not stand in for it.
   */
  it("keeps an animal's arrival date rather than discarding it", async () => {
    await seedRoomsIfEmpty();
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      arrival_date: "2026-08-12",
      room_id: seedRoomId(1),
      date: "2026-08-12",
    });

    expect(record.arrival_date).toBe("2026-08-12");
    expect((await db.records.get(record.id))!.arrival_date).toBe("2026-08-12");
  });

  it("pushes the arrival date to the server with the record", async () => {
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-085",
      source: "bought",
      arrival_date: "2026-08-12",
    });

    const queued = await db.outbox.where("id").equals(record.id).first();
    expect(queued!.data.arrival_date).toBe("2026-08-12");
  });

  it("still leaves an animal age-unknown when only the arrival date is known", async () => {
    // SPEC 13.4 — an arrival date is not an age. A two-year-old cow bought last
    // week arrived last week and is not a week old, so no schedule may fire.
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-086",
      source: "bought",
      arrival_date: "2026-08-12",
    });

    expect(record.date_of_birth).toBeNull();
    expect(ageBasis(record)).toBeNull();
  });

  it("holds an animal at exactly one head", async () => {
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      head_count: 9,
    });
    expect(record.head_count).toBe(1);
  });
});

describe("buying a record", () => {
  it("writes the purchase in the same transaction as the record", async () => {
    // SPEC 3.7 — created automatically with source = bought. Two writes means a
    // tab closed between them leaves an animal on the device with no cost.
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      price: 1_500_000,
      seller: "Nakawa market",
    });

    const purchases = await db.purchases.where("record_id").equals(record.id).toArray();
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ price: 1_500_000, seller: "Nakawa market", count: 1 });

    const entities = (await db.outbox.orderBy("queue_id").toArray()).map((o) => o.entity);
    expect(entities).toEqual(["record", "purchase"]);
  });

  it("carries the group's head count onto the purchase", async () => {
    const record = await createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      head_count: 12,
      source: "bought",
      price: 2_400_000,
    });

    const purchase = (await db.purchases.where("record_id").equals(record.id).toArray())[0];
    // The price is the total for the lot, not per head (SPEC 3.8's rule for
    // sales, applied to the other side of the trade).
    expect(purchase).toMatchObject({ count: 12, price: 2_400_000 });
  });

  it("records nothing for an animal that was not bought", async () => {
    // A price typed and then switched to "born here" must not leave a purchase
    // behind for an animal that cost nothing.
    const record = await createRecord({
      kind: "animal",
      species: "goats",
      tag: "G-001",
      source: "born_here",
      price: 900_000,
    });

    expect(await db.purchases.where("record_id").equals(record.id).count()).toBe(0);
  });

  it("records nothing when the price is blank", async () => {
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-085",
      source: "bought",
      price: null,
    });

    expect(await db.purchases.where("record_id").equals(record.id).count()).toBe(0);
  });
});

describe("editing a record", () => {
  it("stamps the offspring figure with the day it changed", async () => {
    // SPEC 3.4 — the number is typed by hand, and the screen prints
    // "2 (updated 12 Aug)" beside it so a stale figure looks stale.
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      sex: "female",
      source: "bought",
    });
    expect(record.offspring_updated_at).toBeNull();

    await updateRecord(record.id, { offspring_count: 2 });

    const updated = await db.records.get(record.id);
    expect(updated!.offspring_count).toBe(2);
    expect(updated!.offspring_updated_at).toBe(todayInEAT());
  });

  it("leaves the stamp alone when the figure did not change", async () => {
    // Re-saving the form without touching the number must not make an old
    // count look freshly confirmed.
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      sex: "female",
      source: "bought",
    });
    await updateRecord(record.id, { offspring_count: 2 });
    await db.records.update(record.id, { offspring_updated_at: "2026-01-05" });

    await updateRecord(record.id, { offspring_count: 2, breed: "Friesian" });

    const updated = await db.records.get(record.id);
    expect(updated!.offspring_updated_at).toBe("2026-01-05");
    expect(updated!.breed).toBe("Friesian");
  });

  it("pushes only the fields whose value actually changed", async () => {
    // A form hands back everything it manages. Pushing the untouched fields too
    // would assert this device's stale values for them and beat another
    // device's genuine edit on timestamp — manufacturing the very conflict the
    // per-field merge exists to avoid (SPEC 5.4). Found end to end, in
    // frontend/e2e/two-device-convergence.mjs, not here.
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      breed: "Hereford",
      source: "bought",
    });
    await db.outbox.clear();

    // Exactly what the edit dialog sends: every field it manages, one changed.
    await updateRecord(record.id, {
      tag: "C-084",
      breed: "Hereford",
      notes: "Quiet with the calves",
    });

    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(Object.keys(queued[0]!.data)).toEqual(["notes"]);
  });

  it("queues nothing at all when a form is saved unchanged", async () => {
    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-085", breed: "Angus", source: "bought",
    });
    await db.outbox.clear();

    await updateRecord(record.id, { tag: "C-085", breed: "Angus", notes: null });

    expect(await db.outbox.count()).toBe(0);
  });

  it("never pushes the head count", async () => {
    // It is derived on the server from sales, deaths and splits (SPEC 6.7).
    // A typed-in number arriving late would beat another device's real sale.
    const record = await createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      head_count: 12,
      source: "bought",
    });
    await db.outbox.clear();

    await updateRecord(record.id, { breed: "Landrace" });

    const queued = await db.outbox.toArray();
    expect(Object.keys(queued[0]!.data)).toEqual(["breed"]);
  });
});

describe("moving", () => {
  it("appends an event and updates the derived room", async () => {
    await seedRoomsIfEmpty();
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      room_id: seedRoomId(1),
      // Dated explicitly. Location is ordered by date before created_at
      // (SPEC 4.1), so a placement left to default to today would outrank a
      // move dated in the past and this test would depend on the calendar.
      date: "2026-08-30",
    });

    await recordMove({
      record_id: record.id,
      to_room_id: seedRoomId(3),
      date: "2026-08-31",
      reason: "routine",
    });

    const moves = await db.moves.where("record_id").equals(record.id).toArray();
    expect(moves).toHaveLength(2);
    expect(currentRoomId(moves)).toBe(seedRoomId(3));
  });

  it("refuses to move a record into the room it is already in", async () => {
    // SPEC 6.4 — the current room is not selectable.
    await seedRoomsIfEmpty();
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      room_id: seedRoomId(1),
    });

    await expect(
      recordMove({ record_id: record.id, to_room_id: seedRoomId(1), date: "2026-08-31", reason: "routine" }),
    ).rejects.toThrow(/already in this room/);
  });

  it("refuses to move a sold record", async () => {
    // SPEC 6.2 — actions on an inactive record are hidden, not merely disabled.
    await seedRoomsIfEmpty();
    const record = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      room_id: seedRoomId(1),
    });
    await db.records.put({ ...record, status: "sold" });

    await expect(
      recordMove({ record_id: record.id, to_room_id: seedRoomId(2), date: "2026-08-31", reason: "routine" }),
    ).rejects.toThrow(/sold/);
  });

  it("splits a group when only part of it moves", async () => {
    // SPEC 4.3.
    await seedRoomsIfEmpty();
    const group = await createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      source: "bought",
      head_count: 10,
      room_id: seedRoomId(1),
    });

    const { splitRecord } = await recordMove({
      record_id: group.id,
      to_room_id: seedRoomId(2),
      date: "2026-08-31",
      reason: "weaning",
      count: 4,
    });

    expect(splitRecord).not.toBeNull();
    expect(splitRecord!.tag).toBe("P-Weaners-2");
    expect(splitRecord!.initial_head_count).toBe(4);
    expect(splitRecord!.parent_record_id).toBe(group.id);
    expect((await db.records.get(group.id))!.head_count).toBe(6);
  });

  it("does not push the original group's head count", async () => {
    // The server derives it from the child. Pushing this device's arithmetic
    // would let it overwrite another device's sale (SPEC 6.7).
    await seedRoomsIfEmpty();
    const group = await createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      source: "bought",
      head_count: 10,
      room_id: seedRoomId(1),
    });
    await db.outbox.clear();

    await recordMove({
      record_id: group.id,
      to_room_id: seedRoomId(2),
      date: "2026-08-31",
      reason: "weaning",
      count: 4,
    });

    const queued = await db.outbox.toArray();
    const parentUpdates = queued.filter((o) => o.entity === "record" && o.id === group.id);
    expect(parentUpdates).toHaveLength(0);
    expect(queued.some((o) => "head_count" in o.data)).toBe(false);
  });

  it("gives the split its own move history from the destination", async () => {
    await seedRoomsIfEmpty();
    const group = await createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      source: "bought",
      head_count: 10,
      room_id: seedRoomId(1),
    });

    const { splitRecord } = await recordMove({
      record_id: group.id,
      to_room_id: seedRoomId(2),
      date: "2026-08-31",
      reason: "weaning",
      count: 4,
    });

    const childMoves = await db.moves.where("record_id").equals(splitRecord!.id).toArray();
    expect(childMoves).toHaveLength(1);
    expect(currentRoomId(childMoves)).toBe(seedRoomId(2));
    expect((await db.moves.where("record_id").equals(group.id).toArray())).toHaveLength(1);
  });

  it("moves the whole group when the full count is taken", async () => {
    await seedRoomsIfEmpty();
    const group = await createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      source: "bought",
      head_count: 10,
      room_id: seedRoomId(1),
    });

    const { splitRecord } = await recordMove({
      record_id: group.id,
      to_room_id: seedRoomId(2),
      date: "2026-08-31",
      reason: "routine",
      count: 10,
    });

    expect(splitRecord).toBeNull();
    expect((await db.records.get(group.id))!.head_count).toBe(10);
  });
});

describe("selling and dying", () => {
  async function group(head: number) {
    return createRecord({
      kind: "group",
      species: "pigs",
      tag: "P-Weaners",
      head_count: head,
      source: "bought",
    });
  }

  it("takes part of a group without creating a child record", async () => {
    // SPEC 4.3 — unlike a partial move, a sale creates nothing new. The
    // quantity simply leaves and the Sale row carries the count.
    const record = await group(10);

    await recordSale({ record_id: record.id, date: "2026-08-31", price: 900_000, count: 4 });

    expect(await db.records.count()).toBe(1);
    expect((await db.records.get(record.id))!.head_count).toBe(6);
    expect((await db.records.get(record.id))!.status).toBe("active");
  });

  it("marks the record sold once the last of it goes", async () => {
    // SPEC 6.1 — the record leaves the active lists and its history stays.
    const record = await group(4);

    await recordSale({ record_id: record.id, date: "2026-08-31", price: 900_000, count: 4 });

    const after = await db.records.get(record.id);
    expect(after!.head_count).toBe(0);
    expect(after!.status).toBe("sold");
  });

  it("keeps both sales and clamps at zero when a group is oversold", async () => {
    // SPEC 6.7, the case the whole sync design exists for. Two offline devices
    // each sell five from a group of eight. Neither sale may be discarded.
    const record = await group(8);

    await recordSale({ record_id: record.id, date: "2026-08-31", price: 500_000, count: 5 });
    await db.records.update(record.id, { head_count: 8, status: "active" }); // the other device's view
    await recordSale({ record_id: record.id, date: "2026-08-31", price: 500_000, count: 5 });

    const sales = await db.sales.where("record_id").equals(record.id).toArray();
    expect(sales).toHaveLength(2);
    expect((await db.records.get(record.id))!.head_count).toBe(3);
    expect(sales.reduce((n, s) => n + s.count, 0)).toBe(10);
  });

  it("never pushes the head count", async () => {
    // The count is derived on the server from these very events (SPEC 3.4). A
    // pushed number would let the second device's arithmetic beat the first
    // device's real sale simply by arriving later.
    const record = await group(4);
    await db.outbox.clear();

    await recordSale({ record_id: record.id, date: "2026-08-31", price: 900_000, count: 4 });

    const pushed = await db.outbox.toArray();
    expect(pushed.map((o) => o.entity)).toEqual(["sale", "record"]);
    expect(Object.keys(pushed[1]!.data)).toEqual(["status"]);
  });

  it("refuses to sell a record that has already gone", async () => {
    // SPEC 6.2 — hidden on screen, but a stale tab could still get here.
    const record = await group(1);
    await recordSale({ record_id: record.id, date: "2026-08-31", price: 900_000 });

    await expect(
      recordSale({ record_id: record.id, date: "2026-08-31", price: 900_000 }),
    ).rejects.toThrow(/sold/);
  });

  it("records a death the same way, with its cause", async () => {
    const record = await group(3);

    await recordDeath({ record_id: record.id, date: "2026-08-31", cause: "illness", count: 3 });

    const after = await db.records.get(record.id);
    expect(after!.status).toBe("dead");
    expect((await db.deaths.toArray())[0]).toMatchObject({ cause: "illness", count: 3 });
  });

  it("cannot take more than the record holds", async () => {
    const record = await group(3);

    await recordDeath({ record_id: record.id, date: "2026-08-31", cause: "predator", count: 99 });

    expect((await db.deaths.toArray())[0]!.count).toBe(3);
    expect((await db.records.get(record.id))!.head_count).toBe(0);
  });
});

describe("seeding", () => {
  it("creates the ten rooms with R4 in isolation", async () => {
    // SPEC 6.10.
    await seedRoomsIfEmpty();
    const rooms = await db.rooms.toArray();

    expect(rooms).toHaveLength(10);
    expect(rooms.map((r) => r.code)).toContain("R10");
    expect(rooms.filter((r) => r.is_isolation).map((r) => r.code)).toEqual(["R4"]);
    expect(rooms.every((r) => r.capacity === 20)).toBe(true);
  });

  it("uses ids two devices would both arrive at", async () => {
    // Independent offline seeds must be the same rooms, or the first sync
    // produces twenty.
    await seedRoomsIfEmpty();
    const first = (await db.rooms.toArray()).map((r) => r.id).sort();

    await db.delete();
    await db.open();
    await seedRoomsIfEmpty();
    const second = (await db.rooms.toArray()).map((r) => r.id).sort();

    expect(second).toEqual(first);
  });

  it("does not run twice", async () => {
    await seedRoomsIfEmpty();
    await seedRoomsIfEmpty();
    expect(await db.rooms.count()).toBe(10);
  });

  it("leaves a room the user has renamed alone", async () => {
    await seedRoomsIfEmpty();
    await updateRoom(seedRoomId(1), { name: "Front room" });

    await seedRoomsIfEmpty();

    expect((await db.rooms.get(seedRoomId(1)))!.name).toBe("Front room");
  });
});

describe("derived values", () => {
  it("counts occupancy as head, not records", async () => {
    // SPEC 4.2 — and never as a percentage.
    await seedRoomsIfEmpty();
    await createRecord({
      kind: "group", species: "pigs", tag: "P-A", source: "bought",
      head_count: 25, room_id: seedRoomId(1),
    });
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-1", source: "bought",
      room_id: seedRoomId(1),
    });

    const inRoom = await db.records.where("current_room_id").equals(seedRoomId(1)).toArray();
    expect(occupancy(inRoom)).toBe(26);
  });

  it("calls a room with two species Mixed", async () => {
    await seedRoomsIfEmpty();
    const room = (await db.rooms.get(seedRoomId(1)))!;
    await createRecord({ kind: "animal", species: "cattle", tag: "C-1", source: "bought", room_id: room.id });
    await createRecord({ kind: "animal", species: "pigs", tag: "P-1", source: "bought", room_id: room.id });

    const inRoom = await db.records.where("current_room_id").equals(room.id).toArray();
    expect(roomType(room, inRoom)).toBe("Mixed");
  });

  it("calls the isolation room Isolation whatever is in it", async () => {
    await seedRoomsIfEmpty();
    const room = (await db.rooms.get(seedRoomId(4)))!;
    await createRecord({ kind: "animal", species: "cattle", tag: "C-1", source: "bought", room_id: room.id });

    const inRoom = await db.records.where("current_room_id").equals(room.id).toArray();
    expect(roomType(room, inRoom)).toBe("Isolation");
  });

  it("blocks a duplicate tag and names the room it is in", async () => {
    // SPEC 6.5.
    await seedRoomsIfEmpty();
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(3),
    });

    const clash = findTagClash("C-084", await db.records.toArray(), await db.rooms.toArray());
    expect(clash).not.toBeNull();
    expect(clash!.roomCode).toBe("R3");
  });

  it("frees a tag once its record is sold", async () => {
    await seedRoomsIfEmpty();
    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(3),
    });
    await db.records.put({ ...record, status: "sold" });

    const clash = findTagClash("C-084", await db.records.toArray(), await db.rooms.toArray());
    expect(clash).toBeNull();
  });
});
