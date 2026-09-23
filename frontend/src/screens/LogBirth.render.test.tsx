import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDeviceIdCache } from "../db/ids";
import { createRecord, recordBirth } from "../db/mutations";
import { db } from "../db/schema";
import { seedRoomId, seedRoomsIfEmpty } from "../db/seed";
import { LogBirthScreen } from "./LogBirth";
import { RecordDetailScreen } from "./RecordDetail";
import { muteLayoutEffectWarning } from "./renderNoise";

/**
 * Smoke tests for the birth screens (SPEC 22.5).
 *
 * The rules are pinned in `domain/births.test.ts` and what a birth writes in
 * `db/births.test.ts`; the layout was checked by rendering in Chrome at 390px,
 * which jsdom cannot repeat because it lays nothing out.
 *
 * What these catch is the layer neither covers: that each screen renders at
 * all, and that its buttons carry class names this project actually defines.
 * The four store screens shipped with `btn-primary` — a class that does not
 * exist here — and rendered their primary action as unstyled text while every
 * check passed. So the class names are asserted by name, and the browser is
 * still where the pixels get looked at.
 *
 * Two render helpers, because these screens read from IndexedDB through
 * `useLiveQuery`. `render` is the static one and sees the loading state — which
 * is a state worth asserting, since it is what a slow device shows. `mount`
 * renders into jsdom and lets the queries resolve, which is the only way to see
 * a screen that has data behind it.
 */

let unmute: () => void;

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
  await seedRoomsIfEmpty();
});

afterEach(() => unmute());

function tree(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/birth" element={<LogBirthScreen />} />
        <Route path="/records/:recordId" element={<RecordDetailScreen />} />
      </Routes>
    </MemoryRouter>
  );
}

function render(path: string) {
  return renderToStaticMarkup(tree(path));
}

/** Render into jsdom and wait for the live queries to answer. */
async function mount(path: string): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(tree(path));
  });
  // Dexie answers on a later microtask, and the screens that follow a link —
  // an offspring reading its dam — need a second round once the first query
  // has answered. The assertions say plainly if this is not long enough.
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

async function dam(overrides: Record<string, unknown> = {}) {
  return createRecord({
    kind: "animal",
    species: "cattle",
    tag: "C-084",
    breed: "Friesian",
    sex: "female",
    date_of_birth: "2023-05-01",
    source: "bought",
    room_id: seedRoomId(3),
    ...overrides,
  } as Parameters<typeof createRecord>[0]);
}

describe("Log birth renders", () => {
  it("asks which mother, on a farm with none", () => {
    const html = render("/birth");
    expect(html).toContain("Which mother?");
    expect(html).toContain("No female animal or group to record a birth against.");
  });

  it("uses class names this project defines", async () => {
    const mother = await dam();
    const html = await mount(`/birth?record=${mother.id}`);
    // The three that exist. `btn-primary` does not, and rendered as plain text
    // for four screens before anybody opened a browser.
    expect(html).not.toContain("btn-primary");
    expect(html).toContain("btn-action");
  });

  it("renders the form for a chosen dam", async () => {
    const mother = await dam();
    const html = await mount(`/birth?record=${mother.id}`);
    expect(html).toContain("How many born");
    expect(html).toContain("How many survived");
    // The dam's own tag and room, so the form is about the animal in front of
    // you rather than a blank.
    expect(html).toContain("C-084");
    expect(html).toContain("Room 3");
  });

  it("suggests a tag derived from the dam's own", async () => {
    const mother = await dam();
    const html = await mount(`/birth?record=${mother.id}`);
    expect(html).toContain("C-084-1");
  });
});

describe("Record detail renders the birth links", () => {
  it("offers Log birth on a female animal", async () => {
    const mother = await dam();
    const html = await mount(`/records/${mother.id}`);
    expect(html).toContain("Log birth");
    expect(html).toContain(`/birth?record=${mother.id}`);
  });

  it("does not offer it on a male", async () => {
    const bull = await dam({ tag: "C-900", sex: "male" });
    const html = await mount(`/records/${bull.id}`);
    expect(html).not.toContain("Log birth");
  });

  it("offers it on a group, which is how a hatch is recorded", async () => {
    const hens = await dam({
      kind: "group", tag: "H-Layers", species: "hens", sex: null,
      date_of_birth: null, arrival_date: "2026-02-01", head_count: 12,
    });
    const html = await mount(`/records/${hens.id}`);
    expect(html).toContain("Log birth");
  });

  it("lists the offspring, and links the calf back to its parents", async () => {
    const mother = await dam();
    const { offspring } = await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    const damHtml = await mount(`/records/${mother.id}`);
    expect(damHtml).toContain("C-084-1");
    expect(damHtml).toContain(`/records/${offspring[0]!.id}`);

    const calfHtml = await mount(`/records/${offspring[0]!.id}`);
    expect(calfHtml).toContain("Mother");
    expect(calfHtml).toContain(`/records/${mother.id}`);
  });

  it("shows the offspring total as its two parts", async () => {
    const mother = await dam();
    await db.records.update(mother.id, { offspring_baseline: 2 });
    await recordBirth({
      dam_record_id: mother.id,
      date: "2026-09-01",
      born_count: 1,
      surviving_count: 1,
      offspring: [{ tag: "C-084-1", sex: "female", survived: true }],
    });

    const html = await mount(`/records/${mother.id}`);
    expect(html).toContain("2 typed in");
    expect(html).toContain("1 from 1 recorded birth");
  });
});
