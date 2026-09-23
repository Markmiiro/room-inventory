import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CheckIcon, SearchIcon, WarningIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { nextSequentialTags, recordBirth, type OffspringInput } from "../db/mutations";
import { allDeaths, allSales, liveRooms } from "../db/queries";
import { db } from "../db/schema";
import type { Death, Record_, Room, Sale, Sex, Vet } from "../db/types";
import {
  canBeDam,
  canBeSire,
  checkBirth,
  departureWarning,
  offspringShape,
} from "../domain/births";
import { headUnit, plural } from "../domain/format";
import { speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

/**
 * Log birth. SPEC 22.
 *
 * It has to be quick, because it is used standing next to a cow that has just
 * calved: the dam, the date, how many were born, how many survived, then the
 * offspring. Everything else on the form has a default that is right most of
 * the time — today's date, the dam's species and breed, her room — and the
 * offspring tags are suggested from her own tag rather than typed.
 *
 * The screen owns the bottom of the display, so it is a FOCUSED_ROUTE in
 * `App.tsx` and its action bar replaces the navigation rather than stacking
 * with it.
 *
 * What it writes is one transaction in `recordBirth`, which is also where the
 * reasoning about stillbirths and placement lives. Nothing about that is
 * decided here: this screen collects, checks and hands over.
 */
export function LogBirthScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const today = todayInEAT();

  // Every record, not just the active ones: SPEC 22 allows a backdated birth
  // against a dam who has since been sold or died, with a warning.
  const records = useLiveQuery(() => db.records.toArray(), [], [] as Record_[]);
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const sales = useLiveQuery(allSales, [], [] as Sale[]);
  const deaths = useLiveQuery(allDeaths, [], [] as Death[]);
  const vets = useLiveQuery(() => db.vets.toArray(), [], [] as Vet[]);

  const [damId, setDamId] = useState<string | null>(params.get("record"));
  const [search, setSearch] = useState("");
  const [date, setDate] = useState(params.get("date") ?? today);
  const [born, setBorn] = useState("1");
  const [surviving, setSurviving] = useState("1");
  const [sireId, setSireId] = useState("");
  const [sireName, setSireName] = useState("");
  const [vetId, setVetId] = useState("");
  const [notes, setNotes] = useState("");
  const [groupTag, setGroupTag] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sexes, setSexes] = useState<Sex[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dam = records.find((r) => r.id === damId) ?? null;
  const bornCount = Number(born);
  const survivingCount = Number(surviving);
  const shape = offspringShape(Number.isInteger(bornCount) && bornCount > 0 ? bornCount : 1);

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const eligible = records.filter(canBeDam);
    const pool = needle
      ? eligible.filter(
          (r) =>
            r.tag.toLowerCase().includes(needle) ||
            speciesLabel(r.species).toLowerCase().includes(needle),
        )
      : // Active mothers first: the one that just gave birth is almost never
        // the one that was sold last year.
        [...eligible].sort((a, b) =>
          a.status === b.status ? a.tag.localeCompare(b.tag) : a.status === "active" ? -1 : 1,
        );
    return pool.slice(0, 50);
  }, [records, search]);

  /**
   * Suggest the tags, from the dam's own (SPEC 22).
   *
   * `nextSequentialTags` is the helper a group split already uses, so an
   * offspring tag has the same shape as a split's and is checked against the
   * same set of taken tags. They stay editable: a farm that tags calves by year
   * rather than by mother should not have to fight the suggestion.
   */
  useEffect(() => {
    if (!dam) return;
    let cancelled = false;
    const wanted = shape === "individual" ? Math.max(1, Math.min(bornCount || 1, 2)) : 1;
    void nextSequentialTags(dam.tag, wanted).then((suggested) => {
      if (cancelled) return;
      if (shape === "group") setGroupTag((current) => current || suggested[0]!);
      else setTags(suggested);
    });
    return () => {
      cancelled = true;
    };
  }, [dam?.id, dam?.tag, shape, bornCount]);

  // One sex control per individual offspring, defaulting to female because the
  // form has to default to something and nothing here is a guess worth
  // preferring — it is asked per offspring and shown as asked.
  useEffect(() => {
    if (shape !== "individual") return;
    setSexes((current) => {
      const wanted = Math.max(1, Math.min(bornCount || 1, 2));
      const next = [...current];
      while (next.length < wanted) next.push("female");
      return next.slice(0, wanted);
    });
  }, [shape, bornCount]);

  const problem = dam
    ? checkBirth({ dam, date, bornCount, survivingCount }, today)
    : { error: null, warning: null };
  const leftWarning = dam ? departureWarning(dam, date, sales, deaths) : null;
  const room = rooms.find((r) => r.id === dam?.current_room_id) ?? null;
  const lost = Number.isFinite(bornCount - survivingCount)
    ? Math.max(0, bornCount - survivingCount)
    : 0;

  async function submit() {
    if (!dam) return;
    if (problem.error) return setError(problem.error);

    const offspring: OffspringInput[] = [];
    if (shape === "individual") {
      for (let i = 0; i < bornCount; i += 1) {
        const tag = (tags[i] ?? "").trim();
        if (!tag) return setError("Every offspring needs a tag.");
        offspring.push({
          tag,
          // Only asked for the ones that survived. A stillborn animal gets a
          // record so the loss is counted (see `recordBirth`), and inventing a
          // sex for it would be filling in a field nobody checked.
          sex: i < survivingCount ? sexes[i] ?? "female" : null,
          survived: i < survivingCount,
        });
      }
    } else if (survivingCount > 0 || bornCount > 0) {
      const tag = groupTag.trim();
      if (!tag) return setError("The group needs a name.");
      offspring.push({ tag, survived: survivingCount > 0 });
    }

    setSaving(true);
    setError(null);
    try {
      const outcome = await recordBirth({
        dam_record_id: dam.id,
        sire_record_id: sireId || null,
        sire_name: sireId ? null : sireName.trim() || null,
        date,
        born_count: bornCount,
        surviving_count: survivingCount,
        vet_id: vetId || null,
        notes: notes.trim() || null,
        offspring,
        as_group: shape === "group",
      });
      // Back to the dam: her offspring are listed there, which is the thing
      // somebody wants to see immediately after recording them.
      navigate(`/records/${outcome.birth.dam_record_id}`, { replace: true });
    } catch (cause) {
      setError((cause as Error).message);
      setSaving(false);
    }
  }

  if (!dam) {
    return (
      <div className="pb-44 md:pb-8 max-w-3xl">
        <h2 className="text-headline-sm text-primary">Which mother?</h2>
        <p className="text-body-md text-text-muted mt-1">
          Female animals and groups. A male cannot be a mother, so males are not
          listed — name the father below instead.
        </p>
        <div className="relative mt-3">
          <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            className="field pl-12"
            placeholder="Search by tag or species"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <ul className="mt-3 grid gap-2 md:grid-cols-2">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className="card w-full text-left p-4 min-h-row"
                onClick={() => setDamId(candidate.id)}
              >
                <p className="data-value font-bold">{candidate.tag}</p>
                <p className="text-body-md text-text-muted">
                  {speciesLabel(candidate.species)} ·{" "}
                  {candidate.kind === "group"
                    ? `Group of ${candidate.head_count}`
                    : "Single animal"}
                  {candidate.status !== "active" ? ` · ${candidate.status}` : ""}
                </p>
              </button>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="card p-6 text-body-md text-text-muted text-center">
              No female animal or group to record a birth against.
            </li>
          )}
        </ul>
      </div>
    );
  }

  return (
    <div className="pb-44 md:pb-8 max-w-3xl">
      <div className="card p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="data-value font-bold truncate">{dam.tag}</p>
          <p className="text-body-md text-text-muted">
            {speciesLabel(dam.species)}
            {dam.breed ? ` · ${dam.breed}` : ""}
            {room ? ` · ${room.code}` : " · not in a room"}
          </p>
        </div>
        <button type="button" className="btn-quiet" onClick={() => setDamId(null)}>
          Change
        </button>
      </div>

      {/* SPEC 22 — a dam who has left the farm can still have a backdated birth
          logged, and is told so rather than refused. */}
      {leftWarning && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">
          <WarningIcon className="w-5 h-5 shrink-0" />
          {leftWarning}
        </p>
      )}

      <Labelled label="Born on" htmlFor="birth-date">
        <input
          id="birth-date" type="date" className="field font-mono" value={date}
          max={today} onChange={(e) => setDate(e.target.value)}
        />
      </Labelled>

      <div className="grid grid-cols-2 gap-3">
        <Labelled label="How many born" htmlFor="birth-born">
          <input
            id="birth-born" className="field font-mono" value={born} inputMode="numeric"
            onChange={(e) => {
              setBorn(e.target.value);
              // Surviving follows born while they agree, so the ordinary case —
              // everything lived — needs one number rather than two.
              if (surviving === born) setSurviving(e.target.value);
            }}
          />
        </Labelled>
        <Labelled label="How many survived" htmlFor="birth-surviving">
          <input
            id="birth-surviving" className="field font-mono" value={surviving} inputMode="numeric"
            onChange={(e) => setSurviving(e.target.value)}
          />
        </Labelled>
      </div>

      {/**
        * The reason, where the cause is.
        *
        * It used to sit only above the action bar, at the bottom of a long
        * form: a date typed wrong put the message three screens below the date
        * and disabled a button whose reason was off-screen. A rule broken here
        * is a rule about the two fields directly above, so it is said here.
        */}
      {(problem.error ?? error) && (
        <p className="mt-4 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">
          {problem.error ?? error}
        </p>
      )}

      {lost > 0 && !problem.error && (
        <p className="card p-3 mt-3 text-body-md">
          {lost} {plural(lost, "stillbirth")} will be recorded, so the loss is in
          the farm&rsquo;s mortality figures rather than nowhere.
        </p>
      )}

      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">
          {shape === "individual"
            ? `Offspring · ${bornCount || 1} ${plural(bornCount || 1, "record")}`
            : "Offspring · one group"}
        </h2>
        <p className="text-body-md text-text-muted mt-1">
          {shape === "individual"
            ? "Species and breed come from the mother. Tags are suggested from her tag and can be changed."
            : `More than two, so they are recorded as one group of ${bornCount || 0} ${headUnit(bornCount || 0)} rather than as ${bornCount || 0} separate records.`}
        </p>

        {shape === "individual" ? (
          Array.from({ length: Math.max(1, Math.min(bornCount || 1, 2)) }, (_, i) => (
            <div key={i} className="mt-4 border-t border-border pt-3 first:border-0 first:pt-0">
              <label className="data-label block mb-1" htmlFor={`birth-tag-${i}`}>
                {bornCount > 1 ? `Offspring ${i + 1} tag` : "Tag"}
                {i >= survivingCount ? " — did not survive" : ""}
              </label>
              <input
                id={`birth-tag-${i}`}
                className="field font-mono"
                value={tags[i] ?? ""}
                onChange={(e) =>
                  setTags((current) => {
                    const next = [...current];
                    next[i] = e.target.value;
                    return next;
                  })
                }
              />
              {i < survivingCount && (
                <fieldset className="mt-3">
                  <legend className="data-label mb-2">Sex</legend>
                  <div className="flex gap-2">
                    {(["female", "male"] as Sex[]).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() =>
                          setSexes((current) => {
                            const next = [...current];
                            next[i] = option;
                            return next;
                          })
                        }
                        className={`flex-1 min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
                          (sexes[i] ?? "female") === option
                            ? "bg-primary-container text-white border-primary-container"
                            : "bg-card text-text border-border"
                        }`}
                      >
                        {option === "female" ? "Female" : "Male"}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          ))
        ) : (
          <div className="mt-4">
            <label className="data-label block mb-1" htmlFor="birth-group-tag">
              Group name
            </label>
            <input
              id="birth-group-tag" className="field font-mono" value={groupTag}
              onChange={(e) => setGroupTag(e.target.value)}
            />
          </div>
        )}
      </section>

      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">Father</h2>
        <p className="text-body-md text-text-muted mt-1">
          Optional. One of this farm&rsquo;s males, or a name for somebody
          else&rsquo;s animal.
        </p>
        <Labelled label="On this farm" htmlFor="birth-sire">
          <select
            id="birth-sire" className="field" value={sireId}
            onChange={(e) => setSireId(e.target.value)}
          >
            <option value="">Not recorded</option>
            {records.filter(canBeSire).map((male) => (
              <option key={male.id} value={male.id}>
                {male.tag} · {speciesLabel(male.species)}
                {male.status !== "active" ? ` (${male.status})` : ""}
              </option>
            ))}
          </select>
        </Labelled>
        {!sireId && (
          <Labelled label="Or a name" htmlFor="birth-sire-name">
            <input
              id="birth-sire-name" className="field" value={sireName}
              placeholder="A bull from another farm"
              onChange={(e) => setSireName(e.target.value)}
            />
          </Labelled>
        )}
      </section>

      <Labelled label="Vet present" htmlFor="birth-vet">
        <select
          id="birth-vet" className="field" value={vetId}
          onChange={(e) => setVetId(e.target.value)}
        >
          <option value="">Nobody recorded</option>
          {vets.filter((v) => !v.deleted_at).map((vet) => (
            <option key={vet.id} value={vet.id}>{vet.name}</option>
          ))}
        </select>
      </Labelled>

      <Labelled label="Notes" htmlFor="birth-notes">
        <textarea
          id="birth-notes" className="field h-auto py-3" rows={2} value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Labelled>

      {room ? (
        <p className="card p-3 mt-4 text-body-md text-text-muted">
          They will be placed in {room.code} · {room.name}, where {dam.tag} is now.
        </p>
      ) : (
        <p className="card p-3 mt-4 text-body-md text-text-muted">
          {dam.tag} is not in a room, so the offspring will not be placed in one
          either. Move them to place them.
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 bg-card shadow-card-up p-4 md:static md:bg-transparent md:shadow-none md:px-0">
        <button
          type="button"
          className="btn-action w-full text-headline-sm h-14 md:max-w-xs"
          disabled={saving || problem.error !== null}
          onClick={() => void submit()}
        >
          <CheckIcon className="w-6 h-6" />
          {saving ? "Recording…" : "Record birth"}
        </button>
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
    <div className="mt-4 scroll-mb-44">
      <label className="data-label block mb-1" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
