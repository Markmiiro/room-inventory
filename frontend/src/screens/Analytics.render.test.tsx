import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecord, recordSale } from "../db/mutations";
import { db } from "../db/schema";
import { seedRoomId, seedRoomsIfEmpty } from "../db/seed";
import { resetDeviceIdCache } from "../db/ids";
import { muteLayoutEffectWarning } from "./renderNoise";
import { periodFrom } from "../domain/period";
import { AnalyticsScreen } from "./Analytics";

/**
 * A smoke test for the Analytics tab.
 *
 * The figures themselves are covered in `domain/census.test.ts` and
 * `domain/money.test.ts`, where the rules live. What this catches is the layer
 * those tests cannot see: that the screen renders at all, on an empty farm and
 * on a real one, without throwing.
 *
 * It renders statically, so the live queries return their empty defaults on the
 * first pass. That is exactly the state the screen is in for the first frame
 * after every navigation, and rendering it is not optional — an empty-state
 * branch that throws is a blank screen for the user, however good the arithmetic
 * behind it is.
 */

let unmute: () => void;

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
});

afterEach(() => unmute());

const period = periodFrom("2026-09-07", 12);

describe("the Analytics tab", () => {
  it("renders on a farm with no records at all", () => {
    const html = renderToStaticMarkup(<AnalyticsScreen period={period} />);

    expect(html).toContain("What the farm holds");
    expect(html).toContain("Spent and earned by species");
    // The empty states, rather than an empty table with a stray total row.
    expect(html).toContain("No animals or groups are on the farm today.");
    expect(html).toContain("Nothing was bought or sold in this period.");
  });

  it("names the period it is reporting on", () => {
    const html = renderToStaticMarkup(<AnalyticsScreen period={period} />);
    expect(html).toContain("October 2025 to September 2026");
  });

  it("renders after real records and a sale exist", async () => {
    await seedRoomsIfEmpty();
    await createRecord({
      kind: "group",
      species: "hens",
      tag: "H-Flock",
      source: "bought",
      room_id: seedRoomId(1),
      head_count: 240,
    });
    const cow = await createRecord({
      kind: "animal",
      species: "cattle",
      tag: "C-084",
      source: "bought",
      room_id: seedRoomId(2),
    });
    await recordSale({ record_id: cow.id, date: "2026-08-01", price: 1_500_000, count: 1 });

    // Static rendering does not resolve the live queries, so this asserts the
    // component survives a real database rather than asserting the numbers —
    // those are pinned where they are computed.
    expect(() => renderToStaticMarkup(<AnalyticsScreen period={period} />)).not.toThrow();
  });
});
