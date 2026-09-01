import { announceLocalChange } from "../sync/signal";
import { getDeviceId, newId, nowIso, todayInEAT } from "./ids";
import { db } from "./schema";
import type {
  Death,
  DeathCause,
  EntityName,
  Expense,
  ExpenseCategory,
  ExpenseScope,
  HealthRecord,
  HealthType,
  Move,
  MoveReason,
  OutboxOperation,
  Purchase,
  Record_,
  RecordKind,
  Room,
  Sale,
  Sex,
  Source,
  Species,
} from "./types";

/**
 * Every mutation in the app goes through this module.
 *
 * The contract from SPEC 5.1 is that a write lands in IndexedDB and in the
 * outbox **in the same transaction**, then returns. If those were two steps, a
 * tab closed between them would leave a record on the device that the server
 * would never hear about — the exact silent data loss the sync design exists to
 * prevent. Dexie transactions give the atomicity; nothing here awaits a network
 * call, so nothing here can be blocked by one.
 */

type Entity =
  | Room
  | Record_
  | Move
  | Purchase
  | HealthRecord
  | Sale
  | Death
  | Expense
  | ExpenseCategory;

async function enqueue(
  tx: { outbox: typeof db.outbox },
  op: OutboxOperation["op"],
  entity: EntityName,
  row: Entity,
  fields: Record<string, unknown>,
): Promise<void> {
  // Let whoever is listening know there is work to send. Fire-and-forget by
  // design: with no network the operation just stays queued, and nothing the
  // user did is held up waiting to find that out (SPEC 5.1).
  queueMicrotask(announceLocalChange);

  await tx.outbox.add({
    op,
    entity,
    id: row.id,
    data: fields,
    updated_at: row.updated_at,
    queued_at: nowIso(),
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
  });
}

/**
 * The fields whose value would actually change.
 *
 * A form hands back everything it manages, touched or not. Pushing all of it
 * defeats the per-field merge the server does: a device saving one edit would
 * also assert its own stale value for every other field, and win on timestamp.
 * That is how one device renaming a breed loses it to another device saving a
 * note — the merge is right, the client was lying about what changed.
 *
 * SPEC 5.4 is about resolving genuine conflicts. This is what stops the client
 * manufacturing them.
 */
function changedOnly<T extends object>(
  existing: T,
  changes: Partial<T>,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(changes) as Array<[keyof T, T[keyof T]]>) {
    if (value !== existing[key]) out[key] = value;
  }
  return out;
}


// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomInput {
  code: string;
  name: string;
  capacity: number;
  is_isolation?: boolean;
  notes?: string | null;
}

export async function createRoom(input: RoomInput): Promise<Room> {
  const device_id = await getDeviceId();
  const at = nowIso();
  const room: Room = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    code: input.code,
    name: input.name,
    capacity: input.capacity,
    is_isolation: input.is_isolation ?? false,
    notes: input.notes ?? null,
  };

  await db.transaction("rw", db.rooms, db.outbox, async () => {
    await db.rooms.add(room);
    await enqueue(db, "upsert", "room", room, {
      code: room.code,
      name: room.name,
      capacity: room.capacity,
      is_isolation: room.is_isolation,
      notes: room.notes,
    });
  });
  return room;
}

