import type { AuthContext } from "../sessions.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by `attachSession` when the request carries a live session. */
      auth?: AuthContext;
    }
  }
}

export {};
