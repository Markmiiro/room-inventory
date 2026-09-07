import { useMemo, useState } from "react";

import { PlusIcon } from "../components/Icons";
import { createProduceType, updateProduceType } from "../db/mutations";
import { allIntakes, allOuttakes, allProduceTypes } from "../db/queries";
import type { ProduceType, StockIntake, StockOuttake } from "../db/types";
import { plural } from "../domain/format";
import { useLiveQuery } from "../sync/useSync";

/**
 * Manage produce types — SPEC 20.11, 20.17.
 *
 * Produce types are rows rather than an enum, so a farm that starts growing
 * groundnuts needs a form and not a release (SPEC 20.4).
 *
 * This is also where the farm sets what a sack of each usually weighs. That
 * figure is only ever used to warn that an entry looks like a typo, and the
 * screen says so — an unexplained optional number on a settings screen is one
 * people either ignore or fill in wrongly, and a wrong one here would start
 * questioning correct entries.
 */
export function ProduceTypesScreen() {
  const types = useLiveQuery(allProduceTypes, [], [] as ProduceType[]);
  const intakes = useLiveQuery(allIntakes, [], [] as StockIntake[]);
  const outtakes = useLiveQuery(allOuttakes, [], [] as StockOuttake[]);

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** How much each type is actually used, so archiving is an informed choice. */
  const counts = useMemo(() => {
    const used = new Map<string, number>();
    for (const row of [...intakes, ...outtakes]) {
      used.set(row.produce_type_id, (used.get(row.produce_type_id) ?? 0) + 1);
    }
    return used;
  }, [intakes, outtakes]);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return setError("A produce type needs a name.");
    if (types.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
      return setError("There is already a produce type with that name.");
    }
    await createProduceType(trimmed);
    setName("");
    setError(null);
  }

  return (
    <div className="pb-8 max-w-3xl">
      {/*
        SPEC 20.17 — what the sack weight is for, before anyone meets the field.

        Left unexplained it reads as a required setting, and someone guessing at
        it would start the app questioning entries that are perfectly correct.
        Saying plainly that nothing is calculated from it is the part that
        matters: it is the difference between a hint and a measurement.
      */}
      <p className="card p-4 text-body-md text-text-muted">
        A typical sack weight is <strong className="text-text">optional</strong>. The app uses it
        for one thing: if an entry records both sacks and kilograms and the weight per sack looks
        far off, it asks whether that is right. Nothing is ever worked out from it — sacks and
        kilograms are always recorded separately, and the app will never fill one in from the
        other. Leave it empty and nothing changes.
      </p>

      <div className="card p-4 mt-4">
        <label className="data-label block mb-1" htmlFor="pt-name">
          New produce type
        </label>
        <div className="flex gap-2">
          <input
            id="pt-name"
            className="field flex-1"
            value={name}
            placeholder="Groundnuts"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="btn-secondary" onClick={() => void add()}>
            <PlusIcon className="w-5 h-5" />
            Add
          </button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        {types.map((type) => (
          <li key={type.id}>
            <ProduceTypeRow type={type} used={counts.get(type.id) ?? 0} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProduceTypeRow({ type, used }: { type: ProduceType; used: number }) {
  const [draft, setDraft] = useState(
    type.typical_sack_kg === null ? "" : String(type.typical_sack_kg),
  );

  /** Empty clears the figure; anything else is stored as typed. A zero would
   *  mean "a sack weighs nothing", so it is treated as clearing it. */
  async function saveWeight() {
    const trimmed = draft.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value <= 0)) return;
    await updateProduceType(type.id, { typical_sack_kg: value });
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body-lg font-semibold truncate">
            {type.name}
            {!type.is_active && (
              <span className="chip bg-background text-text-muted ml-2">Archived</span>
            )}
          </p>
          <p className="data-label mt-1">
            {used} {plural(used, "entry", "entries")}
          </p>
        </div>
        {/* SPEC 20.14.5 — a type with history is archived, never deleted, so it
            keeps naming the stock it explains while dropping out of pickers. */}
        <button
          type="button"
          className="btn-quiet shrink-0"
          onClick={() => void updateProduceType(type.id, { is_active: !type.is_active })}
        >
          {type.is_active ? "Archive" : "Restore"}
        </button>
      </div>

      <div className="mt-3">
        <label className="data-label block mb-1" htmlFor={`pt-kg-${type.id}`}>
          Typical sack weight
          <span className="text-text-muted normal-case"> · optional, kg</span>
        </label>
        <input
          id={`pt-kg-${type.id}`}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.1"
          className="field"
          placeholder="Not set"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void saveWeight()}
        />
      </div>
    </div>
  );
}
