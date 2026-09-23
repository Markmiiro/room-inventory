import { setTokens } from "../sync/api";
import { META, db, setMeta } from "./schema";
import {
  SEED_PRODUCE_TYPE_COUNT,
  SEED_ROOM_COUNT,
  SEED_SCHEDULE_COUNT,
  SEED_STORE_COUNT,
  seedProduceTypeId,
  seedRoomId,
  seedScheduleId,
  seedStoreId,
} from "./seed";

/**
 * Clear this device. SPEC 23.
 *
 * The same shape as `backend/scripts/reset_data.py`, on the other side of the
 * wire: every recorded row goes, the seeded rows stay at their fixed ids, and
 * the device keeps its own identity.
 *
 * It exists because the alternative was walking somebody through iOS Settings
 * and Android's app storage screens — four different paths, one of which (a
 * Home Screen app's own store) is invisible from the browser's own settings and
 * is the one people miss. A button in the app cannot be missed.
 *
 * **What it does not do is reach the server.** There is no endpoint that
 * deletes; a client can soft-delete a state entity but not an event (see
 * `WRITABLE` in `backend/app/sync.py`), so a device cannot wipe the farm for
 * everybody. If the server still holds rows, the next pull brings them back —
 * which is the truth rather than a bug, and the confirmation says so in words.
 */

/** What was removed, per table, for the report the screen shows afterwards. */
export type ClearSummary = Record<string, number>;

/**
 * The seeded ids, per Dexie table name.
 *
 * Built from the same helpers `seed.ts` uses, so a row added to any seed list
 * is covered here without a second edit — and so these ids cannot drift from
 * the ones the migrations wrote (SPEC 6.10). Losing them would not lose data;
 * it would produce a *second* set of ten rooms on the next sync, which is
 * worse, because it looks like a mistake somebody made rather than one the app
 * made.
 */
function seededIds(): Record<string, Set<string>> {
  const ids = (make: (index: number) => string, count: number) =>
    new Set(Array.from({ length: count }, (_, i) => make(i + 1)));

  return {
    rooms: ids(seedRoomId, SEED_ROOM_COUNT),
    treatmentSchedules: ids(seedScheduleId, SEED_SCHEDULE_COUNT),
    stores: ids(seedStoreId, SEED_STORE_COUNT),
    produceTypes: ids(seedProduceTypeId, SEED_PRODUCE_TYPE_COUNT),
  };
}

/**
 * `meta` is configuration, not records, and is edited rather than emptied.
 *
 * `device_id` in particular must survive: it is what breaks ties in conflict
 * resolution (SPEC 5.4), and a device that changed identity every time it was
 * cleared would be a device whose merges are unpredictable. The seeded flags
 * stay too, because the seeded rows themselves are staying.
 */
const KEPT_TABLES = new Set(["meta"]);

/** How much unsent work a clear would discard — named in the confirmation,
 *  because this is the one part of it that cannot be recovered from the
 *  server. */
export async function pendingChangeCount(): Promise<number> {
  return db.outbox.count();
}

export async function clearDeviceData(): Promise<ClearSummary> {
  const keep = seededIds();
  const summary: ClearSummary = {};

  // Every table Dexie knows about, rather than a list typed here. A table added
  // later is cleared by existing, which is the same rule the server script
  // follows and for the same reason: a missed table is a "fresh start" that
  // quietly keeps somebody's sale prices.
  const tables = db.tables.filter((table) => !KEPT_TABLES.has(table.name));

  await db.transaction("rw", tables.concat(db.meta), async () => {
    for (const table of tables) {
      const seeded = keep[table.name];
      if (seeded) {
        const rows = await table.toArray();
        const doomed = rows
          .map((row) => (row as { id: string }).id)
          .filter((id) => !seeded.has(id));
        await table.bulkDelete(doomed);
        summary[table.name] = doomed.length;
      } else {
        summary[table.name] = await table.count();
        await table.clear();
      }
    }

    /**
     * Back to the beginning of the server's history.
     *
     * The cursor is how much of the server this device has seen. Left where it
     * was, the device would never re-pull the rows it just deleted locally and
     * the two sides would disagree for ever — with nothing on screen saying so.
     * At zero, the next sync asks for everything and the device ends up holding
     * exactly what the server holds, which is the only state worth calling
     * cleared.
     */
    await setMeta(META.cursor, 0);
    await setMeta(META.lastSyncAt, null);
  });

  // Not records, but they belong to the session this device had rather than to
  // the next one. With auth on, the next sync asks for the password again;
  // SPEC 8's rule that an auth failure never wipes local data is untouched by
  // this, because the person just asked for exactly that.
  setTokens(null, null);
  try {
    localStorage.removeItem("auth_state");
  } catch {
    // Private windows and blocked site data throw here. Nothing downstream
    // depends on it: the state is re-read from `GET /config` on the next tick.
  }

  return summary;
}

/** The tables that actually lost something, for the report. */
export function clearedTables(summary: ClearSummary): Array<[string, number]> {
  return Object.entries(summary)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

export function totalCleared(summary: ClearSummary): number {
  return Object.values(summary).reduce((sum, count) => sum + count, 0);
}
