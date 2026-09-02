import { useState } from "react";

import { db } from "../db/schema";
import { login } from "../sync/api";
import { STALE_SYNC_MS, syncEngine, type SyncStatus } from "../sync/engine";
import { useLiveQuery, useSyncStatus } from "../sync/useSync";
import { CheckIcon, CloudOffIcon, SyncIcon, WarningIcon } from "./Icons";

/** The queue, read live.
 *
 *  The engine also tracks a count, but only refreshes it when it ticks. Reading
 *  IndexedDB directly means the indicator updates the instant a change is
 *  queued, so it can never claim "Synced" while something is still waiting.
 */
function usePendingQueue() {
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const oldest = useLiveQuery(() => db.outbox.orderBy("queue_id").first(), [], undefined);
  const stale =
    oldest !== undefined && Date.now() - new Date(oldest.queued_at).getTime() > STALE_SYNC_MS;
  return { pending, stale };
}

/**
 * SPEC 5.5 — visible, but never alarming.
 *
 * It says `Synced`, `N changes pending` or `Offline` in words, because a
 * coloured dot on its own is not an acceptable status indicator (TOKENS.md).
 * Being behind only escalates to an alert after 48 hours, and nothing here ever
 * blocks an action.
 */
export function SyncIndicator() {
  const status = useSyncStatus();
  const queue = usePendingQueue();
  const [open, setOpen] = useState(false);

  const { label, Icon, tone } = describeSyncStatus(status, queue);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-full px-3 min-h-touch md:min-h-touch-desktop
                    font-mono text-data-label uppercase ${tone}`}
        aria-label={`Sync status: ${label}`}
      >
        <Icon className="w-4 h-4" />
        <span>{label}</span>
      </button>

      {open && <SyncPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The words on the indicator.
 *
 * Exported and pure so the rule can be tested directly. This is where a device
 * pointed at the wrong server used to be told it was Synced, and a rule that
 * only exists inside a rendered component is a rule that gets tested through
 * three layers of scaffolding or, in practice, not at all.
 */
export function describeSyncStatus(
  status: Pick<SyncStatus, "state" | "error">,
  queue: { pending: number; stale: boolean },
) {
  if (queue.stale) {
    // SPEC 4.6 — unsynced changes older than 48h are an urgent alert. Until
    // then being behind is reported plainly and never alarmingly (SPEC 5.5).
    return { label: `${queue.pending} stuck`, Icon: WarningIcon, tone: "bg-alert-bg text-alert-text" };
  }
  if (status.state === "offline") {
    const suffix = queue.pending > 0 ? ` · ${queue.pending}` : "";
    return { label: `Offline${suffix}`, Icon: CloudOffIcon, tone: "bg-white/15 text-white" };
  }
  if (queue.pending > 0) {
    return { label: `${queue.pending} pending`, Icon: SyncIcon, tone: "bg-white/15 text-white" };
  }
  /**
   * An empty outbox is not the same thing as a working sync.
   *
   * This used to fall straight through to "Synced" whenever nothing was
   * queued, without ever consulting whether the last attempt actually
   * succeeded. A device pointed at the wrong server has nothing to send, fails
   * every pull, and reported Synced the whole time — the one state the
   * indicator exists to rule out. "Offline" is deliberately not reused here: it
   * means there is no network, which is normal and expected in a building with
   * no coverage, whereas this is a request that reached *something* and got an
   * answer the app could not use.
   */
  if (status.error) {
    return { label: "Not syncing", Icon: WarningIcon, tone: "bg-white/15 text-white" };
  }
  return { label: "Synced", Icon: CheckIcon, tone: "bg-white/15 text-white" };
}

function SyncPanel({ onClose }: { onClose: () => void }) {
  const status = useSyncStatus();
  const { pending } = usePendingQueue();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setMessage(null);
    try {
      await login(password);
      setPassword("");
      setMessage("Signed in. Syncing now.");
      syncEngine.requestSync();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute right-0 top-full mt-2 w-72 z-50 card p-4 text-text">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-body-md font-semibold text-primary">Sync</p>
          <p className="text-body-md text-text-muted">
            {pending === 0
              ? status.error
                ? "Nothing is waiting to be sent, but the last sync did not succeed."
                : "Everything on this device has reached the server."
              : `${pending} ${pending === 1 ? "change is" : "changes are"} waiting to be sent.`}
          </p>
          {/* The reason, in words. It names a cause the person reading it can
              act on — a wrong API address is a deploy setting, not something
              the device can retry its way out of. Local data is untouched
              either way (SPEC 5.5), which is why this informs rather than
              alarms. */}
          {status.error && (
            <p className="text-body-md text-alert-text mt-2">{status.error}</p>
          )}
          {status.lastSyncAt && (
            <p className="data-label mt-2">Last synced {new Date(status.lastSyncAt).toLocaleTimeString()}</p>
          )}
        </div>
        <button type="button" onClick={onClose} className="data-label px-2 py-1">
          Close
        </button>
      </div>

      {/* SPEC 8 — an expired session never wipes local data; it just asks for a
          password the next time the app reaches the server. */}
      <div className="mt-4 border-t border-border pt-3">
        <label className="data-label block mb-1" htmlFor="sync-password">
          Password
        </label>
        <input
          id="sync-password"
          type="password"
          className="field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button
          type="button"
          className="btn-secondary w-full mt-3"
          onClick={() => void signIn()}
          disabled={busy || password.length === 0}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {message && <p className="text-body-md text-text-muted mt-2">{message}</p>}
      </div>

      <button
        type="button"
        className="btn-quiet w-full mt-3"
        onClick={() => syncEngine.requestSync()}
      >
        Sync now
      </button>
    </div>
  );
}
