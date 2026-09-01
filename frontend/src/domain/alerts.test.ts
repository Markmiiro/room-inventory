import { describe, expect, it } from "vitest";

import type { HealthRecord, Move, Record_, Room } from "../db/types";
import { alertsForRecord, alertsForRoom, byPriority, computeAlerts, withdrawalEnd } from "./alerts";
import { calendarEvents, monthGrid } from "./calendar";

/**
 * SPEC 4.6 and 4.7.
 *
 * These rules are shared by four screens — Alerts lists them, Rooms banners
 * them, Room detail marks its rows with them, Calendar arranges the dated ones
 * by day. Testing them here rather than through a screen is the point: a rule
 * that only one screen agrees with is the bug this module exists to prevent.
 */

const TODAY = "2026-09-01";

function room(over: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    code: "R1",
    name: "Front room",
    capacity: 20,
    is_isolation: false,
    notes: null,
    ...over,
  };
}

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
    date_of_birth: null,
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

function move(over: Partial<Move> = {}): Move {
  return {
    id: "mv-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    from_room_id: null,
    to_room_id: "room-1",
    date: "2026-08-01",
    count: 1,
    reason: "new_arrival",
    note: null,
    ...over,
  };
}

function health(over: Partial<HealthRecord> = {}): HealthRecord {
  return {
    id: "hr-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-1",
    type: "vaccination",
    product: "FMD",
    dose: null,
    date: "2026-08-01",
    next_due: null,
    withdrawal_days: null,
    vet_id: null,
    cost: null,
    notes: null,
    ...over,
  };
}

function run(over: Partial<Parameters<typeof computeAlerts>[0]> = {}) {
  return computeAlerts({
    rooms: [room()],
    records: [record()],
    moves: [move()],
    health: [],
    today: TODAY,
    ...over,
  });
}

describe("room over capacity", () => {
  it("raises an urgent alert naming the room and both numbers", () => {
    const alerts = run({
      rooms: [room({ capacity: 2 })],
      records: [record({ kind: "group", head_count: 5 })],
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "room_over_capacity", priority: "urgent", roomId: "room-1" });
    // Colour is never the only signal (SPEC 4.6): the numbers are in the words.
    expect(alerts[0]!.detail).toContain("5");
    expect(alerts[0]!.detail).toContain("2");
  });

  it("says nothing about a room that is exactly full", () => {
    const alerts = run({
      rooms: [room({ capacity: 5 })],
      records: [record({ kind: "group", head_count: 5 })],
    });
    expect(alerts).toEqual([]);
  });

  it("counts head rather than records", () => {
    // SPEC 4.2 — occupancy is head. Three records of four head is twelve, not
    // three, and a room for ten is over.
    const alerts = run({
      rooms: [room({ capacity: 10 })],
      records: [
        record({ id: "a", tag: "A", kind: "group", head_count: 4 }),
        record({ id: "b", tag: "B", kind: "group", head_count: 4 }),
        record({ id: "c", tag: "C", kind: "group", head_count: 4 }),
      ],
    });
    expect(alerts.map((a) => a.kind)).toEqual(["room_over_capacity"]);
  });
});

describe("treatments", () => {
  it("puts an overdue treatment in urgent and says how late it is", () => {
    const alerts = run({ health: [health({ next_due: "2026-08-25" })] });

    expect(alerts[0]).toMatchObject({ kind: "treatment_overdue", priority: "urgent", recordId: "rec-1" });
    expect(alerts[0]!.detail).toContain("7 days ago");
  });

  it("treats a due date of today as due, not overdue", () => {
    // The boundary that decides whether someone is chased today or told they
    // are late.
    const alerts = run({ health: [health({ next_due: TODAY })] });

    expect(alerts[0]).toMatchObject({ kind: "treatment_due_soon", priority: "this_week" });
    expect(alerts[0]!.detail).toBe("Due today.");
  });

  it("puts a treatment seven days out in this week and eight days out in later", () => {
    const soon = run({ health: [health({ next_due: "2026-09-08" })] });
    const later = run({ health: [health({ next_due: "2026-09-09" })] });

    expect(soon[0]).toMatchObject({ kind: "treatment_due_soon", priority: "this_week" });
    expect(later[0]).toMatchObject({ kind: "treatment_due_later", priority: "later" });
  });

  it("says nothing about a treatment more than thirty days out", () => {
    expect(run({ health: [health({ next_due: "2026-10-02" })] })).toEqual([]);
  });

  it("reports one treatment in exactly one window", () => {
    // Overlapping windows would show the same dose three times over.
    const alerts = run({ health: [health({ next_due: "2026-09-03" })] });
    expect(alerts.filter((a) => a.kind.startsWith("treatment_"))).toHaveLength(1);
  });

  it("says nothing about a sold animal", () => {
    // SPEC 6.2 — a sold or dead record is not treated again, so it cannot be
    // overdue for anything.
    const alerts = run({
      records: [record({ status: "sold" })],
      health: [health({ next_due: "2026-08-01" })],
    });
    expect(alerts).toEqual([]);
  });

  it("names the product rather than the bare type when there is one", () => {
    const named = run({ health: [health({ product: "Ivermectin", next_due: "2026-08-30" })] });
    const unnamed = run({ health: [health({ product: null, type: "deworming", next_due: "2026-08-30" })] });

    expect(named[0]!.title).toContain("Ivermectin");
    expect(unnamed[0]!.title).toContain("Deworming");
  });
});

