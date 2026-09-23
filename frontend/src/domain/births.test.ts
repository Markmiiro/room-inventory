import { describe, expect, it } from "vitest";

import type { Birth, Death, Record_, Sale } from "../db/types";
import {
  canBeDam,
  canBeSire,
  checkBirth,
  departureDate,
  departureWarning,
  describeOffspringParts,
  offspringShape,
  offspringTotal,
  sequentialTags,
} from "./births";

/** SPEC 22 — the rules, without a screen or a database in the way. */

function record(overrides: Partial<Record_> = {}): Record_ {
  return {
    id: "dam",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d1",
    deleted_at: null,
    kind: "animal",
    species: "cattle",
    tag: "C-084",
    breed: null,
    sex: "female",
    date_of_birth: "2023-05-01",
    arrival_date: null,
    initial_head_count: 1,
    head_count: 1,
    offspring_baseline: null,
    offspring_baseline_updated_at: null,
    source: "bought",
    status: "active",
    parent_record_id: null,
    notes: null,
    current_room_id: "R1",
    dam_record_id: null,
    sire_record_id: null,
    birth_id: null,
    ...overrides,
  };
}

function birth(overrides: Partial<Birth> = {}): Birth {
  return {
    id: "b1",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    device_id: "d1",
    deleted_at: null,
    dam_record_id: "dam",
    sire_record_id: null,
    sire_name: null,
    date: "2026-09-01",
    born_count: 1,
    surviving_count: 1,
    vet_id: null,
    notes: null,
    ...overrides,
  };
}

describe("who can be a dam", () => {
  it("offers a female animal", () => {
    expect(canBeDam(record({ sex: "female" }))).toBe(true);
  });

  it("does not offer a male", () => {
    expect(canBeDam(record({ sex: "male" }))).toBe(false);
  });

  it("does not offer an animal whose sex is not recorded", () => {
    // Nothing is assumed from an empty field. The sex is asked for on the add
    // screen and can be filled in later.
    expect(canBeDam(record({ sex: null }))).toBe(false);
  });

  it("offers a group, which is how a hatch is recorded (SPEC 22)", () => {
    expect(canBeDam(record({ kind: "group", sex: null }))).toBe(true);
  });

  it("offers a dam who has been sold, so a birth can be backdated", () => {
    expect(canBeDam(record({ status: "sold" }))).toBe(true);
  });

  it("only offers a male animal as the sire", () => {
    expect(canBeSire(record({ sex: "male" }))).toBe(true);
    expect(canBeSire(record({ sex: "female" }))).toBe(false);
    expect(canBeSire(record({ kind: "group", sex: null }))).toBe(false);
  });
});

describe("what a birth must satisfy", () => {
  const today = "2026-09-23";

  it("accepts an ordinary birth", () => {
    expect(
      checkBirth({ dam: record(), date: today, bornCount: 1, survivingCount: 1 }, today),
    ).toEqual({ error: null, warning: null });
  });

  it("refuses more surviving than born", () => {
    const { error } = checkBirth(
      { dam: record(), date: today, bornCount: 2, survivingCount: 3 },
      today,
    );
    expect(error).toMatch(/More surviving \(3\) than born \(2\)/);
  });

  it("accepts nothing surviving", () => {
    // A birth where nothing lived is a real event with real losses to record.
    expect(
      checkBirth({ dam: record(), date: today, bornCount: 2, survivingCount: 0 }, today).error,
    ).toBeNull();
  });

  it("refuses a future date (SPEC 6.8)", () => {
    const { error } = checkBirth(
      { dam: record(), date: "2026-09-24", bornCount: 1, survivingCount: 1 },
      today,
    );
    expect(error).toMatch(/cannot be dated in the future/);
  });

  it("accepts a backdated one (SPEC 6.9)", () => {
    expect(
      checkBirth({ dam: record(), date: "2026-08-01", bornCount: 1, survivingCount: 1 }, today)
        .error,
    ).toBeNull();
  });

  it("refuses a birth before the dam's own date of birth", () => {
    const { error } = checkBirth(
      { dam: record({ date_of_birth: "2023-05-01" }), date: "2023-04-30", bornCount: 1, survivingCount: 1 },
      today,
    );
    expect(error).toMatch(/born on 2023-05-01/);
  });

  it("measures a group dam from her arrival instead", () => {
    const dam = record({ kind: "group", sex: null, date_of_birth: null, arrival_date: "2026-06-01" });
    expect(
      checkBirth({ dam, date: "2026-05-31", bornCount: 6, survivingCount: 6 }, today).error,
    ).toMatch(/arrived on 2026-06-01/);
    expect(
      checkBirth({ dam, date: "2026-06-02", bornCount: 6, survivingCount: 6 }, today).error,
    ).toBeNull();
  });

  it("allows any date against a dam with no date of birth of her own", () => {
    // The unknown case stays unknown rather than being guessed at, exactly as
    // SPEC 13.4 requires everywhere else.
    expect(
      checkBirth(
        { dam: record({ date_of_birth: null }), date: "2020-01-01", bornCount: 1, survivingCount: 1 },
        today,
      ).error,
    ).toBeNull();
  });

  it("refuses a male outright", () => {
    const { error } = checkBirth(
      { dam: record({ sex: "male", tag: "C-900" }), date: today, bornCount: 1, survivingCount: 1 },
      today,
    );
    expect(error).toMatch(/C-900 is recorded as male/);
  });

  it("refuses counts that are not whole numbers", () => {
    expect(
      checkBirth({ dam: record(), date: today, bornCount: 1.5, survivingCount: 1 }, today).error,
    ).toMatch(/whole number/);
    expect(
      checkBirth({ dam: record(), date: today, bornCount: 0, survivingCount: 0 }, today).error,
    ).toMatch(/whole number/);
  });
});

