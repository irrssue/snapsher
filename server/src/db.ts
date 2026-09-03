import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable so a test run can point at a throwaway file instead of the
// database the homeserver is actually serving from.
const dbFile = process.env.DB_FILE || path.join(__dirname, "..", "data.db");
export const db = new Database(dbFile);

db.pragma("journal_mode = WAL");

/**
 * SQLite creates these 0644 by default, which left every local account and
 * every unrelated process on the homeserver able to read the bcrypt password
 * hashes, every email address, the session table, and `pending_signups` —
 * which holds password hashes for accounts that don't exist yet. Session ids
 * are stored as SHA-256 so they can't be replayed, but the hashes can be
 * attacked offline and the address list is directly useful.
 *
 * Applied in code rather than by hand so it also holds on the homeserver, after
 * a fresh checkout, and on whatever the file is copied into — the mode is what
 * a backup carries with it. Run after `journal_mode = WAL` so the `-wal` and
 * `-shm` files exist by now; a missing one is not an error, since WAL recreates
 * them with the database's own mode.
 */
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.chmodSync(dbFile + suffix, 0o600);
  } catch {
    // Not present yet, or not ours to chmod. Neither is worth refusing to boot.
  }
}

// SQLite ignores REFERENCES clauses unless this is on, which quietly made every
// `ON DELETE CASCADE` below a no-op.
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_file TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// SQLite has no `ADD COLUMN IF NOT EXISTS`, so a table created before avatars
// existed needs this checked and applied by hand.
const userColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userColumns.some((column) => column.name === "avatar_file")) {
  db.exec("ALTER TABLE users ADD COLUMN avatar_file TEXT");
}

