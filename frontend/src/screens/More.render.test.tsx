import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecord } from "../db/mutations";
import { resetDeviceIdCache } from "../db/ids";
import { db } from "../db/schema";
import { seedRoomId, seedRoomsIfEmpty } from "../db/seed";
import { MoreScreen } from "./More";
import { muteLayoutEffectWarning } from "./renderNoise";

/**
 * SPEC 23 — the Clear this device control.
 *
 * What is checked here is the wording and the guard, because both are the
 * feature: the destructive button in this app is the only one that deletes
 * records outright rather than marking them sold or dead, and every other
 * safeguard around it lives in the text somebody reads before tapping.
 */

let unmute: () => void;
let teardown: Array<() => void> = [];

beforeEach(async () => {
  unmute = muteLayoutEffectWarning();
  await db.delete();
  await db.open();
  resetDeviceIdCache();
  localStorage.clear();
  await seedRoomsIfEmpty();
});

afterEach(() => {
  for (const undo of teardown) undo();
  teardown = [];
  unmute();
});

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <MoreScreen />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  teardown.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

function button(container: HTMLElement, startsWith: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(startsWith),
  );
  if (!found) throw new Error(`No button starting with ${startsWith}`);
  return found as HTMLButtonElement;
}

/**
 * Type into a controlled input.
 *
 * React installs its own value setter on the element, so assigning `value`
 * directly is swallowed and no change event ever reaches the component. The
 * prototype's setter has to be called instead — taken from the element's own
 * constructor, because jsdom's realm and the test's `window` are not always the
 * same one.
 */
async function type(container: HTMLElement, id: string, value: string) {
  // Found among the container's own inputs rather than with a `#id` selector:
  // scoped `querySelector` on an id misses here, while the element is plainly
  // in the list. React also installs its own value setter on the node, so the
  // prototype's setter has to be called or the change never reaches the
  // component.
  const input = [...container.querySelectorAll("input")].find((el) => el.id === id);
  if (!input) throw new Error(`No input #${id}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Clear this device", () => {
  it("is offered under Data, with a class this project defines", async () => {
    const container = await mount();
    const control = button(container, "Clear this device");
    expect(control.className).toContain("btn-quiet");
    expect(container.innerHTML).not.toContain("btn-primary");
  });

  it("says what it does not do, before it is opened", async () => {
    const container = await mount();
    await act(async () => button(container, "Clear this device").click());

    const text = container.textContent ?? "";
    // The three losses, each a different kind (SPEC 23).
    expect(text).toContain("There is no undo");
    expect(text).toContain("does not clear the server");
    expect(text).toContain("The ten rooms");
  });

  it("names how much unsent work would go with it", async () => {
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", sex: "female",
      source: "bought", room_id: seedRoomId(3),
    });
    const container = await mount();
    await act(async () => button(container, "Clear this device").click());

    // The one part that cannot come back from the server, so it is counted
    // rather than described.
    expect(container.textContent).toMatch(/changes have not reached the server yet/);
  });

  it("will not fire until the word is typed", async () => {
    const container = await mount();
    await act(async () => button(container, "Clear this device").click());

    const confirm = button(container, "Clear it");
    expect(confirm.disabled).toBe(true);

    await type(container, "clear-confirm", "DELETE");

    expect(button(container, "Clear it").disabled).toBe(false);
  });

  it("clears, and reports what went, by table", async () => {
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", sex: "female",
      source: "bought", room_id: seedRoomId(3),
    });
    const container = await mount();
    await act(async () => button(container, "Clear this device").click());

    await type(container, "clear-confirm", "DELETE");
    await act(async () => button(container, "Clear it").click());
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }

    expect(container.textContent).toMatch(/Cleared\./);
    expect(container.textContent).toMatch(/records/);
    expect(await db.records.count()).toBe(0);
    // And the rooms are still there, so the app is usable immediately.
    expect(await db.rooms.count()).toBe(10);
  });
});
