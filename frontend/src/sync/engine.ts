import { getDeviceId } from "../db/ids";
import { META, db, getMeta, setMeta } from "../db/schema";
import type {
  Customer,
  Death,
  EntityName,
  Expense,
  ExpenseCategory,
  HealthRecord,
  Move,
  OutboxOperation,
  ProduceType,
  Purchase,
  Record_,
  Room,
  Sale,
  StockCount,
  StockIntake,
  StockOuttake,
  Store,
  TreatmentSchedule,
  Vet,
  VetVisit,
  VisitNote,
} from "../db/types";
import { ApiError, pullChanges, pushOperations } from "./api";
import { onLocalChange } from "./signal";

/**
 * The background worker that drains the outbox and pulls other devices' changes.
 *
 * It never blocks the UI and it never asks the UI to wait: everything the user
 * does has already been written locally by the time this runs. Its whole job is
 * to make the server agree, eventually.
 *
 * SPEC 5.6 sets the cadence: exponential backoff from 5 seconds to a 5-minute
 * ceiling, retried on regained connectivity, on app foreground, and every five
 * minutes while open. The outbox survives restarts because it lives in
 * IndexedDB rather than in memory.
 */

const BATCH_SIZE = 200;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** SPEC 4.6 — unsynced changes older than 48h become an urgent alert. */
export const STALE_SYNC_MS = 48 * 60 * 60 * 1000;

export type SyncState = "synced" | "pending" | "offline" | "syncing";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncAt: string | null;
  /** True once the oldest queued change has been stuck for over 48 hours. */
  stale: boolean;
  error: string | null;
}

type Listener = (status: SyncStatus) => void;

