import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDeviceIdCache } from "../db/ids";
import { db } from "../db/schema";
import { AnimalsScreen } from "./Animals";
import { muteLayoutEffectWarning } from "./renderNoise";

/**
 * SPEC 18.6 — the filter row on a narrow screen.
 *
 * The real check was a measurement: rendered in Chrome at 390px, every chip is
 * fully visible, nothing overflows horizontally and the touch targets are 48px.
 * jsdom cannot lay anything out, so it cannot repeat that.
 *
 * What it can do is guard the decision the measurement produced. The row used
 * to scroll horizontally, and that is exactly what hid Pigs and the last
 * species off the right edge — so a change back to `overflow-x-auto` is the
 * regression worth catching, and it is visible in the markup even though its
 * consequence is not.
 */

let unmute: () => void;

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
});

afterEach(() => unmute());

function markup(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AnimalsScreen />
    </MemoryRouter>,
  );
}

describe("the species filter row", () => {
  it("wraps rather than scrolling sideways", () => {
    const html = markup();
    const row = html.slice(html.indexOf('aria-label="Filter by species"'));
    const openingTag = html.slice(0, html.indexOf('aria-label="Filter by species"'));
    const rowClasses = openingTag.slice(openingTag.lastIndexOf("<div"));

    expect(rowClasses).toContain("flex-wrap");
    // The idiom that hid two species off the edge of a 390px screen.
    expect(rowClasses).not.toContain("overflow-x-auto");
    expect(row.length).toBeGreaterThan(0);
  });

  it("offers the mammals individually and the birds as one chip", () => {
    const html = markup();
    for (const label of ["All", "Cattle", "Goats", "Sheep", "Pigs", "Birds"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  /** The four open only when Birds is chosen, so they are absent by default —
   *  which is what keeps the closed row down to two lines. */
  it("keeps the four birds out of the row until Birds is chosen", () => {
    const html = markup();
    for (const label of ["Hens", "Ducks", "Geese", "Turkeys"]) {
      expect(html).not.toContain(`>${label}<`);
    }
  });
});
