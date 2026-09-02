import { describe, expect, it } from "vitest";

import { describeSyncStatus } from "./SyncIndicator";

/**
 * SPEC 5.5 — the indicator is visible but never alarming. It also has to be
 * true, which is the part this covers.
 *
 * The bug it pins: an empty outbox was treated as proof of a working sync. A
 * device pointed at the wrong server has nothing queued, fails every pull, and
 * reported "Synced" throughout — the single state the indicator exists to rule
 * out. Fixing the API client to reject non-JSON was necessary but not
 * sufficient; the label has to consult whether the last attempt succeeded.
 */

const quiet = { pending: 0, stale: false };

describe("when the last sync failed", () => {
  it("does not say Synced just because nothing is queued", () => {
    const { label } = describeSyncStatus(
      { state: "pending", error: "The server replied with text/html rather than JSON." },
      quiet,
    );
    expect(label).not.toBe("Synced");
    expect(label).toBe("Not syncing");
  });

  /**
   * "Offline" is a different claim, and a reassuring one: it means there is no
   * network, which is normal in a building with no coverage and implies the
   * work will go out later on its own. A wrong server reached *something*, so
   * saying Offline would be as misleading as saying Synced.
   */
  it("does not call a bad response Offline", () => {
    const { label } = describeSyncStatus({ state: "pending", error: "not json" }, quiet);
    expect(label).not.toContain("Offline");
  });

  it("still reports genuinely queued work by count", () => {
    const { label } = describeSyncStatus(
      { state: "pending", error: "not json" },
      { pending: 3, stale: false },
    );
    expect(label).toBe("3 pending");
  });

  it("still escalates to stuck after 48 hours", () => {
    const { label } = describeSyncStatus(
      { state: "pending", error: "not json" },
      { pending: 2, stale: true },
    );
    expect(label).toBe("2 stuck");
  });
});

describe("when nothing has failed", () => {
  it("says Synced with an empty outbox and no error", () => {
    expect(describeSyncStatus({ state: "synced", error: null }, quiet).label).toBe("Synced");
  });

  it("still says Offline when there is no network", () => {
    expect(describeSyncStatus({ state: "offline", error: null }, quiet).label).toBe("Offline");
  });

  it("keeps the pending count on the offline label", () => {
    const { label } = describeSyncStatus(
      { state: "offline", error: null },
      { pending: 4, stale: false },
    );
    expect(label).toBe("Offline · 4");
  });
});
