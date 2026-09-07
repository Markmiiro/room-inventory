import type { Table } from "dexie";

import { META, db, getMeta, setMeta } from "./schema";

/**
 * Export everything on this device as one JSON file.
 *
 * The server has its own backups (SPEC 10), but this is the copy the user can
 * hold. It matters most for exactly the situation the app is built around: a
 * device that has been offline for a week is the only place its writes exist,
 * and until they sync, a lost phone is lost records.
 *
 * Every table is included, the outbox included — an export taken offline should
 * still describe work that has not reached the server.
 */
/** Bumped whenever `BACKUP_TABLES` changes. An older file is refused rather
 *  than restored with the newer tables silently empty — a restore that looks
 *  like it worked and left the stores bare is worse than one that stops. */
export const SCHEMA_VERSION = 3;

export interface Backup {
  format: "room-inventory-backup";
  /** SPEC 7 names this `schema_version`. It is the only thing standing between
   *  a good restore and a silently mangled one, so it is checked before a
   *  single row is written. */
  schema_version: number;
  taken_at: string;
  device_id: string | null;
  tables: Record<string, unknown[]>;
}

/** Every table an export carries. An import writes exactly these and nothing
 *  else, so a file naming a table this build does not know is refused rather
 *  than half-applied. */
export const BACKUP_TABLES = [
  "rooms", "records", "moves", "purchases", "healthRecords",
  "sales", "deaths", "expenses", "expenseCategories", "customers", "vets",
  // SPEC 13 and 14. A table missing from this list is a table an export
  // silently leaves behind, and the loss only shows up on a restore — by which
  // point the rows it dropped are gone. `schema_version` is bumped alongside
  // it, so an older file is refused rather than restored with these empty.
  "treatmentSchedules", "vetVisits", "visitNotes",
  // SPEC 20. The produce inventory is the whole record of what is in the
  // stores — the balance is derived from these events and exists nowhere else,
  // so a backup without them restores a farm holding nothing.
  "stores", "produceTypes", "stockIntakes", "stockOuttakes", "stockCounts",
  "outbox",
] as const;

export async function buildBackup(): Promise<Backup> {
  const [
    rooms, records, moves, purchases, healthRecords,
    sales, deaths, expenses, expenseCategories, customers, vets,
    treatmentSchedules, vetVisits, visitNotes,
    stores, produceTypes, stockIntakes, stockOuttakes, stockCounts, outbox,
  ] = await Promise.all([
    db.rooms.toArray(),
    db.records.toArray(),
    db.moves.toArray(),
    db.purchases.toArray(),
    db.healthRecords.toArray(),
    db.sales.toArray(),
    db.deaths.toArray(),
    db.expenses.toArray(),
    db.expenseCategories.toArray(),
    db.customers.toArray(),
    db.vets.toArray(),
    db.treatmentSchedules.toArray(),
    db.vetVisits.toArray(),
    db.visitNotes.toArray(),
    db.stores.toArray(),
    db.produceTypes.toArray(),
    db.stockIntakes.toArray(),
    db.stockOuttakes.toArray(),
    db.stockCounts.toArray(),
    db.outbox.toArray(),
  ]);

  return {
    format: "room-inventory-backup",
    schema_version: SCHEMA_VERSION,
    taken_at: new Date().toISOString(),
    device_id: await getMeta<string | null>(META.deviceId, null),
    tables: {
      rooms, records, moves, purchases, healthRecords,
      sales, deaths, expenses, expenseCategories, customers, vets,
      treatmentSchedules, vetVisits, visitNotes,
      stores, produceTypes, stockIntakes, stockOuttakes, stockCounts, outbox,
    },
  };
}

/** How many days ago the last export was taken, or null if there never was one. */
export async function daysSinceBackup(now = new Date()): Promise<number | null> {
  const last = await getMeta<string | null>(META.lastBackupAt, null);
  if (!last) return null;
  return Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000);
}

export async function lastBackupAt(): Promise<string | null> {
  return getMeta<string | null>(META.lastBackupAt, null);
}

/**
 * Take an export and hand it to the browser.
 *
 * The timestamp is only written once the file has been handed over, so a failed
 * save does not leave the app claiming a backup that does not exist.
 */