export class SyncEngine {
  private listeners = new Set<Listener>();
  private unsubscribeLocalChanges: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private status: SyncStatus = {
    state: "pending",
    pending: 0,
    lastSyncAt: null,
    stale: false,
    error: null,
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  start(): void {
    this.unsubscribeLocalChanges = onLocalChange(() => this.schedule(0));
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      document.addEventListener("visibilitychange", this.onForeground);
    }
    void this.refreshStatus();
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribeLocalChanges?.();
    this.unsubscribeLocalChanges = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      document.removeEventListener("visibilitychange", this.onForeground);
    }
  }

  private onOnline = () => this.schedule(0);
  private onForeground = () => {
    if (document.visibilityState === "visible") this.schedule(0);
  };

  /** Ask for a sync now — called after a mutation, so a change made with a
   *  connection present reaches the server promptly. */
  requestSync(): void {
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.emit({ state: "syncing" });
      await this.drainOutbox();
      await this.pull();
      await setMeta(META.lastSyncAt, new Date().toISOString());
      this.failures = 0;
      await this.refreshStatus();
      this.schedule(POLL_INTERVAL_MS);
    } catch (error) {
      this.failures += 1;
      const offline = error instanceof ApiError && error.status === 0;
      await this.refreshStatus({
        state: offline ? "offline" : "pending",
        error: offline ? null : (error as Error).message,
      });
      this.schedule(this.backoffMs());
    } finally {
      this.running = false;
    }
  }

  /** SPEC 5.6 — 5s doubling to a 5-minute ceiling. */
  private backoffMs(): number {
    return Math.min(BASE_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
  }

  private async drainOutbox(): Promise<void> {
    const deviceId = await getDeviceId();

    for (;;) {
      const batch = await db.outbox.orderBy("queue_id").limit(BATCH_SIZE).toArray();
      if (batch.length === 0) return;

      const response = await pushOperations(
        deviceId,
        batch.map((entry) => ({
          op: entry.op,
          entity: entry.entity,
          id: entry.id,
          data: entry.data,
          updated_at: entry.updated_at,
          ...(entry.field_updated_at ? { field_updated_at: entry.field_updated_at } : {}),
        })),
      );

      const byId = new Map(response.results.map((r) => [`${r.entity}:${r.id}`, r]));
      const done: number[] = [];
      const adopt: Array<[EntityName, Record<string, unknown>]> = [];

      for (const entry of batch) {
        const result = byId.get(`${entry.entity}:${entry.id}`);
        if (!result) continue;

        if (result.status === "conflict" && result.server) {
          // The server held a newer value. Adopt it — both sides apply the same
          // deterministic rule, so this is agreement, not a loss.
          adopt.push([entry.entity, result.server]);
        }

        if (result.status === "rejected") {
          // Will never succeed. Dropping it is the only way to stop it blocking
          // every change queued behind it (SPEC 7).
          console.warn("sync: operation rejected", entry.entity, entry.id, result.message);
        }

        // applied, duplicate, conflict and rejected all mean "stop retrying".
        // `duplicate` is the case that makes a lost response harmless (SPEC 5.3).
        done.push(entry.queue_id!);
      }

      // Retire the queue entries before adopting anything. A server row is only
      // written over a local one when nothing is still queued for that id, and
      // these entries have just been settled — leaving them in place would make
      // the row look like it still had unsent work and skip the adoption.
      await db.outbox.bulkDelete(done);
      for (const [entity, row] of adopt) await applyServerRow(entity, row);
      if (done.length === 0) {
        throw new Error("Push returned no usable results; will retry");
      }
    }
  }

  private async pull(): Promise<void> {
    let cursor = await getMeta<number>(META.cursor, 0);

    for (;;) {
      const page = await pullChanges(cursor, 500);
      if (page.changes.length > 0) {
        // `outbox` is in scope because applyServerRow consults it before
        // overwriting a row that still has unsent local work.
        // Past five tables Dexie wants them as an array rather than as
        // positional arguments.
        await db.transaction(
          "rw",
          [
            db.rooms,
            db.records,
            db.moves,
            db.purchases,
            db.healthRecords,
            db.sales,
            db.deaths,
            db.expenses,
            db.expenseCategories,
            db.customers,
            db.vets,
            db.treatmentSchedules,
            db.vetVisits,
            db.visitNotes,
            db.meta,
            db.outbox,
          ],
          async () => {
            for (const change of page.changes) {
              await applyServerRow(change.entity, change.data);
            }
            await setMeta(META.cursor, page.cursor);
          },
        );
      }
      cursor = page.cursor;
      if (!page.has_more) return;
    }
  }

  private async refreshStatus(overrides: Partial<SyncStatus> = {}): Promise<void> {
    const pending = await db.outbox.count();
    const oldest = await db.outbox.orderBy("queue_id").first();
    const lastSyncAt = await getMeta<string | null>(META.lastSyncAt, null);
    const stale =
      oldest !== undefined && Date.now() - new Date(oldest.queued_at).getTime() > STALE_SYNC_MS;

    const state: SyncState =
      overrides.state ?? (pending === 0 ? "synced" : "pending");

    await this.emit({ state, pending, lastSyncAt, stale, error: null, ...overrides });
  }

  private async emit(patch: Partial<SyncStatus>): Promise<void> {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}

/**
 * Write a row the server sent into the local store.
 *
 * Local rows that are still queued in the outbox are not overwritten: the
 * server has not seen them yet, so its version is by definition older. SPEC 5.5
 * is explicit that pending changes are real records and are shown normally.
 */
export async function applyServerRow(
  entity: EntityName,
  data: Record<string, unknown>,
): Promise<void> {
  const id = data.id as string;
  const queued = await db.outbox.where("id").equals(id).count();

  switch (entity) {
    case "room": {
      if (queued > 0) return;
      await db.rooms.put(data as unknown as Room);
      return;
    }
    case "record": {
      if (queued > 0) {
        // Even with a local edit outstanding, the server's derived head_count
        // is worth taking: it accounts for events from other devices that this
        // one cannot see (SPEC 6.7).
        const local = await db.records.get(id);
        if (local) {
          await db.records.put({
            ...local,
            head_count: data.head_count as number,
            status: data.status as Record_["status"],
          });
        }
        return;
      }
      await db.records.put(data as unknown as Record_);
      return;
    }
    case "move": {
      // Events are append-only, so a pulled move can only ever be new.
      await db.moves.put(data as unknown as Move);
      return;
    }
    case "purchase": {
      await db.purchases.put(data as unknown as Purchase);
      return;
    }
    case "health_record": {
      await db.healthRecords.put(data as unknown as HealthRecord);
      return;
    }
    case "sale": {
      await db.sales.put(data as unknown as Sale);
      return;
    }
    case "death": {
      await db.deaths.put(data as unknown as Death);
      return;
    }
    case "expense": {
      await db.expenses.put(data as unknown as Expense);
      return;
    }
    case "expense_category": {
      if (queued > 0) return;
      await db.expenseCategories.put(data as unknown as ExpenseCategory);
      return;
    }
    case "customer": {
      if (queued > 0) return;
      await db.customers.put(data as unknown as Customer);
      return;
    }
    case "vet": {
      if (queued > 0) return;
      await db.vets.put(data as unknown as Vet);
      return;
    }
    case "treatment_schedule": {
      // A state entity, so a local edit still waiting to be sent is newer than
      // whatever the server is offering and must not be written over (SPEC 5.5).
      if (queued > 0) return;
      await db.treatmentSchedules.put(data as unknown as TreatmentSchedule);
      return;
    }
    case "vet_visit": {
      // Also a state entity — a visit is marked completed and annotated after
      // it is created (see `createVetVisit`), so the same rule applies.
      if (queued > 0) return;
      await db.vetVisits.put(data as unknown as VetVisit);
      return;
    }
    case "visit_note": {
      // An event: a pulled note can only ever be new.
      await db.visitNotes.put(data as unknown as VisitNote);
      return;
    }
    // SPEC 20.13 — stores and produce types are state entities with per-field
    // last-write-wins; intakes, outtakes and counts are events, append-only.
    case "store": {
      if (queued > 0) return;
      await db.stores.put(data as unknown as Store);
      return;
    }
    case "produce_type": {
      if (queued > 0) return;
      await db.produceTypes.put(data as unknown as ProduceType);
      return;
    }
    case "stock_intake": {
      await db.stockIntakes.put(data as unknown as StockIntake);
      return;
    }
    case "stock_outtake": {
      await db.stockOuttakes.put(data as unknown as StockOuttake);
      return;
    }
    case "stock_count": {
      await db.stockCounts.put(data as unknown as StockCount);
      return;
    }
    default:
      return;
  }
}

export const syncEngine = new SyncEngine();

export type { OutboxOperation };
