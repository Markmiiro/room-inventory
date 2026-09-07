import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDeviceIdCache } from "../db/ids";
import { muteLayoutEffectWarning } from "./renderNoise";
import { db } from "../db/schema";
import { MoneyScreen } from "./Money";

/**
 * Money is two tabs over one period (SPEC 19.4).
 *
 * These render the shell at both URLs. The tab is in the path rather than in
 * component state, so a bookmark or a reload lands where it was and the back
 * button leaves Analytics rather than the whole screen — which is only true if
 * the path actually selects the tab, and that is what is checked here.
 */

let unmute: () => void;

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
});

afterEach(() => unmute());

function at(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <MoneyScreen />
    </MemoryRouter>,
  );
}

describe("the Money tabs", () => {
  it("shows both tabs and the period selector on either path", () => {
    for (const path of ["/money", "/money/analytics"]) {
      const html = at(path);
      expect(html).toContain(">Summary<");
      expect(html).toContain(">Analytics<");
      // The selector is shared, so it sits above the tabs' content on both.
      expect(html).toContain("12 months");
      expect(html).toContain("5 years");
    }
  });

  it("shows the summary at /money", () => {
    const html = at("/money");
    expect(html).toContain("Estimated profit per record");
    expect(html).not.toContain("What the farm holds");
  });

  it("shows analytics at /money/analytics", () => {
    const html = at("/money/analytics");
    expect(html).toContain("What the farm holds");
    expect(html).toContain("Spent and earned by species");
    expect(html).not.toContain("Estimated profit per record");
  });

  it("marks the selected tab for assistive technology, not by colour alone", () => {
    // SPEC 4.6's rule about colour never being the only signal applies here too:
    // which tab is showing has to be readable without seeing it.
    expect(at("/money")).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Summary/);
    expect(at("/money/analytics")).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Analytics/);
  });

  it("defaults to the summary at 12 months", () => {
    const html = at("/money");
    expect(html).toMatch(/aria-pressed="true"[^>]*>12 months/);
  });
});
