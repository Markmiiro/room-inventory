import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import {
  AnimalsIcon,
  CheckIcon,
  ChevronIcon,
  MoneyIcon,
  RoomsIcon,
  WarningIcon,
} from "../components/Icons";
import {
  BackupRejected,
  daysSinceBackup,
  lastBackupAt,
  parseBackup,
  restoreBackup,
  summarise,
  type Backup,
  type ImportSummary,
} from "../db/backup";
import { runBackup } from "../db/backup";
import { useAlerts } from "../db/useAlerts";
import { formatDate } from "../domain/format";

/** SPEC 10 — "Confirm the host's backups are actually enabled — do not assume."
 *  A week is the point past which this device's copy stops being reassuring. */
const STALE_AFTER_DAYS = 7;

/**
 * More.
 *
 * SPEC 11 fixes the bottom bar at five destinations, so this is where the
 * screens that are not one of them are reached from: Alerts and Health, the
 * things that get configured, and the export.
 *
 * The mockup calls rooms "inventory zones". "Zone" is banned vocabulary
 * (SPEC 2) — they are rooms here, as everywhere else.
 */
export function MoreScreen() {
  const alerts = useAlerts();
  const urgent = alerts.filter((a) => a.priority === "urgent").length;

  return (
    <div className="pb-8 max-w-3xl">
      <Group title="Needs you">
        <Row
          to="/alerts"
          // A warning triangle beside "Nothing needs attention" says the
          // opposite of the words next to it.
          Icon={urgent > 0 ? WarningIcon : CheckIcon}
          title="Alerts"
          detail={
            alerts.length === 0
              ? "Nothing needs attention"
              : `${alerts.length} open${urgent > 0 ? `, ${urgent} urgent` : ""}`
          }
          urgent={urgent > 0}
        />
        <Row
          to="/health"
          Icon={AnimalsIcon}
          title="Health"
          detail="Treatments due, and everything given"
        />
        <Row
          to="/visits"
          title="Vet visits"
          detail="Call-outs and planned visits, and what they cost"
        />
      </Group>

      <Group title="Configuration">
        <Row to="/" Icon={RoomsIcon} title="Manage rooms" detail="Add or rename the ten rooms" />
        <Row
          to="/schedules"
          Icon={AnimalsIcon}
          title="Manage schedules"
          detail="Which treatments are due, and when"
        />
        <Row
          to="/categories"
          Icon={MoneyIcon}
          title="Expense categories"
          detail="Your own labels — the app ships with none"
        />
      </Group>

      <Group title="Contacts">
        {/* No icon: there is no honest one in the set for either of these, and
            TOKENS.md is clear that a wrong icon is worse than none. */}
        <Row to="/customers" title="Customers" detail="Who animals were sold to" />
        <Row to="/vets" title="Vets" detail="Who treated them" />
      </Group>

      <Group title="Data">
        <BackupRow />
        <RestoreRow />
      </Group>
    </div>
  );
}

