import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { getAuthState, onAuthStateChange, type AuthState } from "./api";
import { syncEngine, type SyncStatus } from "./engine";

export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(syncEngine.getStatus());
  useEffect(() => syncEngine.subscribe(setStatus), []);
  return status;
}

/** SPEC 21 — whether this server asks for a password, as the client currently
 *  understands it. Subscribed rather than read once: the answer arrives from
 *  the first sync tick, which is usually after the panel has already been
 *  drawn. */
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>(getAuthState);
  useEffect(() => onAuthStateChange(setState), []);
  return state;
}

export { useLiveQuery };