// Verification landed after some accounts already existed. A NULL here is the
// literal truth about them — never proven — and nothing in the app branches on
// it: with verification happening *before* a users row is ever written (see
// auth.ts), "a row in users" is itself the guarantee, which is a stronger
// invariant than a nullable column every read path would have to remember.
// This column is only the record of *when*, kept in case a future nudge for
// grandfathered accounts needs something to read.
if (!userColumns.some((column) => column.name === "email_verified_at")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified_at INTEGER");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT,
    photo_file TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

/**
 * When this user last consumed their 12-hour posting window.
 *
 * The quota used to be derived from `MAX(posts.created_at)`, which was correct
 * only for as long as posts could never be deleted. The moment
 * `DELETE /api/posts/:id` exists, deriving it from that table means deleting
 * your newest photo hands the window straight back: post, delete, post again,
 * forever — an unlimited-posting loophole that defeats the one rule the whole
 * product is built on. Tracking it on the user instead means the quota outlives
 * the row it was spent on, and a delete never touches it.
 *
 * `NOT NULL DEFAULT 0` so an account that has never posted reads as "allowed
 * now" without a nullable branch in every caller. The backfill is what keeps
 * accounts that posted *before* this column existed from getting one free extra
 * photo on deploy day; it runs only on the migration that adds the column, so
 * re-running it can never resurrect a window a later delete was supposed to
 * keep spent. It has to sit below `CREATE TABLE posts` — on a fresh database
 * that table does not exist yet at the point the other user columns are added.
 */
if (!userColumns.some((column) => column.name === "last_post_at")) {
  db.exec("ALTER TABLE users ADD COLUMN last_post_at INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    UPDATE users
       SET last_post_at = COALESCE(
             (SELECT MAX(posts.created_at) FROM posts WHERE posts.user_id = users.id),
             0
           )
  `);
}

/**
 * Sessions live here rather than inside the cookie so that signing out, an
 * expiry, or a deleted account actually ends the session server-side. The row
 * id is a SHA-256 of the token the browser holds, so a leaked database still
 * can't be replayed as a login.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
  )
`);

/**
 * One row per request, requester -> addressee. Friendship is the "accepted"
 * state of that same row rather than a separate table, so there is exactly
 * one place that can disagree with itself about whether two users are
 * friends. Reads that want "are A and B friends" check both directions.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )
`);

/**
 * One row per (post, user) who liked it. The pair is the primary key so a
 * double-tap can't double-count, and `toggleLike` never needs a separate
 * existence check before deciding whether to insert or delete.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
  )
`);

/**
 * One row per comment. Unlike `likes` there is no natural key to collapse on —
 * the same person may say two different things — so this is an ordinary
 * autoincrement table.
 *
 * This table *is* aggregated, unlike `likes`, and `about.md` says why: anyone
 * who can open a thread could already count the replies in it by scrolling, so
 * the badge `commentCountFor` produces saves the scroll without exposing
 * anything new. A like count is different — nothing on screen reveals it to
 * anyone but the author — which is why that one stays private. The rule the
 * counts follow is "never publish what reading can't already tell you", not
 * "never count".
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

/**
 * A sign-up that has been paid for but not yet proven: the username and
 * password are settled, the address is not. Nothing here is an account —
 * `POST /api/auth/verify-email` is what promotes one of these rows into
 * `users`.
 *
 * Keyed on the (already-normalized) email rather than an autoincrement id, so
 * re-running the sign-up step for the same address *replaces* the pending
 * attempt instead of leaving a trail of live codes behind for one inbox. Only
 * one code is ever valid for a given address at a time.
 *
 * `code_hash` is a SHA-256 of the code, on the same reasoning as
 * `sessions.id`: a row that leaks — through a backup, a log line, a stray
 * `SELECT *` — must not hand out a working code by itself. Honest about what
 * that buys, though: a million codes is still a space anyone holding the row
 * can walk offline in milliseconds, so the hash defends against the row being
 * *seen*, not against it being *attacked*. What actually bounds guessing over
 * the network is `expires_at`, `attempts`, and the address-keyed lockout in
 * auth.ts that outlives this row.
 *
 * `token_hash` is a second, unrelated secret: a hash of an opaque token
 * `/signup` hands back only to the caller who made that request. Since the
 * row is keyed on email alone, nothing before this stopped a second,
 * unrelated caller from re-running `/signup` for someone else's address —
 * upserting fresh username/password/code over the real requester's row and
 * emailing *them* a new code. Requiring the matching token on `/verify-email`
 * and `/resend-code` means whoever's browser didn't make the most recent
 * `/signup` call for that address can't act on the row at all, win or lose;
 * it turns that takeover attempt into a failed one instead.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_signups (
    email TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    resends INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_pending_signups_expires ON pending_signups (expires_at)",
);

/**
 * A password reset in flight. Same discipline as `pending_signups` and for the
 * same reasons: keyed on the (normalized) address so only one code is ever live
 * for one inbox, `code_hash` stored rather than the code so a leaked row isn't
 * itself a working reset, and `expires_at` + `attempts` doing the actual work of
 * bounding guesses over the network.
 *
 * Two differences from `pending_signups`, both deliberate:
 *   - `user_id` with `ON DELETE CASCADE`, so deleting the account takes any
 *     outstanding reset with it rather than leaving a code that resolves to a
 *     row that no longer exists.
 *   - no `token_hash`. The possession token there exists because `/signup`
 *     *replaces* a row someone else may have created, and whoever made the most
 *     recent call has to be the only one able to finish it. A reset row belongs
 *     to an account that already exists and can only ever be completed by
 *     whoever reads that account's inbox, so there is nothing a second caller
 *     could take over: re-running `/forgot-password` only ever mails a fresh
 *     code to the same address.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    email TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets (expires_at)",
);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts (user_id, created_at DESC)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments (post_id, created_at)",
);
/**
 * `likes` is keyed (post_id, user_id) and `comments` is indexed
 * (post_id, created_at), so both are fast for "everything on this post" and a
 * full table scan for "everything by this user". Three paths ask the second
 * question: un-friending deletes both users' likes and comments on each other's
 * posts, deleting an account cascades through every row it owns, and deleting a
 * post does the same for its thread. All three are writes holding a
 * transaction, which is exactly where a scan is most expensive.
 */
db.exec("CREATE INDEX IF NOT EXISTS idx_likes_user ON likes (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_comments_user ON comments (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)");
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_friend_requests_addressee ON friend_requests (addressee_id, status)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_friend_requests_requester ON friend_requests (requester_id, status)",
);

/**
 * Unique indexes that can fail on data that predates them.
 *
 * The case-insensitive pair matters because `UNIQUE` on the column itself is
 * case-sensitive, which would let `Ada@example.com` register alongside
 * `ada@example.com` and let one account impersonate another by casing alone.
 *
 * The normalised friendship pair covers what `(requester_id, addressee_id)`
 * cannot: that index sees A→B and B→A as different rows, so both can exist and
 * `listFriends` then returns the same person twice. Ordering the two ids by
 * MIN/MAX collapses a friendship to one key whichever way round it was made.
 *
 * `required` is what separates a degraded read from a wrong one. A duplicate
 * photo filename or a doubled friendship is visible and annoying; two users
 * differing only in the casing of their email means `findUserByEmail`'s
 * `COLLATE NOCASE` lookup returns an arbitrary one of them, and a sign-in
 * silently lands in the wrong account. That is not something to log and carry
 * on from, so those two take the boot down until the duplicates are resolved.
 */
for (const { name, sql, required } of [
  { name: "posts.photo_file", required: false, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_photo_file ON posts (photo_file)" },
  { name: "users.email", required: true, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users (email COLLATE NOCASE)" },
  { name: "users.username", required: true, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)" },
  { name: "friend_requests.pair", required: false, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair ON friend_requests (requester_id, addressee_id)" },
  { name: "friend_requests.normalised_pair", required: false, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair_normalised ON friend_requests (MIN(requester_id, addressee_id), MAX(requester_id, addressee_id))" },
] as const) {
  try {
    db.exec(sql);
  } catch (err) {
    if (required) {
      throw new Error(
        `[db] Could not add the unique index on ${name} — the table already holds rows that collide there. ` +
          `Refusing to start: with duplicates present a lookup on that column returns an arbitrary one of them, ` +
          `which means signing in to the wrong account. Resolve the duplicates and restart.`,
        { cause: err },
      );
    }
    console.warn(
      `[db] Could not add the unique index on ${name} — the table already holds duplicate rows. Resolve them and restart; until then uniqueness is not enforced there.`,
    );
  }
}

/**
 * Distinguishes "that row already exists" from every other way a write can
 * fail. Anything else — a locked database, a full disk — has to keep its own
 * identity and reach the error handler, because reporting it as a duplicate
 * buries a real fault under a message the user can do nothing about.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return String((err as { code?: string })?.code ?? "").startsWith("SQLITE_CONSTRAINT");
}

export type UserRow = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  avatar_file: string | null;
  created_at: string;
  email_verified_at: number | null;
  /** Epoch ms of the last post that spent this user's 12-hour window; 0 = never. */
  last_post_at: number;
};

export type PendingSignupRow = {
  email: string;
  username: string;
  password_hash: string;
  code_hash: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_sent_at: number;
  attempts: number;
  resends: number;
};

export type PasswordResetRow = {
  email: string;
  user_id: number;
  code_hash: string;
  created_at: number;
  expires_at: number;
  last_sent_at: number;
  attempts: number;
};

export type PostRow = {
  id: number;
  user_id: number;
  description: string | null;
  photo_file: string;
  created_at: number;
};

export type LikeRow = {
  post_id: number;
  user_id: number;
  created_at: number;
};

export type CommentRow = {
  id: number;
  post_id: number;
  user_id: number;
  body: string;
  created_at: number;
};

export type FriendRequestRow = {
  id: number;
  requester_id: number;
  addressee_id: number;
  status: "pending" | "accepted";
  created_at: number;
};

export type SessionRow = {
  id: string;
  user_id: number;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
};
