import { describe, expect, it } from "vitest";

import type { HealthRecord, VetVisit, VisitNote } from "../db/types";
import {
  callOutFeeFor,
  notesForRecord,
  recordsSeen,
  splitCallOutFee,
  summariseVisits,
  totalCallOutFees,
} from "./visits";

/** SPEC 14 — vet visits, and the call-out fee split. */

function visit(over: Partial<VetVisit> = {}): VetVisit {
  return {
    id: "vis-1",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    date: "2026-08-01",
    vet_id: "vet-1",
    status: "completed",
    call_out_fee: 90_000,
    reason: null,
    notes: null,
    ...over,
  };
}

function treatment(over: Partial<HealthRecord> = {}): HealthRecord {
  return {
    id: "hr-1",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    record_id: "rec-a",
    type: "treatment",
    product: null,
    dose: null,
    date: "2026-08-01",
    next_due: null,
    withdrawal_days: null,
    vet_id: null,
    cost: null,
    notes: null,
    schedule_id: null,
    visit_id: "vis-1",
    ...over,
  };
}

function note(over: Partial<VisitNote> = {}): VisitNote {
  return {
    id: "vn-1",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    visit_id: "vis-1",
    record_id: "rec-b",
    note: "Watch the front left leg",
    ...over,
  };
}

describe("who counts as seen — SPEC 14.4", () => {
  it("counts an animal that was treated", () => {
    expect(recordsSeen({ visit: visit(), health: [treatment()], notes: [] })).toEqual(["rec-a"]);
  });

  /** The whole reason VisitNote exists: seen, but nothing was given. */
  it("counts an animal the vet only looked at", () => {
    expect(recordsSeen({ visit: visit(), health: [], notes: [note()] })).toEqual(["rec-b"]);
  });

  it("counts an animal treated and noted only once", () => {
    const seen = recordsSeen({
      visit: visit(),
      health: [treatment({ record_id: "rec-a" })],
      notes: [note({ record_id: "rec-a" })],
    });
    expect(seen).toEqual(["rec-a"]);
  });

  it("ignores treatments and notes belonging to another visit", () => {
    const seen = recordsSeen({
      visit: visit({ id: "vis-1" }),
      health: [treatment({ visit_id: "vis-2", record_id: "rec-x" })],
      notes: [note({ visit_id: "vis-2", record_id: "rec-y" })],
    });
    expect(seen).toEqual([]);
  });

  it("ignores a self-administered treatment, which has no visit at all", () => {
    const seen = recordsSeen({
      visit: visit(),
      health: [treatment({ visit_id: null, record_id: "rec-z" })],
      notes: [],
    });
    expect(seen).toEqual([]);
  });

  it("ignores deleted rows", () => {
    const seen = recordsSeen({
      visit: visit(),
      health: [treatment({ deleted_at: "2026-08-02T00:00:00Z" })],
      notes: [note({ deleted_at: "2026-08-02T00:00:00Z" })],
    });
    expect(seen).toEqual([]);
  });
});

describe("splitting the call-out fee — SPEC 14.3", () => {
  it("splits evenly across the animals seen", () => {
    const split = splitCallOutFee({
      visit: visit({ call_out_fee: 90_000 }),
      health: [treatment({ record_id: "rec-a" }), treatment({ id: "hr-2", record_id: "rec-b" })],
      notes: [note({ record_id: "rec-c" })],
    });

    expect(split.seenCount).toBe(3);
    expect([...split.perRecord.values()]).toEqual([30_000, 30_000, 30_000]);
    expect(split.unallocated).toBe(0);
  });

  /**
   * Money is whole shillings everywhere (SPEC 1). A fee that does not divide
   * evenly cannot produce fractional shares, and the shares must still add back
   * up to what was actually paid.
   */
  it("keeps the shares whole and summing to exactly the fee", () => {
    const split = splitCallOutFee({
      visit: visit({ call_out_fee: 100_000 }),
      health: [
        treatment({ id: "h1", record_id: "rec-a" }),
        treatment({ id: "h2", record_id: "rec-b" }),
        treatment({ id: "h3", record_id: "rec-c" }),
      ],
      notes: [],
    });

    const shares = [...split.perRecord.values()];
    expect(shares.every((n) => Number.isInteger(n))).toBe(true);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100_000);
    // The odd shilling goes to one record, not to all of them.
    expect(shares.sort()).toEqual([33_333, 33_333, 33_334]);
  });

  it("gives the whole fee to a single animal seen", () => {
    const split = splitCallOutFee({ visit: visit({ call_out_fee: 90_000 }), health: [treatment()], notes: [] });
    expect(split.perRecord.get("rec-a")).toBe(90_000);
  });

  /** SPEC 14.3 — "a visit with a fee but no animals attached leaves the fee
   *  unallocated. It still counts in the farm total." */
  it("leaves the whole fee unallocated when nobody was attached", () => {
    const split = splitCallOutFee({ visit: visit({ call_out_fee: 90_000 }), health: [], notes: [] });

    expect(split.perRecord.size).toBe(0);
    expect(split.unallocated).toBe(90_000);
    expect(split.total).toBe(90_000);
  });

  it("says nothing is owed when there is no fee", () => {
    const split = splitCallOutFee({ visit: visit({ call_out_fee: null }), health: [treatment()], notes: [] });
    expect(split.total).toBe(0);
    expect(split.unallocated).toBe(0);
    expect(split.perRecord.size).toBe(0);
  });

  /**
   * The contrast SPEC 14.3 draws with SPEC 4.4. Feed is spread by head-days
   * because ten head really did eat twice what five ate. A call-out is one
   * journey, so a group of forty and a single calf take the same share.
   */
  it("does not weight the split by head count or by time on the farm", () => {
    const split = splitCallOutFee({
      visit: visit({ call_out_fee: 90_000 }),
      // One is a group of forty, the other a single animal — the domain does
      // not look at either, and that is the point.
      health: [treatment({ record_id: "rec-group" }), treatment({ id: "h2", record_id: "rec-calf" })],
      notes: [],
    });

    expect(split.perRecord.get("rec-group")).toBe(45_000);
    expect(split.perRecord.get("rec-calf")).toBe(45_000);
  });

  it("splits the same way whichever order the rows arrive in", () => {
    const a = splitCallOutFee({
      visit: visit({ call_out_fee: 100_000 }),
      health: [treatment({ id: "h1", record_id: "rec-c" }), treatment({ id: "h2", record_id: "rec-a" })],
      notes: [note({ record_id: "rec-b" })],
    });
    const b = splitCallOutFee({
      visit: visit({ call_out_fee: 100_000 }),
      health: [treatment({ id: "h2", record_id: "rec-a" }), treatment({ id: "h1", record_id: "rec-c" })],
      notes: [note({ record_id: "rec-b" })],
    });
    expect([...a.perRecord]).toEqual([...b.perRecord]);
  });
});

