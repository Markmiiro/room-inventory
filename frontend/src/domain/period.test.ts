import { describe, expect, it } from "vitest";

import { inPeriod, periodFrom, periodLabel, periodOptionLabel, rowsInPeriod } from "./period";

/**
 * The period both Money tabs read.
 *
 * Extracted from the Money screen when Analytics arrived (SPEC 19). These tests
 * pin the behaviour it had there, because the point of sharing it is that the
 * two tabs answer for the same window — a refactor that quietly shifted the
 * boundary by a day would move every figure on both.
 */

const TODAY = "2026-09-07";

describe("the window", () => {
  it("runs back whole calendar months and ends today", () => {
    expect(periodFrom(TODAY, 12)).toEqual({
      since: "2025-10-01",
      until: "2026-09-07",
      months: 12,
    });
  });

  /** Three months ending in September is July, August, September — not a
   *  window starting on the 7th of June. */
  it("starts on the first of its earliest month", () => {
    expect(periodFrom(TODAY, 3).since).toBe("2026-07-01");
  });

  it("crosses a year boundary correctly", () => {
    expect(periodFrom("2026-02-15", 3).since).toBe("2025-12-01");
  });

  it("handles five years", () => {
    expect(periodFrom(TODAY, 60).since).toBe("2021-10-01");
  });
});

describe("what falls inside it", () => {
  const period = periodFrom(TODAY, 3);

  it("includes both ends", () => {
    expect(inPeriod(period, "2026-07-01")).toBe(true);
    expect(inPeriod(period, "2026-09-07")).toBe(true);
  });

  it("excludes the day before and the day after", () => {
    expect(inPeriod(period, "2026-06-30")).toBe(false);
    expect(inPeriod(period, "2026-09-08")).toBe(false);
  });

  it("filters rows by their date", () => {
    const rows = [{ date: "2026-06-30" }, { date: "2026-08-01" }, { date: "2026-09-08" }];
    expect(rowsInPeriod(period, rows)).toEqual([{ date: "2026-08-01" }]);
  });
});

describe("how it is worded", () => {
  it("names both months and years", () => {
    expect(periodLabel(periodFrom(TODAY, 12))).toBe("October 2025 to September 2026");
  });

  it("calls sixty months five years, not 60 months", () => {
    expect(periodOptionLabel(60)).toBe("5 years");
    expect(periodOptionLabel(3)).toBe("3 months");
    expect(periodOptionLabel(12)).toBe("12 months");
  });
});
