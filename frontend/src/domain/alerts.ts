import type {
  HealthRecord,
  Move,
  ProduceType,
  Record_,
  Room,
  Store,
  TreatmentSchedule,
  Vet,
  VetVisit,
} from "../db/types";
import { AGE_UNKNOWN_DETAIL, recordsWithUnknownAge } from "./age";
import { addDays, daysBetween } from "./format";
import { currentRoomId, isOverCapacity, occupancy } from "./rules";
import {
  balanceKey,
  balancesAsAt,
  countVariances,
  lastCountDates,
  type StockInput,
} from "./stores";
import { scheduleDueItems, type DueItem } from "./schedules";

/**
 * SPEC 4.6 — alerts.
 *
 * These are **computed conditions, not stored flags**, which is why they live
 * here rather than inside the Alerts screen. Three screens read the same
 * answers: Alerts lists them by urgency, Rooms banners the ones about rooms,
 * Room detail marks the rows they name, and Calendar arranges the dated ones by
 * day. A rule written into any one of those screens would be a rule the other
 * three quietly disagree with.
 *
 * Every alert carries its meaning in `title` and `detail` as words. Colour is
 * never the only signal, so the priority is a value the caller can read rather
 * than something implied by styling.
 */

export type AlertPriority = "urgent" | "this_week" | "later";

export type AlertKind =
  | "room_over_capacity"
  | "treatment_overdue"
  | "sync_failing"
  | "withdrawal_active"
  | "treatment_due_soon"
  | "long_isolation"
  | "duplicate_tag"
  | "treatment_due_later"
  // SPEC 16 — the three conditions sections 13 and 15 add.
  | "scheduled_treatment_due"
  | "no_date_of_birth"
  // SPEC 14.2 — a planned visit "appears on the Calendar and in Alerts as it
  // approaches".
  | "planned_visit"
  // SPEC 20.12 — the produce stores.
  | "store_negative"
  | "store_over_capacity"
  | "stock_count_overdue"
  | "large_variance";

export interface Alert {
  /** Stable across recomputations, so React keys and "seen" state hold still. */
  id: string;
  kind: AlertKind;
  priority: AlertPriority;
  title: string;
  detail: string;
  /** What the alert is about, for the screens that mark their own rows. */
  roomId?: string;
  recordId?: string;
  /** The date the alert hangs off, when it has one — Calendar orders by this. */
  date?: string;
  /** SPEC 13.6 — the schedule a due item came from, so the screens can chip it
   *  with where the date came from rather than implying it was typed. */
  scheduleId?: string;
  /** How many records an aggregate alert covers, for the ones that count
   *  rather than name (SPEC 13.4). */
  count?: number;
}

export interface AlertInputs {
  rooms: Room[];
  records: Record_[];
  moves: Move[];
  health: HealthRecord[];
  /** SPEC 13 — the rules that turn a schedule into a date. Defaulted so the
   *  existing callers and tests keep working unchanged. */
  schedules?: TreatmentSchedule[];
  /** SPEC 14 — planned visits, for the one that is coming up. */
  visits?: VetVisit[];
  /** Named on the alert, because "a vet visit" is less useful than which vet. */
  vets?: Vet[];
  /** Today in East Africa Time, as YYYY-MM-DD. */
  today: string;
  /** When the oldest unsent outbox entry was queued, as an ISO timestamp.
   *  Null when there is nothing waiting. */
  oldestPendingAt?: string | null;
  pendingCount?: number;
  /** Now, for the one rule measured in hours rather than days. */
  now?: Date;
  /** SPEC 20.12 — the produce stores. Defaulted so every existing caller and
   *  test keeps working unchanged. */
  stores?: Store[];
  produceTypes?: ProduceType[];
  stock?: StockInput;
}

const SYNC_FAILING_HOURS = 48;
/** SPEC 20.12 — how long a store and produce type may go uncounted. */
const STOCK_COUNT_DAYS = 90;
const LONG_ISOLATION_DAYS = 14;
const DUE_SOON_DAYS = 7;
const DUE_LATER_DAYS = 30;

