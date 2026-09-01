import { useState } from "react";

import { PlusIcon } from "../components/Icons";
import { getDeviceId, newId, nowIso } from "../db/ids";
import { db } from "../db/schema";
import type { Customer, Vet } from "../db/types";
import { useLiveQuery } from "../sync/useSync";

/**
 * Customers and Vets — SPEC 3.11.
 *
 * Both are a name and a way to reach someone, so they are one screen with two
 * shapes rather than two near-identical ones. They are state entities, so an
 * edit merges per field: two devices correcting different halves of the same
 * phone number both keep their correction (SPEC 5.4).
 */
export function ContactsScreen({ kind }: { kind: "customer" | "vet" }) {
  const isCustomer = kind === "customer";
  const rows = useLiveQuery(
    async () => {
      const all = isCustomer ? await db.customers.toArray() : await db.vets.toArray();
      return all.filter((row) => !row.deleted_at).sort((a, b) => a.name.localeCompare(b.name));
    },
    [isCustomer],
    [] as Array<Customer | Vet>,
  );

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return setError(isCustomer ? "A customer needs a name." : "A vet needs a name.");

    const device_id = await getDeviceId();
    const at = nowIso();
    const base = {
      id: newId(),
      created_at: at,
      updated_at: at,
      device_id,
      deleted_at: null,
      name: trimmed,
      phone: phone.trim() || null,
      notes: null,
    };

    if (isCustomer) {
      const customer: Customer = { ...base, location: location.trim() || null };
      await db.transaction("rw", db.customers, db.outbox, async () => {
        await db.customers.add(customer);
        await db.outbox.add({
          op: "upsert",
          entity: "customer",
          id: customer.id,
          data: {
            name: customer.name,
            phone: customer.phone,
            location: customer.location,
            notes: customer.notes,
          },
          updated_at: customer.updated_at,
          queued_at: at,
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
        });
      });
    } else {
      const vet: Vet = base;
      await db.transaction("rw", db.vets, db.outbox, async () => {
        await db.vets.add(vet);
        await db.outbox.add({
          op: "upsert",
          entity: "vet",
          id: vet.id,
          data: { name: vet.name, phone: vet.phone, notes: vet.notes },
          updated_at: vet.updated_at,
          queued_at: at,
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
        });
      });
    }

    setName("");
    setPhone("");
    setLocation("");
    setError(null);
  }

  return (
    <div className="pb-8 max-w-3xl">
      <div className="card p-4">
        <label className="data-label block mb-1" htmlFor="contact-name">Name</label>
        <input
          id="contact-name" className="field" value={name}
          placeholder={isCustomer ? "Who buys from you" : "Who treats the animals"}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="data-label block mt-4 mb-1" htmlFor="contact-phone">Phone</label>
        <input
          id="contact-phone" className="field font-mono" value={phone} inputMode="tel"
          onChange={(e) => setPhone(e.target.value)}
        />

        {isCustomer && (
          <>
            <label className="data-label block mt-4 mb-1" htmlFor="contact-location">Location</label>
            <input
              id="contact-location" className="field" value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}

        <button type="button" className="btn-secondary w-full mt-4" onClick={() => void add()}>
          <PlusIcon className="w-5 h-5" />
          Add {isCustomer ? "customer" : "vet"}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          No {isCustomer ? "customers" : "vets"} yet.
        </p>
      ) : (
        <ul className="mt-4 grid gap-2 md:grid-cols-2">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="card p-4">
                <p className="text-body-lg font-semibold truncate">{row.name}</p>
                {row.phone && <p className="data-value text-text-muted">{row.phone}</p>}
                {"location" in row && row.location && (
                  <p className="text-body-md text-text-muted">{row.location}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
