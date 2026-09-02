import { describe, expect, it } from "vitest";

import type { HealthRecord, Record_, TreatmentSchedule } from "../db/types";
import {
  durationInWords,
  nextDueFor,
  recordsCovered,
  scheduleCovers,
  scheduleDueItems,
  timingInWords,
} from "./schedules";

/** SPEC 13 — the schedule rules, tested without a database or a screen. */

const TODAY = "2026-09-02";

function record(over: Partial<Record_> = {}): Record_ {
  return {
    id: "rec-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    kind: "animal",
    species: "cattle",
    tag: "C-084",
    breed: null,
    sex: "female",
    date_of_birth: "2026-01-01",
    arrival_date: null,
    initial_head_count: 1,
    head_count: 1,
    offspring_count: null,
    offspring_updated_at: null,
    source: "bought",
    status: "active",
    parent_record_id: null,
    notes: null,
    current_room_id: "room-1",
    ...over,
  };
}

function schedule(over: Partial<TreatmentSchedule> = {}): TreatmentSchedule {
  return {
    id: "sch-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    name: "Deworming",
    species: "cattle",
    type: "deworming",
    first_due_age_days: 60,
    repeat_every_days: 90,
    applies_to: "both",
    default_product: null,
    default_withdrawal_days: null,
    is_active: true,
    notes: null,
    ...over,
  };
}

function treatment(over: Partial<HealthRecord> = {}): HealthRecord {
  return {
    id: "hr-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    type: "deworming",
    product: null,
    dose: null,
    date: "2026-03-01",
    next_due: null,
    withdrawal_days: null,
    vet_id: null,
    cost: null,
    notes: null,
    schedule_id: "sch-1",
    visit_id: null,
    ...over,
  };
}

describe("the interval rule — SPEC 13.3", () => {
  /**
   * The rule the spec states twice, and the reason this file exists.
   *
   * "Deworm on the 7th when it was due on the 10th, and the next one counts
   * from the 7th." Counting from the plan instead would let every early dose
   * shorten the real gap permanently, compounding into an over-treated animal.
   */
  it("counts the next dose from the day it was actually given, not the day it was planned", () => {
    // Born 1 Jan, first dose planned at 60 days: 2 March.
    const born = record({ date_of_birth: "2026-01-01" });
    const every90 = schedule({ first_due_age_days: 60, repeat_every_days: 90 });

    expect(nextDueFor(every90, born, [])?.dueDate).toBe("2026-03-02");

    // Given three days early, on 27 February.
    const early = treatment({ date: "2026-02-27" });
    const next = nextDueFor(every90, born, [early]);

    // 90 days from 27 February, not 90 days from the planned 2 March.
    expect(next?.dueDate).toBe("2026-05-28");
    expect(next?.dueDate).not.toBe("2026-05-31");
    expect(next?.lastGiven?.id).toBe("hr-1");
  });

  it("counts from a late dose the same way, so the gap is never shortened either", () => {
    const born = record({ date_of_birth: "2026-01-01" });
    const every90 = schedule({ first_due_age_days: 60, repeat_every_days: 90 });

    // Planned 2 March, actually given a week late on 9 March.
    const late = treatment({ date: "2026-03-09" });
    expect(nextDueFor(every90, born, [late])?.dueDate).toBe("2026-06-07");
  });

  it("does not compound drift across repeated early doses", () => {
    const born = record({ date_of_birth: "2026-01-01" });
    const every90 = schedule({ first_due_age_days: 60, repeat_every_days: 90 });

    // Each dose is the anchor for the next, so the gap is always exactly 90
    // days from the last real event however early any one of them was.
    const first = treatment({ id: "hr-1", date: "2026-02-27" });
    const second = treatment({ id: "hr-2", date: "2026-05-20" });

    expect(nextDueFor(every90, born, [first, second])?.dueDate).toBe("2026-08-18");
  });

  it("anchors on the most recent dose, whatever order the history arrives in", () => {
    const born = record();
    const every90 = schedule();
    const older = treatment({ id: "hr-1", date: "2026-03-01" });
    const newer = treatment({ id: "hr-2", date: "2026-06-01" });

    expect(nextDueFor(every90, born, [older, newer])?.dueDate).toBe("2026-08-30");
    expect(nextDueFor(every90, born, [newer, older])?.dueDate).toBe("2026-08-30");
  });

  it("breaks a same-day tie on created_at, so two devices agree", () => {
    const born = record();
    const every90 = schedule();
    const a = treatment({ id: "hr-a", date: "2026-06-01", created_at: "2026-06-01T08:00:00Z" });
    const b = treatment({ id: "hr-b", date: "2026-06-01", created_at: "2026-06-01T17:00:00Z" });

    expect(nextDueFor(every90, born, [a, b])?.lastGiven?.id).toBe("hr-b");
    expect(nextDueFor(every90, born, [b, a])?.lastGiven?.id).toBe("hr-b");
  });

  /** SPEC 13.3 — "an ad-hoc treatment does not disturb any schedule." */
  it("ignores a treatment with no schedule_id, so a sick animal does not reset the plan", () => {
    const born = record({ date_of_birth: "2026-01-01" });
    const every90 = schedule({ first_due_age_days: 60, repeat_every_days: 90 });
    const adHoc = treatment({ date: "2026-08-01", schedule_id: null });

    // Still the first dose, still counted from birth.
    const next = nextDueFor(every90, born, [adHoc]);
    expect(next?.dueDate).toBe("2026-03-02");
    expect(next?.lastGiven).toBeNull();
  });

  it("ignores a dose given against a different schedule", () => {
    const born = record();
    const dewormer = schedule({ id: "sch-1" });
    const other = treatment({ schedule_id: "sch-2", date: "2026-08-01" });

    expect(nextDueFor(dewormer, born, [other])?.lastGiven).toBeNull();
  });

  it("ignores a deleted dose", () => {
    const born = record();
    const every90 = schedule();
    const deleted = treatment({ date: "2026-08-01", deleted_at: "2026-08-02T00:00:00Z" });

    expect(nextDueFor(every90, born, [deleted])?.lastGiven).toBeNull();
  });
});

