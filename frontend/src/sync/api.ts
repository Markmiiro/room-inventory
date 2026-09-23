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
    // A response that was not JSON did not come from this API at all, so its
    // status says nothing about whether retrying could work. It is almost
    // always a misconfigured base URL, which is fixed by a redeploy rather than
    // by anything the device can do — so it must not be treated as a permanent
    // failure that lets queued work be discarded.
    if (this.code === NOT_JSON) return true;
    return this.status >= 500 || this.status === 0;
  }
}

/** `code` for a response whose body was not JSON. See `expectJson`. */
export const NOT_JSON = "not_json";

/**
 * Whether a response actually carries a JSON body.
 *
 * This exists because of a specific, silent failure. If `VITE_API_BASE` is
 * wrong — most easily by omitting the scheme, which makes it a relative URL
 * that resolves against the app's own origin — every request lands on the
 * static frontend server instead of the API. That server answers a GET with
 * `200 OK` and the contents of `index.html`, because serving the app shell for
 * unknown paths is exactly what a single-page app needs it to do.
 *
 * So the sync engine saw a 200 and a body, and the only thing that went wrong
 * was a JSON parse error thrown from somewhere it was not expected. Nothing
 * about the failure said "you are talking to the wrong server", and with an
 * empty outbox the indicator went on reporting Synced.
 *
 * Checking the content type turns that into a plain, named failure. Anything
 * that is not JSON is not an answer from this API, whatever its status code.
 */
function isJson(response: Response): boolean {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  // Strip any `; charset=utf-8`, then accept `application/json` and the
  // structured-suffix forms the API also uses, such as
  // `application/problem+json` for RFC 7807 errors (SPEC 7).
  const mime = type.split(";")[0]!.trim();
  return mime === "application/json" || mime.endsWith("+json");
}

/** The wrong-server message, which names the cause rather than the symptom. */
function notJson(response: Response): ApiError {
  const type = response.headers.get("content-type") ?? "none";
  return new ApiError(
    response.status,
    NOT_JSON,
    `The server replied with ${type} rather than JSON. ` +
      "This is not a response from the API — the request is most likely not " +
      "reaching it. Check that VITE_API_BASE names the backend, with its " +
      "scheme and no path.",
  );
}

/**
 * SPEC 21 — whether this server asks for a password.
 *
 * Three values, and the third is not a placeholder. `unknown` is the state of
 * a device that has not reached the server since it was installed, which on
 * this app is an ordinary state rather than a startup blip: the whole point is
 * that it works for days with no signal. So the value is cached in
 * localStorage and survives a restart, and the UI is written to cope with not
 * knowing yet.
 *
 * It is never guessed from a build-time variable. The server is the only thing
 * that knows, and a frontend deployed against a server whose flag was later
 * flipped would otherwise be confidently wrong in whichever direction it was
 * built — either hiding the only way to sign in, or asking for a password
 * nobody has.
 */
export type AuthState = "required" | "off" | "unknown";

const AUTH_STATE_KEY = "auth_state";

function readStoredAuthState(): AuthState {
  const stored = localStorage.getItem(AUTH_STATE_KEY);
  return stored === "required" || stored === "off" ? stored : "unknown";
}

let authState: AuthState = readStoredAuthState();
const authListeners = new Set<(state: AuthState) => void>();

export function getAuthState(): AuthState {
  return authState;
}

/** Subscribe to changes, so the sync panel stops offering a password box the
 *  moment the server says it does not want one. */
export function onAuthStateChange(listener: (state: AuthState) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function setAuthState(next: AuthState): void {
  if (next === authState) return;
  authState = next;
  localStorage.setItem(AUTH_STATE_KEY, next);
  for (const listener of authListeners) listener(next);
}

/**
 * Ask the server whether it wants a token (SPEC 21).
 *
 * Unauthenticated, one boolean, and safe to call on every sync tick. A failure
 * is not an error the user needs to see — it means there is no network, which
 * is the normal state in a building with no coverage — so the cached answer
 * stands and the caller carries on.
 */
export async function refreshAuthState(): Promise<AuthState> {
  try {
    const config = await request<{ auth_enabled: boolean }>("/config", {}, false);
    setAuthState(config.auth_enabled ? "required" : "off");
  } catch {
    // Keep what we had. An old answer is better than a guess, and a wrong
    // guess here either hides sign-in or demands a password that does not
    // exist.
  }
  return authState;
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
        // Nothing is sent while the server says it does not want one. A device
        // that signed in before the flag was flipped is holding a token that
        // means nothing now, and sending it would only invite confusion in a
        // log (SPEC 21).
        ...(accessToken && authState !== "off" ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });
  } catch (cause) {
    // No network. Not an error the user needs to see — this is the normal
    // state in a building with no coverage.
    throw new ApiError(0, "offline", String(cause));
  }

  if (response.status === 401) {
    // The server is asking after all — whatever this device last cached, or a
    // flag flipped back on from the host's dashboard while it was offline. The
    // sign-in control has to reappear, and it is this that makes it (SPEC 21).
    setAuthState("required");
  }

  if (response.status === 401 && retryOn401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init, false);
  }

  if (!response.ok) {
    // An error page from the wrong server is not an API error, and reporting it
    // as one would hide the actual problem behind a generic "Request failed".
    if (!isJson(response)) throw notJson(response);
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      problem.code ?? "error",
      problem.title ?? `Request failed with ${response.status}`,
    );
  }

  // A 204 carries no body at all, so there is nothing to validate.
  if (response.status === 204) return undefined as T;

  // Everything else must be JSON. A 200 that is not is the wrong server
  // answering, and must never be mistaken for a successful sync.
  if (!isJson(response)) throw notJson(response);

  try {
    return (await response.json()) as T;
  } catch {
    // The header claimed JSON and the body was not. Rarer, but the same lie,
    // so it gets the same answer rather than an unhandled SyntaxError escaping
    // into the engine.
    throw notJson(response);
  }
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
