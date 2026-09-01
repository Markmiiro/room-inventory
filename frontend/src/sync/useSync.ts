import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { syncEngine, type SyncStatus } from "./engine";

export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(syncEngine.getStatus());
  useEffect(() => syncEngine.subscribe(setStatus), []);
  return status;
}

export { useLiveQuery };
