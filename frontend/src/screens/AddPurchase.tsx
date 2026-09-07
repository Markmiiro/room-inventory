import { useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CheckIcon, PlusIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { createRecord, updateRecord } from "../db/mutations";
import { activeRecords, liveRooms } from "../db/queries";
import type { Record_, RecordKind, Room, Sex, Source, Species } from "../db/types";
import { formatUGX } from "../domain/format";
import { ALL_SPECIES, findTagClash, speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";


const SOURCES: Array<{ value: Source; label: string }> = [
  { value: "born_here", label: "Born here" },
  { value: "bought", label: "Bought" },
  { value: "gift", label: "Gift" },
];

/**
 * Add or purchase.
 *
 * Laid out against `screenshots/06-add-purchase.png`. Three of the mockup's
 * choices are not reproduced:
 *
 * - It labels the second kind "Group / Batch". "Batch" is banned vocabulary
 *   (SPEC 2), so the control says Group.
 * - Breed is a "Select Breed" dropdown there. SPEC 3.4 makes breed free text
 *   and the app ships no breed list, so a dropdown would be a list of nothing.
 * - Its initial vaccines and treatments write HealthRecords, which do not exist
 *   yet. Offering the checkboxes would mean silently dropping what was ticked.
 *
 * Price and seller do work: SPEC 3.7 says a Purchase is created automatically
 * whenever a record is added with `source = bought`, and `createRecord` writes
 * both rows in one transaction.
 */
export function AddPurchaseScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const existing = useLiveQuery(activeRecords, [], [] as Record_[]);

  const [kind, setKind] = useState<RecordKind>("animal");
  const [species, setSpecies] = useState<Species>("cattle");
  const [tag, setTag] = useState("");
  const [breed, setBreed] = useState("");
  const [sex, setSex] = useState<Sex>("female");
  const [dob, setDob] = useState("");
  const [arrival, setArrival] = useState(todayInEAT());
  const [headCount, setHeadCount] = useState("1");
  const [offspring, setOffspring] = useState("");
  const [roomId, setRoomId] = useState(params.get("room") ?? "");
  const [source, setSource] = useState<Source>("bought");
  const [price, setPrice] = useState("");
  const [seller, setSeller] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isGroup = kind === "group";
  const priceShillings = price.trim() === "" ? null : Number(price.replace(/[,\s]/g, ""));

  async function submit() {
    const trimmed = tag.trim();
    if (!trimmed) return setError(isGroup ? "A group needs a name." : "An animal needs a tag.");

    const clash = findTagClash(trimmed, existing, rooms);
    if (clash) {
      return setError(
        clash.roomCode
          ? `This tag is already used by an animal in ${clash.roomCode}.`
          : "This tag is already used by another active record.",
      );
    }

    const head = isGroup ? Number(headCount) : 1;
    if (isGroup && (!Number.isInteger(head) || head < 1)) {
      return setError("A group needs a head count of 1 or more.");
    }

    const today = todayInEAT();
    // SPEC 6.8 — nothing may be dated in the future; SPEC 6.9 — backdating is fine.
    if (!isGroup && dob && dob > today) return setError("A date of birth cannot be in the future.");
    if (arrival > today) return setError("An arrival cannot be dated in the future.");

    let offspringCount: number | null = null;
    if (!isGroup && offspring.trim() !== "") {
      offspringCount = Number(offspring);
      if (!Number.isInteger(offspringCount) || offspringCount < 0) {
        return setError("Offspring must be a whole number, or left blank.");
      }
    }

    if (source === "bought" && priceShillings !== null) {
      if (!Number.isFinite(priceShillings) || priceShillings < 0) {
        return setError("A price must be a whole number of shillings, or left blank.");
      }
    }

    setSaving(true);
    setError(null);
    try {
      const record = await createRecord({
        kind,
        species,
        tag: trimmed,
        breed: breed.trim() || null,
        sex: isGroup ? null : sex,
        date_of_birth: isGroup ? null : dob || null,
        // Kept for an animal too; it used to be dropped here (see createRecord).
        arrival_date: arrival || null,
        head_count: head,
        source,
        notes: notes.trim() || null,
        room_id: roomId || null,
        date: arrival,
        price: source === "bought" ? priceShillings : null,
        seller: source === "bought" ? seller : null,
      });

      // Offspring is not part of createRecord's shape — it is a hand-typed
      // figure that carries its own "last updated" stamp (SPEC 3.4), so it is
      // written as an edit rather than smuggled into creation.
      if (offspringCount !== null) {
        await updateRecord(record.id, { offspring_count: offspringCount });
      }

      navigate(`/records/${record.id}`, { replace: true });
    } catch (cause) {
      setError((cause as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="pb-44 md:pb-8 max-w-3xl">
      <Segmented
        label="What is being added"
        value={kind}
        options={[
          { value: "animal", label: "Single animal" },
          { value: "group", label: "Group" },
        ]}
        onChange={(v) => setKind(v as RecordKind)}
      />

      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">Species</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {ALL_SPECIES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSpecies(option)}
              className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                species === option
                  ? "bg-primary-container text-white border-primary-container"
                  : "bg-card text-text border-border"
              }`}
            >
              {species === option && <CheckIcon className="w-4 h-4" />}
              {speciesLabel(option)}
            </button>
          ))}
        </div>
      </section>

      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">Identification</h2>

        <Field label={isGroup ? "Group name" : "Tag"} htmlFor="add-tag">
          <input
            id="add-tag" className="field font-mono" value={tag} autoFocus
            placeholder={isGroup ? "P-Weaners" : "C-084"}
            onChange={(e) => setTag(e.target.value)}
          />
        </Field>

        <Field label="Breed" htmlFor="add-breed" hint="Free text — there is no fixed breed list.">
          <input
            id="add-breed" className="field" value={breed} placeholder="Friesian"
            onChange={(e) => setBreed(e.target.value)}
          />
        </Field>

        {isGroup ? (
          <>
            <Field label="Head count" htmlFor="add-head">
              <input
                id="add-head" className="field font-mono" value={headCount} inputMode="numeric"
                onChange={(e) => setHeadCount(e.target.value)}
              />
            </Field>
            <Field label="Arrived" htmlFor="add-arrival">
              <input
                id="add-arrival" type="date" className="field font-mono" value={arrival}
                max={todayInEAT()} onChange={(e) => setArrival(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Segmented
              label="Sex"
              value={sex}
              options={[
                { value: "female", label: "Female" },
                { value: "male", label: "Male" },
              ]}
              onChange={(v) => setSex(v as Sex)}
            />
            <Field label="Date of birth" htmlFor="add-dob">
              <input
                id="add-dob" type="date" className="field font-mono" value={dob}
                max={todayInEAT()} onChange={(e) => setDob(e.target.value)}
              />
            </Field>
            <Field label="Arrived" htmlFor="add-arrival">
              <input
                id="add-arrival" type="date" className="field font-mono" value={arrival}
                max={todayInEAT()} onChange={(e) => setArrival(e.target.value)}
              />
            </Field>
            <Field
              label={sex === "male" ? "Offspring sired" : "Offspring"}
              htmlFor="add-offspring"
              hint="Typed by hand, never counted for you."
            >
              <input
                id="add-offspring" className="field font-mono" value={offspring} inputMode="numeric"
                placeholder="Leave blank if unknown"
                onChange={(e) => setOffspring(e.target.value)}
              />
            </Field>
          </>
        )}

        <Field label="Room" htmlFor="add-room">
          <select
            id="add-room" className="field" value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="">Not placed yet</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.code} · {room.name}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="card p-4 mt-4">
        <h2 className="text-headline-sm text-primary">How it arrived</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {SOURCES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSource(option.value)}
              className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                source === option.value
                  ? "bg-primary-container text-white border-primary-container"
                  : "bg-card text-text border-border"
              }`}
            >
              {source === option.value && <CheckIcon className="w-4 h-4" />}
              {option.label}
            </button>
          ))}
        </div>

        {source === "bought" && (
          <>
            <Field
              label="Price (UGX)"
              htmlFor="add-price"
              hint={
                priceShillings !== null && Number.isFinite(priceShillings) && priceShillings > 0
                  ? formatUGX(priceShillings)
                  : "Whole shillings. Leave blank if it is not known."
              }
            >
              <input
                id="add-price" className="field font-mono" value={price} inputMode="numeric"
                placeholder="1500000" onChange={(e) => setPrice(e.target.value)}
              />
            </Field>
            <Field label="Seller" htmlFor="add-seller">
              <input
                id="add-seller" className="field" value={seller} placeholder="Who it came from"
                onChange={(e) => setSeller(e.target.value)}
              />
            </Field>
          </>
        )}
      </section>

      <section className="card p-4 mt-4">
        <Field label="Notes" htmlFor="add-notes">
          <textarea
            id="add-notes" className="field h-auto py-3" rows={3} value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </section>

      {error && (
        <p className="mt-4 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
      )}

      {/* This screen owns the bottom of the display, so it is a FOCUSED_ROUTE
          and its bar replaces the navigation rather than stacking with it. */}
      <div className="fixed inset-x-0 bottom-0 z-30 bg-card shadow-card-up p-4 md:static md:bg-transparent md:shadow-none md:px-0">
        <button
          type="button"
          className="btn-action w-full text-headline-sm h-14 md:max-w-xs"
          disabled={saving}
          onClick={() => void submit()}
        >
          <PlusIcon className="w-6 h-6" />
          {saving ? "Adding…" : isGroup ? "Add group" : "Add animal"}
        </button>
      </div>
    </div>
  );
}

function Field({
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
    // Focusing a field — tabbing, or the keyboard opening — scrolls it into
    // view, and the action bar is `fixed bottom-0`. `scroll-mb` reserves that
    // bar's height so the field being typed into never lands underneath it.
    <div className="mt-4 scroll-mb-44">
      <label className="data-label block mb-1" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="text-body-md text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="data-label mb-2">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 min-w-[120px] min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
              value === option.value
                ? "bg-primary-container text-white border-primary-container"
                : "bg-card text-text border-border"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
