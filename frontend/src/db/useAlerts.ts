import { useMemo } from "react";

import type { HealthRecord, Move, Record_, Room } from "./types";
import { allHealth, allMoves, liveRooms, outboxAge } from "./queries";
import { db } from "./schema";
import { todayInEAT } from "./ids";
import { computeAlerts, type Alert } from "../domain/alerts";
import { useLiveQuery } from "../sync/useSync";

/**
 * The alert rules, wired to this device's database.
 *
 * `domain/alerts.ts` stays a pure function of its inputs so it can be tested
 * without a database; this is the one place that fetches those inputs. Alerts,
 * Rooms, Room detail and Calendar all call this, so all four are looking at the
 * same answers rather than four near-copies of the rules.
 */
export function useAlerts(): Alert[] {
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  // Every record, not just the active ones: the rules decide for themselves
  // what a sold record does and does not raise (SPEC 6.2).
  const records = useLiveQuery(() => db.records.toArray(), [], [] as Record_[]);
  const moves = useLiveQuery(allMoves, [], [] as Move[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);
  const outbox = useLiveQuery(outboxAge, [], { count: 0, oldestQueuedAt: null });

  return useMemo(
    () =>
      computeAlerts({
        rooms,
        records,
        moves,
        health,
        today: todayInEAT(),
        oldestPendingAt: outbox.oldestQueuedAt,
        pendingCount: outbox.count,
      }),
    [rooms, records, moves, health, outbox],
  );
}
