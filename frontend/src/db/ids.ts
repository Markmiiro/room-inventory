import { ulid } from "ulid";

import { META, getMeta, setMeta } from "./schema";

/**
 * IDs are minted here, on the device, never by the server (SPEC 3.1). That is
 * what lets a record created with no signal keep one stable identity forever —
 * and it is also what makes pushing twice harmless, since the server recognises
 * the id and answers `duplicate` (SPEC 5.3).
 *
 * ULIDs rather than UUIDs because they sort by creation time, so an event log
 * is naturally ordered.
 */
export function newId(): string {
  return ulid();
}

let cachedDeviceId: string | null = null;

/** A stable per-device id. It breaks ties in conflict resolution (SPEC 5.4),
 *  so it must survive restarts — hence it lives in IndexedDB, not memory. */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const existing = await getMeta<string | null>(META.deviceId, null);
  if (existing) {
    cachedDeviceId = existing;
    return existing;
  }
  const fresh = ulid();
  await setMeta(META.deviceId, fresh);
  cachedDeviceId = fresh;
  return fresh;
}

/** For tests. */
export function resetDeviceIdCache(): void {
  cachedDeviceId = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A plain YYYY-MM-DD in East Africa Time.
 *
 *  SPEC 1: dates without a time carry no timezone, but "today" still has to
 *  mean today where the farm is. Deriving it from the device's own locale would
 *  put a phone left on UTC a day behind during the evening. */
export function todayInEAT(at: Date = new Date()): string {
  const eat = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  return eat.toISOString().slice(0, 10);
}
