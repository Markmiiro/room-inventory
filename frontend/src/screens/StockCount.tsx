import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { todayInEAT } from "../db/ids";
import { recordStockCount } from "../db/mutations";
import { activeProduceTypes, allStockEvents, liveStores } from "../db/queries";
import type { ProduceType, Store } from "../db/types";
import { balanceFor, type StockInput, varianceAgainst } from "../domain/stores";
import { useLiveQuery } from "../sync/useSync";
import { Field, NumberField, Picker } from "./stockControls";
import { Quantity } from "./Stores";

const NO_EVENTS: StockInput = { intakes: [], outtakes: [], counts: [] };

/**
 * Stock count — SPEC 20.7, 20.11.
 *
 * Pick a store and produce type, see what the ledger says, enter what was
 * actually in the store, and read the difference **in words before
 * confirming**.
 *
 * The variance is shown rather than absorbed because absorbing it is how a
 * ledger quietly stops matching the store. Without this screen the only way to
 * correct a drift would be to invent a fake outtake, which would pollute the
 * very reasons that make the outtake record worth keeping.
 */
export function StockCountScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const today = todayInEAT();

  const stores = useLiveQuery(liveStores, [], [] as Store[]);
  const types = useLiveQuery(activeProduceTypes, [], [] as ProduceType[]);
  const events = useLiveQuery(allStockEvents, [], NO_EVENTS);

  const [storeId, setStoreId] = useState(params.get("store") ?? "");
  const [typeId, setTypeId] = useState(params.get("produce") ?? "");
  const [date, setDate] = useState(today);
  const [countedSacks, setCountedSacks] = useState("");
  const [countedKg, setCountedKg] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const store = storeId || stores[0]?.id || "";
  const produce = typeId || types[0]?.id || "";
  const kg = Number(countedKg);
  const sacks = countedSacks.trim() ? Number(countedSacks) : null;

  // The ledger as at the day being counted, so backdating a count compares it
  // against what the records said then rather than what they say now.
  const ledger = useMemo(
    () => balanceFor(date, store, produce, events),
    [date, store, produce, events],
  );

  const variance = useMemo(() => {
    if (!countedKg.trim() || !Number.isFinite(kg) || kg < 0) return null;
    return varianceAgainst(ledger.kg, ledger.sacks, kg, sacks);
  }, [countedKg, kg, sacks, ledger.kg, ledger.sacks]);

  const problem = useMemo(() => {
    if (!store || !produce) return "Choose a store and a produce type.";
    // Zero is a real count — a store can be empty — so only a missing or
    // negative figure is a problem.
    if (!countedKg.trim() || !Number.isFinite(kg) || kg < 0) {
      return "Enter the weight you counted, in kilograms.";
    }
    // SPEC 20.14.6 — no future dates.
    if (date > today) return "A count cannot be dated in the future.";
    return null;
  }, [store, produce, countedKg, kg, date, today]);

  async function save() {
    if (problem || saving) return;
    setSaving(true);
    try {
      await recordStockCount({
        store_id: store,
        produce_type_id: produce,
        date,
        counted_sacks: sacks,
        counted_kg: kg,
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

      <Field label="Date" htmlFor="cnt-date">
        <input
          id="cnt-date"
          type="date"
          className="field"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>

      <p className="card p-3 mt-4 text-body-md">
        <span className="data-label">The records say</span>
        <span className="block data-value mt-1">
          <Quantity kg={ledger.kg} sacks={ledger.sacks} partial={ledger.sacksPartial} />
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Counted kg"
          htmlFor="cnt-kg"
          value={countedKg}
          onChange={setCountedKg}
          step="0.1"
        />
        <NumberField
          label="Counted sacks"
          htmlFor="cnt-sacks"
          value={countedSacks}
          onChange={setCountedSacks}
          hint="Optional"
        />
      </div>

      {/*
        SPEC 20.7 — the difference in words, before confirming.

        Finding more than the ledger says is as ordinary as finding less
        (SPEC 20.14.4): coffee dries, sacks get miscounted, and a delivery can
        go unrecorded. Both are worded the same way round and neither is
        treated as an error.
      */}
      {variance && (
        <p className="card p-4 mt-3 text-body-md">
          {variance.words ?? "That matches the records exactly."}
        </p>
      )}

      {variance?.words && (
        <p className="text-body-md text-text-muted mt-2">
          Saving this sets the balance to what you counted. Nothing already recorded is changed
          or removed — deliveries and sales after this date carry on from the counted figure.
        </p>
      )}

      <Field label="Notes" htmlFor="cnt-notes" hint="Optional">
        <input
          id="cnt-notes"
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
        Save count
      </button>
    </div>
  );
}