export const PRIORITY_ORDER: AlertPriority[] = ["urgent", "this_week", "later"];

export const PRIORITY_LABEL: Record<AlertPriority, string> = {
  urgent: "Urgent",
  this_week: "This week",
  later: "Later",
};

/**
 * Every alert the current data implies, most urgent first.
 *
 * Pure: the same inputs always give the same answers, which is what makes the
 * rules testable without a database or a screen.
 */
export function computeAlerts(inputs: AlertInputs): Alert[] {
  const { rooms, records, moves, health, today } = inputs;

  const active = records.filter((r) => r.status === "active" && !r.deleted_at);
  const liveHealth = health.filter((h) => !h.deleted_at);
  const byId = new Map(active.map((record) => [record.id, record]));
  const roomById = new Map(rooms.filter((r) => !r.deleted_at).map((room) => [room.id, room]));

  // SPEC 13.3 — computed once and passed down, because two rules read it and a
  // second pass would be a second chance to disagree.
  const dueItems = scheduleDueItems({
    records: active,
    schedules: inputs.schedules ?? [],
    health: liveHealth,
    today,
  });

  const alerts: Alert[] = [
    ...roomsOverCapacity(roomById, active),
    ...treatmentAlerts(liveHealth, byId, today),
    ...scheduledTreatments(dueItems),
    ...missingDateOfBirth(active),
    ...plannedVisits(inputs.visits ?? [], inputs.vets ?? [], today),
    ...syncFailing(inputs),
    ...longIsolationStays(roomById, active, moves, today),
    ...duplicateTags(active),
    // SPEC 20.12 — added to the existing rules rather than derived separately,
    // so Alerts, Rooms and Calendar cannot disagree about them.
    ...storeAlerts(inputs),
  ];

  return alerts.sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  );
}

/** Room over capacity — urgent. The animals are already there; this says so. */
function roomsOverCapacity(roomById: Map<string, Room>, active: Record_[]): Alert[] {
  const alerts: Alert[] = [];
  for (const room of roomById.values()) {
    const inRoom = active.filter((record) => record.current_room_id === room.id);
    const occupied = occupancy(inRoom);
    if (!isOverCapacity(room, occupied)) continue;
    alerts.push({
      id: `room_over_capacity:${room.id}`,
      kind: "room_over_capacity",
      priority: "urgent",
      title: `Room ${room.code} is over capacity`,
      detail: `${occupied} head in a room with space for ${room.capacity}.`,
      roomId: room.id,
    });
  }
  return alerts;
}

/**
 * The three `next_due` rules and the withdrawal rule.
 *
 * They share a pass because they all read the same rows, and because a
 * treatment must land in exactly one of overdue / due soon / due later — the
 * windows are checked in order so they cannot double-report.
 */
function treatmentAlerts(
  health: HealthRecord[],
  byId: Map<string, Record_>,
  today: string,
): Alert[] {
  const alerts: Alert[] = [];

  for (const treatment of health) {
    const record = byId.get(treatment.record_id);
    // SPEC 6.2 — a sold or dead animal is not treated again, so it raises
    // nothing. Its history stays readable on its own screen.
    if (!record) continue;
    const what = treatment.product ?? typeLabel(treatment.type);

    if (treatment.next_due) {
      const days = daysBetween(today, treatment.next_due);
      if (days < 0) {
        alerts.push({
          id: `treatment_overdue:${treatment.id}`,
          kind: "treatment_overdue",
          priority: "urgent",
          title: `${record.tag} — ${what} overdue`,
          detail: `Was due ${-days} ${plural(-days, "day")} ago, on ${treatment.next_due}.`,
          recordId: record.id,
          date: treatment.next_due,
        });
      } else if (days <= DUE_SOON_DAYS) {
        alerts.push({
          id: `treatment_due_soon:${treatment.id}`,
          kind: "treatment_due_soon",
          priority: "this_week",
          title: `${record.tag} — ${what} due`,
          detail: days === 0 ? "Due today." : `Due in ${days} ${plural(days, "day")}.`,
          recordId: record.id,
          date: treatment.next_due,
        });
      } else if (days <= DUE_LATER_DAYS) {
        alerts.push({
          id: `treatment_due_later:${treatment.id}`,
          kind: "treatment_due_later",
          priority: "later",
          title: `${record.tag} — ${what} due`,
          detail: `Due in ${days} days, on ${treatment.next_due}.`,
          recordId: record.id,
          date: treatment.next_due,
        });
      }
    }

    // SPEC 3.6 — withdrawal ends `date + withdrawal_days`, and is active while
    // that end is today or later.
    const end = withdrawalEnd(treatment);
    if (end && end >= today) {
      alerts.push({
        id: `withdrawal_active:${treatment.id}`,
        kind: "withdrawal_active",
        priority: "this_week",
        title: `${record.tag} — withdrawal active`,
        detail: `${what} was given on ${treatment.date}. Withdrawal ends ${end}.`,
        recordId: record.id,
        date: end,
      });
    }
  }

  return alerts;
}

