import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { todayInEAT } from "../db/ids";
import { recordIntake } from "../db/mutations";
import { activeProduceTypes, liveStores } from "../db/queries";
import type { IntakeSource, ProduceType, Store } from "../db/types";
import { sackWeightWarning } from "../domain/stores";
import { useLiveQuery } from "../sync/useSync";
import { Chip, Field, NumberField, Picker } from "./stockControls";

/**
 * Add stock — SPEC 20.11.
 *
 * Store, produce type, date, sacks, kilograms, then the source as two large
 * cards: **From garden** or **Bought**. Garden reveals the garden name; bought
 * reveals cost and seller.
 *
 * The two are separated because they mean different things to the money
 * figures: a bought intake is a cost like an animal purchase, and a garden
 * intake is neither income nor cost — it enters at zero, because growing it was
 * already recorded under Expenses and counting it again would understate the
 * farm's profit (SPEC 20.9, 20.10).
 */
export function AddStockScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const today = todayInEAT();

  const stores = useLiveQuery(liveStores, [], [] as Store[]);
  const types = useLiveQuery(activeProduceTypes, [], [] as ProduceType[]);

  const [storeId, setStoreId] = useState(params.get("store") ?? "");
  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState(today);
  const [sacks, setSacks] = useState("");
  const [kg, setKg] = useState("");
  const [source, setSource] = useState<IntakeSource>("garden");
  const [gardenName, setGardenName] = useState("");
  const [seller, setSeller] = useState("");
  const [cost, setCost] = useState("");
  const [harvestLabel, setHarvestLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const store = storeId || stores[0]?.id || "";
  const produce = typeId || types[0]?.id || "";
  const weight = Number(kg);

  /**
   * SPEC 20.17 — a typo check, not a rule. It warns and the button stays
   * enabled: the farm knows its own sacks, and a half-full one is a real thing.
   * Nothing is computed from the typical weight.
   */
  const chosenType = types.find((t) => t.id === produce);
  const sackWarning = chosenType
    ? sackWeightWarning(
        chosenType.name,
        chosenType.typical_sack_kg,
        sacks.trim() ? Number(sacks) : null,
        weight,
      )
    : null;

  const problem = useMemo(() => {
    if (!store || !produce) return "Choose a store and a produce type.";
    // SPEC 20.8 — kg is required on every event; sacks never are.
    if (!kg.trim() || !Number.isFinite(weight) || weight <= 0) {
      return "Enter the weight in kilograms.";
    }
    // SPEC 20.14.6 — no future dates. Backdating to any day up to today is
    // fine and recomputes the balance.
    if (date > today) return "A delivery cannot be dated in the future.";
    if (source === "bought" && (!cost.trim() || Number(cost) <= 0)) {
      return "Enter what the produce cost.";
    }
    return null;
  }, [store, produce, kg, weight, date, today, source, cost]);

  async function save() {
    if (problem || saving) return;
    setSaving(true);
    try {
      await recordIntake({
        store_id: store,
        produce_type_id: produce,
        date,
        sacks: sacks.trim() ? Number(sacks) : null,
        kg: weight,
        source,
        garden_name: gardenName,
        seller,
        cost: source === "bought" ? Number(cost) : null,
        harvest_label: harvestLabel,
        notes,
      });
      navigate(`/stores/${store}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pb-40 md:pb-24">
      <Picker
        label="Store"
        value={store}
        onChange={setStoreId}
        options={stores.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
      />
      <Picker
        label="Produce"
        value={produce}
        onChange={setTypeId}
        options={types.map((t) => ({ value: t.id, label: t.name }))}
      />

      <Field label="Date" htmlFor="in-date">
        <input
          id="in-date"
          type="date"
          className="field"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3 mt-4">
        {/* Kilograms first: weight is what gets sold and what carries value,
            and sacks are the physical check (SPEC 20.8). */}
        <NumberField label="Kilograms" htmlFor="in-kg" value={kg} onChange={setKg} step="0.1" />
        <NumberField
          label="Sacks"
          htmlFor="in-sacks"
          value={sacks}
          onChange={setSacks}
          hint="Optional"
        />
      </div>

      {sackWarning && (
        <p className="card p-4 mt-3 text-body-md text-alert-text">{sackWarning}</p>
      )}

      <fieldset className="mt-4">
        <legend className="data-label mb-2">Where it came from</legend>
        <div className="grid grid-cols-2 gap-3">
          <SourceCard
            active={source === "garden"}
            onClick={() => setSource("garden")}
            title="From garden"
            detail="Grown here"
          />
          <SourceCard
            active={source === "bought"}
            onClick={() => setSource("bought")}
            title="Bought"
            detail="Paid for"
          />
        </div>
      </fieldset>

      {source === "garden" ? (
        <>
          <Field label="Garden" htmlFor="in-garden" hint="Optional">
            <input
              id="in-garden"
              className="field"
              placeholder="Lower garden"
              value={gardenName}
              onChange={(e) => setGardenName(e.target.value)}
            />
          </Field>
          {/* SPEC 20.9 — said in words wherever a produce value appears, so a
              zero cost never reads as an accident. */}
          <p className="card p-4 mt-3 text-body-md text-text-muted">
            Produce from the garden is added at <strong className="text-text">no cost</strong>.
            What it cost to grow — seed, labour, fertiliser — is already recorded under Expenses,
            and counting it twice would make the farm look less profitable than it is.
          </p>
        </>
      ) : (
        <>
          <NumberField label="Cost, UGX" htmlFor="in-cost" value={cost} onChange={setCost} />
          <Field label="Seller" htmlFor="in-seller" hint="Optional">
            <input
              id="in-seller"
              className="field"
              value={seller}
              onChange={(e) => setSeller(e.target.value)}
            />
          </Field>
        </>
      )}

      {/* SPEC 20.16 Q2 — a label, not a lot. It costs nothing to record and is
          what a farm would need later to tell one harvest from another. */}
      <Field label="Harvest" htmlFor="in-harvest" hint="Optional, e.g. March 2026">
        <input
          id="in-harvest"
          className="field"
          value={harvestLabel}
          onChange={(e) => setHarvestLabel(e.target.value)}
        />
      </Field>

      <Field label="Notes" htmlFor="in-notes" hint="Optional">
        <input
          id="in-notes"
          className="field"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      {problem && <p className="text-body-md text-alert-text mt-4">{problem}</p>}

      <button
        type="button"
        className="btn-action w-full mt-6 text-headline-sm h-14"
        disabled={problem !== null || saving}
        onClick={() => void save()}
      >
        Add stock
      </button>
    </div>
  );
}

function SourceCard({
  active,
  onClick,
  title,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-lg border p-4 text-left min-h-touch ${
        active
          ? "bg-primary-container text-white border-primary-container"
          : "bg-card text-text border-border"
      }`}
    >
      <span className="text-body-md font-semibold block">{title}</span>
      <span className={`text-body-md ${active ? "text-white/80" : "text-text-muted"}`}>
        {detail}
      </span>
    </button>
  );
}

export { Chip };
