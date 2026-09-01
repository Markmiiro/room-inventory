import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetDeviceIdCache } from "../db/ids";
import { createRecord, recordMove } from "../db/mutations";
import { META, db, getMeta } from "../db/schema";
import { seedRoomId, seedRoomsIfEmpty } from "../db/seed";
import { ApiError, type PullResponse, type PushResponse } from "./api";

// vi.mock factories are hoisted above the module body, so the spies have to be
// created in a hoisted block or they do not exist yet when the factory runs.
const { pushOperations, pullChanges } = vi.hoisted(() => ({
  pushOperations:
    vi.fn<(device: string, operations: Array<Record<string, unknown>>) => Promise<PushResponse>>(),
  pullChanges: vi.fn<(since: number, limit?: number) => Promise<PullResponse>>(),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, pushOperations, pullChanges };
});

const { SyncEngine, applyServerRow } = await import("./engine");

/** Stand-in for a server that accepts everything pushed at it. */
function acceptAll(): void {
  pushOperations.mockImplementation(async (_device, operations) => ({
    results: operations.map((o) => ({
      id: o.id as string,
      entity: o.entity as never,
      status: "applied" as const,
    })),
    head_seq: operations.length,
    server_time: new Date().toISOString(),
  }));
}

function offline(): void {
  const fail = async () => {
    throw new ApiError(0, "offline", "network down");
  };
  pushOperations.mockImplementation(fail);
  pullChanges.mockImplementation(fail);
}

function noChanges(): void {
  pullChanges.mockImplementation(async (since) => ({
    changes: [],
    cursor: since,
    has_more: false,
    server_time: new Date().toISOString(),
  }));
}

/** Drive one sync attempt without waiting on the engine's own timers. */
async function syncOnce(engine: InstanceType<typeof SyncEngine>): Promise<void> {
  await (engine as unknown as { tick: () => Promise<void> }).tick();
}

let engine: InstanceType<typeof SyncEngine>;

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetDeviceIdCache();
  pushOperations.mockReset();
  pullChanges.mockReset();
  engine = new SyncEngine();
  await seedRoomsIfEmpty();
});

/**
 * The behaviour the whole design exists for: work carries on with no network,
 * and catches up when one returns. SPEC 5.1, 5.3, 5.6.
 */
describe("working offline", () => {
  it("keeps accepting writes while the network is down", async () => {
    offline();

    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    await recordMove({
      record_id: record.id, to_room_id: seedRoomId(2), date: "2026-08-31", reason: "routine",
    });
    await syncOnce(engine);

    // The writes are real and readable; only the outbox is behind.
    expect(await db.records.count()).toBe(1);
    expect(await db.moves.count()).toBe(2);
    expect(await db.outbox.count()).toBe(3);
    expect(engine.getStatus().state).toBe("offline");
  });

  it("drains everything queued once the network returns", async () => {
    offline();
    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    await recordMove({
      record_id: record.id, to_room_id: seedRoomId(2), date: "2026-08-31", reason: "routine",
    });
    await syncOnce(engine);
    expect(await db.outbox.count()).toBe(3);

    acceptAll();
    noChanges();
    await syncOnce(engine);

    expect(await db.outbox.count()).toBe(0);
    expect(engine.getStatus().state).toBe("synced");
  });

  it("pushes operations in the order they were made", async () => {
    acceptAll();
    noChanges();

    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    await recordMove({
      record_id: record.id, to_room_id: seedRoomId(2), date: "2026-08-31", reason: "routine",
    });
    await syncOnce(engine);

    const sent = pushOperations.mock.calls[0]![1].map((o) => o.entity);
    expect(sent).toEqual(["record", "move", "move"]);
  });

  it("holds the queue when a push fails, losing nothing", async () => {
    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    pushOperations.mockRejectedValue(new ApiError(500, "server_error", "boom"));

    await syncOnce(engine);

    expect(await db.outbox.count()).toBe(2);
    expect((await db.records.get(record.id))!.tag).toBe("C-084");
  });

  it("backs off further with each consecutive failure, up to five minutes", async () => {
    // SPEC 5.6 — 5s doubling to a 5-minute ceiling.
    const backoff = (failures: number) =>
      (engine as unknown as { failures: number; backoffMs: () => number }).backoffMs.call({
        failures,
      } as never);

    expect(backoff(1)).toBe(5_000);
    expect(backoff(2)).toBe(10_000);
    expect(backoff(3)).toBe(20_000);
    expect(backoff(20)).toBe(5 * 60 * 1000);
  });
});