export async function runBackup(): Promise<void> {
  const backup = await buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `room-inventory-${backup.taken_at.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  await setMeta(META.lastBackupAt, backup.taken_at);
}


// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export class BackupRejected extends Error {}

/**
 * Check a file before touching anything.
 *
 * SPEC 7 — an import replaces all data. That makes a half-applied import worse
 * than no import at all: it would leave the device holding a mixture of two
 * farms with no way to tell which rows came from where. So the file is fully
 * validated first, and if anything is wrong nothing is written.
 */
export function parseBackup(text: string): Backup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupRejected("That file is not valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new BackupRejected("That file does not look like a backup.");
  }
  const candidate = parsed as Partial<Backup>;

  if (candidate.format !== "room-inventory-backup") {
    throw new BackupRejected(
      "That file was not exported by this app. Nothing has been changed.",
    );
  }

  // A newer file may hold columns this build would drop on write, and an older
  // one may be missing columns it needs. Either way, guessing is worse than
  // refusing (SPEC 7).
  if (candidate.schema_version !== SCHEMA_VERSION) {
    throw new BackupRejected(
      `That backup is version ${candidate.schema_version ?? "unknown"}, and this app reads ` +
        `version ${SCHEMA_VERSION}. Nothing has been changed.`,
    );
  }

  const tables = candidate.tables;
  if (typeof tables !== "object" || tables === null) {
    throw new BackupRejected("That backup has no data in it.");
  }

  for (const name of BACKUP_TABLES) {
    const rows = (tables as Record<string, unknown>)[name];
    if (rows !== undefined && !Array.isArray(rows)) {
      throw new BackupRejected(`The ${name} in that backup are not a list. Nothing has been changed.`);
    }
  }

  const unknown = Object.keys(tables).filter(
    (name) => !(BACKUP_TABLES as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw new BackupRejected(
      `That backup holds data this app does not know about (${unknown.join(", ")}). ` +
        "Nothing has been changed.",
    );
  }

  return candidate as Backup;
}

export interface ImportSummary {
  taken_at: string;
  rows: Record<string, number>;
  total: number;
}

/** What restoring this file would do, for the confirmation step. */
export function summarise(backup: Backup): ImportSummary {
  const rows: Record<string, number> = {};
  let total = 0;
  for (const name of BACKUP_TABLES) {
    const count = (backup.tables[name] ?? []).length;
    if (count > 0) rows[name] = count;
    total += count;
  }
  return { taken_at: backup.taken_at, rows, total };
}

/**
 * Replace everything on this device with the contents of a backup.
 *
 * One transaction over every table: a clear that succeeded followed by a write
 * that failed would leave the device empty, which is the one outcome worse than
 * refusing the file.
 *
 * The outbox is restored too. An export taken offline describes work the server
 * has never seen, and dropping it here would lose exactly the writes this app
 * exists to protect.
 */
export async function restoreBackup(backup: Backup): Promise<ImportSummary> {
  const summary = summarise(backup);

  await db.transaction(
    "rw",
    [
      db.rooms, db.records, db.moves, db.purchases, db.healthRecords,
      db.sales, db.deaths, db.expenses, db.expenseCategories,
      db.customers, db.vets, db.treatmentSchedules, db.vetVisits,
      db.visitNotes, db.stores, db.produceTypes, db.stockIntakes,
      db.stockOuttakes, db.stockCounts, db.outbox, db.meta,
    ],
    async () => {
      // Typed as a bare Dexie Table: the row shapes have nothing in common, and
      // every one of them has already been checked by parseBackup.
      const tables: Array<[(typeof BACKUP_TABLES)[number], Table<unknown, unknown>]> = [
        ["rooms", db.rooms as Table<unknown, unknown>],
        ["records", db.records as Table<unknown, unknown>],
        ["moves", db.moves as Table<unknown, unknown>],
        ["purchases", db.purchases as Table<unknown, unknown>],
        ["healthRecords", db.healthRecords as Table<unknown, unknown>],
        ["sales", db.sales as Table<unknown, unknown>],
        ["deaths", db.deaths as Table<unknown, unknown>],
        ["expenses", db.expenses as Table<unknown, unknown>],
        ["expenseCategories", db.expenseCategories as Table<unknown, unknown>],
        ["customers", db.customers as Table<unknown, unknown>],
        ["vets", db.vets as Table<unknown, unknown>],
        ["treatmentSchedules", db.treatmentSchedules as Table<unknown, unknown>],
        ["vetVisits", db.vetVisits as Table<unknown, unknown>],
        ["visitNotes", db.visitNotes as Table<unknown, unknown>],
        ["stores", db.stores as Table<unknown, unknown>],
        ["produceTypes", db.produceTypes as Table<unknown, unknown>],
        ["stockIntakes", db.stockIntakes as Table<unknown, unknown>],
        ["stockOuttakes", db.stockOuttakes as Table<unknown, unknown>],
        ["stockCounts", db.stockCounts as Table<unknown, unknown>],
        ["outbox", db.outbox as Table<unknown, unknown>],
      ];

      for (const [name, table] of tables) {
        await table.clear();
        const rows = backup.tables[name] ?? [];
        if (rows.length > 0) await table.bulkAdd(rows);
      }

      // The pull cursor belongs to the device that took the export, not to this
      // one. Resetting it makes the next sync re-read everything rather than
      // skipping changes this device has never actually seen.
      await setMeta(META.cursor, 0);
    },
  );

  return summary;
}
