import puppeteer from "puppeteer-core";

/**
 * SPEC 5.4 and 6.7, proven end to end.
 *
 * Both rules are unit-tested on each side of the wire, and neither has ever
 * been shown working across it. Two browser contexts give two isolated
 * IndexedDB stores, which is what "device" means to this app: two real clients,
 * both offline, both writing to the same record, both coming back.
 *
 * Navigation while offline goes through the app's own router rather than
 * page.goto — a document request needs the service worker, which is a separate
 * claim tested separately.
 */
const BASE = "http://localhost:5173";
const PASSWORD = "e2e-test-password";
const R1 = "0000000000000000000000R001";

const failures = [];
const say = (m) => console.log(m);
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  say(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`}`);
  if (!ok) failures.push(label);
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

async function openDevice(name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => say(`  [${name}] PAGE ERROR ${String(e).slice(0, 140)}`));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));
  return { name, context, page };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const click = async (d, text) => {
  const h = await d.page.evaluateHandle(
    (t) => [...document.querySelectorAll("button,a")].find((e) => e.textContent.trim().startsWith(t)) ?? null, text);
  const el = h.asElement();
  if (!el) throw new Error(`[${d.name}] no "${text}"`);
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await wait(100);
  await el.click();
  await wait(400);
};

const type = async (d, id, v) => {
  await d.page.waitForSelector(`#${id}`, { timeout: 5000 });
  await d.page.evaluate((i) => document.getElementById(i).scrollIntoView({ block: "center" }), id);
  await wait(100);
  await d.page.click(`#${id}`, { clickCount: 3 });
  await d.page.type(`#${id}`, v);
};

/** A real page load. Only safe while the device is online. */
const loadPage = async (d, path) => {
  await d.page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
  await wait(1000);
};

/**
 * In-app navigation, for use while offline: the router's own link handling, so
 * no document is requested. A document request offline needs the service
 * worker, which is a separate claim tested separately.
 */
const routeTo = async (d, path) => {
  const went = await d.page.evaluate((p) => {
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === p);
    if (link) { link.click(); return "link"; }
    return null;
  }, path);
  if (!went) throw new Error(`[${d.name}] no in-app link to ${path}`);
  await wait(1000);
};

/** Idempotent: clicking the chip toggles, so an already-open panel must not be
 *  clicked shut. Getting this wrong makes every later sync a silent no-op. */
async function openSyncPanel(d) {
  const opened = await d.page.evaluate(() => {
    const isOpen = () => [...document.querySelectorAll("button")]
      .some((x) => x.textContent.trim() === "Sync now");
    if (isOpen()) return true;
    [...document.querySelectorAll("button")]
      .find((b) => /SYNCED|PENDING|OFFLINE|SYNCING/i.test(b.textContent))?.click();
    return false;
  });
  await wait(500);
  const ready = await d.page.evaluate(() => [...document.querySelectorAll("button")]
    .some((x) => x.textContent.trim() === "Sync now"));
  if (!ready) throw new Error(`[${d.name}] could not open the sync panel (was ${opened ? "open" : "closed"})`);
}

async function signIn(d) {
  await openSyncPanel(d);
  await type(d, "sync-password", PASSWORD);
  await click(d, "Sign in");
  await wait(2500);

  // SPEC 8 rate-limits login to 5 attempts per 15 minutes. A locked-out run
  // would otherwise sail through every later step doing nothing at all, and
  // report convergence between two devices that never spoke.
  const ok = await d.page.evaluate(async () => {
    const res = await fetch("/api/sync/pull?since=0&limit=1", {
      headers: { Authorization: `Bearer ${localStorage.getItem("access_token") ?? ""}` },
    });
    return res.status;
  });
  if (ok !== 200) {
    const text = await d.page.evaluate(() => document.body.innerText.slice(0, 300));
    throw new Error(`[${d.name}] sign-in did not take (pull returned ${ok}).\n${text}`);
  }
}

async function syncNow(d) {
  await openSyncPanel(d);
  const clicked = await d.page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sync now");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error(`[${d.name}] no Sync now button`);
  await wait(2600);
  await d.page.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Close")?.click();
  });
  await wait(300);
}

/** How much this device still has queued. Zero after a successful push. */
async function pending(d) {
  return d.page.evaluate(async () => {
    const open = indexedDB.open("room-inventory");
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const r = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
    return (await new Promise((res) => { r.onsuccess = () => res(r.result); })).length;
  });
}

/** Read the device's own database. This is the state that has to converge. */
async function readState(d) {
  return d.page.evaluate(async () => {
    const open = indexedDB.open("room-inventory");
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const read = (store) => new Promise((res) => {
      const r = db.transaction(store, "readonly").objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
    });
    const [records, sales] = await Promise.all([read("records"), read("sales")]);
    const g = records.find((r) => r.tag === "P-Weaners");
    const own = sales.filter((s) => s.record_id === g?.id);
    return {
      breed: g?.breed ?? null,
      notes: g?.notes ?? null,
      head: g?.head_count ?? null,
      status: g?.status ?? null,
      sales: own.length,
      headSold: own.reduce((n, s) => n + s.count, 0),
      salePrices: own.map((s) => s.price).sort((x, y) => x - y),
    };
  });
}

// ---------------------------------------------------------------------------
say("\n=== setup: one group of 8, on both devices ===");
const a = await openDevice("A");
await signIn(a);