describe("a dam who has left the farm", () => {
  const sale = (date: string): Sale => ({
    id: `s-${date}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    device_id: "d1",
    deleted_at: null,
    record_id: "dam",
    date,
    price: 1,
    count: 1,
    customer_id: null,
    notes: null,
  });

  it("takes the last departure date, for a group sold in parts", () => {
    expect(departureDate(record(), [sale("2026-05-01"), sale("2026-06-01")], [])).toBe(
      "2026-06-01",
    );
  });

  it("warns, and never blocks, for a birth after she left (SPEC 22)", () => {
    const warning = departureWarning(
      record({ status: "sold", tag: "C-084" }),
      "2026-07-01",
      [sale("2026-06-01")],
      [],
    );
    expect(warning).toMatch(/sold on 2026-06-01, which is before this date/);
  });

  it("still notes her status for a birth before she left", () => {
    const warning = departureWarning(
      record({ status: "sold" }),
      "2026-05-01",
      [sale("2026-06-01")],
      [],
    );
    expect(warning).toMatch(/is recorded as sold/);
    expect(warning).not.toMatch(/before this date/);
  });

  it("says nothing about an active dam", () => {
    expect(departureWarning(record(), "2026-09-01", [], [] as Death[])).toBeNull();
  });
});

describe("how the offspring are recorded", () => {
  it("gives one or two their own animal records", () => {
    expect(offspringShape(1)).toBe("individual");
    expect(offspringShape(2)).toBe("individual");
  });

  it("offers a group above that (SPEC 22)", () => {
    expect(offspringShape(3)).toBe("group");
    expect(offspringShape(24)).toBe("group");
  });
});

describe("the offspring figure", () => {
  it("adds the typed baseline to the births counted, without touching either", () => {
    const dam = record({ offspring_baseline: 2 });
    const total = offspringTotal(dam, [
      birth({ id: "b1", born_count: 1, surviving_count: 1 }),
      birth({ id: "b2", born_count: 2, surviving_count: 2 }),
    ]);
    expect(total).toEqual({ total: 5, baseline: 2, fromBirths: 3, birthCount: 2 });
  });

  it("counts the survivors, not everything born", () => {
    // A stillbirth is in the mortality figures under its own cause. Counting it
    // here as well would have one loss adding to two different totals.
    const total = offspringTotal(record(), [birth({ born_count: 3, surviving_count: 1 })]);
    expect(total.fromBirths).toBe(1);
  });

  it("ignores births belonging to another dam", () => {
    const total = offspringTotal(record({ id: "dam" }), [birth({ dam_record_id: "other" })]);
    expect(total.fromBirths).toBe(0);
  });

  it("ignores a deleted birth", () => {
    const total = offspringTotal(record(), [birth({ deleted_at: "2026-09-02T00:00:00Z" })]);
    expect(total.fromBirths).toBe(0);
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(describeOffspringParts(offspringTotal(record(), []), null)).toBeNull();
  });

  it("names both halves so neither can hide behind the total", () => {
    const dam = record({ offspring_baseline: 2 });
    const described = describeOffspringParts(offspringTotal(dam, [birth()]), "12 Aug 2026");
    expect(described).toBe("2 typed in (updated 12 Aug 2026) plus 1 from 1 recorded birth");
  });

  it("describes births alone when nothing was ever typed", () => {
    expect(
      describeOffspringParts(offspringTotal(record(), [birth(), birth({ id: "b2" })]), null),
    ).toBe("2 from 2 recorded births");
  });
});

describe("the sequential tags (SPEC 4.3's rule, reused)", () => {
  it("numbers from the dam's tag", () => {
    expect(sequentialTags("C-084", new Set(), 2)).toEqual(["C-084-1", "C-084-2"]);
  });

  it("skips tags already in use", () => {
    expect(sequentialTags("C-084", new Set(["C-084-1"]), 2)).toEqual(["C-084-2", "C-084-3"]);
  });

  it("does not stack suffixes on a tag that already has one", () => {
    // Otherwise a calf of C-084-1 would be C-084-1-1, and its own calf
    // C-084-1-1-1.
    expect(sequentialTags("C-084-3", new Set(["C-084-1"]), 1)).toEqual(["C-084-2"]);
  });
});
