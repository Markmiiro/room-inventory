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
  IntakeSource,
  Move,
  MoveReason,
  OutboxOperation,
  OuttakeReason,
  PriceBasis,
  ProduceType,
  Purchase,
  Record_,
  RecordKind,
  Room,
  Sale,
  Sex,
  Source,
  Species,
  StockCount,
  StockIntake,
  StockOuttake,
  Store,
  TreatmentSchedule,
  VetVisit,
  VisitNote,
  VisitStatus,
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
  | ExpenseCategory
  | TreatmentSchedule
  | VetVisit
  | VisitNote
  | Store
  | ProduceType
  | StockIntake
  | StockOuttake
  | StockCount;

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
    // Kept for animals as well as groups. It used to be discarded for an
    // animal, which meant a date the user had typed on the add form survived
    // only as the date of the record's first move — recoverable in principle,
    // invisible in practice, and gone entirely for an animal added with no
    // room. It is when the animal joined the farm, which is worth knowing on
    // its own.
    //
    // It is deliberately *not* an age. SPEC 13.3 counts an animal's age from
    // its date of birth and a group's from its arrival, and that asymmetry is
    // correct: a two-year-old cow bought last week arrived last week and is not
    // a week old. `domain/age.ts` does not read this field for an animal.
    arrival_date: input.arrival_date ?? null,
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
  /** SPEC 13.3 — the schedule this dose satisfies. Set when the treatment was
   *  logged from a due item; left null for an ad-hoc one. */
  schedule_id?: string | null;
  /** SPEC 14.2 — the visit this was given during. Null when self-administered. */
  visit_id?: string | null;
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
    // SPEC 13.3 — an ad-hoc treatment carries null here and so does not move
    // any schedule's next date. Only a dose logged against a due item does.
    schedule_id: input.schedule_id ?? null,
    // SPEC 14.2 — set only when the dose was given during a visit, which is
    // also what makes the animal count as seen for the call-out fee split.
    visit_id: input.visit_id ?? null,
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
      schedule_id: treatment.schedule_id,
      visit_id: treatment.visit_id,
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


// ---------------------------------------------------------------------------
// Treatment schedules — SPEC 13
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  name: string;
  species: TreatmentSchedule["species"];
  type: HealthType;
  first_due_age_days?: number | null;
  repeat_every_days?: number | null;
  applies_to?: TreatmentSchedule["applies_to"];
  default_product?: string | null;
  default_withdrawal_days?: number | null;
  notes?: string | null;
}

export async function createSchedule(input: ScheduleInput): Promise<TreatmentSchedule> {
  const device_id = await getDeviceId();
  const at = nowIso();

  const schedule: TreatmentSchedule = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    name: input.name.trim(),
    species: input.species,
    type: input.type,
    first_due_age_days: input.first_due_age_days ?? null,
    repeat_every_days: input.repeat_every_days ?? null,
    applies_to: input.applies_to ?? "both",
    default_product: input.default_product?.trim() || null,
    default_withdrawal_days: input.default_withdrawal_days ?? null,
    is_active: true,
    notes: input.notes?.trim() || null,
  };

  await db.transaction("rw", db.treatmentSchedules, db.outbox, async () => {
    await db.treatmentSchedules.add(schedule);
    await enqueue(db, "upsert", "treatment_schedule", schedule, scheduleFields(schedule));
  });

  return schedule;
}

/**
 * Edit a schedule.
 *
 * A state entity, so the same per-field discipline as rooms and categories: only
 * what genuinely changed is pushed, or this device's untouched copy of every
 * other field would compete with another device's real edit to it (SPEC 5.4).
 *
 * `is_active` is in here rather than in a delete: SPEC 13.5 says schedules are
 * archived, never deleted, so the treatments already given against one keep
 * naming it.
 */
export type ScheduleEdit = Partial<
  Pick<
    TreatmentSchedule,
    | "name"
    | "species"
    | "type"
    | "first_due_age_days"
    | "repeat_every_days"
    | "applies_to"
    | "default_product"
    | "default_withdrawal_days"
    | "is_active"
    | "notes"
  >
