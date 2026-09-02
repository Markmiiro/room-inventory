import { describe, expect, it } from "vitest";

import type { Record_ } from "../db/types";
import { ageBasis, ageInDays, isAgeUnknown, missingAgeField, recordsWithUnknownAge } from "./age";

/** SPEC 13.4 — the shared age rule that sections 13 and 15 both depend on. */

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

describe("what age counts from", () => {
  it("uses date of birth for an animal", () => {
    expect(ageBasis(record({ date_of_birth: "2026-03-01" }))).toBe("2026-03-01");
  });

  it("uses arrival date for a group", () => {
    const group = record({ kind: "group", date_of_birth: null, arrival_date: "2026-03-01" });
    expect(ageBasis(group)).toBe("2026-03-01");
  });

  /**
   * An animal's arrival date is not a fallback for its date of birth. SPEC 13.4
   * forbids guessing, and an arrival date is when it got here, not when it was
   * born — a two-year-old bought last week is not a week old.
   */
  it("does not fall back to arrival date for an animal", () => {
    const bought = record({ date_of_birth: null, arrival_date: "2026-08-01" });
    expect(ageBasis(bought)).toBeNull();
    expect(isAgeUnknown(bought)).toBe(true);
  });

  it("does not fall back to the creation date", () => {
    const noDob = record({ date_of_birth: null, created_at: "2026-01-01T00:00:00Z" });
    expect(ageBasis(noDob)).toBeNull();
    expect(ageInDays(noDob, "2026-09-02")).toBeNull();
  });
});

describe("age in days", () => {
  it("counts whole days from the basis", () => {
    expect(ageInDays(record({ date_of_birth: "2026-08-01" }), "2026-09-02")).toBe(32);
  });

  it("is zero on the day itself", () => {
    expect(ageInDays(record({ date_of_birth: "2026-09-02" }), "2026-09-02")).toBe(0);
  });

  it("is null rather than zero when unknown, so callers cannot treat it as newborn", () => {
    expect(ageInDays(record({ date_of_birth: null }), "2026-09-02")).toBeNull();
  });
});

describe("the records to warn about", () => {
  it("names only the active ones", () => {
    const records = [
      record({ id: "a", date_of_birth: null }),
      record({ id: "b", date_of_birth: null, status: "sold" }),
      record({ id: "c", date_of_birth: null, status: "dead" }),
      record({ id: "d", date_of_birth: null, deleted_at: "2026-08-01T00:00:00Z" }),
      record({ id: "e", date_of_birth: "2026-01-01" }),
    ];
    expect(recordsWithUnknownAge(records).map((r) => r.id)).toEqual(["a"]);
  });

  it("names the field the user would actually be asked for", () => {
    expect(missingAgeField(record({ kind: "animal" }))).toBe("date of birth");
    expect(missingAgeField(record({ kind: "group" }))).toBe("arrival date");
  });
});