function BackupRow() {
  const [days, setDays] = useState<number | null | undefined>(undefined);
  const [taken, setTaken] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function refresh() {
    setDays(await daysSinceBackup());
    setTaken(await lastBackupAt());
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Never backed up, or backed up too long ago: both read in red, in words.
  const never = days === null;
  const stale = days !== null && days !== undefined && days > STALE_AFTER_DAYS;
  const warn = never || stale;

  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <span className={`shrink-0 mt-0.5 ${warn ? "text-alert" : "text-success-text"}`}>
          {warn ? <WarningIcon className="w-6 h-6" /> : <CheckIcon className="w-6 h-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body-lg font-semibold">Back up and export</p>
          {days === undefined ? (
            <p className="text-body-md text-text-muted">Checking…</p>
          ) : never ? (
            <p className="text-body-md font-semibold text-alert">
              Never backed up. Everything recorded offline lives only on this device
              until it syncs.
            </p>
          ) : (
            <p
              className={`text-body-md ${stale ? "font-semibold text-alert" : "text-text-muted"}`}
            >
              Last backup {formatDate(taken!.slice(0, 10))} ({days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} ago`})
              {stale && " — longer than a week"}
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        className="btn-action w-full mt-3"
        disabled={running}
        onClick={async () => {
          setRunning(true);
          try {
            await runBackup();
            await refresh();
          } finally {
            setRunning(false);
          }
        }}
      >
        {running ? "Exporting…" : "Run backup"}
      </button>
      <p className="text-body-md text-text-muted mt-2">
        Saves every record on this device as one file, including changes that have
        not reached the server yet.
      </p>
    </div>
  );
}

/**
 * Restore from a file.
 *
 * SPEC 7 — an import replaces all data, behind an explicit confirmation. So the
 * file is read and validated first, the confirmation says what it is about to
 * destroy and what it is about to write, and the button that does it is not the
 * one that picked the file.
 */
function RestoreRow() {
  const [pending, setPending] = useState<{ backup: Backup; summary: ImportSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportSummary | null>(null);

  async function choose(file: File) {
    setError(null);
    setDone(null);
    try {
      const backup = parseBackup(await file.text());
      setPending({ backup, summary: summarise(backup) });
    } catch (cause) {
      setPending(null);
      setError(
        cause instanceof BackupRejected
          ? cause.message
          : "That file could not be read. Nothing has been changed.",
      );
    }
  }

  return (
    <div className="p-4">
      <p className="text-body-lg font-semibold">Restore from a backup</p>
      <p className="text-body-md text-text-muted mt-1">
        Replaces everything on this device with the contents of the file. There is
        no undo.
      </p>

      <label className="btn-quiet w-full mt-3 cursor-pointer">
        Choose a backup file
        <input
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so choosing the same file twice still fires.
            e.target.value = "";
            if (file) void choose(file);
          }}
        />
      </label>

      {error && (
        <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
      )}

      {done && (
        <p className="mt-3 rounded-lg bg-success text-success-text text-body-md p-3">
          Restored {done.total} rows from the backup taken {formatDate(done.taken_at.slice(0, 10))}.
        </p>
      )}

      {pending && (
        <div className="mt-3 rounded-xl bg-alert-bg border-l-4 border-alert p-4">
          <p className="text-body-lg font-semibold text-alert-text">
            This will erase everything on this device
          </p>
          <p className="text-body-md text-alert-text mt-1">
            Every room, record, move, treatment, sale and expense here is deleted and
            replaced with the {pending.summary.total} rows in this file, taken{" "}
            {formatDate(pending.summary.taken_at.slice(0, 10))}. Anything on this device
            that has not synced yet is lost.
          </p>
          <ul className="mt-2 text-body-md text-alert-text">
            {Object.entries(pending.summary.rows).map(([table, count]) => (
              <li key={table}>
                {count} {table}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-3">
            <button type="button" className="btn-quiet flex-1" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={async () => {
                const summary = await restoreBackup(pending.backup);
                setPending(null);
                setDone(summary);
              }}
            >
              Erase and restore
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="data-label">{title}</h2>
      <div className="card mt-2 divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({
  to,
  Icon,
  title,
  detail,
  urgent,
}: {
  to: string;
  Icon?: (props: { className?: string }) => JSX.Element;
  title: string;
  detail: string;
  urgent?: boolean;
}) {
  return (
    <Link to={to} className="flex items-center gap-3 p-4 min-h-row">
      {Icon && <Icon className={`w-6 h-6 shrink-0 ${urgent ? "text-alert" : "text-primary"}`} />}
      <span className="min-w-0 flex-1">
        <span className="block text-body-lg font-semibold">{title}</span>
        <span className={`block text-body-md ${urgent ? "text-alert font-semibold" : "text-text-muted"}`}>
          {detail}
        </span>
      </span>
      <ChevronIcon className="w-5 h-5 text-text-muted shrink-0" />
    </Link>
  );
}
