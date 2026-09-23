import { beforeEach, describe, expect, it } from "vitest";

import { computeAlerts } from "../domain/alerts";
import { isAgeUnknown, recordsWithUnknownAge } from "../domain/age";
import { offspringTotal } from "../domain/births";
import { resetDeviceIdCache, todayInEAT } from "./ids";
import { createRecord, recordBirth, recordSale } from "./mutations";
import { birthsForDam, offspringOf } from "./queries";
import { db } from "./schema";
import { seedRoomId, seedRoomsIfEmpty } from "./seed";

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetDeviceIdCache();
  await seedRoomsIfEmpty();
});

async function dam(overrides: Parameters<typeof createRecord>[0] | object = {}) {
  return createRecord({
    kind: "animal",
    species: "cattle",
    tag: "C-084",
    breed: "Friesian",
    sex: "female",
    date_of_birth: "2023-05-01",
    source: "bought",
    room_id: seedRoomId(3),
    date: "2026-01-02",
    ...(overrides as object),
  } as Parameters<typeof createRecord>[0]);
}

/**
 * SPEC 22 — what a birth does, end to end, in one transaction.
 *
 * These go through the real Dexie store rather than a mock, because the thing
 * being asserted is that all of it lands together: the event, the offspring,
 * their placement, and the stillbirths. A half-written birth is one of the two
 * silent failures the feature exists to end.
 */
