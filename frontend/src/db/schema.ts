import Dexie, { type Table } from "dexie";

import {
  POULTRY_REPLACEMENT,
  expensesToRemapFromPoultry,
  recordsToRemapFromPoultry,
  recoverAnimalArrivalDates,
  schedulesToRemapFromPoultry,
} from "./backfill";

import type {
  Customer,
  Death,
  Expense,
  ExpenseCategory,
  HealthRecord,
  Move,
  OutboxOperation,
  Purchase,
  Record_,
  Room,
  Sale,
  SyncMeta,
  TreatmentSchedule,
  Vet,
  VetVisit,
  VisitNote,
} from "./types";

/**
 * The local database. This is the app's primary store, not a cache of the
 * server's: every screen reads from here, and every mutation writes here first
 * (SPEC 5.1). The server holds the same rows, and sync reconciles the two.
 *
 * Indexes are chosen for the queries the screens actually run — SPEC 6.13 says
 * to assume thousands of rows, so nothing here scans the whole table.
 */
export class RoomInventoryDB extends Dexie {
  rooms!: Table<Room, string>;
  records!: Table<Record_, string>;
  moves!: Table<Move, string>;
  purchases!: Table<Purchase, string>;
  healthRecords!: Table<HealthRecord, string>;
  sales!: Table<Sale, string>;
  deaths!: Table<Death, string>;
  expenseCategories!: Table<ExpenseCategory, string>;
  expenses!: Table<Expense, string>;
  customers!: Table<Customer, string>;
  vets!: Table<Vet, string>;
  treatmentSchedules!: Table<TreatmentSchedule, string>;
  vetVisits!: Table<VetVisit, string>;
  visitNotes!: Table<VisitNote, string>;
  outbox!: Table<OutboxOperation, number>;
  meta!: Table<SyncMeta, string>;