describe("withdrawal", () => {
  it("stays active through its last day and stops the day after", () => {
    // SPEC 6.6 — the warning before a sale hangs off this date, so the end of
    // the period has to be exact.
    const treatment = health({ date: "2026-08-30", withdrawal_days: 2 });
    expect(withdrawalEnd(treatment)).toBe("2026-09-01");

    const onLastDay = run({ health: [treatment] });
    expect(onLastDay.some((a) => a.kind === "withdrawal_active")).toBe(true);

    const dayAfter = computeAlerts({
      rooms: [room()],
      records: [record()],
      moves: [move()],
      health: [treatment],
      today: "2026-09-02",
    });
    expect(dayAfter.some((a) => a.kind === "withdrawal_active")).toBe(false);
  });

  it("has no withdrawal when no days were recorded", () => {
    expect(withdrawalEnd(health({ withdrawal_days: null }))).toBeNull();
    expect(withdrawalEnd(health({ withdrawal_days: 0 }))).toBeNull();
  });
});

describe("long isolation stays", () => {
  const isolation = room({ id: "iso", code: "R4", is_isolation: true });

  it("raises after fourteen days, not at fourteen", () => {
    const at14 = run({
      rooms: [isolation],
      records: [record({ current_room_id: "iso" })],
      moves: [move({ to_room_id: "iso", date: "2026-08-18" })],
    });
    const at15 = run({
      rooms: [isolation],
      records: [record({ current_room_id: "iso" })],
      moves: [move({ to_room_id: "iso", date: "2026-08-17" })],
    });

    expect(at14.some((a) => a.kind === "long_isolation")).toBe(false);
    expect(at15.some((a) => a.kind === "long_isolation")).toBe(true);
  });

  it("counts from the latest arrival, not the first", () => {
    // An animal that went into isolation in March, left, and came back
    // yesterday has been there a day.
    const alerts = run({
      rooms: [isolation, room()],
      records: [record({ current_room_id: "iso" })],
      moves: [
        move({ id: "m1", to_room_id: "iso", date: "2026-03-01" }),
        move({ id: "m2", from_room_id: "iso", to_room_id: "room-1", date: "2026-03-10" }),
        move({ id: "m3", from_room_id: "room-1", to_room_id: "iso", date: "2026-08-31" }),
      ],
    });

    expect(alerts.some((a) => a.kind === "long_isolation")).toBe(false);
  });

  it("ignores a long stay in an ordinary room", () => {
    const alerts = run({ moves: [move({ date: "2026-01-01" })] });
    expect(alerts).toEqual([]);
  });
});

describe("duplicate tags", () => {
  it("raises one alert for the pair, not one per record", () => {
    // SPEC 5.4 — the server keeps both and raises this rather than discarding
    // one, so the alert is about the collision.
    const alerts = run({
      records: [record({ id: "a" }), record({ id: "b" })],
      moves: [],
    });

    const duplicates = alerts.filter((a) => a.kind === "duplicate_tag");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.priority).toBe("this_week");
    expect(duplicates[0]!.title).toContain("C-084");
  });

  it("ignores a tag freed by a sold record", () => {
    // SPEC 6.5 — a tag from a sold or dead record may be reused.
    const alerts = run({
      records: [record({ id: "a" }), record({ id: "b", status: "sold" })],
      moves: [],
    });
    expect(alerts.some((a) => a.kind === "duplicate_tag")).toBe(false);
  });

  it("keeps its id stable however the records are ordered", () => {
    const forwards = run({ records: [record({ id: "a" }), record({ id: "b" })], moves: [] });
    const backwards = run({ records: [record({ id: "b" }), record({ id: "a" })], moves: [] });

    expect(forwards[0]!.id).toBe(backwards[0]!.id);
  });
});

