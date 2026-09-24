import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDeviceIdCache } from "../db/ids";
import { createRecord } from "../db/mutations";
import { db } from "../db/schema";
import { seedRoomId, seedRoomsIfEmpty } from "../db/seed";
import { AddPurchaseScreen } from "./AddPurchase";
import { RecordDetailScreen } from "./RecordDetail";
import { muteLayoutEffectWarning } from "./renderNoise";

/**
 * SPEC 22.9 — naming the parents on the Add form.
 *
 * Driven through the screen rather than `createRecord` alone, because what is
 * being pinned is mostly the form's behaviour: the section appears only for
 * Born here, choosing a mother fills in her breed and room, and saving links
 * the record without writing a Birth.
 */

let unmute: () => void;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
  await seedRoomsIfEmpty();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  unmute();
});

async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

async function mount(path = "/add") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/add" element={<AddPurchaseScreen />} />
          <Route path="/records/:recordId" element={<RecordDetailScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`No button containing "${text}"`);
  return found;
}

async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}

async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function value(id: string) {
  return container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value;
}

async function farm() {
  const mother = await createRecord({
    kind: "animal", species: "cattle", tag: "C-084", breed: "Ankole", sex: "female",
    source: "bought", room_id: seedRoomId(3),
  });
  const father = await createRecord({
    kind: "animal", species: "cattle", tag: "C-BULL", sex: "male", source: "bought",
  });
  await createRecord({
    kind: "animal", species: "goats", tag: "G-001", sex: "female", source: "bought",
  });
  return { mother, father };
}

describe("Add — parents of an animal born here", () => {
  it("offers Parents only once Born here is chosen", async () => {
    await farm();
    await mount();
    expect(container.textContent).not.toContain("Parents");

    await click("Born here");
    expect(container.textContent).toContain("Parents");
    // The distinction from Log birth is said on the form itself.
    expect(container.textContent).toContain("This does not log a birth");
    expect(container.querySelector('a[href="/birth"]')?.textContent).toBe("Log birth");
  });

  it("lists mothers of the selected species only, with their room", async () => {
    await farm();
    await mount();
    await click("Born here");

    const text = container.textContent!;
    expect(text).toContain("C-084");
    expect(text).not.toContain("G-001");
    // The bull is offered as a father, not as a mother.
    const damSection = container.querySelector("#add-dam")!.closest("div.mt-4")!;
    expect(damSection.textContent).not.toContain("C-BULL");
  });

  it("fills in breed and room from the mother, and links without logging a birth", async () => {
    const { mother, father } = await farm();
    await mount();
    await click("Born here");
    await click("C-084");

    expect(value("add-breed")).toBe("Ankole");
    expect(value("add-room")).toBe(seedRoomId(3));
    expect(container.textContent).toContain("filled in from C-084");
    // With a mother chosen, the Log birth link goes to her.
    expect(container.querySelector(`a[href="/birth?record=${mother.id}"]`)).not.toBeNull();

    await click("C-BULL");
    // Still editable after the pre-fill.
    await type("add-breed", "Ankole cross");
    await type("add-tag", "C-085");
    await click("Add animal");

    const added = (await db.records.where("tag").equals("C-085").first())!;
    expect(added.source).toBe("born_here");
    expect(added.breed).toBe("Ankole cross");
    expect(added.dam_record_id).toBe(mother.id);
    expect(added.sire_record_id).toBe(father.id);
    expect(added.birth_id).toBeNull();
    expect(await db.births.count()).toBe(0);
  });

  it("takes an outside father by name", async () => {
    await farm();
    await mount();
    await click("Born here");
    await type("add-sire-name", "Neighbour's Boran bull");
    await type("add-tag", "C-086");
    await click("Add animal");

    const added = (await db.records.where("tag").equals("C-086").first())!;
    expect(added.dam_record_id).toBeNull();
    expect(added.sire_record_id).toBeNull();
    expect(added.sire_name).toBe("Neighbour's Boran bull");
  });

  it("drops the parents if the source is switched away from Born here", async () => {
    await farm();
    await mount();
    await click("Born here");
    await click("C-084");
    await click("Bought");
    await type("add-tag", "C-087");
    await click("Add animal");

    const added = (await db.records.where("tag").equals("C-087").first())!;
    expect(added.dam_record_id).toBeNull();
  });

  it("shows on both records: the mother lists it, and it names its parents", async () => {
    const { mother } = await farm();
    const calf = await createRecord({
      kind: "animal", species: "cattle", tag: "C-085", sex: "female", source: "born_here",
      dam_record_id: mother.id, sire_name: "Neighbour's Boran bull",
    });

    await mount(`/records/${mother.id}`);
    expect(container.textContent).toContain("C-085");
    expect(container.textContent).toContain("no birth logged");
    await act(async () => root.unmount());
    container.remove();

    await mount(`/records/${calf.id}`);
    expect(container.querySelector(`a[href="/records/${mother.id}"]`)?.textContent).toBe("C-084");
    expect(container.textContent).toContain("Father Neighbour's Boran bull — not a record on this farm");
  });
});
