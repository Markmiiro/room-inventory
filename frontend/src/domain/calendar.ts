import type {
  Death,
  HealthRecord,
  Move,
  Purchase,
  Record_,
  Room,
  Sale,
  TreatmentSchedule,
  Vet,
  VetVisit,
} from "../db/types";
import { typeLabel } from "./alerts";
import { scheduleDueItems } from "./schedules";

/**
 * SPEC 4.7 — the calendar.
 *
 * "The same events as Alerts, arranged by date instead of urgency." So this
 * reads the same rows the alert rules read, and deliberately shares
 * `domain/alerts.ts`'s vocabulary rather than restating it: a treatment that is
 * overdue in one place must not be described differently in the other.
 *
 * Past entries are history — what was done. Future ones are `next_due` dates —
 * what is coming. Nothing here invents a status; a date either has passed or it
 * has not.
 */

export type CalendarKind = "treatment" | "purchase" | "sale" | "move" | "death" | "visit";

export interface CalendarEvent {
  id: string;
  kind: CalendarKind;
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  detail: string;
  recordId?: string;
  /** Future `next_due` dates, as opposed to something that has happened. */
  scheduled: boolean;
}

/** The legend labels every marker type in words (SPEC 4.7) — colour alone
 *  would leave the calendar unreadable to anyone who cannot separate the dots. */
export const KIND_LABEL: Record<CalendarKind, string> = {
  treatment: "Treatments",
  purchase: "Purchases",
  sale: "Sales",
  move: "Moves",
  death: "Deaths",
  visit: "Vet visits",
};

export interface CalendarInputs {
  records: Record_[];
  rooms: Room[];
  moves: Move[];
  purchases: Purchase[];
  health: HealthRecord[];
  sales: Sale[];
  deaths: Death[];
  /** SPEC 16 — the calendar gains scheduled treatments. Defaulted so existing
   *  callers keep working unchanged. */
  schedules?: TreatmentSchedule[];
  /** SPEC 16 — the calendar gains planned vet visits. */
  visits?: VetVisit[];
  vets?: Vet[];
  today: string;
}

const CAUSE_LABEL: Record<Death["cause"], string> = {
  illness: "Illness",
  injury: "Injury",
  predator: "Predator",
  age: "Age",
  stillbirth: "Stillbirth",
  unknown: "Cause unknown",
};

