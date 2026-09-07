import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { todayInEAT } from "../db/ids";
import { recordOuttake } from "../db/mutations";
import { activeProduceTypes, allStockEvents, liveStores } from "../db/queries";
import type { OuttakeReason, PriceBasis, ProduceType, Store } from "../db/types";
import { formatUGX } from "../domain/format";
import { balanceFor, balancesAsAt, type StockInput } from "../domain/stores";
import { useLiveQuery } from "../sync/useSync";
import { Chip, Field, NumberField, Picker } from "./stockControls";
import { Quantity } from "./Stores";

const NO_EVENTS: StockInput = { intakes: [], outtakes: [], counts: [] };

const REASONS: Array<{ value: OuttakeReason; label: string }> = [
  { value: "sold", label: "Sold" },
  { value: "home_use", label: "Home use" },
  { value: "seed", label: "Seed" },
  { value: "gift", label: "Gift" },
  { value: "spoiled", label: "Spoiled" },
  { value: "processing", label: "Processing" },
  { value: "moved", label: "Moved" },
  { value: "other", label: "Other" },
];

/**
 * Take out stock — SPEC 20.11.
 *
 * The frequent action during harvest, which is why Store detail gives it the
 * single yellow button. Store, produce, date, quantity, then the reason as
 * chips. Sold reveals the price; moved reveals the destination.
 *
 * **What is currently in the store is shown above the quantity field**, so
 * nobody has to remember it or leave the form to look.
 */