describe("sync failing", () => {
  const now = new Date("2026-09-01T12:00:00Z");

  it("stays quiet while changes are merely waiting", () => {
    // Being offline is normal here — it is not an alert.
    const alerts = run({
      oldestPendingAt: "2026-08-31T12:00:00Z",
      pendingCount: 3,
      now,
    });
    expect(alerts).toEqual([]);
  });

  it("raises once they have been stuck for two days", () => {
    const alerts = run({
      oldestPendingAt: "2026-08-30T11:00:00Z",
      pendingCount: 3,
      now,
    });

    expect(alerts[0]).toMatchObject({ kind: "sync_failing", priority: "urgent" });
    // The reassurance matters: the work is not lost, and saying so stops
    // someone re-entering it.
    expect(alerts[0]!.detail).toContain("not lost");
  });

  it("says nothing when there is nothing queued", () => {
    expect(run({ oldestPendingAt: null, pendingCount: 0, now })).toEqual([]);
  });
});

describe("grouping for the screens that share these rules", () => {
  it("orders urgent before this week before later", () => {
    const alerts = run({
      rooms: [room({ capacity: 1 })],
      records: [record({ kind: "group", head_count: 5 })],
      health: [health({ next_due: "2026-09-20" }), health({ id: "hr-2", next_due: "2026-09-03" })],
    });

    expect(byPriority(alerts).map(([priority]) => priority)).toEqual([
      "urgent",
      "this_week",
      "later",
    ]);
  });

  it("hands each screen only the alerts it is about", () => {
    const alerts = run({
      rooms: [room({ capacity: 1 })],
      records: [record({ kind: "group", head_count: 5 })],
      health: [health({ next_due: "2026-08-01" })],
    });

    expect(alertsForRoom(alerts, "room-1").map((a) => a.kind)).toEqual(["room_over_capacity"]);
    expect(alertsForRecord(alerts, "rec-1").map((a) => a.kind)).toEqual(["treatment_overdue"]);
  });
});

describe("the calendar", () => {
  const inputs = {
    records: [record()],
    rooms: [room(), room({ id: "room-2", code: "R2" })],
    moves: [move({ from_room_id: "room-1", to_room_id: "room-2", date: "2026-08-20" })],
    purchases: [],
    health: [health({ date: "2026-08-01", next_due: "2026-09-15", dose: "2ml" })],
    sales: [],
    deaths: [],
    today: TODAY,
  };

  it("gives a treatment two entries: the day it was given and the day it is due", () => {
    const events = calendarEvents(inputs).filter((e) => e.kind === "treatment");

    expect(events.map((e) => e.date)).toEqual(["2026-08-01", "2026-09-15"]);
    expect(events[0]!.scheduled).toBe(false);
    expect(events[1]!.scheduled).toBe(true);
  });

  it("names rooms by code in a move", () => {
    const [entry] = calendarEvents(inputs).filter((e) => e.kind === "move");
    expect(entry!.title).toBe("Move R1 to R2");
  });

  it("orders by date", () => {
    const dates = calendarEvents(inputs).map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("puts a sale and a death on the days they happened", () => {
    // They belong here rather than in the screen: SPEC 4.7 says the calendar
    // shows the same events as Alerts, and which events those are is one
    // decision, made once.
    const events = calendarEvents({
      ...inputs,
      sales: [
        {
          id: "s1", created_at: "2026-08-12T00:00:00Z", updated_at: "2026-08-12T00:00:00Z",
          device_id: "d", deleted_at: null, record_id: "rec-a", date: "2026-08-12",
          price: 900_000, count: 3, customer_id: null, notes: null,
        },
      ],
      deaths: [
        {
          id: "d1", created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z",
          device_id: "d", deleted_at: null, record_id: "rec-a", date: "2026-08-14",
          count: 1, cause: "predator", vet_id: null, notes: null,
        },
      ],
    });

    const sale = events.find((e) => e.kind === "sale");
    const death = events.find((e) => e.kind === "death");

    expect(sale).toMatchObject({ date: "2026-08-12", title: "Sale" });
    // The head sold is what separates two sales out of the same group.
    expect(sale!.detail).toContain("3 head");
    // The cause is the title: "Death" beside a tag says nothing useful.
    expect(death).toMatchObject({ date: "2026-08-14", title: "Predator" });
  });

  it("builds whole weeks, Sunday first, around the month", () => {
    // September 2026 starts on a Tuesday and has 30 days: five weeks.
    const grid = monthGrid(2026, 9);

    expect(grid).toHaveLength(35);
    expect(grid[0]).toBe("2026-08-30");
    expect(grid[grid.length - 1]).toBe("2026-10-03");
    expect(grid.length % 7).toBe(0);
  });
});