/**
 * SPEC 13 and 16 — a treatment a schedule says is due.
 *
 * These sit alongside the `next_due` rules rather than replacing them: a farm
 * partway through adopting schedules has both, and SPEC 13.6 says the two
 * appear together with the scheduled ones chipped to say where the date came
 * from. They use the same three windows as the hand-typed ones, so "overdue" is
 * one idea on this screen and not two.
 *
 * Only one alert per (record, schedule) pair is possible, because
 * `scheduleDueItems` returns one item per pair. The windows are checked in
 * order so an item cannot land in two of them.
 */
function scheduledTreatments(items: DueItem[]): Alert[] {
  const alerts: Alert[] = [];

  for (const item of items) {
    const { record, schedule, dueDate, days } = item;
    // Anything further out than a month is not yet worth a line on a screen
    // whose whole purpose is what needs doing.
    if (days > DUE_LATER_DAYS) continue;

    const what = schedule.default_product ?? schedule.name;
    const base = {
      kind: "scheduled_treatment_due" as const,
      recordId: record.id,
      scheduleId: schedule.id,
      date: dueDate,
    };

    if (days < 0) {
      alerts.push({
        ...base,
        id: `scheduled_treatment_due:${item.id}`,
        priority: "urgent",
        title: `${record.tag} — ${what} overdue`,
        detail: `${schedule.name} was due ${-days} ${plural(-days, "day")} ago, on ${dueDate}.`,
      });
    } else if (days <= DUE_SOON_DAYS) {
      alerts.push({
        ...base,
        id: `scheduled_treatment_due:${item.id}`,
        priority: "this_week",
        title: `${record.tag} — ${what} due`,
        detail:
          days === 0
            ? `${schedule.name} is due today.`
            : `${schedule.name} is due in ${days} ${plural(days, "day")}.`,
      });
    } else {
      alerts.push({
        ...base,
        id: `scheduled_treatment_due:${item.id}`,
        priority: "later",
        title: `${record.tag} — ${what} due`,
        detail: `${schedule.name} is due in ${days} days, on ${dueDate}.`,
      });
    }
  }

  return alerts;
}

/**
 * SPEC 13.4 — the silent failure, said out loud.
 *
 * A record with no date of birth fires no schedule and shows no sale readiness.
 * Nothing about that is visible from the absence itself, which is exactly why
 * it needs an alert: the app going quiet looks identical to the app having
 * nothing to say.
 *
 * One alert for all of them rather than one each. SPEC 13.4 words it as a
 * count — "N animals have no date of birth" — and a farm that has never filled
 * the field in would otherwise get an alert list that is nothing but this,
 * burying every alert that names something to actually do today.
 */