>;

export async function updateSchedule(id: string, changes: ScheduleEdit): Promise<void> {
  const device_id = await getDeviceId();
  const at = nowIso();

  await db.transaction("rw", db.treatmentSchedules, db.outbox, async () => {
    const existing = await db.treatmentSchedules.get(id);
    if (!existing) throw new Error(`No schedule ${id}`);

    const real = changedOnly(existing, changes);
    if (Object.keys(real).length === 0) return;

    const updated: TreatmentSchedule = { ...existing, ...real, updated_at: at, device_id };
    await db.treatmentSchedules.put(updated);
    await enqueue(db, "upsert", "treatment_schedule", updated, real as Record<string, unknown>);
  });
}

function scheduleFields(schedule: TreatmentSchedule): Record<string, unknown> {
  return {
    name: schedule.name,
    species: schedule.species,
    type: schedule.type,
    first_due_age_days: schedule.first_due_age_days,
    repeat_every_days: schedule.repeat_every_days,
    applies_to: schedule.applies_to,
    default_product: schedule.default_product,
    default_withdrawal_days: schedule.default_withdrawal_days,
    is_active: schedule.is_active,
    notes: schedule.notes,
  };
}


// ---------------------------------------------------------------------------
// Vet visits — SPEC 14
// ---------------------------------------------------------------------------

export interface VetVisitInput {
  date: string;
  vet_id?: string | null;
  status?: VisitStatus;
  call_out_fee?: number | null;
  reason?: string | null;
  notes?: string | null;
}

/**
 * Create a visit.
 *
 * **A state entity, not an event — a deliberate departure from SPEC 16.**
 *
 * SPEC 16's sync note says "Visits and visit notes are events, append-only".
 * That cannot be built as written. SPEC 14.2 gives a visit a `status` of
 * `planned` or `completed` and describes the working pattern as "create the
 * visit, add treatments as they happen, mark completed" — marking completed is
 * an update to an existing row. The same is true of the two fields the vet
 * leaves behind: the call-out fee and "what the vet said" are both written
 * after the visit, onto a row that already exists. An append-only visit would
 * make every one of those a new visit, and a farm with one call-out would end
 * up with three rows for it and the fee counted three times.
 *
 * So a visit carries `field_versions` and merges per field like a room or a
 * schedule (SPEC 5.4). That is also the behaviour the farm needs: one person
 * marking a visit completed and another typing up the vet's advice must not
 * cost each other their work.
 *
 * `VisitNote` genuinely is an event, and is built as one — it is written once,
 * about one animal, and corrected by adding another note.
 */
export async function createVetVisit(input: VetVisitInput): Promise<VetVisit> {
  const device_id = await getDeviceId();
  const at = nowIso();

  const visit: VetVisit = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    date: input.date,
    vet_id: input.vet_id ?? null,
    // SPEC 14.2 — "called out" starts completed and "scheduled" starts planned.
    status: input.status ?? "completed",
    call_out_fee: input.call_out_fee ?? null,
    reason: input.reason?.trim() || null,
    notes: input.notes?.trim() || null,
  };

  await db.transaction("rw", db.vetVisits, db.outbox, async () => {
    await db.vetVisits.add(visit);
    await enqueue(db, "upsert", "vet_visit", visit, visitFields(visit));
  });

  return visit;
}

export type VetVisitEdit = Partial<
  Pick<VetVisit, "date" | "vet_id" | "status" | "call_out_fee" | "reason" | "notes">
>;

