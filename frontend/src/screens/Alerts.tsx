import { Link } from "react-router-dom";

import { CheckIcon, WarningIcon } from "../components/Icons";
import { useAlerts } from "../db/useAlerts";
import { byPriority, PRIORITY_LABEL, type Alert, type AlertPriority } from "../domain/alerts";

/**
 * Alerts — everything that needs attention, by urgency.
 *
 * The rules are in `domain/alerts.ts`, not here. This screen only arranges what
 * that module returns, which is what keeps it agreeing with the banner on Rooms
 * and the row markers on Room detail.
 *
 * Two things in `screenshots/09-alerts.png` contradict SPEC 4.6 and are not
 * reproduced: it puts a long isolation stay in Urgent at seven days, where the
 * spec says This week at fourteen; and it puts unsynced changes in Later, where
 * the spec makes unsynced work older than 48 hours Urgent. The spec wins.
 */
export function AlertsScreen() {
  const alerts = useAlerts();
  const sections = byPriority(alerts);

  if (alerts.length === 0) return <NothingNeedsAttention />;

  return (
    <div className="pb-8">
      {sections.map(([priority, list]) => (
        <section key={priority} className="mt-6 first:mt-0">
          <h2 className="data-label">
            {PRIORITY_LABEL[priority]} · {list.length}
          </h2>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {list.map((alert) => (
              <li key={alert.id}>
                <AlertCard alert={alert} priority={priority} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const ACCENT: Record<AlertPriority, string> = {
  urgent: "border-alert",
  this_week: "border-action",
  later: "border-border",
};

function AlertCard({ alert, priority }: { alert: Alert; priority: AlertPriority }) {
  return (
    <div className={`card border-l-4 p-4 h-full ${ACCENT[priority]}`}>
      <p className="flex items-start gap-2">
        {priority === "urgent" && <WarningIcon className="w-5 h-5 shrink-0 text-alert mt-0.5" />}
        <span className="text-body-lg font-semibold">{alert.title}</span>
      </p>
      <p className="text-body-md text-text-muted mt-1">{alert.detail}</p>

      {/* The alert names what to look at; the link goes there. SPEC 4.6 asks
          for the meaning in words, so the label says where it leads. */}
      <div className="mt-3 flex gap-4">
        {alert.recordId && (
          <Link to={`/records/${alert.recordId}`} className="text-body-md font-semibold text-primary underline">
            Open the record
          </Link>
        )}
        {alert.roomId && (
          <Link to={`/rooms/${alert.roomId}`} className="text-body-md font-semibold text-primary underline">
            Open the room
          </Link>
        )}
      </div>
    </div>
  );
}

/** SPEC 4.6 — a green check, the words, and a line naming what was checked, so
 *  an empty screen reads as "checked and clear" rather than "not working". */
function NothingNeedsAttention() {
  return (
    <div className="card p-6 text-center">
      <CheckIcon className="w-10 h-10 mx-auto text-success-text" />
      <p className="text-headline-sm text-primary mt-3">Nothing needs attention</p>
      <p className="text-body-md text-text-muted mt-2 max-w-md mx-auto">
        Checked room capacity, treatments due and overdue, active withdrawal periods,
        long isolation stays, duplicate tags, and changes waiting to sync.
      </p>
    </div>
  );
}