  constructor(name = "room-inventory") {
    super(name);
    this.version(1).stores({
      rooms: "id, code, deleted_at",
      records: "id, status, species, tag, current_room_id, parent_record_id, [status+current_room_id]",
      // Current location is the latest move by (date, created_at) — SPEC 4.1 —
      // so the history index is compound on exactly that.
      moves: "id, record_id, [record_id+date], date",
      outbox: "++queue_id, entity, id, next_attempt_at",
      meta: "key",
    });

    // Room detail's move log looks a room's moves up from both ends. Devices
    // already carry a version 1 database, so the two indexes arrive as an
    // upgrade rather than an edit to version 1 — changing a shipped version's
    // schema in place leaves those devices without the indexes the queries need.
    this.version(2).stores({
      moves: "id, record_id, [record_id+date], date, to_room_id, from_room_id",
    });

    // SPEC 3.7. Looked up by record, and by date for the money screens.
    this.version(3).stores({
      purchases: "id, record_id, date",
    });

    // SPEC 3.6. `next_due` is indexed because Alerts and Calendar both scan it
    // across every record rather than reading one animal's history.
    this.version(4).stores({
      healthRecords: "id, record_id, date, next_due",
    });

    // SPEC 3.8 and 3.9. These decide when a record stopped being on the farm,
    // which SPEC 4.4 needs before it can stop charging it for feed.
    this.version(5).stores({
      sales: "id, record_id, date",
      deaths: "id, record_id, date",
    });

    // SPEC 3.10 and 3.11. No categories are seeded: the app ships with none and
    // the first expense creates the first one.
    this.version(6).stores({
      expenseCategories: "id, name",
      expenses: "id, category_id, date",
      customers: "id, name",
      vets: "id, name",
    });

    // SPEC 13. `schedule_id` joins a treatment back to the rule it satisfied,
    // and the due computation reads it per record, so it is indexed rather than
    // scanned (SPEC 6.13). Adding an index to `healthRecords` means restating
    // its whole index list: Dexie replaces a table's schema, it does not merge.
    this.version(7).stores({
      // `is_active` is deliberately not indexed. IndexedDB has no boolean key
      // type, so a boolean index silently matches nothing — the archived ones
      // are filtered in memory instead, over a table that holds a handful of
      // rows rather than thousands.
      treatmentSchedules: "id, species",
      healthRecords: "id, record_id, date, next_due, schedule_id",
    });

    /**
     * Recover the arrival dates that were discarded for animals.
     *
     * `createRecord` used to keep `arrival_date` only for groups, so the date
     * typed on the add form was dropped for an animal. It survived as the date
     * of the record's initial placement — the move with a null `from_room_id` —
     * and this reads it back from there. It recovers what the user entered
     * rather than guessing: the value written is the one they typed.
     *
     * The matching server-side recovery is
     * `backend/alembic/versions/0007_backfill_animal_arrival_date.py`, and both
     * derive the same date from the same move, so the two agree without
     * needing to talk.
     *
     * The correction is queued for the server as well as written locally. A
     * record created offline before the fix already has an outbox entry
     * carrying a null arrival date, and the server migration will have run long
     * before that entry arrives — so without this the null would land on the
     * server and be pulled back over the recovered value. The queued entry
     * carries the record's existing `updated_at` rather than now, so a genuine
     * later edit on another device still wins (SPEC 5.4).
     *
     * No table's shape changes, so `stores` names nothing: this version exists
     * only to carry the upgrade.
     */
    this.version(8).upgrade(async (tx) => {
      const [records, moves] = await Promise.all([
        tx.table("records").toArray(),
        tx.table("moves").toArray(),
      ]);

      for (const { recordId, arrival_date } of recoverAnimalArrivalDates(
        records as Record_[],
        moves as Move[],
      )) {
        const record = (records as Record_[]).find((r) => r.id === recordId)!;
        await tx.table("records").put({ ...record, arrival_date });
        await tx.table("outbox").add({
          op: "upsert",
          entity: "record",
          id: recordId,
          data: { arrival_date },
          // The record's existing stamp, not now: a genuine later edit on
          // another device must still win (SPEC 5.4).
          updated_at: record.updated_at,
          queued_at: new Date().toISOString(),
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
        });
      }
    });

    // SPEC 14. Visits are looked up by date for the list and the calendar;
    // notes and treatments are both looked up by the visit they belong to, so
    // the fee split never scans either table whole (SPEC 6.13). Adding
    // `visit_id` to `healthRecords` means restating its index list, because
    // Dexie replaces a table's schema rather than merging into it.
    this.version(9).stores({
      vetVisits: "id, date, status",
      visitNotes: "id, visit_id, record_id",
      healthRecords: "id, record_id, date, next_due, schedule_id, visit_id",
    });

    /**
     * SPEC 18 — split `poultry` into hens, ducks, geese and turkeys.
     *
     * The enum lost a value, so this moves every row still carrying it:
     * records onto `hens`, treatment schedules onto `birds`, and any expense
     * tagged to the species onto `hens` alongside the records it allocates to.
     * The three destinations differ on purpose and `backfill.ts` says why.
     *
     * Every change is queued for the server as well as written locally, for
     * the reason version 8 gives: a record created offline before this shipped
     * still has an outbox entry carrying `poultry`, and the server migration
     * will have run long before it arrives. Without a correction queued behind
     * it, that stale value would land on the server and be pulled straight
     * back over the remapped one.
     *
     * Each queued entry keeps the row's existing `updated_at` rather than now,
     * so a genuine later edit on another device still wins (SPEC 5.4). If the
     * farmer has already corrected a pen of ducks on their phone, this must
     * not overwrite it from the tablet.
     *
     * No table's shape changes, so `stores` names nothing.
     */
    this.version(10).upgrade(async (tx) => {
      const queued: Array<{ entity: string; id: string; data: Record<string, unknown>; updated_at: string }> = [];

      const records = (await tx.table("records").toArray()) as Record_[];
      const movedIds = new Set(recordsToRemapFromPoultry(records));
      for (const record of records) {
        if (!movedIds.has(record.id)) continue;
        await tx.table("records").put({ ...record, species: POULTRY_REPLACEMENT });
        queued.push({
          entity: "record",
          id: record.id,
          data: { species: POULTRY_REPLACEMENT },
          updated_at: record.updated_at,
        });
      }

      const schedules = (await tx.table("treatmentSchedules").toArray()) as TreatmentSchedule[];
      const scheduleIds = new Set(
        schedulesToRemapFromPoultry(schedules as Array<{ id: string; species: string }>),
      );
      for (const schedule of schedules) {
        if (!scheduleIds.has(schedule.id)) continue;
        await tx.table("treatmentSchedules").put({ ...schedule, species: "birds" });
        queued.push({
          entity: "treatment_schedule",
          id: schedule.id,
          data: { species: "birds" },
          updated_at: schedule.updated_at,
        });
      }

      const expenses = (await tx.table("expenses").toArray()) as Expense[];
      const expenseIds = new Set(expensesToRemapFromPoultry(expenses));
      for (const expense of expenses) {
        if (!expenseIds.has(expense.id)) continue;
        await tx.table("expenses").put({ ...expense, applies_to_id: POULTRY_REPLACEMENT });
        queued.push({
          entity: "expense",
          id: expense.id,
          data: { applies_to_id: POULTRY_REPLACEMENT },
          updated_at: expense.updated_at,
        });
      }

      for (const entry of queued) {
        await tx.table("outbox").add({
          op: "upsert",
          ...entry,
          queued_at: new Date().toISOString(),
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
        });
      }

      // Kept so Animals can say how many were moved. It is a guess for any bird
      // that was not a hen, and the only person who can tell is the one holding
      // the phone.
      await tx.table("meta").put({ key: "poultry_split_count", value: movedIds.size });
    });
  }
}

export const db = new RoomInventoryDB();

/** Keys held in `meta`. */
export const META = {
  /** Highest server `seq` this device has pulled. */
  cursor: "sync_cursor",
  /** This device's stable id, used to break conflict ties. */
  deviceId: "device_id",
  /** When the last successful push or pull completed. */
  lastSyncAt: "last_sync_at",
  /** Whether the ten rooms have been seeded locally. */
  seeded: "rooms_seeded",
  /** Whether the starter treatment schedules have been seeded locally (SPEC 13.5). */
  schedulesSeeded: "schedules_seeded",
  /** When an export was last taken. SPEC 10 wants backups confirmed rather
   *  than assumed, and this is the device's half of that. */
  lastBackupAt: "last_backup_at",
  /** How many records the SPEC 18 split moved from `poultry` onto `hens`, and
   *  whether that has been shown. The count is kept because the remap is a
   *  guess for any bird that was not a hen, and the person who knows which is
   *  which has to be told there is something to check. */
  poultrySplit: "poultry_split_count",
  poultrySplitSeen: "poultry_split_seen",
} as const;

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
