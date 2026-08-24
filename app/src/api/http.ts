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
      found.set(trimmed, decodeURIComponent(rest.join("=").trim()));
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

  const res = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload =
    res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>);

  if (!res.ok) {
    const code = typeof payload.code === "string" ? payload.code : undefined;
    if (code === "session_expired" && !silenceSessionExpiry) {
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
