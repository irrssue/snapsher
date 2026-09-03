/**
 * Single entry point for every call to the API, so credentials, the CSRF
 * header, and error handling can't be forgotten one endpoint at a time.
 */

/**
 * Two names, because the server picks between them at boot. Over HTTPS it sets
 * `__Host-csrf`, a prefix the browser only honours on a `Secure` cookie and
 * which no sibling subdomain can forge; over plain HTTP — local development —
 * that prefix would make the browser drop the cookie outright, so the bare name
 * is used instead. The prefixed one is checked first so that a stale bare
 * cookie left over from before the rename can never win.
 */
const CSRF_COOKIES = ["__Host-csrf", "csrf"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Long enough that a slow phone upload finishes, short enough that a request
 * the tunnel silently dropped still ends. Without a deadline `fetch` waits
 * forever, and every in-flight flag in the app — `sharing`, `submitting`,
 * `sending`, `uploading` — stays raised for the life of the tab, leaving a
 * disabled button and a spinner as the app's final state.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * The whole parsed error payload. Several failures carry a field the caller
   * needs to recover properly rather than just something to display — a 429
   * from `POST /api/posts` reports the `nextAllowedAt` that caused it, and
   * without it a second tab never learns its posting window is spent.
   */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sessionExpiredListeners = new Set<() => void>();

/** Fires when the server reports the session is gone, so the UI can sign out. */
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

function readCsrfToken(): string | null {
  const found = new Map<string, string>();
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.split("=");
    const trimmed = name.trim();
    if (CSRF_COOKIES.includes(trimmed) && !found.has(trimmed)) {
      const raw = rest.join("=").trim();
      try {
        found.set(trimmed, decodeURIComponent(raw));
      } catch {
        // A stray `%` makes `decodeURIComponent` throw a URIError, and this
        // function runs before every non-GET request — one malformed cookie in
        // the jar would otherwise break liking, commenting, posting and signing
        // in all at once. The server wraps the same call for the same reason;
        // take the value as-is and let the comparison fail honestly instead.
        found.set(trimmed, raw);
      }
    }
  }
  for (const name of CSRF_COOKIES) {
    const value = found.get(name);
    if (value !== undefined) return value;
  }
  return null;
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  /** Set on the session probe at startup, where a 401 just means "not signed in yet". */
  silenceSessionExpiry?: boolean;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, silenceSessionExpiry, ...init } = options;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (!SAFE_METHODS.has(method)) {
    // The cookie is readable to us and unreadable to any other origin, which
    // is what makes echoing it back a proof the request came from this app.
    const token = readCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      method,
      headers,
      credentials: "include",
      // Callers may pass their own signal (a longer deadline for an upload, or
      // one they abort themselves); this is only the floor under the ones that
      // don't.
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Both abort flavours surface as a DOMException: `TimeoutError` from the
    // deadline above, `AbortError` from a caller's own signal. Neither is a
    // server answer, so neither can be reported as one — but both are worth
    // retrying, which is the one thing the message has to convey.
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ApiError("That took too long. Check your connection and try again.", 0, "timeout");
    }
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again.",
      0,
      "network",
    );
  }

  const payload =
    res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>);

  if (!res.ok) {
    const code = typeof payload.code === "string" ? payload.code : undefined;
    // Any 401 ends the session, not just `session_expired`. That code is only
    // emitted when a cookie was actually presented; a cookie that is simply
    // *gone* — cleared site data, an ITP eviction — answers `not_authenticated`
    // instead, and the SPA used to keep rendering the signed-in shell around a
    // session that no longer existed, failing every write inside it.
    if (res.status === 401 && !silenceSessionExpiry) {
      for (const listener of sessionExpiredListeners) listener();
    }
    const message =
      typeof payload.error === "string"
        ? payload.error
        : "Something went wrong. Please try again.";
    throw new ApiError(message, res.status, code, payload);
  }

  return payload as T;
}

/**
 * A 200 is not proof the body is what we asked for. `res.json()` failing turns
 * any non-JSON success — a tunnel's HTML error page, a Cloudflare interstitial
 * — into `{}`, and the blind `payload as T` above then hands a component
 * `undefined` where it expects an array. `posts.map` throws during render and,
 * with the error boundary catching it, the whole app is replaced by a recovery
 * screen for what is really a transient network fault.
 *
 * So every wrapper below states the shape it expects and a violation becomes a
 * caught, retryable error instead of a corrupt state write.
 */
function badShape(what: string): ApiError {
  return new ApiError(
    "The server sent something we couldn't read. Please try again.",
    502,
    "bad_response",
    { what },
  );
}

export function expectArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw badShape(what);
  return value as T[];
}

export function expectObject<T>(value: unknown, what: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badShape(what);
  return value as T;
}

export function expectNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw badShape(what);
  return value;
}

export function expectBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw badShape(what);
  return value;
}