export async function updateRoom(
  id: string,
  changes: Partial<Pick<Room, "code" | "name" | "capacity" | "is_isolation" | "notes">>,
): Promise<void> {
  const device_id = await getDeviceId();
  const at = nowIso();

  await db.transaction("rw", db.rooms, db.outbox, async () => {
    const existing = await db.rooms.get(id);
    if (!existing) throw new Error(`No room ${id}`);
    // Only the fields that genuinely changed are pushed. The server merges per
    // field, so sending an untouched one would make this device's stale value
    // compete with — and beat — another device's genuine edit to it (SPEC 5.4).
    const real = changedOnly(existing, changes);
    if (Object.keys(real).length === 0) return;

    const updated: Room = { ...existing, ...real, updated_at: at, device_id };
    await db.rooms.put(updated);
    await enqueue(db, "upsert", "room", updated, real as Record<string, unknown>);
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RecordInput {
  kind: RecordKind;
  species: Species;
  tag: string;
  breed?: string | null;
  sex?: Sex | null;
  date_of_birth?: string | null;
  arrival_date?: string | null;
  head_count?: number;
  source: Source;
  notes?: string | null;
  parent_record_id?: string | null;
  /** Where it starts out. Written as the record's first move, since location is
   *  never a field on the record itself (SPEC 3.4, 4.1). */
  room_id?: string | null;
  /** The date of that first move. Defaults to today. */
  date?: string;
  /** SPEC 3.7 — recorded as a Purchase when the source is `bought`. Whole
   *  shillings; ignored for anything that was born here or given. */
  price?: number | null;
  seller?: string | null;
}

export async function createRecord(input: RecordInput): Promise<Record_> {
  const device_id = await getDeviceId();
  const at = nowIso();
  // SPEC 3.4 — an animal is always exactly one head.
  const head = input.kind === "animal" ? 1 : Math.max(1, input.head_count ?? 1);

  const record: Record_ = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    kind: input.kind,
    species: input.species,
    tag: input.tag,
    breed: input.breed ?? null,
    sex: input.kind === "animal" ? input.sex ?? null : null,
    date_of_birth: input.kind === "animal" ? input.date_of_birth ?? null : null,
    arrival_date: input.kind === "group" ? input.arrival_date ?? null : null,
    initial_head_count: head,
    head_count: head,
    offspring_count: null,
    offspring_updated_at: null,
    source: input.source,
    status: "active",
    parent_record_id: input.parent_record_id ?? null,
    notes: input.notes ?? null,
    current_room_id: null,
  };

  const move: Move | null = input.room_id
    ? {
        id: newId(),
        created_at: at,
        updated_at: at,
        device_id,
        deleted_at: null,
        record_id: record.id,
        from_room_id: null, // SPEC 3.5 — null for an initial placement.
        to_room_id: input.room_id,
        date: input.date ?? todayInEAT(),
        count: head,
        reason: "new_arrival",
        note: null,
      }
    : null;

  if (move) record.current_room_id = move.to_room_id;

  // SPEC 3.7 — "created automatically when a record is added with source =
  // bought". It rides in the same transaction as the record, so a tab closed
  // mid-write can never leave an animal on the device with its cost missing.
  const purchase: Purchase | null =
    input.source === "bought" && input.price != null && input.price > 0
      ? {
          id: newId(),
          created_at: at,
          updated_at: at,
          device_id,
          deleted_at: null,
          record_id: record.id,
          date: input.date ?? todayInEAT(),
          price: Math.round(input.price),
          seller: input.seller?.trim() || null,
          count: head,
        }
      : null;

  await db.transaction("rw", db.records, db.moves, db.purchases, db.outbox, async () => {
    await db.records.add(record);
    await enqueue(db, "upsert", "record", record, {
      kind: record.kind,
      species: record.species,
      tag: record.tag,
      breed: record.breed,
      sex: record.sex,
      date_of_birth: record.date_of_birth,
      arrival_date: record.arrival_date,
      initial_head_count: record.initial_head_count,
      source: record.source,
      status: record.status,
      parent_record_id: record.parent_record_id,
      notes: record.notes,
    });

    if (move) {
      await db.moves.add(move);
      await enqueue(db, "insert", "move", move, moveFields(move));
    }

    if (purchase) {
      await db.purchases.add(purchase);
      await enqueue(db, "insert", "purchase", purchase, {
        record_id: purchase.record_id,
        date: purchase.date,
        price: purchase.price,
        seller: purchase.seller,
        count: purchase.count,
      });
    }
  });

  return record;
}

/**
 * The fields Record detail may edit by hand.
 *
 * `head_count` is deliberately absent. The server derives it from sales, deaths
 * and splits (SPEC 6.7, backend/app/domain/reconcile.py); pushing a typed-in
 * number would let one device's stale arithmetic beat another device's real
 * sale simply by arriving later. `kind` is immutable (SPEC 3.4), and location
 * is a move, never a field.
 */
export type RecordEdit = Partial<
  Pick<
    Record_,
    "tag" | "breed" | "sex" | "date_of_birth" | "arrival_date" | "notes" | "offspring_count"
  >
>;

export async function updateRecord(id: string, changes: RecordEdit): Promise<void> {
  const device_id = await getDeviceId();
  const at = nowIso();

  await db.transaction("rw", db.records, db.outbox, async () => {
    const existing = await db.records.get(id);
    if (!existing) throw new Error(`No record ${id}`);

    const real = changedOnly(existing, changes);
    if (Object.keys(real).length === 0) return;

    const fields: Record<string, unknown> = { ...real };
    // SPEC 3.4 — the offspring figure is stamped whenever it changes, so the
    // screen can print "2 (updated 12 Aug)" and a stale number reads as stale.
    if ("offspring_count" in real) {
      fields.offspring_updated_at = todayInEAT();
    }

    const updated = { ...existing, ...fields, updated_at: at, device_id } as Record_;
    await db.records.put(updated);
    // Only what changed, for the same per-field reason as updateRoom.
    await enqueue(db, "upsert", "record", updated, fields);
  });
}

function moveFields(move: Move): Record<string, unknown> {
  return {
    record_id: move.record_id,
    from_room_id: move.from_room_id,
    to_room_id: move.to_room_id,
    date: move.date,
    count: move.count,
    reason: move.reason,
    note: move.note,
  };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

export interface MoveInput {
  record_id: string;
  to_room_id: string;
  date: string;
  reason: MoveReason;
  note?: string | null;
  /** Head to move. Below the group's own count this splits the group. */
  count?: number;
}

export interface MoveOutcome {
  move: Move;
  /** Set when the move split a group, per SPEC 4.3. */
  splitRecord: Record_ | null;
}

/**
 * Record a move.
 *
 * A whole-record move is one appended event. Moving *part* of a group is a
 * split (SPEC 4.3): a new record is created for the head that left, carrying
 * its own move history from the destination, and the original is reduced. No
 * head_count is written for the original — the server derives it from the child
 * (see backend/app/domain/reconcile.py), which is what stops two offline
 * devices from overwriting each other's arithmetic.
 */
export async function recordMove(input: MoveInput): Promise<MoveOutcome> {
  const device_id = await getDeviceId();
  const at = nowIso();

  return db.transaction("rw", db.records, db.moves, db.outbox, async () => {
    const record = await db.records.get(input.record_id);
    if (!record) throw new Error(`No record ${input.record_id}`);
    // SPEC 6.2 — a sold or dead record cannot be moved.
    if (record.status !== "active") {
      throw new Error(`${record.tag} is ${record.status} and cannot be moved`);
    }
    // SPEC 6.4 — the current room is not a valid destination.
    if (record.current_room_id === input.to_room_id) {
      throw new Error(`${record.tag} is already in this room`);
    }

    const requested = input.count ?? record.head_count;
    const count = Math.min(Math.max(1, requested), record.head_count);
    const isSplit = record.kind === "group" && count < record.head_count;

    if (!isSplit) {
      const move: Move = {
        id: newId(),
        created_at: at,
        updated_at: at,
        device_id,
        deleted_at: null,
        record_id: record.id,
        from_room_id: record.current_room_id,
        to_room_id: input.to_room_id,
        date: input.date,
        count,
        reason: input.reason,
        note: input.note ?? null,
      };
      await db.moves.add(move);
      await enqueue(db, "insert", "move", move, moveFields(move));
      await db.records.put({ ...record, current_room_id: await latestRoom(record.id) });
      return { move, splitRecord: null };
    }

    const child: Record_ = {
      ...record,
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      // SPEC 4.3 — species, breed, arrival date and source are copied.
      tag: await deriveSplitTag(record.tag),
      initial_head_count: count,
      head_count: count,
      parent_record_id: record.id,
      // The offspring figure belongs to the original animal, not to head split
      // out of a group, so it does not travel.
      offspring_count: null,
      offspring_updated_at: null,
      current_room_id: input.to_room_id,
      seq: undefined,
    };

    const move: Move = {
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      deleted_at: null,
      record_id: child.id,
      from_room_id: record.current_room_id,
      to_room_id: input.to_room_id,
      date: input.date,
      count,
      reason: input.reason,
      note: input.note ?? null,
    };

    await db.records.add(child);
    await enqueue(db, "upsert", "record", child, {
      kind: child.kind,
      species: child.species,
      tag: child.tag,
      breed: child.breed,
      sex: child.sex,
      date_of_birth: child.date_of_birth,
      arrival_date: child.arrival_date,
      initial_head_count: child.initial_head_count,
      source: child.source,
      status: child.status,
      parent_record_id: child.parent_record_id,
      notes: child.notes,
    });

    await db.moves.add(move);
    await enqueue(db, "insert", "move", move, moveFields(move));

    // The original's count drops locally so the UI is right immediately. It is
    // deliberately not pushed: the server recomputes it from the child records,
    // and a pushed figure would be one device's stale view of the truth.
    await db.records.put({
      ...record,
      head_count: record.head_count - count,
      updated_at: at,
    });

    return { move, splitRecord: child };
  });
}

async function latestRoom(recordId: string): Promise<string | null> {
  const moves = await db.moves.where("record_id").equals(recordId).toArray();
  if (moves.length === 0) return null;
  // SPEC 4.1 — most recent by date, then created_at.
  moves.sort((a, b) =>
    a.date === b.date ? a.created_at.localeCompare(b.created_at) : a.date.localeCompare(b.date),
  );
  return moves[moves.length - 1]!.to_room_id;
}

/** SPEC 4.3 — derive the split's tag, e.g. `P-Weaners` becomes `P-Weaners-2`. */
async function deriveSplitTag(baseTag: string): Promise<string> {
  const root = baseTag.replace(/-(\d+)$/, "");
  const siblings = await db.records.filter((r) => r.tag.startsWith(`${root}-`)).toArray();
  let suffix = 2;
  const taken = new Set(siblings.map((r) => r.tag));
  while (taken.has(`${root}-${suffix}`)) suffix += 1;
  return `${root}-${suffix}`;
}


// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthInput {
  record_id: string;
  type: HealthType;
  product?: string | null;
  dose?: string | null;
  date?: string;
  next_due?: string | null;
  withdrawal_days?: number | null;
  vet_id?: string | null;
  cost?: number | null;
  notes?: string | null;
}

/**
 * Record a treatment.
 *
 * An event, like a move: append-only, never edited. Two devices dosing the same
 * animal offline both keep their row, because an animal treated twice is a fact
 * about that animal rather than a conflict to resolve (SPEC 5.4).
 */
export async function recordHealth(input: HealthInput): Promise<HealthRecord> {
  const device_id = await getDeviceId();
  const at = nowIso();

  const treatment: HealthRecord = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    record_id: input.record_id,
    type: input.type,
    product: input.product?.trim() || null,
    dose: input.dose?.trim() || null,
    date: input.date ?? todayInEAT(),
    next_due: input.next_due || null,
    withdrawal_days: input.withdrawal_days ?? null,
    vet_id: input.vet_id ?? null,
    cost: input.cost ?? null,
    notes: input.notes?.trim() || null,
  };

  await db.transaction("rw", db.healthRecords, db.outbox, async () => {
    await db.healthRecords.add(treatment);
    await enqueue(db, "insert", "health_record", treatment, {
      record_id: treatment.record_id,
      type: treatment.type,
      product: treatment.product,
      dose: treatment.dose,
      date: treatment.date,
      next_due: treatment.next_due,
      withdrawal_days: treatment.withdrawal_days,
      vet_id: treatment.vet_id,
      cost: treatment.cost,
      notes: treatment.notes,
    });
  });

  return treatment;
}


// ---------------------------------------------------------------------------
// Leaving the farm — sales and deaths
// ---------------------------------------------------------------------------

/**
 * What a sale or a death does to the record it names.
 *
 * SPEC 4.3 — neither creates a child record the way a partial move does. The
 * quantity simply leaves and the event carries the count.
 *
 * SPEC 6.1 — when the count reaches zero the record's status changes and it
 * drops out of the active lists, while its history stays readable.
 *
 * SPEC 6.7 — the local count is clamped at zero and the event is kept whatever
 * happens. Two offline devices each selling five from a group of eight must end
 * with both sales recorded, a count of zero, and an alert — never with one sale
 * quietly discarded. The clamped count is **not** pushed: the server derives it
 * from the events (`backend/app/domain/reconcile.py`), which is the only reason
 * the second device's arithmetic cannot overwrite the first device's sale.
 */
function leavingUpdate(record: Record_, count: number, status: Record_["status"]) {
  const remaining = Math.max(0, record.head_count - count);
  return {
    ...record,
    head_count: remaining,
    status: remaining === 0 ? status : record.status,
  };
}

export interface SaleInput {
  record_id: string;
  date: string;
  /** Total for the sale, not per head (SPEC 3.8). Whole shillings. */
  price: number;
  count?: number;
  customer_id?: string | null;
  notes?: string | null;
}

export async function recordSale(input: SaleInput): Promise<Sale> {
  const device_id = await getDeviceId();
  const at = nowIso();

  return db.transaction("rw", db.records, db.sales, db.outbox, async () => {
    const record = await db.records.get(input.record_id);
    if (!record) throw new Error(`No record ${input.record_id}`);
    // SPEC 6.2 — those actions are hidden on an inactive record, but a stale
    // screen could still get here.
    if (record.status !== "active") {
      throw new Error(`${record.tag} is ${record.status} and cannot be sold`);
    }

    const count = Math.min(Math.max(1, input.count ?? record.head_count), record.head_count);

    const sale: Sale = {
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      deleted_at: null,
      record_id: record.id,
      date: input.date,
      price: Math.round(input.price),
      count,
      customer_id: input.customer_id ?? null,
      notes: input.notes?.trim() || null,
    };

    await db.sales.add(sale);
    await enqueue(db, "insert", "sale", sale, {
      record_id: sale.record_id,
      date: sale.date,
      price: sale.price,
      count: sale.count,
      customer_id: sale.customer_id,
      notes: sale.notes,
    });

    const updated = leavingUpdate(record, count, "sold");
    await db.records.put(updated);
    // Only `status` is pushed. `head_count` is derived (SPEC 3.4).
    if (updated.status !== record.status) {
      await enqueue(db, "upsert", "record", updated, { status: updated.status });
    }

    return sale;
  });
}

export interface DeathInput {
  record_id: string;
  date: string;
  cause: DeathCause;
  count?: number;
  vet_id?: string | null;
  notes?: string | null;
}

export async function recordDeath(input: DeathInput): Promise<Death> {
  const device_id = await getDeviceId();
  const at = nowIso();

  return db.transaction("rw", db.records, db.deaths, db.outbox, async () => {
    const record = await db.records.get(input.record_id);
    if (!record) throw new Error(`No record ${input.record_id}`);
    if (record.status !== "active") {
      throw new Error(`${record.tag} is already ${record.status}`);
    }

    const count = Math.min(Math.max(1, input.count ?? record.head_count), record.head_count);

    const death: Death = {
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      deleted_at: null,
      record_id: record.id,
      date: input.date,
      count,
      cause: input.cause,
      vet_id: input.vet_id ?? null,
      notes: input.notes?.trim() || null,
    };

    await db.deaths.add(death);
    await enqueue(db, "insert", "death", death, {
      record_id: death.record_id,
      date: death.date,
      count: death.count,
      cause: death.cause,
      vet_id: death.vet_id,
      notes: death.notes,
    });

    const updated = leavingUpdate(record, count, "dead");
    await db.records.put(updated);
    if (updated.status !== record.status) {
      await enqueue(db, "upsert", "record", updated, { status: updated.status });
    }

    return death;
  });
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export async function createExpenseCategory(name: string): Promise<ExpenseCategory> {
  const device_id = await getDeviceId();
  const at = nowIso();

  const category: ExpenseCategory = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    name: name.trim(),
    is_archived: false,
  };

  await db.transaction("rw", db.expenseCategories, db.outbox, async () => {
    await db.expenseCategories.add(category);
    await enqueue(db, "upsert", "expense_category", category, {
      name: category.name,
      is_archived: category.is_archived,
    });
  });

  return category;
}

export async function updateExpenseCategory(
  id: string,
  changes: Partial<Pick<ExpenseCategory, "name" | "is_archived">>,
): Promise<void> {
  const device_id = await getDeviceId();
  const at = nowIso();

  await db.transaction("rw", db.expenseCategories, db.outbox, async () => {
    const existing = await db.expenseCategories.get(id);
    if (!existing) throw new Error(`No category ${id}`);
    const real = changedOnly(existing, changes);
    if (Object.keys(real).length === 0) return;

    const updated: ExpenseCategory = { ...existing, ...real, updated_at: at, device_id };
    await db.expenseCategories.put(updated);
    await enqueue(db, "upsert", "expense_category", updated, real as Record<string, unknown>);
  });
}

export interface ExpenseInput {
  amount: number;
  category_id: string;
  date: string;
  applies_to: ExpenseScope;
  applies_to_id?: string | null;
  note?: string | null;
}

export async function recordExpense(input: ExpenseInput): Promise<Expense> {
  const device_id = await getDeviceId();
  const at = nowIso();

  const expense: Expense = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    amount: Math.round(input.amount),
    category_id: input.category_id,
    date: input.date,
    applies_to: input.applies_to,
    // SPEC 3.10 — null when the expense is farm-wide, required otherwise.
    applies_to_id: input.applies_to === "farm" ? null : input.applies_to_id ?? null,
    note: input.note?.trim() || null,
  };

  await db.transaction("rw", db.expenses, db.outbox, async () => {
    await db.expenses.add(expense);
    await enqueue(db, "insert", "expense", expense, {
      amount: expense.amount,
      category_id: expense.category_id,
      date: expense.date,
      applies_to: expense.applies_to,
      applies_to_id: expense.applies_to_id,
      note: expense.note,
    });
  });

  return expense;
}
