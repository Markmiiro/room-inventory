import { byCode, byName, type StockInput } from "../domain/stores";
import { db } from "./schema";
import type {
  Birth,
  Death,
  Expense,
  ExpenseCategory,
  HealthRecord,
  Move,
  ProduceType,
  Purchase,
  StockCount,
  StockIntake,
  StockOuttake,
  Store,
  Record_,
  Room,
  Sale,
  TreatmentSchedule,
  VetVisit,
  VisitNote,
} from "./types";

/** Reads the screens run. Everything comes from IndexedDB, so every screen
 *  renders identically with or without a network (SPEC 1). */

export async function activeRecordsByRoom(): Promise<Map<string, Record_[]>> {
  const records = await db.records.where("status").equals("active").toArray();
  const byRoom = new Map<string, Record_[]>();
  for (const record of records) {
    if (record.deleted_at || !record.current_room_id) continue;
    const list = byRoom.get(record.current_room_id) ?? [];
    list.push(record);
    byRoom.set(record.current_room_id, list);
  }
  return byRoom;
}

export async function liveRooms(): Promise<Room[]> {
  const rooms = await db.rooms.toArray();
  return rooms
    .filter((room) => !room.deleted_at)
    .sort((a, b) => numericCode(a.code) - numericCode(b.code));
}

function numericCode(code: string): number {
  const digits = code.replace(/\D/g, "");
  return digits ? Number(digits) : Number.MAX_SAFE_INTEGER;
}

export async function recordsInRoom(roomId: string): Promise<Record_[]> {
  const records = await db.records
    .where("[status+current_room_id]")
    .equals(["active", roomId])
    .toArray();
  return records.filter((r) => !r.deleted_at).sort((a, b) => a.tag.localeCompare(b.tag));
}

export async function movesForRecord(recordId: string) {
  const moves = await db.moves.where("record_id").equals(recordId).toArray();
  return moves.sort((a, b) =>
    a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date),
  );
}

export async function activeRecords(): Promise<Record_[]> {
  const records = await db.records.where("status").equals("active").toArray();
  return records.filter((r) => !r.deleted_at);
}

/** SPEC 4.3 — the records split off this one. Indexed, not scanned: a group
 *  split repeatedly leaves a chain worth following. */
export async function childRecords(recordId: string): Promise<Record_[]> {
  const records = await db.records.where("parent_record_id").equals(recordId).toArray();
  return records.filter((r) => !r.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Every move into or out of this room, newest first — the room's own history
 *  rather than one record's (SPEC 4.1 orders by date, then created_at). */
export async function movesForRoom(roomId: string): Promise<Move[]> {
  const [arrived, left] = await Promise.all([
    db.moves.where("to_room_id").equals(roomId).toArray(),
    db.moves.where("from_room_id").equals(roomId).toArray(),
  ]);
  return [...arrived, ...left]
    .filter((move) => !move.deleted_at)
    .sort((a, b) =>
      a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date),
    );
}

export async function allMoves(): Promise<Move[]> {
  const moves = await db.moves.toArray();
  return moves.filter((m) => !m.deleted_at);
}

export async function allPurchases(): Promise<Purchase[]> {
  const purchases = await db.purchases.toArray();
  return purchases.filter((p) => !p.deleted_at);
}

export async function allHealth(): Promise<HealthRecord[]> {
  const health = await db.healthRecords.toArray();
  return health.filter((h) => !h.deleted_at);
}

/** One record's treatments, newest first. */
export async function healthForRecord(recordId: string): Promise<HealthRecord[]> {
  const health = await db.healthRecords.where("record_id").equals(recordId).toArray();
  return health
    .filter((h) => !h.deleted_at)
    .sort((a, b) =>
      a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date),
    );
}

/** What the sync-failing rule needs: how much is queued, and since when. */
export async function outboxAge(): Promise<{ count: number; oldestQueuedAt: string | null }> {
  const pending = await db.outbox.orderBy("queue_id").toArray();
  return {
    count: pending.length,
    oldestQueuedAt: pending[0]?.queued_at ?? null,
  };
}

export async function allSales(): Promise<Sale[]> {
  const sales = await db.sales.toArray();
  return sales.filter((s) => !s.deleted_at);
}

export async function allDeaths(): Promise<Death[]> {
  const deaths = await db.deaths.toArray();
  return deaths.filter((d) => !d.deleted_at);
}

