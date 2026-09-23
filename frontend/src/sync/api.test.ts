import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  NOT_JSON,
  getAuthState,
  login,
  pullChanges,
  pushOperations,
  refreshAuthState,
  setTokens,
} from "./api";

/**
 * The wrong-server case.
 *
 * If `VITE_API_BASE` is wrong — most easily by omitting the scheme, which makes
 * it a relative URL that resolves against the app's own origin — every request
 * lands on the static frontend server instead of the API. That server answers a
 * GET with `200 OK` and the contents of `index.html`, because serving the app
 * shell for unknown paths is what a single-page app needs it to do.
 *
 * A 200 with a body is what a successful sync looks like from the outside, so
 * nothing downstream noticed. These tests pin the rule that stops it: a
 * response that is not JSON is not an answer from this API, whatever its status
 * code says.
 */

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><title>Room Inventory</title></head><body><div id="root"></div></body></html>`;

function reply(body: string, init: { status?: number; type?: string | null } = {}): Response {
  const headers = new Headers();
  if (init.type !== null) headers.set("content-type", init.type ?? "application/json");
  return new Response(body, { status: init.status ?? 200, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a 200 that is not JSON", () => {
  it("fails a pull rather than reporting a successful sync", async () => {
    // Exactly what the SPA fallback returns: 200, text/html, the app shell.
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: "text/html" }));

    await expect(pullChanges(0)).rejects.toBeInstanceOf(ApiError);
  });

  it("names the cause rather than the symptom", async () => {
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: "text/html; charset=utf-8" }));

    const error = (await pullChanges(0).catch((e: ApiError) => e)) as ApiError;
    expect(error.code).toBe(NOT_JSON);
    // The person reading this needs to know it is a deploy setting, not a
    // transient network problem they should wait out.
    expect(error.message).toContain("VITE_API_BASE");
    expect(error.message).toContain("text/html");
  });

  it("fails a push, so queued work is never silently dropped", async () => {
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: "text/html" }));

    await expect(pushOperations("device-a", [])).rejects.toMatchObject({ code: NOT_JSON });
  });

  it("fails a login", async () => {
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: "text/html" }));

    await expect(login("hunter2")).rejects.toMatchObject({ code: NOT_JSON });
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("stays retryable, so nothing queued is discarded over a config mistake", async () => {
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: "text/html" }));

    const error = (await pullChanges(0).catch((e: ApiError) => e)) as ApiError;
    // A wrong base URL is fixed by a redeploy, not by the device giving up on
    // its outbox. `retryable` is false for an ordinary 200, so this is the
    // NOT_JSON rule doing the work rather than the status code.
    expect(error.retryable).toBe(true);
  });

  it("rejects a response with no content type at all", async () => {
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: null }));

    await expect(pullChanges(0)).rejects.toMatchObject({ code: NOT_JSON });
  });

  it("rejects a body that is not JSON even when the header claims it is", async () => {
    // The header lies. Without the guarded parse this escapes as a raw
    // SyntaxError from somewhere the engine was not expecting one.
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { type: "application/json" }));

    await expect(pullChanges(0)).rejects.toMatchObject({ code: NOT_JSON });
  });
});

describe("an error status that is not JSON", () => {
  it("reports the wrong server rather than a generic request failure", async () => {
    // A 404 from the frontend's own static server, which is what a wrong base
    // URL produces for a POST.
    fetchMock.mockResolvedValue(reply(INDEX_HTML, { status: 404, type: "text/html" }));

    const error = (await pullChanges(0).catch((e: ApiError) => e)) as ApiError;
    expect(error.code).toBe(NOT_JSON);
    expect(error.status).toBe(404);
  });
});

describe("what still works", () => {
  it("accepts a normal JSON response", async () => {
    fetchMock.mockResolvedValue(
      reply(
        JSON.stringify({ changes: [], cursor: 7, has_more: false, server_time: "2026-09-02T00:00:00Z" }),
      ),
    );

    await expect(pullChanges(0)).resolves.toMatchObject({ cursor: 7, has_more: false });
  });

  it("accepts a charset on the content type", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ changes: [], cursor: 0, has_more: false, server_time: "x" }), {
        type: "application/json; charset=utf-8",
      }),
    );

    await expect(pullChanges(0)).resolves.toMatchObject({ cursor: 0 });
  });

  it("accepts the problem+json the API uses for errors (SPEC 7)", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ code: "bad_credentials", title: "Password is not correct" }), {
        status: 401,
        type: "application/problem+json",
      }),
    );

    const error = (await login("wrong").catch((e: ApiError) => e)) as unknown as ApiError;
    // The real API error survives: it is not swallowed by the new check.
    expect(error.code).toBe("bad_credentials");
    expect(error.message).toBe("Password is not correct");
  });

  it("still treats a dropped connection as offline, not as a bad response", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = (await pullChanges(0).catch((e: ApiError) => e)) as ApiError;
    expect(error.status).toBe(0);
    expect(error.code).toBe("offline");
  });
});


/**
 * SPEC 21 — how the client learns whether this server wants a password.
 *
 * The rule that matters most is the last one: a 401 promotes the state to
 * `required` whatever was cached, because that is what makes the flag safe to
 * turn back on. A device that was offline when it happened has to find out from
 * the first refusal rather than from a support call.
 */
describe("the auth state", () => {
  beforeEach(() => {
    localStorage.clear();
    setTokens(null, null);
  });

  it("reads `off` from the server's one boolean", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ auth_enabled: false })));

    expect(await refreshAuthState()).toBe("off");
    expect(getAuthState()).toBe("off");
  });

  it("reads `required` the same way", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ auth_enabled: true })));

    expect(await refreshAuthState()).toBe("required");
  });

  it("keeps the cached answer when the server cannot be reached", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ auth_enabled: false })));
    await refreshAuthState();

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    // An old answer beats a guess: guessing wrong either hides the only way to
    // sign in or demands a password that does not exist.
    expect(await refreshAuthState()).toBe("off");
  });

  it("sends no token while the server says it wants none", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ auth_enabled: false })));
    await refreshAuthState();
    setTokens("stale-token-from-before-the-flag-changed", "stale-refresh");

    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ changes: [], cursor: 0, has_more: false, server_time: "" })),
    );
    await pullChanges(0);

    const headers = new Headers(fetchMock.mock.calls.at(-1)![1].headers);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("promotes itself to `required` on a 401, whatever was cached", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ auth_enabled: false })));
    await refreshAuthState();
    expect(getAuthState()).toBe("off");

    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ code: "not_authenticated", title: "Authentication required" }), {
        status: 401,
        type: "application/problem+json",
      }),
    );
    await pullChanges(0).catch(() => undefined);

    // The flag was turned back on while this device was away.
    expect(getAuthState()).toBe("required");
  });
});