describe("what a record and the farm carry", () => {
  it("adds a record's share across every visit", () => {
    const visits = [
      visit({ id: "v1", call_out_fee: 90_000 }),
      visit({ id: "v2", call_out_fee: 40_000 }),
    ];
    const health = [
      treatment({ id: "h1", visit_id: "v1", record_id: "rec-a" }),
      treatment({ id: "h2", visit_id: "v1", record_id: "rec-b" }),
      treatment({ id: "h3", visit_id: "v2", record_id: "rec-a" }),
    ];

    // 45,000 from the first visit, 40,000 from the second.
    expect(callOutFeeFor("rec-a", visits, health, [])).toBe(85_000);
    expect(callOutFeeFor("rec-b", visits, health, [])).toBe(45_000);
  });

  /** A planned visit is a journey nobody has made. Charging for it would put
   *  money against an animal for something that has not happened. */
  it("charges nothing for a planned visit", () => {
    const planned = visit({ status: "planned", call_out_fee: 90_000 });
    expect(callOutFeeFor("rec-a", [planned], [treatment()], [])).toBe(0);
    expect(totalCallOutFees([planned])).toBe(0);
  });

  it("counts a completed visit's whole fee in the farm total, allocated or not", () => {
    const visits = [visit({ id: "v1", call_out_fee: 90_000 }), visit({ id: "v2", call_out_fee: 10_000 })];
    // Nobody is attached to either, so none of it reaches a record — and all of
    // it still counts for the farm (SPEC 14.3).
    expect(totalCallOutFees(visits)).toBe(100_000);
    expect(callOutFeeFor("rec-a", visits, [], [])).toBe(0);
  });

  it("ignores a deleted visit", () => {
    const gone = visit({ deleted_at: "2026-08-05T00:00:00Z" });
    expect(totalCallOutFees([gone])).toBe(0);
    expect(callOutFeeFor("rec-a", [gone], [treatment()], [])).toBe(0);
  });
});

describe("the visit list — SPEC 14.5", () => {
  it("puts planned visits first, whatever their dates", () => {
    const rows = summariseVisits(
      [
        visit({ id: "old", status: "completed", date: "2026-07-01" }),
        visit({ id: "soon", status: "planned", date: "2026-12-01" }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.visit.id)).toEqual(["soon", "old"]);
  });

  it("orders planned soonest-first and completed most-recent-first", () => {
    const rows = summariseVisits(
      [
        visit({ id: "p-late", status: "planned", date: "2026-12-01" }),
        visit({ id: "p-soon", status: "planned", date: "2026-09-10" }),
        visit({ id: "c-old", status: "completed", date: "2026-06-01" }),
        visit({ id: "c-new", status: "completed", date: "2026-08-01" }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.visit.id)).toEqual(["p-soon", "p-late", "c-new", "c-old"]);
  });

  it("counts the animals each visit saw", () => {
    const rows = summariseVisits(
      [visit()],
      [treatment({ record_id: "rec-a" })],
      [note({ record_id: "rec-b" })],
    );
    expect(rows[0]!.seenCount).toBe(2);
  });
});

describe("a record's observations", () => {
  it("returns only this record's notes, newest first", () => {
    const notes = [
      note({ id: "n1", record_id: "rec-a", created_at: "2026-08-01T00:00:00Z" }),
      note({ id: "n2", record_id: "rec-a", created_at: "2026-09-01T00:00:00Z" }),
      note({ id: "n3", record_id: "rec-b" }),
    ];
    expect(notesForRecord(notes, "rec-a").map((n) => n.id)).toEqual(["n2", "n1"]);
  });
});
