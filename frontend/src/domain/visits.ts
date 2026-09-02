import type { HealthRecord, VetVisit, VisitNote } from "../db/types";

/**
 * SPEC 14 — vet visits, and what the call-out fee costs each animal.
 *
 * The fee is the whole reason this module exists. SPEC 14.3:
 *
 *   Split **evenly across the animals seen on that visit**, where "seen" means
 *   having either a treatment or a note against them in that visit. This is a
 *   direct cost, not the head-day allocation of SPEC 4.4 — a call-out is paid
 *   per journey, not per day of feeding.
 *
 * That contrast is the point. Feed is spread by head-days because ten head for
 * a fortnight really did eat twice what five head for a fortnight ate. A
 * call-out is one journey: the vet drove out once, and an animal that was
 * looked at for a minute cost the same share of that drive as one that was
 * treated for an hour. Weighting it by head or by days would be inventing a
 * proportionality that does not exist.
 *
 * Everything here is pure, so the same split is shown on the visit, on the
 * record and on the Money summary.
 */

/** SPEC 14.4 — a treatment and a note both count the animal as seen. */
export interface VisitInputs {
  visit: VetVisit;
  health: HealthRecord[];
  notes: VisitNote[];
}

/**
 * The records seen on a visit, as a set of ids.
 *
 * A record treated *and* noted is seen once. Without the set it would take two
 * shares of the fee, which is the arithmetic the "seen" wording is there to
 * prevent.
 */
export function recordsSeen({ visit, health, notes }: VisitInputs): string[] {
  const seen = new Set<string>();
  for (const treatment of health) {
    if (treatment.deleted_at) continue;
    if (treatment.visit_id !== visit.id) continue;
    seen.add(treatment.record_id);
  }
  for (const note of notes) {
    if (note.deleted_at) continue;
    if (note.visit_id !== visit.id) continue;
    seen.add(note.record_id);
  }
  // Sorted so the order does not depend on which table was read first, which
  // is what keeps the remainder below landing on the same records every time.
  return [...seen].sort();
}

export interface FeeSplit {
  /** Shillings charged to each record seen. Empty when nothing is allocated. */
  perRecord: Map<string, number>;
  /** The whole fee, whether or not any of it could be allocated. */
  total: number;
  /** Shillings that reached no record. SPEC 14.3 keeps this in the farm total. */
  unallocated: number;
  seenCount: number;
}

/**
 * Split one visit's call-out fee across the animals it saw.
 *
 * Money is whole shillings everywhere in this app (SPEC 1), so a fee that does
 * not divide evenly cannot simply be divided — the shares would either be
 * fractions or would not add back up to what was paid. The remainder is handed
 * out one shilling at a time to the first records in id order, so the shares
 * always sum to exactly the fee.
 *
 * A visit with a fee but no animals attached leaves the whole fee unallocated.
 * SPEC 14.3 is explicit that it still counts in the farm total, and Money
 * Summary already says that per-record figures will not sum to the farm figure.
 */
export function splitCallOutFee(inputs: VisitInputs): FeeSplit {
  const total = inputs.visit.call_out_fee ?? 0;
  const seen = recordsSeen(inputs);

  if (total <= 0 || seen.length === 0) {
    return {
      perRecord: new Map(),
      total,
      unallocated: total > 0 ? total : 0,
      seenCount: seen.length,
    };
  }

  const base = Math.floor(total / seen.length);
  let remainder = total - base * seen.length;

  const perRecord = new Map<string, number>();
  for (const recordId of seen) {
    // The remainder is a handful of shillings at most, spread one per record
    // rather than dumped on one of them.
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    perRecord.set(recordId, base + extra);
  }

  return { perRecord, total, unallocated: 0, seenCount: seen.length };
}

/**
 * What one record carries in call-out fees across every visit.
 *
 * A direct cost, so it belongs beside purchase price and treatment cost in the
 * per-record profit of SPEC 4.5 — not in the estimated expense share.
 */
export function callOutFeeFor(
  recordId: string,
  visits: VetVisit[],
  health: HealthRecord[],
  notes: VisitNote[],
): number {
  let total = 0;
  for (const visit of visits) {
    if (visit.deleted_at) continue;
    // A planned visit has not happened and has cost nothing yet. Charging for
    // it would put money against an animal for a journey nobody has made.
    if (visit.status !== "completed") continue;
    total += splitCallOutFee({ visit, health, notes }).perRecord.get(recordId) ?? 0;
  }
  return total;
}

/** Every completed visit's fee, allocated or not — the farm-level figure. */
export function totalCallOutFees(visits: VetVisit[]): number {
  return visits
    .filter((visit) => !visit.deleted_at && visit.status === "completed")
    .reduce((sum, visit) => sum + (visit.call_out_fee ?? 0), 0);
}

/**
 * One visit, with the things a screen needs to draw a row for it.
 *
 * Sorted planned-first and then by date, which is what SPEC 14.5 asks the list
 * for: a planned visit is the one you can still act on.
 */
export interface VisitSummary {
  visit: VetVisit;
  seenCount: number;
  fee: number;
}

export function summariseVisits(
  visits: VetVisit[],
  health: HealthRecord[],
  notes: VisitNote[],
): VisitSummary[] {
  return visits
    .filter((visit) => !visit.deleted_at)
    .map((visit) => ({
      visit,
      seenCount: recordsSeen({ visit, health, notes }).length,
      fee: visit.call_out_fee ?? 0,
    }))
    .sort((a, b) => {
      // Planned first, whatever their dates: they are the ones still to happen.
      if (a.visit.status !== b.visit.status) return a.visit.status === "planned" ? -1 : 1;
      // Planned visits read soonest-first, completed ones most-recent-first.
      const order = a.visit.date.localeCompare(b.visit.date);
      return a.visit.status === "planned" ? order : -order;
    });
}

/** One record's visit notes, newest first — its observations (SPEC 14.5). */
export function notesForRecord(notes: VisitNote[], recordId: string): VisitNote[] {
  return notes
    .filter((note) => !note.deleted_at && note.record_id === recordId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
