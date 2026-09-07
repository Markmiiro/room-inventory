import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import { RoomInventoryDB } from "./schema";

/**
 * SPEC 18 — the version 10 upgrade, run for real.
 *
 * `backfill.test.ts` covers the rules about *which* rows move. This covers the
 * wiring: that the upgrade fires at all, writes what the rules picked, queues
 * the corrections for the server, and records the count the Animals screen
 * shows. Those are separate failure modes — a correct rule that is never called
 * is indistinguishable, from the farm's side, from no migration at all.
 *
 * It works by building a database at version 9, exactly as a device that has
 * been running the shipped app has, and then opening it with the real class.
 * Dexie runs 9 → 10 on open, so what is exercised is the upgrade that ships
 * rather than a copy of it.
 */

const V9_STORES = {
  rooms: "id, code, deleted_at",
  records: "id, status, species, tag, current_room_id, parent_record_id, [status+current_room_id]",
  moves: "id, record_id, date",
  outbox: "++queue_id, entity, id, next_attempt_at",
  meta: "key",
  expenses: "id, category_id, date",
  treatmentSchedules: "id, species",
};

let opened: Array<Dexie | RoomInventoryDB> = [];

afterEach(async () => {
  for (const database of opened) {
    await database.delete().catch(() => {});
    database.close();
  }
  opened = [];
});

function stamped<T extends object>(over: T) {
  return {
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    ...over,
  };
}

/** A database as a device running the shipped app has it: version 9, with rows
 *  still on `poultry`. */
async function atVersion9(name: string, seed: (database: Dexie) => Promise<void>) {
  const old = new Dexie(name);
  old.version(9).stores(V9_STORES);
  await old.open();
  await seed(old);
  old.close();
}

/** Open with the real class, which runs the upgrade. */
async function upgrade(name: string): Promise<RoomInventoryDB> {
  const database = new RoomInventoryDB(name);
  opened.push(database);
  await database.open();
  return database;
}

describe("upgrading a device that still has poultry rows", () => {
  it("moves the records onto hens", async () => {
    const name = "split-records";
    await atVersion9(name, async (old) => {
      await old.table("records").bulkAdd([
        stamped({ id: "a", species: "poultry", tag: "P-1", status: "active", head_count: 40 }),
        stamped({ id: "b", species: "cattle", tag: "C-1", status: "active", head_count: 1 }),
      ]);
    });

    const database = await upgrade(name);

    expect((await database.records.get("a"))!.species).toBe("hens");
    // Everything else is left exactly as it was.
    expect((await database.records.get("b"))!.species).toBe("cattle");
  });

  it("moves the treatment schedules onto birds rather than hens", async () => {
    const name = "split-schedules";
    await atVersion9(name, async (old) => {
      await old.table("treatmentSchedules").add(
        stamped({ id: "s1", name: "Newcastle vaccination", species: "poultry", type: "vaccination" }),
      );
    });

    const database = await upgrade(name);

    // Narrowing this to hens would silently stop vaccinating the ducks.
    expect((await database.treatmentSchedules.get("s1"))!.species).toBe("birds");
  });

  it("moves an expense tagged to the poultry species", async () => {
    const name = "split-expenses";
    await atVersion9(name, async (old) => {
      await old.table("expenses").bulkAdd([
        stamped({ id: "e1", amount: 90_000, applies_to: "species", applies_to_id: "poultry" }),
        stamped({ id: "e2", amount: 10_000, applies_to: "room", applies_to_id: "poultry" }),
      ]);
    });

    const database = await upgrade(name);

    expect((await database.expenses.get("e1"))!.applies_to_id).toBe("hens");
    // A room id that merely reads "poultry" is not a species tag.
    expect((await database.expenses.get("e2"))!.applies_to_id).toBe("poultry");
  });

  /**
   * The reason version 8 queues its corrections too. A record created offline
   * before this shipped still has an outbox entry carrying `poultry`, and the
   * server migration will have run long before it arrives — so without a
   * correction queued behind it, the stale value lands on the server and is
   * pulled straight back over the remapped one.
   */
  it("queues every change for the server", async () => {
    const name = "split-outbox";
    await atVersion9(name, async (old) => {
      await old.table("records").add(stamped({ id: "a", species: "poultry", tag: "P-1" }));
      await old.table("treatmentSchedules").add(stamped({ id: "s1", species: "poultry" }));
    });

    const database = await upgrade(name);
    const queued = await database.outbox.toArray();

    expect(queued).toHaveLength(2);
    expect(queued.find((o) => o.entity === "record")).toMatchObject({
      id: "a",
      data: { species: "hens" },
    });
    expect(queued.find((o) => o.entity === "treatment_schedule")).toMatchObject({
      id: "s1",
      data: { species: "birds" },
    });
  });

  /**
   * SPEC 5.4. If the farmer has already corrected a pen of ducks on their
   * phone, the tablet's migration must not overwrite it — so the queued entry
   * carries the row's existing stamp rather than now.
   */
  it("keeps the row's existing updated_at so a real edit still wins", async () => {
    const name = "split-stamp";
    await atVersion9(name, async (old) => {
      await old.table("records").add(stamped({ id: "a", species: "poultry", tag: "P-1" }));
    });

    const database = await upgrade(name);

    expect((await database.outbox.toArray())[0]!.updated_at).toBe("2026-08-20T00:00:00Z");
  });

  it("records how many were moved, so the screen can say so", async () => {
    const name = "split-count";
    await atVersion9(name, async (old) => {
      await old.table("records").bulkAdd([
        stamped({ id: "a", species: "poultry", tag: "P-1" }),
        stamped({ id: "b", species: "poultry", tag: "P-2" }),
        stamped({ id: "c", species: "goats", tag: "G-1" }),
      ]);
    });

    const database = await upgrade(name);

    expect((await database.meta.get("poultry_split_count"))!.value).toBe(2);
  });

  it("queues nothing and counts nothing on a device that kept no poultry", async () => {
    const name = "split-none";
    await atVersion9(name, async (old) => {
      await old.table("records").add(stamped({ id: "a", species: "cattle", tag: "C-1" }));
    });

    const database = await upgrade(name);

    expect(await database.outbox.count()).toBe(0);
    expect((await database.meta.get("poultry_split_count"))!.value).toBe(0);
  });
});