describe("first dose and one-off schedules — SPEC 13.3", () => {
  it("counts a first dose from date of birth for an animal", () => {
    const born = record({ date_of_birth: "2026-06-01" });
    expect(nextDueFor(schedule({ first_due_age_days: 30 }), born, [])?.dueDate).toBe("2026-07-01");
  });

  it("counts a first dose from the arrival date for a group", () => {
    const group = record({
      kind: "group",
      date_of_birth: null,
      arrival_date: "2026-06-01",
      head_count: 40,
    });
    expect(nextDueFor(schedule({ first_due_age_days: 30 }), group, [])?.dueDate).toBe("2026-07-01");
  });

  it("uses the interval as the first age when no first age is set", () => {
    const born = record({ date_of_birth: "2026-06-01" });
    const intervalOnly = schedule({ first_due_age_days: null, repeat_every_days: 90 });
    expect(nextDueFor(intervalOnly, born, [])?.dueDate).toBe("2026-08-30");
  });

  it("stops after the single dose of a one-off schedule", () => {
    const born = record();
    const oneOff = schedule({ first_due_age_days: 14, repeat_every_days: null });

    expect(nextDueFor(oneOff, born, [])?.dueDate).toBe("2026-01-15");
    expect(nextDueFor(oneOff, born, [treatment({ date: "2026-01-15" })])).toBeNull();
  });

  it("never becomes due when the schedule has neither a first age nor an interval", () => {
    const born = record();
    const empty = schedule({ first_due_age_days: null, repeat_every_days: null });
    expect(nextDueFor(empty, born, [])).toBeNull();
  });
});

describe("age unknown — SPEC 13.4", () => {
  /** The silent failure. Nothing fires, and nothing is guessed. */
  it("produces no due date for an animal with no date of birth", () => {
    const noDob = record({ date_of_birth: null });
    expect(nextDueFor(schedule(), noDob, [])).toBeNull();
  });

  it("produces no due date for a group with no arrival date", () => {
    const noArrival = record({ kind: "group", date_of_birth: null, arrival_date: null });
    expect(nextDueFor(schedule(), noArrival, [])).toBeNull();
  });

  it("does not fall back to the record's creation date", () => {
    // Created in January; if creation date were used as a birth date, a 60-day
    // schedule would claim this animal was due in March.
    const noDob = record({ date_of_birth: null, created_at: "2026-01-01T00:00:00Z" });
    const items = scheduleDueItems({
      records: [noDob],
      schedules: [schedule()],
      health: [],
      today: TODAY,
    });
    expect(items).toEqual([]);
  });

  /**
   * A record with no age still becomes due once it has been treated: the
   * interval anchors on the dose, which is a real date, so the missing birth
   * date stops mattering from then on.
   */
  it("still schedules from a real dose even when the age is unknown", () => {
    const noDob = record({ date_of_birth: null });
    const next = nextDueFor(schedule(), noDob, [treatment({ date: "2026-06-01" })]);
    expect(next?.dueDate).toBe("2026-08-30");
  });
});

