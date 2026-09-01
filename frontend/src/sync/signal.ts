/**
 * A one-line signal from the write path to the sync engine.
 *
 * The mutation layer must not depend on the engine directly. It writes to
 * IndexedDB and returns, and whether anything is listening is none of its
 * business — that is the whole point of SPEC 5.1. This also keeps the two
 * testable apart: a test that never starts an engine gets no background work.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Something was queued. Drain it when convenient. */
export function announceLocalChange(): void {
  for (const listener of listeners) listener();
}

export function onLocalChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
