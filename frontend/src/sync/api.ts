import type { EntityName } from "../db/types";

/** HTTP client for the sync and auth endpoints.
 *
 *  SPEC 8: an auth failure must never wipe local data. Nothing in this module
 *  touches IndexedDB — it reports failures upward and lets the app carry on
 *  working from the device.
 */

const BASE_URL = import.meta.env.VITE_API_BASE ?? "/api";

export interface OperationResult {
  id: string;
  entity: EntityName;
  status: "applied" | "duplicate" | "conflict" | "rejected";
  server?: Record<string, unknown> | null;
  message?: string | null;
}

export interface PushResponse {
  results: OperationResult[];
  head_seq: number;
  server_time: string;
}

export interface PullChange {
  entity: EntityName;
  id: string;
  seq: number;
  data: Record<string, unknown>;
}

export interface PullResponse {
  changes: PullChange[];
  cursor: number;
  has_more: boolean;
  server_time: string;
}

/** RFC 7807, with the `code` the outbox branches on (SPEC 7). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Whether retrying could ever succeed. A 4xx that is not auth or rate
   *  limiting will fail identically forever, and must not hold up the outbox. */
  get retryable(): boolean {
    if (this.status === 401 || this.status === 429) return true;
    return this.status >= 500 || this.status === 0;
  }
}

let accessToken: string | null = null;
let refreshToken: string | null = null;

export function setTokens(access: string | null, refresh: string | null): void {
  accessToken = access;
  refreshToken = refresh;
  if (access) localStorage.setItem("access_token", access);
  else localStorage.removeItem("access_token");
  if (refresh) localStorage.setItem("refresh_token", refresh);
  else localStorage.removeItem("refresh_token");
}

export function loadTokens(): void {
  accessToken = localStorage.getItem("access_token");
  refreshToken = localStorage.getItem("refresh_token");
}

export function hasTokens(): boolean {
  return accessToken !== null;
}

async function request<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });
  } catch (cause) {
    // No network. Not an error the user needs to see — this is the normal
    // state in a building with no coverage.
    throw new ApiError(0, "offline", String(cause));
  }

  if (response.status === 401 && retryOn401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init, false);
  }

  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      problem.code ?? "error",
      problem.title ?? `Request failed with ${response.status}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function tryRefresh(): Promise<boolean> {
  try {
    const tokens = await request<{ access_token: string; refresh_token: string }>(
      "/auth/refresh",
      { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) },
      false,
    );
    setTokens(tokens.access_token, tokens.refresh_token);
    return true;
  } catch {
    // SPEC 8: the refresh token may well have expired while the device was
    // offline. Clear the tokens so the app knows to ask for a password next
    // time it reaches the server — and leave every local row untouched.
    setTokens(null, null);
    return false;
  }
}

export async function login(password: string): Promise<void> {
  const tokens = await request<{ access_token: string; refresh_token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  setTokens(tokens.access_token, tokens.refresh_token);
}

export async function pushOperations(
  device_id: string,
  operations: Array<Record<string, unknown>>,
): Promise<PushResponse> {
  return request<PushResponse>("/sync/push", {
    method: "POST",
    body: JSON.stringify({ device_id, operations }),
  });
}

export async function pullChanges(since: number, limit = 500): Promise<PullResponse> {
  return request<PullResponse>(`/sync/pull?since=${since}&limit=${limit}`);
}