export async function updateVetVisit(id: string, changes: VetVisitEdit): Promise<void> {
  const device_id = await getDeviceId();
  const at = nowIso();

  await db.transaction("rw", db.vetVisits, db.outbox, async () => {
    const existing = await db.vetVisits.get(id);
    if (!existing) throw new Error(`No visit ${id}`);

    const real = changedOnly(existing, changes);
    if (Object.keys(real).length === 0) return;

    const updated: VetVisit = { ...existing, ...real, updated_at: at, device_id };
    await db.vetVisits.put(updated);
    // Per field, for the same reason as every other state entity: sending an
    // untouched field would let this device's stale copy beat another device's
    // real edit to it (SPEC 5.4).
    await enqueue(db, "upsert", "vet_visit", updated, real as Record<string, unknown>);
  });
}

function visitFields(visit: VetVisit): Record<string, unknown> {
  return {
    date: visit.date,
    vet_id: visit.vet_id,
    status: visit.status,
    call_out_fee: visit.call_out_fee,
    reason: visit.reason,
    notes: visit.notes,
  };
}

export interface VisitNoteInput {
  visit_id: string;
  record_id: string;
  note: string;
}

/**
 * SPEC 14.4 — record that the vet looked at an animal without treating it.
 *
 * An event: written once, never edited. It exists so "the vet looked at this
 * one and said watch it" can be recorded without inventing a treatment that
 * never happened — and it counts that animal as seen, so it takes its share of
 * the call-out fee (SPEC 14.3).
 */
export async function recordVisitNote(input: VisitNoteInput): Promise<VisitNote> {
  const device_id = await getDeviceId();
  const at = nowIso();

  const note: VisitNote = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    visit_id: input.visit_id,
    record_id: input.record_id,
    note: input.note.trim(),
  };

  await db.transaction("rw", db.visitNotes, db.outbox, async () => {
    await db.visitNotes.add(note);
    await enqueue(db, "insert", "visit_note", note, {
      visit_id: note.visit_id,
      record_id: note.record_id,
      note: note.note,
    });
  });

  return note;
}


/* ── SPEC 20 — produce stores ────────────────────────────────────────────── */

export interface IntakeInput {
  store_id: string;
  produce_type_id: string;
  date: string;
  sacks?: number | null;
  kg: number;
  source: IntakeSource;
  garden_name?: string | null;
  seller?: string | null;
  customer_id?: string | null;
  cost?: number | null;
  harvest_label?: string | null;
  notes?: string | null;
}

/** The fields pushed for an intake. Listed once so the local row and the queued
 *  operation cannot drift apart. */
function intakeFields(intake: StockIntake): Record<string, unknown> {
  return {
    store_id: intake.store_id,
    produce_type_id: intake.produce_type_id,
    date: intake.date,
    sacks: intake.sacks,
    kg: intake.kg,
    source: intake.source,
    garden_name: intake.garden_name,
    seller: intake.seller,
    customer_id: intake.customer_id,
    cost: intake.cost,
    harvest_label: intake.harvest_label,
    notes: intake.notes,
  };
}