export function calendarEvents(inputs: CalendarInputs): CalendarEvent[] {
  const { records, rooms, moves, purchases, health, sales, deaths, today } = inputs;
  const tagOf = new Map(records.map((r) => [r.id, r.tag]));
  const codeOf = new Map(rooms.map((r) => [r.id, r.code]));
  const name = (id: string) => tagOf.get(id) ?? "A record";

  const events: CalendarEvent[] = [];

  for (const move of moves) {
    if (move.deleted_at) continue;
    const from = move.from_room_id ? codeOf.get(move.from_room_id) : null;
    const to = codeOf.get(move.to_room_id) ?? "another room";
    events.push({
      id: `move:${move.id}`,
      kind: "move",
      date: move.date,
      title: from ? `Move ${from} to ${to}` : `Placed in ${to}`,
      detail: `${name(move.record_id)} · ${move.count} head`,
      recordId: move.record_id,
      scheduled: false,
    });
  }

  for (const purchase of purchases) {
    if (purchase.deleted_at) continue;
    events.push({
      id: `purchase:${purchase.id}`,
      kind: "purchase",
      date: purchase.date,
      title: "Purchase",
      detail: `${name(purchase.record_id)}${purchase.seller ? ` from ${purchase.seller}` : ""}`,
      recordId: purchase.record_id,
      scheduled: false,
    });
  }

  for (const treatment of health) {
    if (treatment.deleted_at) continue;
    const what = treatment.product ?? typeLabel(treatment.type);

    events.push({
      id: `treatment:${treatment.id}`,
      kind: "treatment",
      date: treatment.date,
      title: what,
      detail: `${name(treatment.record_id)}${treatment.dose ? ` · ${treatment.dose}` : ""}`,
      recordId: treatment.record_id,
      scheduled: false,
    });

    // The due date is a separate entry: the dose given and the dose owed are
    // two different days, and the calendar is arranged by day.
    if (treatment.next_due) {
      events.push({
        id: `treatment_due:${treatment.id}`,
        kind: "treatment",
        date: treatment.next_due,
        title: `${what} due`,
        detail: name(treatment.record_id),
        recordId: treatment.record_id,
        scheduled: treatment.next_due >= today,
      });
    }
  }

  for (const sale of sales) {
    if (sale.deleted_at) continue;
    events.push({
      id: `sale:${sale.id}`,
      kind: "sale",
      date: sale.date,
      title: "Sale",
      // The head matters as much as the money: a group sold in parts leaves
      // several entries and only the count tells them apart.
      detail: `${name(sale.record_id)} · ${sale.count} head`,
      recordId: sale.record_id,
      scheduled: false,
    });
  }

  /**
   * SPEC 13 and 16 — scheduled treatments, arranged by the day they fall due.
   *
   * These are always `scheduled: true`: unlike a `next_due` date, a schedule
   * produces only the *next* dose, and the doses already given are in the
   * treatment history above under their own dates. A scheduled item in the past
   * is overdue rather than historical, and the screen colours it from `date`
   * against `today` exactly as it does the hand-typed ones.
   */
  for (const item of scheduleDueItems({
    records,
    schedules: inputs.schedules ?? [],
    health,
    today,
  })) {
    events.push({
      id: `schedule_due:${item.id}`,
      kind: "treatment",
      date: item.dueDate,
      title: `${item.schedule.default_product ?? item.schedule.name} due`,
      detail: `${name(item.record.id)} · from ${item.schedule.name}`,
      recordId: item.record.id,
      scheduled: true,
    });
  }

  /**
   * SPEC 14.5 and 16 — vet visits on the calendar.
   *
   * Both kinds appear. A planned visit is the actionable one and is marked
   * `scheduled`; a completed one is history, and belongs on its date the same
   * way a treatment does. A visit is about the farm rather than one animal, so
   * it carries no `recordId` — the animals it saw are on the visit itself.
   */
  const vetName = new Map((inputs.vets ?? []).map((v) => [v.id, v.name]));
  for (const visit of inputs.visits ?? []) {
    if (visit.deleted_at) continue;
    const who = (visit.vet_id && vetName.get(visit.vet_id)) || "Vet";
    events.push({
      id: `visit:${visit.id}`,
      kind: "visit",
      date: visit.date,
      title: visit.status === "planned" ? `${who} visit planned` : `${who} visit`,
      detail: visit.reason ?? (visit.status === "planned" ? "Planned" : "Completed"),
      scheduled: visit.status === "planned",
    });
  }

  for (const death of deaths) {
    if (death.deleted_at) continue;
    events.push({
      id: `death:${death.id}`,
      kind: "death",
      date: death.date,
      title: CAUSE_LABEL[death.cause],
      detail: `${name(death.record_id)} · ${death.count} head`,
      recordId: death.record_id,
      scheduled: false,
    });
  }

  return events.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
}

/** Events grouped by day, for painting markers on a month grid. */
export function eventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = byDate.get(event.date) ?? [];
    list.push(event);
    byDate.set(event.date, list);
  }
  return byDate;
}

/** The days of a month grid, Sunday-first, padded with the neighbouring days
 *  that fill the first and last weeks. Always whole weeks, so the grid does not
 *  change shape from month to month. */
export function monthGrid(year: number, month: number): string[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  // Day 0 of the next month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  return Array.from({ length: cells }, (_, i) =>
    new Date(Date.UTC(year, month - 1, 1 - firstWeekday + i)).toISOString().slice(0, 10),
  );
}
