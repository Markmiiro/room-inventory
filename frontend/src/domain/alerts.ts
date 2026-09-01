import type { HealthRecord, Move, Record_, Room } from "../db/types";
import { addDays, daysBetween } from "./format";
import { currentRoomId, isOverCapacity, occupancy } from "./rules";

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
  | "treatment_due_later";

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
}

export interface AlertInputs {
  rooms: Room[];
  records: Record_[];
  moves: Move[];
  health: HealthRecord[];
  /** Today in East Africa Time, as YYYY-MM-DD. */
  today: string;
  /** When the oldest unsent outbox entry was queued, as an ISO timestamp.
   *  Null when there is nothing waiting. */
  oldestPendingAt?: string | null;
  pendingCount?: number;
  /** Now, for the one rule measured in hours rather than days. */
  now?: Date;
}

const SYNC_FAILING_HOURS = 48;
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

  const alerts: Alert[] = [
    ...roomsOverCapacity(roomById, active),
    ...treatmentAlerts(liveHealth, byId, today),
    ...syncFailing(inputs),
    ...longIsolationStays(roomById, active, moves, today),
    ...duplicateTags(active),
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
