import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDeviceIdCache } from "../db/ids";
import { recordIntake, recordOuttake } from "../db/mutations";
import { db } from "../db/schema";
import { seedProduceTypeId, seedStoreId, seedStoresIfEmpty } from "../db/seed";
import { AddStockScreen } from "./AddStock";
import { StoreDetailScreen } from "./StoreDetail";
import { StoresScreen } from "./Stores";
import { TakeOutStockScreen } from "./TakeOutStock";
import { muteLayoutEffectWarning } from "./renderNoise";

/**
 * Smoke tests for the four store screens (SPEC 20.11).
 *
 * The balance itself is pinned in `domain/stores.test.ts`, and the layout was
 * checked by rendering in Chrome at 390px — jsdom cannot lay anything out, so
 * it cannot repeat that. What these catch is the layer neither covers: that
 * each screen renders at all, on an empty farm and on a stocked one.
 *
 * That is not hypothetical here. All four shipped with `btn-primary` on their
 * main button, a class this project does not define, so every one of them
 * rendered its primary action as unstyled text. Nothing failed; it just looked
 * wrong, and only a browser caught it. These assert the real class name.
 */

let unmute: () => void;

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
});

afterEach(() => unmute());

const STORE = seedStoreId(1);
const COFFEE = seedProduceTypeId(2);

function render(path: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/stores" element={<StoresScreen />} />
        <Route path="/stores/:storeId" element={<StoreDetailScreen />} />
        <Route path="/stock/in" element={<AddStockScreen />} />
        <Route path="/stock/out" element={<TakeOutStockScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the store screens render", () => {
  it("shows Stores on a farm holding nothing", () => {
    const html = render("/stores");
    expect(html).toContain("Add stock");
  });

  it("renders Store detail", () => {
    expect(() => render(`/stores/${STORE}`)).not.toThrow();
  });

  it("renders both stock forms", () => {
    expect(render("/stock/in")).toContain("Where it came from");
    expect(render("/stock/out")).toContain("Why it is leaving");
  });

  it("renders after real stock exists", async () => {
    await seedStoresIfEmpty();
    await recordIntake({
      store_id: STORE,
      produce_type_id: COFFEE,
      date: "2026-03-01",
      sacks: 40,
      kg: 2480,
      source: "garden",
      garden_name: "Lower garden",
    });
    expect(() => render(`/stores/${STORE}`)).not.toThrow();
    expect(() => render("/stores")).not.toThrow();
  });
});

/**
 * TOKENS.md: the action yellow appears once per screen, on the primary button,
 * and `.btn-action` is deliberately the only rule that produces that colour.
 * A misspelled class is invisible to the type checker and to every test that
 * only asks whether the screen rendered.
 */
describe("the primary button", () => {
  /**
   * Store detail is not in this list. A static render cannot resolve the live
   * queries, so it always takes its "no such store" branch and has no buttons
   * to check — asserting against it would be asserting about the empty state.
   * Its button is covered by the Chrome pass instead.
   */
  const withButtons = ["/stores", "/stock/in", "/stock/out"];

  it("uses the class that exists, on each screen that has one", () => {
    for (const path of withButtons) {
      const html = render(path);
      expect(html).toContain("btn-action");
      expect(html).not.toContain("btn-primary");
    }
  });

  it("uses the action yellow exactly once per screen", () => {
    for (const path of withButtons) {
      const matches = render(path).match(/btn-action/g) ?? [];
      expect(matches).toHaveLength(1);
    }
  });
});

/**
 * SPEC 20.14.7 and 20.14.8 — a move needs a different destination store, and
 * writes both halves in one transaction so produce is never in neither.
 */
describe("moving between stores", () => {
  it("writes a mirrored intake in the destination", async () => {
    await seedStoresIfEmpty();
    await recordIntake({
      store_id: STORE,
      produce_type_id: COFFEE,
      date: "2026-03-01",
      kg: 500,
      sacks: 8,
      source: "garden",
    });

    const { mirrored } = await recordOuttake({
      store_id: STORE,
      produce_type_id: COFFEE,
      date: "2026-04-01",
      kg: 200,
      sacks: 3,
      reason: "moved",
      to_store_id: seedStoreId(2),
    });

    expect(mirrored).not.toBeNull();
    expect(mirrored!.store_id).toBe(seedStoreId(2));
    expect(mirrored!.kg).toBe(200);
    // The produce did not leave the farm, so it carries no cost into the
    // destination — that would inflate its weighted average (SPEC 20.9).
    expect(mirrored!.cost).toBeNull();
  });

  it("refuses a move to the same store", async () => {
    await seedStoresIfEmpty();
    await expect(
      recordOuttake({
        store_id: STORE,
        produce_type_id: COFFEE,
        date: "2026-04-01",
        kg: 10,
        reason: "moved",
        to_store_id: STORE,
      }),
    ).rejects.toThrow(/different destination/);
  });

  it("queues both halves for the server", async () => {
    await seedStoresIfEmpty();
    await db.outbox.clear();

    await recordOuttake({
      store_id: STORE,
      produce_type_id: COFFEE,
      date: "2026-04-01",
      kg: 200,
      reason: "moved",
      to_store_id: seedStoreId(2),
    });

    const queued = await db.outbox.toArray();
    expect(queued.map((o) => o.entity).sort()).toEqual(["stock_intake", "stock_outtake"]);
  });
});
