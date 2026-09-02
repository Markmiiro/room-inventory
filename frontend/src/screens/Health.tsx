import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { CheckIcon, PlusIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { recordHealth } from "../db/mutations";
import { activeRecords, allHealth, allSchedules } from "../db/queries";
import type { HealthRecord, HealthType, Record_, TreatmentSchedule } from "../db/types";
import { recordsWithUnknownAge } from "../domain/age";
import { typeLabel, withdrawalEnd } from "../domain/alerts";
import { daysBetween, formatDate, formatUGX, plural } from "../domain/format";
import { durationInWords, scheduleDueItems, type DueItem } from "../domain/schedules";
import { useLiveQuery } from "../sync/useSync";

const TYPES: HealthType[] = ["vaccination", "deworming", "treatment", "vitamin", "other"];

/**
 * One row of the Due list, from either source.
 *
 * A hand-typed `next_due` and a schedule-derived date are the same thing to the
 * person reading the screen — something that needs doing, on a day. They differ
 * only in where the date came from, which is what `schedule` records and what
 * the chip says out loud (SPEC 13.6).
 */
interface DueRow {
  key: string;
  recordId: string;
  title: string;
  subtitle: string;
  days: number;
  /** Null for a hand-typed due date. */
  schedule: TreatmentSchedule | null;
  /** Present on scheduled rows, so logging one can carry the schedule through. */
  item?: DueItem;
}

/**
 * Health — what is due, and what has been given.
 *
 * "Due" reads the same `next_due` dates the alert rules read, so an animal that
 * is overdue here is overdue on Alerts too. What this screen adds is the way to
 * act on it: logging a treatment is the only thing that clears one.
 */
export function HealthScreen() {
  const records = useLiveQuery(activeRecords, [], [] as Record_[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);
  const schedules = useLiveQuery(allSchedules, [], [] as TreatmentSchedule[]);
  const [tab, setTab] = useState<"due" | "history">("due");
  const [logging, setLogging] = useState<{ record: Record_; from?: DueItem } | null>(null);
  const [picking, setPicking] = useState(false);

  const byRecord = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const today = todayInEAT();

  /**
   * Due comes from two places and is shown as one list.
   *
   * SPEC 13.6 — scheduled items "appear alongside manually-dated ones, each
   * carrying a small chip naming its schedule so it is clear where the date
   * came from". A farm partway through adopting schedules has both kinds at
   * once, and splitting them into two lists would make the user check two
   * places for one question.
   *
   * The rules themselves are in `domain/schedules.ts`, not here — the Alerts
   * screen, the record detail and the calendar read exactly the same answers.
   */
  const due = useMemo<DueRow[]>(() => {
    const manual: DueRow[] = health
      .filter((h) => h.next_due && byRecord.has(h.record_id))
      .map((h) => ({
        key: `manual:${h.id}`,
        recordId: h.record_id,
        title: h.product ?? typeLabel(h.type),
        subtitle: `${typeLabel(h.type)}${h.dose ? ` \u00b7 ${h.dose}` : ""}`,
        days: daysBetween(today, h.next_due!),
        schedule: null,
      }));

    const scheduled: DueRow[] = scheduleDueItems({
      records,
      schedules,
      health,
      today,
    }).map((item) => ({
      key: `scheduled:${item.id}`,
      recordId: item.record.id,
      title: item.schedule.default_product ?? item.schedule.name,
      subtitle: `${typeLabel(item.schedule.type)}${
        item.lastGiven ? ` \u00b7 last given ${formatDate(item.lastGiven.date)}` : " \u00b7 first dose"
      }`,
      days: item.days,
      schedule: item.schedule,
      item,
    }));

    return [...manual, ...scheduled].sort((a, b) => a.days - b.days);
  }, [health, records, schedules, byRecord, today]);

  const overdue = due.filter((d) => d.days < 0);
  const thisWeek = due.filter((d) => d.days >= 0 && d.days <= 7);
  const later = due.filter((d) => d.days > 7);

  // SPEC 13.4 — the records no schedule can reach. Named on the screen whose
  // job is "what is due", because their absence from that list is exactly the
  // silent failure the spec is warning about.
  const ageUnknown = useMemo(() => recordsWithUnknownAge(records), [records]);

  const history = useMemo(
    () => [...health].sort((a, b) => b.date.localeCompare(a.date)),
    [health],
  );

  return (
    <div className="pb-40 md:pb-24">
      <div className="flex border-b border-border" role="tablist">
        <Tab active={tab === "due"} onClick={() => setTab("due")}>
          Due{due.length > 0 && ` · ${due.length}`}
        </Tab>
        <Tab active={tab === "history"} onClick={() => setTab("history")}>
          History{history.length > 0 && ` · ${history.length}`}
        </Tab>
      </div>

      {tab === "due" && ageUnknown.length > 0 && <AgeUnknownNotice records={ageUnknown} />}

      {tab === "due" ? (
        due.length === 0 ? (
          <Empty>
            Nothing is due. Treatments appear here from a schedule, or once one is
            logged with a next due date by hand.
          </Empty>
        ) : (
          <>
            <DueSection
              title="Overdue"
              urgent
              rows={overdue}
              byRecord={byRecord}
              onLog={setLogging}
            />
            <DueSection title="This week" rows={thisWeek} byRecord={byRecord} onLog={setLogging} />
            <DueSection title="Later" rows={later} byRecord={byRecord} onLog={setLogging} />
          </>
        )
      ) : history.length === 0 ? (
        <Empty>Nothing has been logged yet.</Empty>
      ) : (
        <ul className="mt-4 grid gap-2 md:grid-cols-2">
          {history.map((treatment) => (
            <li key={treatment.id}>
              <HistoryCard treatment={treatment} record={byRecord.get(treatment.record_id)} today={today} />
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        aria-label="Log a treatment"
        className="btn-action fixed right-4 bottom-24 md:bottom-8 z-30 h-14 w-14 !px-0 rounded-xl"
        onClick={() => setPicking(true)}
      >
        <PlusIcon className="w-7 h-7" />
      </button>

      {picking && (
        <PickRecordDialog
          records={records}
          onClose={() => setPicking(false)}
          onPick={(record) => {
            setPicking(false);
            // Picked cold, so no schedule: an ad-hoc treatment (SPEC 13.3).
            setLogging({ record });
          }}
        />
      )}
      {logging && (
        <LogTreatmentDialog
          record={logging.record}
          from={logging.from}
          onClose={() => setLogging(null)}
        />
      )}
    </div>
  );
}

function DueSection({
  title,
  urgent,
  rows,
  byRecord,
  onLog,
}: {
  title: string;
  urgent?: boolean;
  rows: DueRow[];
  byRecord: Map<string, Record_>;
  onLog: (target: { record: Record_; from?: DueItem }) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className={`text-headline-sm flex items-center gap-2 ${urgent ? "text-alert" : "text-primary"}`}>
        {urgent && <WarningIcon className="w-5 h-5" />}
        {title}
      </h2>
      <ul className="mt-2 grid gap-2 md:grid-cols-2">
        {rows.map((row) => {
          const record = byRecord.get(row.recordId);
          const { days } = row;
          return (
            <li key={row.key}>
              <div className={`card border-l-4 p-4 h-full ${urgent ? "border-alert" : "border-action"}`}>
                <p className="flex flex-wrap items-center gap-2">
                  <Link to={`/records/${row.recordId}`} className="data-value font-bold underline">
                    {record?.tag ?? "A record"}
                  </Link>
                  <span
                    className={`chip ${urgent ? "bg-alert-bg text-alert-text" : "bg-success text-success-text"}`}
                  >
                    {days < 0
                      ? `${-days} ${plural(-days, "day")} overdue`
                      : days === 0
                        ? "Due today"
                        : `Due in ${days} ${plural(days, "day")}`}
                  </span>
                  {/* SPEC 13.6 — where the date came from, in words. Without it
                      a schedule-derived date is indistinguishable from one
                      somebody typed, and only one of the two can be corrected
                      by editing the treatment. */}
                  {row.schedule && (
                    <span className="chip bg-background text-text-muted border border-border">
                      From {row.schedule.name}
                    </span>
                  )}
                </p>
                <p className="text-body-lg font-semibold mt-1">{row.title}</p>
                <p className="text-body-md text-text-muted">{row.subtitle}</p>
                {record && (
                  <button
                    type="button"
                    className="btn-secondary w-full mt-3"
                    onClick={() => onLog({ record, from: row.item })}
                  >
                    Log it
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * SPEC 13.4 — the records that fire no schedule, said plainly.
 *
 * This sits above the Due list rather than inside it, because these records
 * have nothing due — that is the problem. Putting them in the list would mean
 * inventing a date for them, which 13.4 forbids in as many words.
 */
function AgeUnknownNotice({ records }: { records: Record_[] }) {
  const animals = records.filter((r) => r.kind === "animal").length;
  const groups = records.length - animals;

  return (
    <div className="card border-l-4 border-action p-4 mt-4">
      <p className="text-body-lg font-semibold">
        {records.length} {plural(records.length, "record")} cannot be scheduled
      </p>
      <p className="text-body-md text-text-muted mt-1">
        {animals > 0 &&
          `${animals} ${plural(animals, "animal")} ${animals === 1 ? "has" : "have"} no date of birth`}
        {animals > 0 && groups > 0 && ", and "}
        {groups > 0 &&
          `${groups} ${plural(groups, "group")} ${groups === 1 ? "has" : "have"} no arrival date`}
        . Without one their age cannot be worked out, so no schedule runs for them.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {records.slice(0, 12).map((record) => (
          <li key={record.id}>
            <Link
              to={`/records/${record.id}`}
              className="chip bg-background text-text border border-border underline"
            >
              {record.tag}
            </Link>
          </li>
        ))}
        {records.length > 12 && (
          <li className="chip text-text-muted">and {records.length - 12} more</li>
        )}
      </ul>
    </div>
  );
}

function HistoryCard({
  treatment,
  record,
  today,
}: {
  treatment: HealthRecord;
  record: Record_ | undefined;
  today: string;
}) {
  const end = withdrawalEnd(treatment);
  const withdrawing = end !== null && end >= today;

  return (
    <div className="card p-4 h-full">
      <div className="flex items-center justify-between gap-3">
        <Link to={`/records/${treatment.record_id}`} className="data-value font-bold truncate underline">
          {record?.tag ?? "A record"}
        </Link>
        <span className="data-label shrink-0">{formatDate(treatment.date)}</span>
      </div>
      <p className="text-body-lg font-semibold mt-1">
        {treatment.product ?? typeLabel(treatment.type)}
      </p>
      <p className="text-body-md text-text-muted">
        {typeLabel(treatment.type)}
        {treatment.dose ? ` · ${treatment.dose}` : ""}
        {treatment.cost != null ? ` · ${formatUGX(treatment.cost)}` : ""}
      </p>
      {withdrawing && (
        // SPEC 6.6 — this is what a sale has to warn about, so it is stated
        // wherever the treatment is shown.
        <p className="mt-2 rounded-lg bg-alert-bg text-alert-text text-body-md p-2">
          Withdrawal until {formatDate(end!)}. Selling before then needs confirming.
        </p>
      )}
      {treatment.notes && <p className="text-body-md mt-2 whitespace-pre-wrap">{treatment.notes}</p>}
    </div>
  );
}

function PickRecordDialog({
  records,
  onClose,
  onPick,
}: {
  records: Record_[];
  onClose: () => void;
  onPick: (record: Record_) => void;
}) {
  const [search, setSearch] = useState("");
  const matches = records
    .filter((r) => r.tag.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 50);

  return (
    <Dialog label="Choose what to treat" onClose={onClose}>
      <h2 className="text-headline-sm text-primary">Who is being treated?</h2>
      <input
        className="field mt-4"
        placeholder="Search by tag"
        value={search}
        autoFocus
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="mt-3 flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
        {matches.map((record) => (
          <li key={record.id}>
            <button
              type="button"
              className="card w-full text-left p-3 min-h-row"
              onClick={() => onPick(record)}
            >
              <span className="data-value font-bold">{record.tag}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && (
          <li className="text-body-md text-text-muted p-3">Nothing matches that search.</li>
        )}
      </ul>
      <button type="button" className="btn-quiet w-full mt-4" onClick={onClose}>
        Cancel
      </button>
    </Dialog>
  );
}

/**
 * Log a treatment, optionally against the schedule it satisfies.
 *
 * `from` is the due item this was opened from. When it is present the schedule
 * pre-fills the form and — the part that matters — the saved treatment carries
 * `schedule_id`. That is the whole mechanism behind SPEC 13.3's interval rule:
 * the next dose is counted forward from the `date` typed here, so a treatment
 * given early moves the next one earlier by exactly as much.
 *
 * Opened without `from`, nothing is stamped and the schedule is untouched. A
 * sick animal dewormed out of turn must not silently reset the herd's plan.
 */
function LogTreatmentDialog({
  record,
  from,
  onClose,
}: {
  record: Record_;
  from?: DueItem;
  onClose: () => void;
}) {
  const schedule = from?.schedule ?? null;
  const [type, setType] = useState<HealthType>(schedule?.type ?? "vaccination");
  const [product, setProduct] = useState(schedule?.default_product ?? "");
  const [dose, setDose] = useState("");
  const [date, setDate] = useState(todayInEAT());
  const [nextDue, setNextDue] = useState("");
  const [withdrawal, setWithdrawal] = useState(
    schedule?.default_withdrawal_days == null ? "" : String(schedule.default_withdrawal_days),
  );
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const today = todayInEAT();
    // SPEC 6.8 — a treatment cannot be dated in the future, and `next_due`
    // must be.
    if (date > today) return setError("A treatment cannot be dated in the future.");
    if (nextDue && nextDue <= today) return setError("A next due date has to be in the future.");

    const days = withdrawal.trim() === "" ? null : Number(withdrawal);
    if (days !== null && (!Number.isInteger(days) || days < 0)) {
      return setError("Withdrawal must be a whole number of days, or left blank.");
    }

    const shillings = cost.trim() === "" ? null : Number(cost.replace(/[,\s]/g, ""));
    if (shillings !== null && (!Number.isFinite(shillings) || shillings < 0)) {
      return setError("A cost must be a whole number of shillings, or left blank.");
    }

    await recordHealth({
      record_id: record.id,
      type,
      product: product || null,
      dose: dose || null,
      date,
      next_due: nextDue || null,
      withdrawal_days: days,
      cost: shillings,
      notes: notes || null,
      // The link back to the rule. Null when this was not opened from a due
      // item, which is what keeps an ad-hoc dose out of the schedule (SPEC 13.3).
      schedule_id: schedule?.id ?? null,
    });
    onClose();
  }

  return (
    <Dialog label="Log a treatment" onClose={onClose}>
      <h2 className="text-headline-sm text-primary">Treat {record.tag}</h2>

      {schedule && (
        <p className="mt-3 rounded-lg bg-background text-body-md p-3">
          Against <span className="font-semibold">{schedule.name}</span>.{" "}
          {schedule.repeat_every_days == null
            ? "This schedule does not repeat, so nothing further will become due."
            : `The next one is counted from the day you enter below, not from the day it was planned \u2014 so ${durationInWords(
                schedule.repeat_every_days,
              )} after that date.`}
        </p>
      )}

      <fieldset className="mt-4">
        <legend className="data-label mb-2">Type</legend>
        <div className="flex flex-wrap gap-2">
          {TYPES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setType(option)}
              className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                type === option
                  ? "bg-primary-container text-white border-primary-container"
                  : "bg-card text-text border-border"
              }`}
            >
              {type === option && <CheckIcon className="w-4 h-4" />}
              {typeLabel(option)}
            </button>
          ))}
        </div>
      </fieldset>

      <Labelled label="Product" htmlFor="hr-product">
        <input id="hr-product" className="field" value={product} placeholder="FMD vaccine"
          onChange={(e) => setProduct(e.target.value)} />
      </Labelled>
      <Labelled label="Dose" htmlFor="hr-dose">
        <input id="hr-dose" className="field" value={dose} placeholder="2ml"
          onChange={(e) => setDose(e.target.value)} />
      </Labelled>
      <Labelled label="Given on" htmlFor="hr-date">
        <input id="hr-date" type="date" className="field font-mono" value={date}
          max={todayInEAT()} onChange={(e) => setDate(e.target.value)} />
      </Labelled>
      <Labelled label="Next due" htmlFor="hr-next" hint="Leave blank if it does not repeat.">
        <input id="hr-next" type="date" className="field font-mono" value={nextDue}
          onChange={(e) => setNextDue(e.target.value)} />
      </Labelled>
      <Labelled
        label="Withdrawal (days)"
        htmlFor="hr-withdrawal"
        hint="Selling inside this period will warn, not block."
      >
        <input id="hr-withdrawal" className="field font-mono" value={withdrawal} inputMode="numeric"
          onChange={(e) => setWithdrawal(e.target.value)} />
      </Labelled>
      <Labelled label="Cost (UGX)" htmlFor="hr-cost">
        <input id="hr-cost" className="field font-mono" value={cost} inputMode="numeric"
          onChange={(e) => setCost(e.target.value)} />
      </Labelled>
      <Labelled label="Notes" htmlFor="hr-notes">
        <textarea id="hr-notes" className="field h-auto py-3" rows={2} value={notes}
          onChange={(e) => setNotes(e.target.value)} />
      </Labelled>

      {error && <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>}

      <div className="mt-6 flex gap-3">
        <button type="button" className="btn-quiet flex-1" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-secondary flex-1" onClick={() => void save()}>Log it</button>
      </div>
    </Dialog>
  );
}

function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-4 sm:p-6 max-h-[92vh] overflow-y-auto"
        role="dialog"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Labelled({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <label className="data-label block mb-1" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 min-h-touch md:min-h-touch-desktop text-headline-sm border-b-2 -mb-px ${
        active ? "border-primary text-primary" : "border-transparent text-text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="card p-6 mt-4 text-body-md text-text-muted text-center">{children}</p>;
}