await loadPage(a, "/add");
await click(a, "Group");
await click(a, "Pigs");
await type(a, "add-tag", "P-Weaners");
await type(a, "add-head", "8");
await a.page.select("#add-room", R1);
await click(a, "Add group");
await wait(1400);

const recordId = await a.page.evaluate(async () => {
  const open = indexedDB.open("room-inventory");
  const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
  const r = db.transaction("records", "readonly").objectStore("records").getAll();
  const all = await new Promise((res) => { r.onsuccess = () => res(r.result); });
  return all.find((x) => x.tag === "P-Weaners").id;
});
await syncNow(a);
check("A pushed everything it had", await pending(a), 0);

const b = await openDevice("B");
await signIn(b);
await syncNow(b);

const startA = await readState(a);
const startB = await readState(b);
say(`  A: ${JSON.stringify(startA)}`);
say(`  B: ${JSON.stringify(startB)}`);
check("both devices start from the same group of 8", [startA.head, startB.head], [8, 8]);

// ---------------------------------------------------------------------------
say("\n=== both devices go offline ===");
await loadPage(a, `/records/${recordId}`);
await loadPage(b, `/records/${recordId}`);
await a.page.setOfflineMode(true);
await b.page.setOfflineMode(true);

// Prove the cut is real, or everything after this proves nothing.
for (const d of [a, b]) {
  const dead = await d.page.evaluate(async () => {
    try { await fetch("/api/health", { cache: "no-store" }); return false; } catch { return true; }
  });
  check(`${d.name} is genuinely offline`, dead, true);
}

// --- SPEC 5.4: two devices edit different fields of the same record --------
say("\n=== offline: A edits breed, B edits notes, on the same record ===");
await click(a, "Edit");
await type(a, "edit-breed", "Landrace");
await click(a, "Save");
await wait(900);

await click(b, "Edit");
await type(b, "edit-notes", "Checked by device B");
await click(b, "Save");
await wait(900);

// --- SPEC 6.7: both sell five from the same group of eight -----------------
say("=== offline: both devices sell 5 head from the same group of 8 ===");
for (const [d, price] of [[a, "500000"], [b, "600000"]]) {
  await routeTo(d, `/sell?record=${recordId}`);
  await type(d, "sell-count", "5");
  await type(d, "sell-price", price);
  await click(d, "Sell ");
  await wait(1200);
}

const offlineA = await readState(a);
const offlineB = await readState(b);
say(`  A offline: ${JSON.stringify(offlineA)}`);
say(`  B offline: ${JSON.stringify(offlineB)}`);
check("A sold 5 of its 8, leaving 3", offlineA.head, 3);
check("B sold 5 of its 8, leaving 3", offlineB.head, 3);

// ---------------------------------------------------------------------------
say("\n=== both come back online ===");
await a.page.setOfflineMode(false);
await b.page.setOfflineMode(false);
await wait(600);

/**
 * Converging takes more than one exchange: each device has to push its own work
 * and then pull the other's, and the server's derived head_count only settles
 * once both sales have landed. Syncing until both are quiet is the honest way
 * to ask "did they converge" — stopping after a fixed number of rounds would
 * leave whichever device synced last looking right and the other looking wrong.
 */
for (let round = 1; round <= 6; round += 1) {
  await syncNow(a);
  await syncNow(b);
  const [qa, qb] = [await pending(a), await pending(b)];
  const [sa, sb] = [await readState(a), await readState(b)];
  const settled = qa === 0 && qb === 0 && JSON.stringify(sa) === JSON.stringify(sb);
  say(`  round ${round}: queued A=${qa} B=${qb}${settled ? " — settled" : ""}`);
  if (settled) break;
}

check("A has nothing left queued", await pending(a), 0);
check("B has nothing left queued", await pending(b), 0);

const finalA = await readState(a);
const finalB = await readState(b);
say(`  A final: ${JSON.stringify(finalA)}`);
say(`  B final: ${JSON.stringify(finalB)}`);

say("\n=== assertions ===");
check("the two devices converged", finalA, finalB);
// SPEC 5.4 — per field, so neither edit is lost to the other.
check("A's breed survived B's edit", finalA.breed, "Landrace");
check("B's note survived A's edit", finalA.notes, "Checked by device B");
// SPEC 6.7 — both sales kept, count clamped at zero, nothing discarded.
check("both sales were kept", finalA.sales, 2);
check("both prices are there", finalA.salePrices, [500000, 600000]);
check("ten head were sold from a group of eight", finalA.headSold, 10);
check("the count clamped at zero rather than going negative", finalA.head, 0);
check("the record is marked sold", finalA.status, "sold");

// The server must have recorded the oversell rather than swallowed it.
const anomalies = await a.page.evaluate(async () => {
  const res = await fetch("/api/sync/anomalies", {
    headers: { Authorization: `Bearer ${localStorage.getItem("access_token") ?? ""}` },
  });
  return res.ok ? await res.json() : { status: res.status };
});
// SPEC 6.7 — "Never silently discard a sale." The server has to have said
// something about the group going below zero.
const anomalyText = JSON.stringify(anomalies);
say(`  server anomalies: ${anomalyText.slice(0, 300)}`);
check("the server recorded the oversell", /P-Weaners|below zero|oversold/i.test(anomalyText), true);

await browser.close();
say(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