function missingDateOfBirth(active: Record_[]): Alert[] {
  const missing = recordsWithUnknownAge(active);
  if (missing.length === 0) return [];

  const animals = missing.filter((r) => r.kind === "animal").length;
  const groups = missing.length - animals;

  // Named separately when both are present: they are missing two different
  // fields, on two different forms (SPEC 13.4).
  const what =
    groups === 0
      ? `${animals} ${plural(animals, "animal")} ${animals === 1 ? "has" : "have"} no date of birth`
      : animals === 0
        ? `${groups} ${plural(groups, "group")} ${groups === 1 ? "has" : "have"} no arrival date`
        : `${animals} ${plural(animals, "animal")} have no date of birth and ${groups} ${plural(groups, "group")} have no arrival date`;

  return [
    {
      // Stable regardless of which records are missing it, so the alert does
      // not flicker into a new identity every time one is filled in.
      id: "no_date_of_birth",
      kind: "no_date_of_birth",
      priority: "this_week",
      title: `${what}, so ${missing.length === 1 ? "its" : "their"} treatment schedule cannot run.`,
      detail: AGE_UNKNOWN_DETAIL,
      count: missing.length,
    },
  ];
}

/**
 * SPEC 14.2 — a planned visit, as it approaches.
 *
 * Only planned ones. A completed visit is a thing that has happened and needs
 * nothing from anybody, and a visit already marked completed but dated in the
 * future is a data entry slip rather than something to chase.
 *
 * A planned visit whose date has passed is the case worth being loud about: it
 * either happened and nobody recorded it, or it did not happen and nobody
 * rebooked it. Both need a person, so it is urgent rather than quietly dropped.
 */
function plannedVisits(visits: VetVisit[], vets: Vet[], today: string): Alert[] {
  const nameOf = new Map(vets.filter((v) => !v.deleted_at).map((v) => [v.id, v.name]));
  const alerts: Alert[] = [];

  for (const visit of visits) {
    if (visit.deleted_at) continue;
    if (visit.status !== "planned") continue;

    const days = daysBetween(today, visit.date);
    if (days > DUE_LATER_DAYS) continue;

    const who = (visit.vet_id && nameOf.get(visit.vet_id)) || "The vet";
    const why = visit.reason ? ` \u2014 ${visit.reason}` : "";

    if (days < 0) {
      alerts.push({
        id: `planned_visit:${visit.id}`,
        kind: "planned_visit",
        priority: "urgent",
        title: `${who} was due ${-days} ${plural(-days, "day")} ago`,
        detail: `A visit planned for ${visit.date} is still marked planned${why}. Mark it completed, or move it.`,
        date: visit.date,
      });
    } else {
      alerts.push({
        id: `planned_visit:${visit.id}`,
        kind: "planned_visit",
        priority: days <= DUE_SOON_DAYS ? "this_week" : "later",
        title: days === 0 ? `${who} is due today` : `${who} is due in ${days} ${plural(days, "day")}`,
        detail: `Planned for ${visit.date}${why}.`,
        date: visit.date,
      });
    }
  }

  return alerts;
}

/** SPEC 4.6 — unsynced changes older than 48 hours. Not "offline": being
 *  offline is normal here. This is work that has been stuck long enough to
 *  suggest it is not getting through on its own. */
function syncFailing(inputs: AlertInputs): Alert[] {
  const { oldestPendingAt, pendingCount = 0, now = new Date() } = inputs;
  if (!oldestPendingAt || pendingCount === 0) return [];

  const hours = (now.getTime() - new Date(oldestPendingAt).getTime()) / 3_600_000;
  if (hours < SYNC_FAILING_HOURS) return [];

  return [
    {
      id: "sync_failing",
      kind: "sync_failing",
      priority: "urgent",
      title: `${pendingCount} ${plural(pendingCount, "change")} not sent for ${Math.floor(hours / 24)} days`,
      detail:
        "The work is saved on this device and is not lost. It has been waiting long enough to be worth looking at the connection.",
    },
  ];
}