export function TakeOutStockScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const today = todayInEAT();

  const stores = useLiveQuery(liveStores, [], [] as Store[]);
  const types = useLiveQuery(activeProduceTypes, [], [] as ProduceType[]);
  const events = useLiveQuery(allStockEvents, [], NO_EVENTS);

  const [storeId, setStoreId] = useState(params.get("store") ?? "");
  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState(today);
  const [sacks, setSacks] = useState("");
  const [kg, setKg] = useState("");
  const [reason, setReason] = useState<OuttakeReason>("sold");
  const [basis, setBasis] = useState<PriceBasis>("kg");
  const [unitPrice, setUnitPrice] = useState("");
  const [toStoreId, setToStoreId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const store = storeId || stores[0]?.id || "";
  const weight = Number(kg);
  const sackCount = sacks.trim() ? Number(sacks) : null;

  /**
   * What is actually in this store, so the form can open on something real.
   *
   * Defaulting to the first produce type alphabetically opened Take out on
   * "Beans · in store now 0 kg" for a store holding coffee and maize — the
   * frequent action, pre-filled with the one produce it could not be about.
   * Falling back to the plain list still matters: a store may hold nothing, and
   * an empty picker would be worse than an unhelpful one.
   */
  const stocked = useMemo(
    () => balancesAsAt(today, events).filter((b) => b.store_id === store && b.kg > 0),
    [today, events, store],
  );
  const produce = typeId || stocked[0]?.produce_type_id || types[0]?.id || "";

  const balance = useMemo(
    () => balanceFor(today, store, produce, events),
    [today, store, produce, events],
  );

  const destinations = stores.filter((s) => s.id !== store);
  const destination = toStoreId && toStoreId !== store ? toStoreId : (destinations[0]?.id ?? "");

  /**
   * SPEC 20.6 — the total is what gets stored, and it is shown large as it is
   * typed. Whichever way the deal was struck, this is the figure the money
   * screens will read.
   */
  const total = useMemo(() => {
    const unit = Number(unitPrice);
    if (!Number.isFinite(unit) || unit <= 0) return null;
    const quantity = basis === "kg" ? weight : sackCount;
    if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) return null;
    return Math.round(unit * quantity);
  }, [unitPrice, basis, weight, sackCount]);

  const problem = useMemo(() => {
    if (!store || !produce) return "Choose a store and a produce type.";
    if (!kg.trim() || !Number.isFinite(weight) || weight <= 0) {
      return "Enter the weight in kilograms.";
    }
    if (date > today) return "Stock cannot leave on a future date.";
    if (reason === "moved" && !destination) {
      return "There is no other store to move this to.";
    }
    if (reason === "sold" && basis === "sack" && sackCount === null) {
      return "Enter the number of sacks, or price per kilogram instead.";
    }
    return null;
  }, [store, produce, kg, weight, date, today, reason, destination, basis, sackCount]);

  /**
   * SPEC 20.14.1 — taking out more than is there is **warned about, not
   * blocked**. The produce may physically be there when the ledger is wrong,
   * and refusing the entry would push someone into inventing a different one.
   */
  const overdraw = weight > balance.kg && Number.isFinite(weight) && weight > 0;

  async function save() {
    if (problem || saving) return;
    setSaving(true);
    try {
      await recordOuttake({
        store_id: store,
        produce_type_id: produce,
        date,
        sacks: sackCount,
        kg: weight,
        reason,
        price_basis: reason === "sold" ? basis : null,
        unit_price: reason === "sold" && unitPrice.trim() ? Number(unitPrice) : null,
        total_price: reason === "sold" ? total : null,
        to_store_id: reason === "moved" ? destination : null,
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

      <Field label="Date" htmlFor="out-date">
        <input
          id="out-date"
          type="date"
          className="field"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>

      {/* SPEC 20.11 — above the quantity field, so nobody has to remember what
          is in the store or leave the form to find out. */}
      <p className="card p-3 mt-4 text-body-md">
        <span className="data-label">In store now</span>
        <span className="block data-value mt-1">
          <Quantity kg={balance.kg} sacks={balance.sacks} partial={balance.sacksPartial} />
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Kilograms" htmlFor="out-kg" value={kg} onChange={setKg} step="0.1" />
        <NumberField
          label="Sacks"
          htmlFor="out-sacks"
          value={sacks}
          onChange={setSacks}
          hint="Optional"
        />
      </div>

      {overdraw && (
        <p className="card p-4 mt-3 text-body-md text-alert-text">
          That is more than the {balance.kg} kg this store has on record. It will still be saved —
          the produce may be there when the records are wrong — and the balance will stop at zero
          until a stock count sets it straight.
        </p>
      )}

      <fieldset className="mt-4">
        <legend className="data-label mb-2">Why it is leaving</legend>
        {/* Wrapped rather than scrolled sideways: eight chips do not fit on one
            390px row, and a chip past the edge is one nobody finds. */}
        <div className="flex flex-wrap gap-2">
          {REASONS.map((option) => (
            <Chip
              key={option.value}
              active={reason === option.value}
              onClick={() => setReason(option.value)}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      {reason === "sold" && (
        <>
          <fieldset className="mt-4">
            <legend className="data-label mb-2">Price per</legend>
            {/* SPEC 20.16 Q1 — a sale may be negotiated either way, and neither
                quantity is derived from the other (SPEC 20.8). The total is what
                gets stored. */}
            <div className="flex gap-2">
              <Chip active={basis === "kg"} onClick={() => setBasis("kg")}>
                Kilogram
              </Chip>
              <Chip active={basis === "sack"} onClick={() => setBasis("sack")}>
                Sack
              </Chip>
            </div>
          </fieldset>

          <NumberField
            label={`UGX per ${basis === "kg" ? "kilogram" : "sack"}`}
            htmlFor="out-price"
            value={unitPrice}
            onChange={setUnitPrice}
          />

          <div className="card p-4 mt-3">
            <span className="data-label">Total</span>
            <span className="block text-headline-lg-mobile md:text-headline-lg font-mono text-primary mt-1">
              {total === null ? "—" : formatUGX(total)}
            </span>
          </div>
        </>
      )}

      {reason === "moved" && destinations.length > 0 && (
        <>
          {/* SPEC 20.14.7 — the current store is not offered as a destination. */}
          <Picker
            label="Move to"
            value={destination}
            onChange={setToStoreId}
            options={destinations.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
          />
          <p className="text-body-md text-text-muted mt-2">
            The same weight is added to that store in one step, so it is never in neither.
          </p>
        </>
      )}

      <Field label="Notes" htmlFor="out-notes" hint="Optional">
        <input
          id="out-notes"
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
        Take out
      </button>
    </div>
  );
}