describe("which records a schedule covers — SPEC 13.3", () => {
  it("matches on species", () => {
    expect(scheduleCovers(schedule({ species: "cattle" }), record({ species: "cattle" }))).toBe(true);
    expect(scheduleCovers(schedule({ species: "cattle" }), record({ species: "goats" }))).toBe(false);
  });

  it("matches every species when set to all", () => {
    expect(scheduleCovers(schedule({ species: "all" }), record({ species: "pigs" }))).toBe(true);
  });

  it("respects applies_to", () => {
    const animal = record({ kind: "animal" });
    const group = record({ kind: "group" });

    expect(scheduleCovers(schedule({ applies_to: "animals" }), animal)).toBe(true);
    expect(scheduleCovers(schedule({ applies_to: "animals" }), group)).toBe(false);
    expect(scheduleCovers(schedule({ applies_to: "groups" }), group)).toBe(true);
    expect(scheduleCovers(schedule({ applies_to: "groups" }), animal)).toBe(false);
    expect(scheduleCovers(schedule({ applies_to: "both" }), animal)).toBe(true);
    expect(scheduleCovers(schedule({ applies_to: "both" }), group)).toBe(true);
  });

  it("counts only active records", () => {
    const records = [
      record({ id: "a", status: "active" }),
      record({ id: "b", status: "sold" }),
      record({ id: "c", status: "dead" }),
      record({ id: "d", deleted_at: "2026-08-01T00:00:00Z" }),
    ];
    expect(recordsCovered(schedule(), records).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("the due list — SPEC 13.3", () => {
  it("raises nothing for an archived schedule", () => {
    const items = scheduleDueItems({
      records: [record()],
      schedules: [schedule({ is_active: false })],
      health: [],
      today: TODAY,
    });
    expect(items).toEqual([]);
  });

  it("raises nothing for a sold or dead record", () => {
    const items = scheduleDueItems({
      records: [record({ id: "sold", status: "sold" }), record({ id: "dead", status: "dead" })],
      schedules: [schedule()],
      health: [],
      today: TODAY,
    });
    expect(items).toEqual([]);
  });

  it("gives one item per record per schedule, soonest first", () => {
    const items = scheduleDueItems({
      records: [record({ id: "a", date_of_birth: "2026-08-01" })],
      schedules: [
        schedule({ id: "s-late", first_due_age_days: 90 }),
        schedule({ id: "s-soon", first_due_age_days: 10 }),
      ],
      health: [],
      today: TODAY,
    });

    expect(items.map((i) => i.schedule.id)).toEqual(["s-soon", "s-late"]);
    expect(items[0]!.id).toBe("s-soon:a");
  });

  it("reports days as negative when overdue and positive when still coming", () => {
    const items = scheduleDueItems({
      // Born 1 Jan, due at 60 days on 2 March — long past today.
      records: [record({ date_of_birth: "2026-01-01" })],
      schedules: [schedule({ first_due_age_days: 60, repeat_every_days: null })],
      health: [],
      today: TODAY,
    });
    expect(items[0]!.days).toBeLessThan(0);
    expect(items[0]!.dueDate).toBe("2026-03-02");
  });

  it("does not let one record's history leak into another's schedule", () => {
    const items = scheduleDueItems({
      records: [
        record({ id: "a", date_of_birth: "2026-06-01" }),
        record({ id: "b", date_of_birth: "2026-06-01" }),
      ],
      schedules: [schedule({ first_due_age_days: 30, repeat_every_days: 90 })],
      // Only `a` was treated.
      health: [treatment({ record_id: "a", date: "2026-07-01" })],
      today: TODAY,
    });

    const byRecord = new Map(items.map((i) => [i.record.id, i]));
    expect(byRecord.get("a")!.dueDate).toBe("2026-09-29");
    expect(byRecord.get("b")!.dueDate).toBe("2026-07-01");
  });
});

describe("timing in words — SPEC 13.6", () => {
  it("says both halves when a schedule has both", () => {
    expect(timingInWords(schedule({ first_due_age_days: 120, repeat_every_days: 180 }))).toBe(
      "First at 4 months, then every 6 months",
    );
  });

  it("says a one-off is a one-off", () => {
    expect(timingInWords(schedule({ first_due_age_days: 14, repeat_every_days: null }))).toBe(
      "Once, at 2 weeks",
    );
  });

  it("names the anchor for an interval-only schedule", () => {
    expect(timingInWords(schedule({ first_due_age_days: null, repeat_every_days: 90 }))).toBe(
      "Every 3 months from birth or arrival",
    );
  });

  it("says plainly when a schedule can never fire", () => {
    expect(timingInWords(schedule({ first_due_age_days: null, repeat_every_days: null }))).toBe(
      "No timing set, so it never becomes due",
    );
  });

  /** Only exact multiples are converted: a rounded restatement of a number the
   *  user typed exactly is worse than the number itself on this screen. */
  it("keeps days as days when they are not a whole number of larger units", () => {
    // 65 is not a whole number of weeks, months or years, so it stays days.
    expect(durationInWords(65)).toBe("65 days");
    // 63 is exactly nine weeks, so it does convert.
    expect(durationInWords(63)).toBe("9 weeks");
    expect(durationInWords(1)).toBe("1 day");
    expect(durationInWords(7)).toBe("1 week");
    expect(durationInWords(30)).toBe("1 month");
    expect(durationInWords(365)).toBe("1 year");
    expect(durationInWords(180)).toBe("6 months");
  });
});