/** SPEC 4.6 — more than fourteen days in an isolation room. */
function longIsolationStays(
  roomById: Map<string, Room>,
  active: Record_[],
  moves: Move[],
  today: string,
): Alert[] {
  const alerts: Alert[] = [];
  const movesByRecord = new Map<string, Move[]>();
  for (const move of moves) {
    if (move.deleted_at) continue;
    const list = movesByRecord.get(move.record_id) ?? [];
    list.push(move);
    movesByRecord.set(move.record_id, list);
  }

  for (const record of active) {
    const room = roomById.get(record.current_room_id ?? "");
    if (!room?.is_isolation) continue;

    const since = arrivedAt(movesByRecord.get(record.id) ?? [], room.id);
    if (!since) continue;
    const days = daysBetween(since, today);
    if (days <= LONG_ISOLATION_DAYS) continue;

    alerts.push({
      id: `long_isolation:${record.id}`,
      kind: "long_isolation",
      priority: "this_week",
      title: `${record.tag} has been in ${room.code} for ${days} days`,
      detail: `Isolation since ${since}. Worth deciding whether it still needs to be there.`,
      recordId: record.id,
      roomId: room.id,
      date: since,
    });
  }

  return alerts;
}

/**
 * SPEC 4.6 — two active records sharing a tag.
 *
 * On one device this is blocked at entry (SPEC 6.5). It appears here because
 * the server accepts both when they come from two devices that were offline,
 * and raises this instead of throwing one away (SPEC 5.4).
 */
function duplicateTags(active: Record_[]): Alert[] {
  const byTag = new Map<string, Record_[]>();
  for (const record of active) {
    const key = record.tag.trim().toLowerCase();
    const list = byTag.get(key) ?? [];
    list.push(record);
    byTag.set(key, list);
  }

  const alerts: Alert[] = [];
  for (const [, sharing] of byTag) {
    if (sharing.length < 2) continue;
    // Sorted so the id does not change with the order rows came out of Dexie.
    const ids = sharing.map((r) => r.id).sort();
    alerts.push({
      id: `duplicate_tag:${ids.join("+")}`,
      kind: "duplicate_tag",
      priority: "this_week",
      title: `${sharing.length} active records share the tag ${sharing[0]!.tag}`,
      detail:
        "Two devices recorded the same tag while offline. Both were kept — rename one, or mark the one that has left.",
      recordId: ids[0],
    });
  }
  return alerts;
}

/** The date a record arrived in the room it is in now. */
function arrivedAt(moves: Move[], roomId: string): string | null {
  const live = moves.filter((m) => !m.deleted_at);
  if (currentRoomId(live) !== roomId) return null;

  // Walk back through consecutive moves into this room: a record moved out and
  // back has been there since it came back, not since the first time.
  const ordered = [...live].sort((a, b) =>
    a.date === b.date ? a.created_at.localeCompare(b.created_at) : a.date.localeCompare(b.date),
  );
  let since: string | null = null;
  for (const move of ordered) {
    since = move.to_room_id === roomId && move.from_room_id !== roomId ? move.date : since;
    if (move.to_room_id !== roomId) since = null;
  }
  return since;
}

export function withdrawalEnd(treatment: HealthRecord): string | null {
  if (treatment.withdrawal_days == null || treatment.withdrawal_days <= 0) return null;
  return addDays(treatment.date, treatment.withdrawal_days);
}

const TYPE_LABEL: Record<HealthRecord["type"], string> = {
  vaccination: "Vaccination",
  deworming: "Deworming",
  treatment: "Treatment",
  vitamin: "Vitamin",
  other: "Treatment",
};

export function typeLabel(type: HealthRecord["type"]): string {
  return TYPE_LABEL[type];
}

/** The alerts naming one record — Room detail and Animals mark their rows with
 *  these rather than each re-deriving the conditions. */
export function alertsForRecord(alerts: Alert[], recordId: string): Alert[] {
  return alerts.filter((alert) => alert.recordId === recordId);
}

export function alertsForRoom(alerts: Alert[], roomId: string): Alert[] {
  return alerts.filter((alert) => alert.roomId === roomId);
}

export function byPriority(alerts: Alert[]): Array<[AlertPriority, Alert[]]> {
  return PRIORITY_ORDER.map(
    (priority) => [priority, alerts.filter((a) => a.priority === priority)] as [AlertPriority, Alert[]],
  ).filter(([, list]) => list.length > 0);
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}


