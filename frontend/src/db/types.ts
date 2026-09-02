/** Entity shapes. These mirror the server's tables exactly — the same rows live
 *  in IndexedDB and in Postgres, which is what lets a screen render identically
 *  whether or not there is a network. */

export type Species = "cattle" | "goats" | "sheep" | "pigs" | "poultry";
export type RecordKind = "animal" | "group";
export type Sex = "male" | "female";
export type Source = "born_here" | "bought" | "gift";
export type RecordStatus = "active" | "sold" | "dead";
export type MoveReason =
  | "routine"
  | "weaning"
  | "sick"
  | "isolation"
  | "new_arrival"
  | "breeding";

/** SPEC 3.1 — the fields every entity carries. */
export interface SyncFields {
  id: string;
  created_at: string;
  updated_at: string;
  device_id: string;
  deleted_at: string | null;
  /** Server-assigned. Absent until the row has been through a sync. */
  seq?: number;
}

export interface Room extends SyncFields {
  code: string;
  name: string;
  capacity: number;
  is_isolation: boolean;
  notes: string | null;
}

export interface Record_ extends SyncFields {
  kind: RecordKind;
  species: Species;
  tag: string;
  breed: string | null;
  sex: Sex | null;
  date_of_birth: string | null;
  arrival_date: string | null;
  /** What the record was created holding. Immutable. */
  initial_head_count: number;
  /** Derived from events; the server recomputes it and may correct this. */
  head_count: number;
  offspring_count: number | null;
  offspring_updated_at: string | null;
  source: Source;
  status: RecordStatus;
  parent_record_id: string | null;
  notes: string | null;
  /** Cache of the latest move's destination. Recomputed, never authoritative. */
  current_room_id: string | null;
}

export interface Move extends SyncFields {
  record_id: string;
  from_room_id: string | null;
  to_room_id: string;
  date: string;
  count: number;
  reason: MoveReason;
  note: string | null;
}

/** SPEC 3.7 — what a bought record cost. Written alongside the record itself,
 *  never on its own: a purchase with no record is an orphan the server rejects. */
export interface Purchase extends SyncFields {
  record_id: string;
  date: string;
  /** Whole shillings. Money is an integer everywhere in this app (SPEC 1). */
  price: number;
  seller: string | null;
  count: number;
}

/** SPEC 3.6 — one treatment, vaccination or dose. */
export type HealthType = "vaccination" | "deworming" | "treatment" | "vitamin" | "other";

export interface HealthRecord extends SyncFields {
  record_id: string;
  type: HealthType;
  product: string | null;
  dose: string | null;
  date: string;
  /** Drives the overdue and due-soon alerts, and the calendar (SPEC 4.6, 4.7). */
  next_due: string | null;
  /** Withdrawal ends `date + withdrawal_days`; until then a sale needs
   *  confirming (SPEC 6.6). */
  withdrawal_days: number | null;
  vet_id: string | null;
  /** Whole shillings, charged directly against this record (SPEC 4.5). */
  cost: number | null;
  notes: string | null;
  /** SPEC 13.3 — the schedule this dose satisfies, when it was logged from a
   *  due item. Null for an ad-hoc treatment: a sick animal treated out of turn
   *  must not shift any schedule's next date. */
  schedule_id: string | null;
}

/** SPEC 3.8 — a sale. A group sold in parts carries several. */
export interface Sale extends SyncFields {
  record_id: string;
  date: string;
  /** Total for the sale, not per head. Whole shillings. */
  price: number;
  count: number;
  customer_id: string | null;
  notes: string | null;
}

export type DeathCause =
  | "illness"
  | "injury"
  | "predator"
  | "age"
  | "stillbirth"
  | "unknown";

/** SPEC 3.9 — a death. */
export interface Death extends SyncFields {
  record_id: string;
  date: string;
  count: number;
  cause: DeathCause;
  vet_id: string | null;
  notes: string | null;
}

/** SPEC 3.11 — created by the user; the app ships with none. */
export interface ExpenseCategory extends SyncFields {
  name: string;
  is_archived: boolean;
}

export interface Customer extends SyncFields {
  name: string;
  phone: string | null;
  location: string | null;
  notes: string | null;
}

export interface Vet extends SyncFields {
  name: string;
  phone: string | null;
  notes: string | null;
}

/** SPEC 13.2 — which records a schedule covers. */
export type ScheduleAppliesTo = "animals" | "groups" | "both";

/** A schedule may cover one species or every one of them (SPEC 13.2). */
export type ScheduleSpecies = Species | "all";

/**
 * SPEC 13.2 — a rule, not a date.
 *
 * "This species, at this age or on this interval, needs this treatment." A
 * state entity: it is edited in place and archived rather than deleted, so a
 * schedule that has stopped applying keeps naming the treatments it produced
 * (SPEC 4.8).
 */
export interface TreatmentSchedule extends SyncFields {
  name: string;
  species: ScheduleSpecies;
  type: HealthType;
  /** Days after birth or arrival for the first dose. Null means interval-only. */
  first_due_age_days: number | null;
  /** Days between doses after the first. Null means the schedule fires once. */
  repeat_every_days: number | null;
  applies_to: ScheduleAppliesTo;
  default_product: string | null;
  default_withdrawal_days: number | null;
  is_active: boolean;
  notes: string | null;
}

/** SPEC 3.10 — money spent on the farm rather than on one animal. */
export type ExpenseScope = "farm" | "species" | "room";

export interface Expense extends SyncFields {
  /** Whole shillings, greater than zero. */
  amount: number;
  category_id: string;
  date: string;
  applies_to: ExpenseScope;
  /** A species name or a room id. Null when the expense is farm-wide. */
  applies_to_id: string | null;
  note: string | null;
}

export type EntityName =
  | "room"
  | "record"
  | "move"
  | "sale"
  | "death"
  | "purchase"
  | "health_record"
  | "expense_category"
  | "customer"
  | "vet"
  | "expense"
  | "treatment_schedule";

/** One queued mutation. SPEC 5.1. */
export interface OutboxOperation {
  /** Autoincrement, so the outbox drains in the order the user worked. */
  queue_id?: number;
  op: "upsert" | "insert";
  entity: EntityName;
  /** The entity's own id. Retrying the same operation is safe because of it. */
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
  field_updated_at?: Record<string, string>;
  queued_at: string;
  attempts: number;
  last_error: string | null;
  /** When the next attempt may be made; set by the backoff. */
  next_attempt_at: string | null;
}

export interface SyncMeta {
  key: string;
  value: unknown;
}
