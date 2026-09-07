/** Entity shapes. These mirror the server's tables exactly — the same rows live
 *  in IndexedDB and in Postgres, which is what lets a screen render identically
 *  whether or not there is a network. */

/**
 * SPEC 18 — the four birds are separate species.
 *
 * `poultry` was one value covering hens, ducks, geese and turkeys, which are
 * not one thing: they mature at different ages, so they reach market at
 * different ages (SPEC 15), and a room holding hens is not a room holding
 * geese. The single value made the sale-readiness target meaningless for three
 * of the four, because whatever number it carried was right for at most one.
 *
 * The order here is the order they are shown in everywhere — the filter chips,
 * the Animals list sections, the census. `ALL_SPECIES` in `domain/rules.ts` is
 * the runtime list, and it is the only one: a screen must never write its own.
 */
export type Species =
  | "cattle"
  | "goats"
  | "sheep"
  | "pigs"
  | "hens"
  | "ducks"
  | "geese"
  | "turkeys";
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
  /** SPEC 14.2 — the visit this treatment was given during. Null for a
   *  self-administered one, which is how the farm works most days. */
  visit_id: string | null;
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
/**
 * What a schedule covers: one species, every bird, or everything.
 *
 * `birds` exists because of SPEC 18. The Newcastle and Gumboro schedules were
 * seeded against `poultry`, and when that became four species the choice was
 * either four copies of each row or one row that says "the birds". Four copies
 * is worse than it looks: changing the Newcastle interval would become four
 * edits that must agree, and a farmer who changed only three would get a
 * schedule that fires differently for ducks than for hens with nothing on
 * screen explaining why. One row keeps one interval to edit, and keeps the
 * seeded IDs stable so an edit already made survives the split (SPEC 16).
 */
export type ScheduleSpecies = Species | "birds" | "all";

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

/** SPEC 14.2 — a planned visit is a future date; a completed one has happened. */
export type VisitStatus = "planned" | "completed";

/**
 * SPEC 14.2 — one visit from the vet.
 *
 * A real visit is one date, one vet, several animals, some treated and some
 * only looked at, and a single call-out fee for the lot. A treatment is one
 * animal and one product, so none of that fits on a HealthRecord — which is why
 * this exists rather than more fields on the treatment.
 *
 * It is a **state** entity rather than an event, which is a deliberate
 * departure from SPEC 16's sync note; see the comment on `createVetVisit` in
 * `db/mutations.ts` for why an append-only visit cannot be marked completed.
 */
export interface VetVisit extends SyncFields {
  /** May be in the future, for a planned visit (SPEC 14.2). */
  date: string;
  vet_id: string | null;
  status: VisitStatus;
  /** Whole shillings. The fee for the journey, separate from any treatment
   *  cost (SPEC 14.3). */
  call_out_fee: number | null;
  reason: string | null;
  notes: string | null;
}

/**
 * SPEC 14.4 — the vet looked at this one and said watch it.
 *
 * An observation rather than a treatment. It exists so that "seen but not
 * treated" can be recorded without inventing a dose that was never given, and
 * it counts the animal as seen for the fee split.
 *
 * A genuine event: written once, about one animal, on one visit.
 */
export interface VisitNote extends SyncFields {
  visit_id: string;
  record_id: string;
  note: string;
}

/* ── SPEC 20 — stores and produce ───────────────────────────────────────────
 *
 * A second inventory beside the livestock one. It shares the sync engine, the
 * design language and the money figures, and shares none of the data model:
 * produce is kilograms and sacks, animals are head, and conflating them
 * corrupts both. **A Store is not a Room** (SPEC 20.2) — rooms carry a capacity
 * in head, a derived species type and animals inside them, and putting sacks in
 * one would corrupt occupancy, room type and every alert that reads them.
 */

/** SPEC 20.3 — a state entity. Seeded with two at fixed ids, like the rooms. */
export interface Store extends SyncFields {
  code: string;
  name: string;
  /** Optional. Warns when exceeded, never blocks — the sacks are physically
   *  there whether the app approves or not (SPEC 4.2's rule, restated). */
  capacity_sacks: number | null;
  notes: string | null;
}

/**
 * SPEC 20.4 — a state entity, never a hardcoded enum.
 *
 * Seeded with Coffee, Maize and Beans and extended by the user. The species
 * enum was the other choice and it cost a nine-file migration to undo (SPEC 18).
 */
export interface ProduceType extends SyncFields {
  name: string;
  is_active: boolean;
  notes: string | null;
}

export type IntakeSource = "garden" | "bought";

/** SPEC 20.5 — produce arriving in a store. An event: append-only. */
export interface StockIntake extends SyncFields {
  store_id: string;
  produce_type_id: string;
  date: string;
  /** Optional. When it is absent anywhere in a series the sack balance is
   *  reported as partial rather than as though it were complete (SPEC 20.8). */
  sacks: number | null;
  /** Required on every event. Weight is what gets sold and what carries value. */
  kg: number;
  source: IntakeSource;
  garden_name: string | null;
  seller: string | null;
  customer_id: string | null;
  /** UGX. Required when bought, absent when from the garden — growing it was
   *  already recorded as Expenses, and a second notional cost here would count
   *  the same money twice (SPEC 20.9). */
  cost: number | null;
  /** SPEC 20.16 Q2 — a label, not a lot. It records which harvest a delivery
   *  came from without giving it its own balance, because nothing can say which
   *  physical kilograms later left a pooled store. */
  harvest_label: string | null;
  notes: string | null;
}

/** SPEC 20.6 — why produce left. Always required: an unexplained outtake is a
 *  hole in exactly the records this feature exists to keep. */
export type OuttakeReason =
  | "sold"
  | "home_use"
  | "seed"
  | "gift"
  | "spoiled"
  | "processing"
  | "moved"
  | "other";

/** What was negotiated. Sales may be struck per kilogram or per sack, and the
 *  two are never derived from one another (SPEC 20.8). */
export type PriceBasis = "kg" | "sack";

/** SPEC 20.6 — produce leaving a store. An event: append-only. */
export interface StockOuttake extends SyncFields {
  store_id: string;
  produce_type_id: string;
  date: string;
  sacks: number | null;
  kg: number;
  reason: OuttakeReason;
  price_basis: PriceBasis | null;
  /** What was typed, per `price_basis`. Display and audit only. */
  unit_price: number | null;
  /** UGX, and **the stored truth**. Every money figure reads this, so none of
   *  them depends on how the deal was worded (SPEC 20.6). */
  total_price: number | null;
  customer_id: string | null;
  /** Only when the reason is `moved`. The mirrored intake is written in the
   *  same transaction, so a half-finished move cannot leave produce in neither
   *  store (SPEC 20.14.8). */
  to_store_id: string | null;
  notes: string | null;
}

/**
 * SPEC 20.7 — a physical count, reconciling the ledger against the store.
 *
 * Not decoration. Coffee loses weight as it dries and beans go to weevils, so
 * without this the ledger drifts and the only way to correct it would be to
 * invent a fake outtake — which would pollute the reasons that make the feature
 * worth having.
 *
 * A count **resets** the running balance to its counted figure from its date
 * onward, which is why it belongs to the balance rule rather than beside it.
 */
export interface StockCount extends SyncFields {
  store_id: string;
  produce_type_id: string;
  date: string;
  counted_sacks: number | null;
  counted_kg: number;
  notes: string | null;
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
  | "treatment_schedule"
  | "vet_visit"
  | "visit_note"
  | "store"
  | "produce_type"
  | "stock_intake"
  | "stock_outtake"
  | "stock_count";

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