describe("recording a birth", () => {
  it("creates an offspring with an exact date of birth", async () => {
    const mother = await dam();
    const { offspring } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    expect(offspring).toHaveLength(1);
    const calf = (await db.records.get(offspring[0]!.id))!;
    expect(calf.date_of_birth).toBe("2026-09-01");
    expect(calf.source).toBe("born_here");
    // The whole point: an age exists, so a schedule can fire (SPEC 13.4).
    expect(isAgeUnknown(calf)).toBe(false);
  });

  it("inherits the species and breed from the dam", async () => {
    const mother = await dam();
    const { offspring } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "male", survived: true }],
    });
    expect(offspring[0]).toMatchObject({ species: "cattle", breed: "Friesian", sex: "male" });
  });

  it("places the offspring in the dam's room, as an initial move", async () => {
    const mother = await dam();
    const { offspring } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    const moves = await db.moves.where("record_id").equals(offspring[0]!.id).toArray();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      from_room_id: null,
      to_room_id: seedRoomId(3),
      date: "2026-09-01",
      reason: "new_arrival",
    });
    expect((await db.records.get(offspring[0]!.id))!.current_room_id).toBe(seedRoomId(3));
  });

  it("places nothing when the dam is in no room", async () => {
    const mother = await dam({ room_id: null });
    const { offspring } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });
    // An invented room would be a location nobody recorded.
    expect(await db.moves.where("record_id").equals(offspring[0]!.id).count()).toBe(0);
  });

  it("records a stillbirth for every one that did not survive", async () => {
    const mother = await dam();
    const { offspring, deaths } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 2,
      surviving_count: 1,
      offspring: [
        { tag: "C-084-1", sex: "female", survived: true },
        { tag: "C-084-2", survived: false },
      ],
    });

    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toMatchObject({ count: 1, cause: "stillbirth", date: "2026-09-01" });

    // The lost one has a record of its own, which is what the death hangs off.
    const lost = (await db.records.get(offspring[1]!.id))!;
    expect(lost.status).toBe("dead");
    expect(lost.head_count).toBe(0);
    expect(lost.date_of_birth).toBe("2026-09-01");
  });

  it("leaves the dam's own record alone", async () => {
    const mother = await dam();
    await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 2,
      surviving_count: 1,
      offspring: [
        { tag: "C-084-1", sex: "female", survived: true },
        { tag: "C-084-2", survived: false },
      ],
    });

    const after = (await db.records.get(mother.id))!;
    // Giving birth takes nothing out of her, and a stillbirth is against the
    // offspring's record rather than hers — if it were not, a single animal's
    // mother would have been marked dead by her own calf's loss.
    expect(after.head_count).toBe(1);
    expect(after.status).toBe("active");
    // And the typed baseline is untouched: two sources of truth is what SPEC 22
    // forbids.
    expect(after.offspring_baseline).toBeNull();
  });

  it("records more than two as one group, holding everything born", async () => {
    const hen = await dam({ kind: "group", tag: "H-Layers", species: "hens", sex: null, head_count: 12, date_of_birth: null, arrival_date: "2026-02-01" });
    const { offspring, deaths } = await recordBirth({
      dam_record_id: hen.id,
      date: "2026-09-01",
      born_count: 20,
      surviving_count: 18,
      offspring: [{ tag: "H-Layers-1", survived: true }],
      as_group: true,
    });

    expect(offspring).toHaveLength(1);
    const chicks = (await db.records.get(offspring[0]!.id))!;
    expect(chicks.kind).toBe("group");
    expect(chicks.initial_head_count).toBe(20);
    // The two that did not survive leave by the same route as any other death,
    // so the head count derives to 18 rather than being typed.
    expect(chicks.head_count).toBe(18);
    expect(deaths[0]).toMatchObject({ count: 2, cause: "stillbirth" });
    // A group counts its age from arrival (SPEC 13.3), and a group born here
    // arrived the day it was born.
    expect(chicks.arrival_date).toBe("2026-09-01");
    expect(isAgeUnknown(chicks)).toBe(false);
  });

  it("queues the birth before the records that point at it", async () => {
    const mother = await dam();
    await db.outbox.clear();
    await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    const entities = (await db.outbox.orderBy("queue_id").toArray()).map((o) => o.entity);
    expect(entities).toEqual(["birth", "record", "move"]);
  });

  it("links the offspring to its mother and father, both ways", async () => {
    const mother = await dam();
    const father = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-900",
      sex: "male",
      source: "bought",
    });

    const { birth, offspring } = await recordBirth({
      dam_record_id: mother.id,
      sire_record_id: father.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    expect(offspring[0]).toMatchObject({
      dam_record_id: mother.id,
      sire_record_id: father.id,
      birth_id: birth.id,
    });
    expect((await offspringOf(mother.id)).map((r) => r.tag)).toEqual(["C-084-1"]);
    expect((await birthsForDam(mother.id)).map((b) => b.id)).toEqual([birth.id]);
  });

  it("records an outside sire as a name, with no record to point at", async () => {
    const mother = await dam();
    const { birth } = await recordBirth({
      dam_record_id: mother.id,
      sire_name: "A bull from the next farm",
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });
    expect(birth.sire_record_id).toBeNull();
    expect(birth.sire_name).toBe("A bull from the next farm");
  });

  it("refuses a male dam even from a stale screen", async () => {
    const bull = await dam({ tag: "C-900", sex: "male" });
    await expect(
      recordBirth({
        dam_record_id: bull.id,
        date: "2026-09-01",
        born_count: 1,
        surviving_count: 1,
        offspring: [{ tag: "C-900-1", sex: "female", survived: true }],
      }),
    ).rejects.toThrow(/not recorded as female/);
  });

  it("records a backdated birth against a dam who has since been sold", async () => {
    const mother = await dam();
    await recordSale({ record_id: mother.id, date: "2026-08-01", price: 2_000_000 });

    const { offspring } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-06-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });
    // The birth really happened. Refusing it would lose it (SPEC 22).
    expect(offspring[0]!.date_of_birth).toBe("2026-06-01");
  });

  it("keeps everything or nothing when the dam does not exist", async () => {
    await expect(
      recordBirth({
        dam_record_id: "nobody",
        date: "2026-09-01",
        born_count: 1,
        surviving_count: 1,
        offspring: [{ tag: "X-1", survived: true }],
      }),
    ).rejects.toThrow();

    expect(await db.births.count()).toBe(0);
    expect(await db.records.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

/**
 * SPEC 22 — "Check the 'no date of birth' alert drops for them."
 *
 * The alert counts active records whose age cannot be worked out (SPEC 13.4).
 * An animal born on the farm used to land in it the moment it was created,
 * because nothing knew when it was born. A birth gives it an exact date, so it
 * never enters the count at all.
 */
describe("the no-date-of-birth alert", () => {
  it("does not count an animal created from a birth", async () => {
    const mother = await dam();
    await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    const records = await db.records.toArray();
    expect(recordsWithUnknownAge(records)).toEqual([]);

    const alerts = computeAlerts({
      rooms: await db.rooms.toArray(),
      records,
      moves: await db.moves.toArray(),
      health: [],
      today: todayInEAT(),
    });
    expect(alerts.filter((a) => a.kind === "no_date_of_birth")).toEqual([]);
  });

  it("still counts an animal typed in with no date of birth", async () => {
    // The alert has not been weakened: it covers every record whose age is
    // unknown, which is now only the ones nobody entered a date for.
    await dam({ tag: "C-500", date_of_birth: null });

    const records = await db.records.toArray();
    const alerts = computeAlerts({
      rooms: await db.rooms.toArray(),
      records,
      moves: await db.moves.toArray(),
      health: [],
      today: todayInEAT(),
    });
    const alert = alerts.find((a) => a.kind === "no_date_of_birth");
    expect(alert?.count).toBe(1);
  });

  it("counts the mother's offspring against her total", async () => {
    const mother = await dam();
    await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 3,
      surviving_count: 2,
      offspring: [{ tag: "C-084-1", survived: true }],
      as_group: true,
    });

    const after = (await db.records.get(mother.id))!;
    expect(offspringTotal(after, await db.births.toArray())).toMatchObject({
      total: 2,
      baseline: null,
      fromBirths: 2,
    });
  });
});