/**
 * SPEC 20.12 — the produce store conditions.
 *
 * Four rules, all reading the same derived balance the screens read
 * (`domain/stores.ts`). None of them recomputes anything: an alert that
 * disagreed with the store card it points at would be worse than no alert.
 *
 * Silent on a farm with no stock events, which is every farm until the first
 * delivery — so this costs nothing to have switched on from the start.
 */
function storeAlerts(inputs: AlertInputs): Alert[] {
  const stock = inputs.stock;
  if (!stock) return [];

  const stores = (inputs.stores ?? []).filter((s) => !s.deleted_at);
  const types = (inputs.produceTypes ?? []).filter((p) => !p.deleted_at);
  if (stores.length === 0) return [];

  const storeById = new Map(stores.map((s) => [s.id, s]));
  const typeById = new Map(types.map((p) => [p.id, p]));
  const balances = balancesAsAt(inputs.today, stock);
  const alerts: Alert[] = [];

  for (const balance of balances) {
    const store = storeById.get(balance.store_id);
    const type = typeById.get(balance.produce_type_id);
    if (!store || !type) continue;

    /**
     * Urgent. SPEC 20.14.1 and 20.14.2: both outtakes are kept and the balance
     * clamps at zero, so without this the overdraw leaves no trace on any
     * screen — the store simply reads empty, which is also what an empty store
     * reads like.
     */
    if (balance.wentNegative) {
      alerts.push({
        id: `store-negative-${store.id}-${type.id}`,
        kind: "store_negative",
        priority: "urgent",
        title: `More ${type.name} has left ${store.name} than went in`,
        detail:
          "The balance stops at zero rather than going negative, and nothing has been " +
          "discarded. A stock count will set it straight.",
      });
    }
  }

  // SPEC 20.12 — over capacity is measured in sacks across the whole store, not
  // per produce type: a store is full of sacks whatever is in them.
  for (const store of stores) {
    if (store.capacity_sacks === null) continue;
    const sacks = balances
      .filter((b) => b.store_id === store.id)
      .reduce((sum, b) => sum + b.sacks, 0);
    if (sacks <= store.capacity_sacks) continue;

    alerts.push({
      id: `store-capacity-${store.id}`,
      kind: "store_over_capacity",
      priority: "this_week",
      title: `${store.name} is over capacity`,
      detail: `${sacks} sacks in a store that holds ${store.capacity_sacks}.`,
    });
  }

  /**
   * SPEC 20.12 — nothing counted in ninety days, per store and produce type,
   * **where stock exists**. A store holding nothing does not need counting, and
   * saying so every ninety days would train people to ignore the whole list.
   */
  const counted = lastCountDates(stock);
  for (const balance of balances) {
    const store = storeById.get(balance.store_id);
    const type = typeById.get(balance.produce_type_id);
    if (!store || !type || balance.kg <= 0) continue;

    const last = counted.get(balanceKey(balance.store_id, balance.produce_type_id));
    const days = last === undefined ? null : daysBetween(last, inputs.today);
    if (days !== null && days <= STOCK_COUNT_DAYS) continue;

    alerts.push({
      id: `stock-count-${store.id}-${type.id}`,
      kind: "stock_count_overdue",
      priority: "later",
      title: `${type.name} in ${store.name} has not been counted`,
      detail:
        last === null || last === undefined
          ? "There has never been a stock count for this. Counting it is how the records " +
            "and the store are kept in step."
          : `Last counted ${days} days ago.`,
      date: last ?? undefined,
    });
  }

  /**
   * SPEC 20.12 — a count that differed from the ledger by more than a tenth.
   *
   * It is raised against the count rather than the store, so it stays put once
   * the balance has moved on: the point is that something was wrong then, and
   * it is worth knowing why.
   */
  for (const { count, variance } of countVariances(stock)) {
    if (!variance.large || !variance.words) continue;
    const store = storeById.get(count.store_id);
    const type = typeById.get(count.produce_type_id);
    if (!store || !type) continue;

    alerts.push({
      id: `variance-${count.id}`,
      kind: "large_variance",
      priority: "this_week",
      title: `${type.name} in ${store.name} counted differently from the records`,
      detail: variance.words,
      date: count.date,
    });
  }

  return alerts;
}