export async function allExpenses(): Promise<Expense[]> {
  const expenses = await db.expenses.toArray();
  return expenses
    .filter((e) => !e.deleted_at)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** SPEC 3.11 — the app ships with none, so an empty list is the normal first
 *  state rather than a failure to load. Archived ones stay out of the choices
 *  but keep naming the expenses that already use them (SPEC 4.8). */
export async function liveCategories(): Promise<ExpenseCategory[]> {
  const categories = await db.expenseCategories.toArray();
  return categories
    .filter((c) => !c.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function salesForRecord(recordId: string): Promise<Sale[]> {
  const sales = await db.sales.where("record_id").equals(recordId).toArray();
  return sales.filter((s) => !s.deleted_at).sort((a, b) => b.date.localeCompare(a.date));
}

/** SPEC 13 — every schedule, archived ones included.
 *
 *  The archived ones come back because the due computation still needs to name
 *  the schedule a past treatment was given against, and because the manage
 *  screen shows them so they can be brought back. Filtering to the active ones
 *  is the caller's job, and `scheduleDueItems` does it.
 */
export async function allSchedules(): Promise<TreatmentSchedule[]> {
  const schedules = await db.treatmentSchedules.toArray();
  return schedules
    .filter((s) => !s.deleted_at)
    .sort((a, b) => (a.species === b.species ? a.name.localeCompare(b.name) : a.species.localeCompare(b.species)));
}

/** SPEC 14 — every visit, planned and completed. */
export async function allVetVisits(): Promise<VetVisit[]> {
  const visits = await db.vetVisits.toArray();
  return visits.filter((v) => !v.deleted_at);
}

export async function allVisitNotes(): Promise<VisitNote[]> {
  const notes = await db.visitNotes.toArray();
  return notes.filter((n) => !n.deleted_at);
}

/** SPEC 14.5 — the observations against one animal, for its health history. */
export async function visitNotesForRecord(recordId: string): Promise<VisitNote[]> {
  const notes = await db.visitNotes.where("record_id").equals(recordId).toArray();
  return notes
    .filter((n) => !n.deleted_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The treatments and notes belonging to one visit — what Visit detail lists. */
export async function visitContents(
  visitId: string,
): Promise<{ health: HealthRecord[]; notes: VisitNote[] }> {
  const [health, notes] = await Promise.all([
    db.healthRecords.where("visit_id").equals(visitId).toArray(),
    db.visitNotes.where("visit_id").equals(visitId).toArray(),
  ]);
  return {
    health: health.filter((h) => !h.deleted_at),
    notes: notes.filter((n) => !n.deleted_at),
  };
}


/* ── SPEC 20 — produce stores ────────────────────────────────────────────── */

/** SPEC 20.3 — the stores, in code order. */
export async function liveStores(): Promise<Store[]> {
  const stores = await db.stores.toArray();
  return stores.filter((s) => !s.deleted_at).sort(byCode);
}

/**
 * SPEC 20.4 — the produce types that can still be chosen.
 *
 * Archived types are excluded here rather than filtered per screen. A type with
 * history is archived and never deleted (SPEC 20.14.5), so its name keeps
 * appearing against the stock it explains while dropping out of every picker.
 */
export async function activeProduceTypes(): Promise<ProduceType[]> {
  const types = await db.produceTypes.toArray();
  return types.filter((p) => !p.deleted_at && p.is_active).sort(byName);
}

/** Every produce type including archived ones — what History and a balance
 *  need, since stock can outlive the choice that created it. */
export async function allProduceTypes(): Promise<ProduceType[]> {
  const types = await db.produceTypes.toArray();
  return types.filter((p) => !p.deleted_at).sort(byName);
}

export async function allIntakes(): Promise<StockIntake[]> {
  const rows = await db.stockIntakes.toArray();
  return rows.filter((r) => !r.deleted_at);
}

export async function allOuttakes(): Promise<StockOuttake[]> {
  const rows = await db.stockOuttakes.toArray();
  return rows.filter((r) => !r.deleted_at);
}

export async function allStockCounts(): Promise<StockCount[]> {
  const rows = await db.stockCounts.toArray();
  return rows.filter((r) => !r.deleted_at);
}

/**
 * Everything the balance rule folds, in one call.
 *
 * The three event kinds are always read together — a balance is meaningless
 * without all of them, since a stock count resets what the other two accumulate
 * (SPEC 20.8). Fetching them as a unit is what stops a screen accidentally
 * rendering a balance that ignores the last count.
 */
export async function allStockEvents(): Promise<StockInput> {
  const [intakes, outtakes, counts] = await Promise.all([
    allIntakes(),
    allOuttakes(),
    allStockCounts(),
  ]);
  return { intakes, outtakes, counts };
}


/* ── SPEC 22 — births ────────────────────────────────────────────────────── */

/** Every birth, for the Calendar and for the offspring totals. */
export async function allBirths(): Promise<Birth[]> {
  const births = await db.births.toArray();
  return births.filter((b) => !b.deleted_at);
}

/** One dam's births, newest first. Indexed rather than scanned: SPEC 6.13
 *  assumes thousands of rows, and a dam's own screen must not read them all. */
export async function birthsForDam(damId: string): Promise<Birth[]> {
  const births = await db.births.where("dam_record_id").equals(damId).toArray();
  return births
    .filter((b) => !b.deleted_at)
    .sort((a, b) => (a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date)));
}

/**
 * The records born of this dam — her offspring, tappable from her own screen
 * (SPEC 22).
 *
 * Sold and dead offspring are included. A dam's offspring are a fact about her
 * regardless of what became of them, and leaving out the ones that died would
 * quietly disagree with the total shown beside the figure.
 */
export async function offspringOf(damId: string): Promise<Record_[]> {
  const records = await db.records.where("dam_record_id").equals(damId).toArray();
  return records
    .filter((r) => !r.deleted_at)
    .sort((a, b) =>
      (b.date_of_birth ?? b.arrival_date ?? "").localeCompare(a.date_of_birth ?? a.arrival_date ?? "") ||
      a.tag.localeCompare(b.tag),
    );
}