function buildIntake(input: IntakeInput, device_id: string, at: string): StockIntake {
  const bought = input.source === "bought";
  return {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    store_id: input.store_id,
    produce_type_id: input.produce_type_id,
    date: input.date,
    // Sacks are optional everywhere (SPEC 20.8). Zero is not the same as
    // "not counted", so an absent value stays null rather than becoming 0.
    sacks: input.sacks ?? null,
    kg: input.kg,
    source: input.source,
    // Only the fields belonging to the chosen source survive, so a form that
    // was filled in, switched and submitted cannot leave a seller on a garden
    // delivery.
    garden_name: bought ? null : input.garden_name?.trim() || null,
    seller: bought ? input.seller?.trim() || null : null,
    customer_id: bought ? (input.customer_id ?? null) : null,
    // SPEC 20.9 — garden produce enters at zero cost, because growing it is
    // already recorded as Expenses and counting it twice would understate the
    // farm's profit.
    cost: bought ? Math.round(input.cost ?? 0) : null,
    harvest_label: input.harvest_label?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

/** SPEC 20.5 — produce arriving in a store. */
export async function recordIntake(input: IntakeInput): Promise<StockIntake> {
  const device_id = await getDeviceId();
  const at = nowIso();

  return db.transaction("rw", db.stockIntakes, db.outbox, async () => {
    const intake = buildIntake(input, device_id, at);
    await db.stockIntakes.add(intake);
    await enqueue(db, "insert", "stock_intake", intake, intakeFields(intake));
    return intake;
  });
}

export interface OuttakeInput {
  store_id: string;
  produce_type_id: string;
  date: string;
  sacks?: number | null;
  kg: number;
  reason: OuttakeReason;
  price_basis?: PriceBasis | null;
  unit_price?: number | null;
  total_price?: number | null;
  customer_id?: string | null;
  to_store_id?: string | null;
  notes?: string | null;
}

function outtakeFields(outtake: StockOuttake): Record<string, unknown> {
  return {
    store_id: outtake.store_id,
    produce_type_id: outtake.produce_type_id,
    date: outtake.date,
    sacks: outtake.sacks,
    kg: outtake.kg,
    reason: outtake.reason,
    price_basis: outtake.price_basis,
    unit_price: outtake.unit_price,
    total_price: outtake.total_price,
    customer_id: outtake.customer_id,
    to_store_id: outtake.to_store_id,
    notes: outtake.notes,
  };
}

/**
 * SPEC 20.6 — produce leaving a store.
 *
 * **A move writes both halves in one transaction.** An outtake with reason
 * `moved` is mirrored as an intake in the destination store, carrying the same
 * date and quantities, so a half-finished move cannot leave produce in neither
 * store (SPEC 20.14.8). Dexie rolls the whole transaction back on any failure,
 * which is what makes that guarantee structural rather than hopeful.
 *
 * **Nothing is blocked for being too large.** SPEC 20.14.1: the produce may
 * physically be there when the ledger is wrong, so an overdraw is warned about
 * on the form, written anyway, and clamped by the balance rule with an alert
 * raised. Same rule as SPEC 6.7 for oversold groups.
 */
export async function recordOuttake(
  input: OuttakeInput,
): Promise<{ outtake: StockOuttake; mirrored: StockIntake | null }> {
  const device_id = await getDeviceId();
  const at = nowIso();
  const sold = input.reason === "sold";
  const moved = input.reason === "moved";

  // SPEC 20.14.7 — a store cannot receive its own stock. The form does not
  // offer it; this is the guard for a stale screen.
  if (moved && input.to_store_id === input.store_id) {
    throw new Error("A move needs a different destination store");
  }
  if (moved && !input.to_store_id) {
    throw new Error("A move needs a destination store");
  }

  return db.transaction("rw", db.stockIntakes, db.stockOuttakes, db.outbox, async () => {
    const outtake: StockOuttake = {
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      deleted_at: null,
      store_id: input.store_id,
      produce_type_id: input.produce_type_id,
      date: input.date,
      sacks: input.sacks ?? null,
      kg: input.kg,
      reason: input.reason,
      // Only a sale carries money, and only a move carries a destination. A
      // reason switched on the form leaves nothing behind from the previous one.
      price_basis: sold ? (input.price_basis ?? null) : null,
      unit_price: sold && input.unit_price != null ? Math.round(input.unit_price) : null,
      // SPEC 20.6 — the total is the stored truth. Every money figure reads it,
      // so none of them depends on whether the deal was struck per kilogram or
      // per sack.
      total_price: sold && input.total_price != null ? Math.round(input.total_price) : null,
      customer_id: sold ? (input.customer_id ?? null) : null,
      to_store_id: moved ? (input.to_store_id ?? null) : null,
      notes: input.notes?.trim() || null,
    };

    await db.stockOuttakes.add(outtake);
    await enqueue(db, "insert", "stock_outtake", outtake, outtakeFields(outtake));

    if (!moved) return { outtake, mirrored: null };

    // The other half of the move. It is an ordinary intake — the produce really
    // did arrive in the destination — sourced from the garden so it adds no
    // cost: the farm did not buy anything, it carried sacks across the yard.
    // Giving it a cost here would inflate the weighted average in the
    // destination and count the same money twice (SPEC 20.9).
    const mirrored = buildIntake(
      {
        store_id: outtake.to_store_id!,
        produce_type_id: outtake.produce_type_id,
        date: outtake.date,
        sacks: outtake.sacks,
        kg: outtake.kg,
        source: "garden",
        garden_name: null,
        notes: outtake.notes,
      },
      device_id,
      at,
    );

    await db.stockIntakes.add(mirrored);
    await enqueue(db, "insert", "stock_intake", mirrored, intakeFields(mirrored));

    return { outtake, mirrored };
  });
}


/**
 * SPEC 20.4 and 20.17 — managing produce types.
 *
 * A state entity, so only the fields that genuinely changed are pushed: the
 * server merges per field, and asserting an untouched value would let this
 * device beat another device's real edit to it (SPEC 5.4).
 */
export async function createProduceType(name: string): Promise<ProduceType> {
  const device_id = await getDeviceId();
  const at = nowIso();
  const produceType: ProduceType = {
    id: newId(),
    created_at: at,
    updated_at: at,
    device_id,
    deleted_at: null,
    name: name.trim(),
    is_active: true,
    // Empty until the farm says otherwise (SPEC 20.17).
    typical_sack_kg: null,
    notes: null,
  };

  await db.transaction("rw", db.produceTypes, db.outbox, async () => {
    await db.produceTypes.add(produceType);
    await enqueue(db, "upsert", "produce_type", produceType, {
      name: produceType.name,
      is_active: produceType.is_active,
      typical_sack_kg: produceType.typical_sack_kg,
      notes: produceType.notes,
    });
  });
  return produceType;
}

export async function updateProduceType(
  id: string,
  changes: Partial<Pick<ProduceType, "name" | "is_active" | "typical_sack_kg" | "notes">>,
): Promise<void> {
  const device_id = await getDeviceId();
  const at = nowIso();

  await db.transaction("rw", db.produceTypes, db.outbox, async () => {
    const existing = await db.produceTypes.get(id);
    if (!existing) throw new Error(`No produce type ${id}`);
    const real = changedOnly(existing, changes);
    if (Object.keys(real).length === 0) return;

    const updated: ProduceType = { ...existing, ...real, updated_at: at, device_id };
    await db.produceTypes.put(updated);
    await enqueue(db, "upsert", "produce_type", updated, real as Record<string, unknown>);
  });
}


export interface StockCountInput {
  store_id: string;
  produce_type_id: string;
  date: string;
  counted_sacks?: number | null;
  counted_kg: number;
  notes?: string | null;
}

/**
 * SPEC 20.7 — a physical count.
 *
 * An event, appended like any other. It carries no adjustment and no delta: the
 * balance rule reads it as a **reset** from its date onward
 * (`domain/stores.ts`), so what is stored is simply what was in the store.
 *
 * Recording the difference instead would make the count depend on whatever the
 * ledger happened to say when it was typed — and a backdated delivery arriving
 * later would silently change what the count meant.
 */
export async function recordStockCount(input: StockCountInput): Promise<StockCount> {
  const device_id = await getDeviceId();
  const at = nowIso();

  return db.transaction("rw", db.stockCounts, db.outbox, async () => {
    const count: StockCount = {
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      deleted_at: null,
      store_id: input.store_id,
      produce_type_id: input.produce_type_id,
      date: input.date,
      // Null means the sacks were not counted, which is not the same as zero
      // and is what keeps the sack balance honest (SPEC 20.8).
      counted_sacks: input.counted_sacks ?? null,
      counted_kg: input.counted_kg,
      notes: input.notes?.trim() || null,
    };

    await db.stockCounts.add(count);
    await enqueue(db, "insert", "stock_count", count, {
      store_id: count.store_id,
      produce_type_id: count.produce_type_id,
      date: count.date,
      counted_sacks: count.counted_sacks,
      counted_kg: count.counted_kg,
      notes: count.notes,
    });
    return count;
  });
}