describe("draining the outbox", () => {
  it("drops an operation the server calls a duplicate", async () => {
    // SPEC 5.3 — a push that lands but whose reply is lost must be retryable.
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    pushOperations.mockImplementation(async (_d, operations) => ({
      results: operations.map((o) => ({
        id: o.id as string, entity: o.entity as never, status: "duplicate" as const,
      })),
      head_seq: 1,
      server_time: new Date().toISOString(),
    }));
    noChanges();

    await syncOnce(engine);

    expect(await db.outbox.count()).toBe(0);
  });

  it("adopts the server's version when it loses a conflict", async () => {
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    const local = (await db.records.toArray())[0]!;

    pushOperations.mockImplementation(async (_d, operations) => ({
      results: operations.map((o) => ({
        id: o.id as string,
        entity: o.entity as never,
        status: o.entity === "record" ? ("conflict" as const) : ("applied" as const),
        server: o.entity === "record" ? { ...local, tag: "C-085", seq: 7 } : null,
      })),
      head_seq: 7,
      server_time: new Date().toISOString(),
    }));
    noChanges();

    await syncOnce(engine);

    expect((await db.records.get(local.id))!.tag).toBe("C-085");
    expect(await db.outbox.count()).toBe(0);
  });

  it("drops a rejected operation rather than blocking the queue behind it", async () => {
    // SPEC 7 — the client must tell "retry this" from "this will never work".
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    pushOperations.mockImplementation(async (_d, operations) => ({
      results: operations.map((o) => ({
        id: o.id as string, entity: o.entity as never,
        status: "rejected" as const, message: "malformed",
      })),
      head_seq: 1,
      server_time: new Date().toISOString(),
    }));
    noChanges();

    await syncOnce(engine);

    expect(await db.outbox.count()).toBe(0);
  });
});

describe("pulling", () => {
  it("advances the cursor and stores what came down", async () => {
    pushOperations.mockResolvedValue({ results: [], head_seq: 0, server_time: "" });
    pullChanges.mockImplementation(async (since) =>
      since === 0
        ? {
            changes: [
              {
                entity: "room" as const,
                id: seedRoomId(1),
                seq: 12,
                data: {
                  id: seedRoomId(1), created_at: "2026-08-31T00:00:00Z",
                  updated_at: "2026-08-31T00:00:00Z", device_id: "other", deleted_at: null,
                  seq: 12, code: "R1", name: "Front room", capacity: 53,
                  is_isolation: false, notes: null,
                },
              },
            ],
            cursor: 12,
            has_more: false,
            server_time: "",
          }
        : { changes: [], cursor: since, has_more: false, server_time: "" },
    );

    await syncOnce(engine);

    expect((await db.rooms.get(seedRoomId(1)))!.name).toBe("Front room");
    expect(await getMeta(META.cursor, 0)).toBe(12);
  });

  it("follows pagination until the server says it is done", async () => {
    pushOperations.mockResolvedValue({ results: [], head_seq: 0, server_time: "" });
    pullChanges.mockImplementation(async (since) => ({
      changes: [],
      cursor: since + 1,
      has_more: since < 2,
      server_time: "",
    }));

    await syncOnce(engine);

    // since=0 and since=1 report more; since=2 does not.
    expect(pullChanges).toHaveBeenCalledTimes(3);
  });

  it("does not overwrite a local change that has not been pushed yet", async () => {
    // SPEC 5.5 — pending changes are real records, not provisional ones.
    const record = await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });

    await applyServerRow("record", {
      ...record, tag: "STALE-FROM-SERVER", head_count: 1, status: "active",
    } as never);

    expect((await db.records.get(record.id))!.tag).toBe("C-084");
  });

  it("still takes the server's head count for a record with a pending edit", async () => {
    // SPEC 6.7 — the server's figure accounts for events this device cannot see.
    const group = await createRecord({
      kind: "group", species: "pigs", tag: "P-Weaners", source: "bought",
      head_count: 8, room_id: seedRoomId(1),
    });

    await applyServerRow("record", { ...group, head_count: 3, status: "active" } as never);

    const stored = (await db.records.get(group.id))!;
    expect(stored.head_count).toBe(3);
    expect(stored.tag).toBe("P-Weaners");
  });
});

describe("sync status", () => {
  it("reports how many changes are waiting", async () => {
    offline();
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    await syncOnce(engine);

    expect(engine.getStatus().pending).toBe(2);
    expect(engine.getStatus().state).toBe("offline");
  });

  it("flags a queue stuck for more than 48 hours", async () => {
    // SPEC 4.6 / 5.5 — only then does being behind become an alert.
    offline();
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    await db.outbox.toCollection().modify({ queued_at: threeDaysAgo });

    await syncOnce(engine);

    expect(engine.getStatus().stale).toBe(true);
  });

  it("is not stale while the queue is merely recent", async () => {
    offline();
    await createRecord({
      kind: "animal", species: "cattle", tag: "C-084", source: "bought", room_id: seedRoomId(1),
    });
    await syncOnce(engine);

    expect(engine.getStatus().stale).toBe(false);
  });
});
