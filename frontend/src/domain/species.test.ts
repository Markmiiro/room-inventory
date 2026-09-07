import { describe, expect, it } from "vitest";

import type { Record_, Room, Species } from "../db/types";
import {
  ALL_SPECIES,
  BIRD_SPECIES,
  MAMMAL_SPECIES,
  isBird,
  roomType,
  scheduleSpeciesLabel,
  speciesBreakdown,
  speciesLabel,
} from "./rules";
import { speciesCovered } from "./schedules";

/**
 * SPEC 18 — poultry is four species.
 *
 * The value of these tests is mostly in what they stop drifting apart. The
 * species list is now consulted by five screens, a room's derived type, a
 * schedule's scope and a migration, and the failure mode of any of those
 * falling behind the enum is silent: a species that records can still be
 * created with, quietly missing from the one filter row that would find them.
 */

function record(over: Partial<Record_> = {}): Record_ {
  return {
    id: "rec-1",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    device_id: "d",
    deleted_at: null,
    kind: "animal",
    species: "hens",
    tag: "H-1",
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

const room: Room = {
  id: "room-1",
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
  device_id: "d",
  deleted_at: null,
  code: "R1",
  name: "Room 1",
  capacity: 50,
  is_isolation: false,
  notes: null,
};

describe("the species list", () => {
  it("is the eight of SPEC 18, in the order the spec names them", () => {
    expect(ALL_SPECIES).toEqual([
      "cattle",
      "goats",
      "sheep",
      "pigs",
      "hens",
      "ducks",
      "geese",
      "turkeys",
    ]);
  });

  it("no longer contains poultry", () => {
    expect(ALL_SPECIES).not.toContain("poultry" as Species);
  });

  /** The label map is a `Record<Species, string>`, so a missing entry is a type
   *  error rather than a runtime one — but an *empty* label is not, and that is
   *  what a copy-paste leaves behind. */
  it("gives every species a label", () => {
    for (const species of ALL_SPECIES) {
      expect(speciesLabel(species)).toBeTruthy();
    }
  });

  it("splits cleanly into mammals and birds with nothing left over", () => {
    expect([...MAMMAL_SPECIES, ...BIRD_SPECIES].sort()).toEqual([...ALL_SPECIES].sort());
    expect(MAMMAL_SPECIES.filter(isBird)).toEqual([]);
    expect(BIRD_SPECIES.every(isBird)).toBe(true);
  });

  it("counts the four birds", () => {
    expect(BIRD_SPECIES).toEqual(["hens", "ducks", "geese", "turkeys"]);
  });
});

describe("room type (SPEC 4.2, amended by 18)", () => {
  it("names the species when a room holds only one", () => {
    expect(roomType(room, [record({ species: "ducks" })])).toBe("Ducks");
  });

  /**
   * The regression the split would otherwise have caused. A room that read
   * "Poultry" yesterday holds hens and ducks today, and "Mixed" is the word for
   * cattle sharing with goats — a warning that unlike animals are together. Four
   * kinds of bird is the ordinary case it was never about.
   */
  it("calls a room of two bird species Birds, not Mixed", () => {
    const type = roomType(room, [record({ species: "hens" }), record({ species: "ducks", id: "r2" })]);
    expect(type).toBe("Birds");
    expect(type).not.toBe("Mixed");
  });

  it("calls a room of all four birds Birds", () => {
    const records = BIRD_SPECIES.map((species, i) => record({ id: `r${i}`, species }));
    expect(roomType(room, records)).toBe("Birds");
  });

  it("still calls two mammals Mixed", () => {
    expect(
      roomType(room, [record({ species: "cattle" }), record({ species: "goats", id: "r2" })]),
    ).toBe("Mixed");
  });

  /** Birds housed with a mammal is exactly what Mixed is for. */
  it("calls birds sharing with a mammal Mixed", () => {
    expect(
      roomType(room, [record({ species: "hens" }), record({ species: "pigs", id: "r2" })]),
    ).toBe("Mixed");
  });

  it("still calls an empty room Empty", () => {
    expect(roomType(room, [])).toBe("Empty");
  });

  it("still calls the isolation room Isolation whatever is in it", () => {
    const isolation = { ...room, is_isolation: true };
    expect(roomType(isolation, [record({ species: "hens" })])).toBe("Isolation");
  });

  /** Sold and dead records are not present, so they cannot make a room Mixed. */
  it("ignores records that are not active", () => {
    expect(
      roomType(room, [record({ species: "hens" }), record({ species: "pigs", id: "r2", status: "sold" })]),
    ).toBe("Hens");
  });
});

describe("a schedule's species scope (SPEC 13.3, amended by 18)", () => {
  it("covers every bird when set to birds", () => {
    for (const species of BIRD_SPECIES) {
      expect(speciesCovered("birds", species)).toBe(true);
    }
  });

  /** The point of the scope. Narrowing the seeded Newcastle row to hens would
   *  have silently stopped vaccinating the ducks. */
  it("does not cover a mammal when set to birds", () => {
    for (const species of MAMMAL_SPECIES) {
      expect(speciesCovered("birds", species)).toBe(false);
    }
  });

  it("still covers everything when set to all", () => {
    for (const species of ALL_SPECIES) {
      expect(speciesCovered("all", species)).toBe(true);
    }
  });

  it("still matches one species exactly", () => {
    expect(speciesCovered("hens", "hens")).toBe(true);
    expect(speciesCovered("hens", "ducks")).toBe(false);
  });

  it("labels the bird scope as a group rather than as a species", () => {
    expect(scheduleSpeciesLabel("birds")).toBe("All birds");
    expect(scheduleSpeciesLabel("hens")).toBe("Hens");
    expect(scheduleSpeciesLabel("all")).toBe("Every species");
  });
});

describe("the species breakdown on room cards", () => {
  it("counts each bird species separately", () => {
    const breakdown = speciesBreakdown([
      record({ id: "a", species: "hens", head_count: 240 }),
      record({ id: "b", species: "ducks", head_count: 12 }),
      record({ id: "c", species: "geese", head_count: 4 }),
    ]);
    expect(breakdown).toEqual([
      { species: "hens", head: 240 },
      { species: "ducks", head: 12 },
      { species: "geese", head: 4 },
    ]);
  });

  it("sums two records of the same species by head", () => {
    const breakdown = speciesBreakdown([
      record({ id: "a", species: "turkeys", head_count: 8 }),
      record({ id: "b", species: "turkeys", head_count: 5 }),
    ]);
    expect(breakdown).toEqual([{ species: "turkeys", head: 13 }]);
  });
});
