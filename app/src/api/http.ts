/**
 * Single entry point for every call to the API, so credentials, the CSRF
 * header, and error handling can't be forgotten one endpoint at a time.
 */

const CSRF_COOKIE = "csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name.trim() === CSRF_COOKIE) return decodeURIComponent(rest.join("=").trim());
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
    throw new ApiError(message, res.status, code);
  }

  return payload as T;
}
