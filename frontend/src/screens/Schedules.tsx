import { useMemo, useState, type ReactNode } from "react";

import { CheckIcon, PlusIcon } from "../components/Icons";
import { createSchedule, updateSchedule, type ScheduleInput } from "../db/mutations";
import { activeRecords, allSchedules } from "../db/queries";
import type {
  HealthType,
  Record_,
  ScheduleAppliesTo,
  ScheduleSpecies,
  TreatmentSchedule,
} from "../db/types";
import { typeLabel } from "../domain/alerts";
import { plural } from "../domain/format";
import { recordsCovered, timingInWords } from "../domain/schedules";
import { speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

const SPECIES_OPTIONS: ScheduleSpecies[] = ["all", "cattle", "goats", "sheep", "pigs", "poultry"];
const TYPES: HealthType[] = ["vaccination", "deworming", "treatment", "vitamin", "other"];

const APPLIES_LABEL: Record<ScheduleAppliesTo, string> = {
  animals: "Single animals only",
  groups: "Groups only",
  both: "Animals and groups",
};

function speciesHeading(species: ScheduleSpecies): string {
  return species === "all" ? "Every species" : speciesLabel(species);
}

/**
 * Manage schedules — SPEC 13.6.
 *
 * A schedule is a rule the app applies on the user's behalf, without asking,
 * to every animal it fits. That is the whole value of the feature and also the
 * reason this screen exists rather than the seeded set being fixed: a rule
 * nobody can inspect or change is a rule nobody should trust with an animal.
 *
 * Two things are therefore non-negotiable here. The veterinary-advice note sits
 * at the top, before any schedule is read, because the seeded intervals are
 * suggestions and the app must say so. And every row states its timing in
 * words — "First at 4 months, then every 6 months" — because "120 / 180" is not
 * something anyone can check against what their vet told them.
 */
export function SchedulesScreen() {
  const schedules = useLiveQuery(allSchedules, [], [] as TreatmentSchedule[]);
  const records = useLiveQuery(activeRecords, [], [] as Record_[]);

  const [editing, setEditing] = useState<TreatmentSchedule | null>(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const active = schedules.filter((s) => s.is_active);
  const archived = schedules.filter((s) => !s.is_active);
  const shown = showArchived ? schedules : active;

  // Grouped by species, in the order the species filter uses everywhere else,
  // so a schedule sits where the user already looks for that species.
  const groups = useMemo(() => {
    const bySpecies = new Map<ScheduleSpecies, TreatmentSchedule[]>();
    for (const schedule of shown) {
      const list = bySpecies.get(schedule.species) ?? [];
      list.push(schedule);
      bySpecies.set(schedule.species, list);
    }
    return SPECIES_OPTIONS.filter((s) => bySpecies.has(s)).map(
      (s) => [s, bySpecies.get(s)!] as [ScheduleSpecies, TreatmentSchedule[]],
    );
  }, [shown]);

  return (
    <div className="pb-40 md:pb-24">
      {/* SPEC 13.5 — shown before anything else on the screen, not tucked under
          the list. It is the one line that stops a seeded interval reading as
          an instruction from the app. */}
      <p className="card border-l-4 border-action p-4 text-body-md">
        These are starting suggestions. Check them against your vet&rsquo;s advice for
        your area.
      </p>

      {schedules.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          No schedules yet. Add one below and it will apply to every record it fits.
        </p>
      ) : (
        groups.map(([species, list]) => (
          <section key={species} className="mt-6">
            <h2 className="text-headline-sm text-primary">{speciesHeading(species)}</h2>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {list.map((schedule) => (
                <li key={schedule.id}>
                  <ScheduleCard
                    schedule={schedule}
                    covered={recordsCovered(schedule, records).length}
                    onEdit={() => setEditing(schedule)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {archived.length > 0 && (
        <button
          type="button"
          className="btn-quiet w-full mt-4"
          onClick={() => setShowArchived((on) => !on)}
        >
          {showArchived
            ? "Hide archived"
            : `Show ${archived.length} archived ${plural(archived.length, "schedule")}`}
        </button>
      )}

      <button
        type="button"
        aria-label="Add a schedule"
        className="btn-action fixed right-4 bottom-24 md:bottom-8 z-30 h-14 w-14 !px-0 rounded-xl"
        onClick={() => setAdding(true)}
      >
        <PlusIcon className="w-7 h-7" />
      </button>

      {adding && <ScheduleDialog onClose={() => setAdding(false)} />}
      {editing && (
        <ScheduleDialog schedule={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function ScheduleCard({
  schedule,
  covered,
  onEdit,
}: {
  schedule: TreatmentSchedule;
  covered: number;
  onEdit: () => void;
}) {
  return (
    <div className={`card p-4 h-full ${schedule.is_active ? "" : "opacity-70"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-body-lg font-semibold">{schedule.name}</p>
        {!schedule.is_active && (
          <span className="chip shrink-0 bg-background text-text-muted border border-border">
            Archived
          </span>
        )}
      </div>
      <p className="text-body-md text-text-muted mt-1">
        {typeLabel(schedule.type)} · {APPLIES_LABEL[schedule.applies_to]}
      </p>

      {/* SPEC 13.6 — the timing in words, on every row. */}
      <p className="text-body-md mt-2">{timingInWords(schedule)}</p>

      <p className="data-label mt-2">
        {schedule.is_active
          ? `Applies to ${covered} active ${plural(covered, "record")}`
          : "Not applied while archived"}
      </p>

      {schedule.default_product && (
        <p className="text-body-md text-text-muted mt-1">
          Pre-fills {schedule.default_product}
          {schedule.default_withdrawal_days != null &&
            `, ${schedule.default_withdrawal_days} ${plural(schedule.default_withdrawal_days, "day")} withdrawal`}
        </p>
      )}
      {schedule.notes && <p className="text-body-md mt-2 whitespace-pre-wrap">{schedule.notes}</p>}

      <button type="button" className="btn-quiet w-full mt-3" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}

/**
 * Add or edit one schedule.
 *
 * Timing is typed in days, and the form echoes back what those days mean in
 * words as they are typed. Offering months as a unit would need the app to
 * decide how long a month is, and the answer would then differ from the number
 * stored — better to be plain about the unit and translate it out loud.
 */
function ScheduleDialog({
  schedule,
  onClose,
}: {
  schedule?: TreatmentSchedule;
  onClose: () => void;
}) {
  const editing = schedule !== undefined;

  const [name, setName] = useState(schedule?.name ?? "");
  const [species, setSpecies] = useState<ScheduleSpecies>(schedule?.species ?? "cattle");
  const [type, setType] = useState<HealthType>(schedule?.type ?? "vaccination");
  const [firstDue, setFirstDue] = useState(
    schedule?.first_due_age_days == null ? "" : String(schedule.first_due_age_days),
  );
  const [repeat, setRepeat] = useState(
    schedule?.repeat_every_days == null ? "" : String(schedule.repeat_every_days),
  );
  const [appliesTo, setAppliesTo] = useState<ScheduleAppliesTo>(schedule?.applies_to ?? "both");
  const [product, setProduct] = useState(schedule?.default_product ?? "");
  const [withdrawal, setWithdrawal] = useState(
    schedule?.default_withdrawal_days == null ? "" : String(schedule.default_withdrawal_days),
  );
  const [notes, setNotes] = useState(schedule?.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(
    () =>
      timingInWords({
        first_due_age_days: wholeOrNull(firstDue),
        repeat_every_days: wholeOrNull(repeat),
      } as TreatmentSchedule),
    [firstDue, repeat],
  );

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return setError("A schedule needs a name.");

    const first = wholeOrNull(firstDue);
    const every = wholeOrNull(repeat);
    if (firstDue.trim() !== "" && first === null) {
      return setError("First due must be a whole number of days, or left blank.");
    }
    if (repeat.trim() !== "" && every === null) {
      return setError("Repeat must be a whole number of days, or left blank.");
    }
    // A schedule with neither is not a schedule: it can never become due, and
    // saving it would look like it had been set up when it had not.
    if (first === null && every === null) {
      return setError(
        "A schedule needs a first due age, a repeat interval, or both. Without one it never becomes due.",
      );
    }

    const days = wholeOrNull(withdrawal);
    if (withdrawal.trim() !== "" && days === null) {
      return setError("Withdrawal must be a whole number of days, or left blank.");
    }

    const fields: ScheduleInput = {
      name: trimmed,
      species,
      type,
      first_due_age_days: first,
      repeat_every_days: every,
      applies_to: appliesTo,
      default_product: product.trim() || null,
      default_withdrawal_days: days,
      notes: notes.trim() || null,
    };

    if (editing) {
      await updateSchedule(schedule.id, fields);
    } else {
      await createSchedule(fields);
    }
    onClose();
  }

  /** SPEC 13.5 — archived, never deleted, so the treatments already given
   *  against this schedule keep naming it. */
  async function toggleArchived() {
    if (!editing) return;
    await updateSchedule(schedule.id, { is_active: !schedule.is_active });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-4 sm:p-6 max-h-[92vh] overflow-y-auto"
        role="dialog"
        aria-label={editing ? "Edit schedule" : "Add a schedule"}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-headline-sm text-primary">
          {editing ? `Edit ${schedule.name}` : "Add a schedule"}
        </h2>

        <Labelled label="Name" htmlFor="sc-name">
          <input
            id="sc-name" className="field" value={name} placeholder="Foot and mouth vaccination"
            onChange={(e) => setName(e.target.value)}
          />
        </Labelled>

        <fieldset className="mt-4">
          <legend className="data-label mb-2">Species</legend>
          <div className="flex flex-wrap gap-2">
            {SPECIES_OPTIONS.map((option) => (
              <Chip key={option} active={species === option} onClick={() => setSpecies(option)}>
                {option === "all" ? "All species" : speciesLabel(option)}
              </Chip>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="data-label mb-2">Type</legend>
          <div className="flex flex-wrap gap-2">
            {TYPES.map((option) => (
              <Chip key={option} active={type === option} onClick={() => setType(option)}>
                {typeLabel(option)}
              </Chip>
            ))}
          </div>
        </fieldset>

        <Labelled
          label="First due (days after birth or arrival)"
          htmlFor="sc-first"
          hint="Leave blank for a schedule that only repeats."
        >
          <input
            id="sc-first" className="field font-mono" value={firstDue} inputMode="numeric"
            onChange={(e) => setFirstDue(e.target.value)}
          />
        </Labelled>

        <Labelled
          label="Repeat every (days)"
          htmlFor="sc-repeat"
          hint="Leave blank for a one-off dose."
        >
          <input
            id="sc-repeat" className="field font-mono" value={repeat} inputMode="numeric"
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Labelled>

        {/* The days said back in words, so what was typed can be checked
            against what the vet actually said (SPEC 13.6). */}
        <p className="mt-2 rounded-lg bg-background text-body-md p-3">{preview}</p>

        <fieldset className="mt-4">
          <legend className="data-label mb-2">Applies to</legend>
          <div className="flex flex-wrap gap-2">
            {(["both", "animals", "groups"] as ScheduleAppliesTo[]).map((option) => (
              <Chip key={option} active={appliesTo === option} onClick={() => setAppliesTo(option)}>
                {APPLIES_LABEL[option]}
              </Chip>
            ))}
          </div>
        </fieldset>

        <Labelled label="Default product" htmlFor="sc-product" hint="Pre-fills the treatment form.">
          <input
            id="sc-product" className="field" value={product} placeholder="FMD vaccine"
            onChange={(e) => setProduct(e.target.value)}
          />
        </Labelled>

        <Labelled label="Default withdrawal (days)" htmlFor="sc-withdrawal">
          <input
            id="sc-withdrawal" className="field font-mono" value={withdrawal} inputMode="numeric"
            onChange={(e) => setWithdrawal(e.target.value)}
          />
        </Labelled>

        <Labelled label="Notes" htmlFor="sc-notes">
          <textarea
            id="sc-notes" className="field h-auto py-3" rows={2} value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Labelled>

        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-quiet flex-1" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-secondary flex-1" onClick={() => void save()}>
            Save
          </button>
        </div>

        {editing && (
          <>
            <button
              type="button"
              className="btn-quiet w-full mt-3"
              onClick={() => void toggleArchived()}
            >
              {schedule.is_active ? "Archive this schedule" : "Bring this schedule back"}
            </button>
            <p className="text-body-md text-text-muted mt-2">
              {schedule.is_active
                ? "Archiving stops it becoming due. The treatments already given against it keep naming it."
                : "It stops being due while archived, and nothing already recorded is affected."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** A whole non-negative number, or null for blank. Anything else is null too,
 *  and the caller distinguishes the two by looking at the raw string. */
function wholeOrNull(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function Chip({
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
      aria-pressed={active}
      onClick={onClick}
      className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
        active
          ? "bg-primary-container text-white border-primary-container"
          : "bg-card text-text border-border"
      }`}
    >
      {active && <CheckIcon className="w-4 h-4" />}
      {children}
    </button>
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
      <label className="data-label block mb-1" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
