import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

const directory = mkdtempSync(path.join(tmpdir(), "snapsher-archive-"));
process.env.DB_FILE = path.join(directory, "test.db");
process.env.NODE_ENV = "test";
process.env.HOST = "127.0.0.1";
process.env.COOKIE_SECURE = "0";
const { db } = await import("../dist/db.js");
const store = await import("../dist/postsStore.js");
const { default: express } = await import("express");
const { usersRouter } = await import("../dist/friends.js");
const { attachSession, startSession } = await import("../dist/sessions.js");

const app = express();
// Test-only sign-in; never mounted by the production server.
app.get("/login/:id", (req, res) => {
  startSession(req, res, Number(req.params.id));
  res.json({ ok: true });
});
app.use("/api/users", attachSession, usersRouter);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM users");
  const insert = db.prepare("INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, 'unused')");
  for (let id = 1; id <= 3; id++) insert.run(id, `user${id}`, `user${id}@example.test`);
  db.prepare("INSERT INTO friend_requests (requester_id, addressee_id, status, created_at) VALUES (1, 2, 'accepted', 1)").run();
});
function seed(count, userId = 1) {
  const insert = db.prepare("INSERT INTO posts (user_id, photo_file, created_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      // Equal timestamps deliberately exercise the cursor's id tie-breaker.
      insert.run(userId, `${userId}-${index}.jpg`, 1000 + Math.floor(index / 5));
    }
  })();
}
function walk(actor, userId) {
  const ids = [];
  let cursor;
  do {
    const page = store.listPostPageFor(actor, userId, cursor);
    assert.ok(page.posts.length <= 36);
    ids.push(...page.posts.map((post) => post.id));
    cursor = page.nextCursor ? store.parsePostCursor(page.nextCursor) : undefined;
  } while (cursor);
  return ids;
}
async function cookieFor(userId) {
  const response = await fetch(`${base}/login/${userId}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

test("every photo beyond the old 300 cap is reachable exactly once, including timestamp ties", () => {
  seed(317);
  const expected = db.prepare("SELECT id FROM posts ORDER BY created_at DESC, id DESC").all().map(({ id }) => String(id));
  assert.deepEqual(walk({ userId: 1 }, 1), expected);
  assert.deepEqual(walk({ userId: 2 }, 1), expected);
  assert.equal(store.listPostsFor({ userId: 1 }, 1).length, 300);
});

test("empty profiles and exact page boundaries terminate without a phantom next page", () => {
  assert.deepEqual(store.listPostPageFor({ userId: 1 }, 1), { posts: [], nextCursor: null });
  seed(36);
  assert.equal(store.listPostPageFor({ userId: 1 }, 1).nextCursor, null);
});

test("inserts and deleting the cursor row between pages do not skip remaining photos", () => {
  seed(80);
  const first = store.listPostPageFor({ userId: 1 }, 1);
  const cursor = store.parsePostCursor(first.nextCursor);
  const expected = db.prepare("SELECT id FROM posts WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC").all(cursor.createdAt, cursor.createdAt, cursor.id).map(({ id }) => String(id));
  db.prepare("INSERT INTO posts (user_id, photo_file, created_at) VALUES (1, 'new.jpg', 99999)").run();
  store.deletePostFor({ userId: 1 }, cursor.id);
  const remaining = [];
  let next = cursor;
  while (next) {
    const page = store.listPostPageFor({ userId: 1 }, 1, next);
    remaining.push(...page.posts.map((post) => post.id));
    next = page.nextCursor ? store.parsePostCursor(page.nextCursor) : null;
  }
  assert.deepEqual(remaining, expected);
});

test("every page rechecks friendship; a copied cursor does not grant photo access", () => {
  seed(40);
  const page = store.listPostPageFor({ userId: 2 }, 1);
  const cursor = store.parsePostCursor(page.nextCursor);
  assert.throws(() => store.listPostPageFor({ userId: 3 }, 1, cursor), { code: "not_friends" });
  db.exec("DELETE FROM friend_requests");
  assert.throws(() => store.listPostPageFor({ userId: 2 }, 1, cursor), { code: "not_friends" });
  assert.equal(store.resolvePhotoFor({ userId: 2 }, "1-0.jpg"), null);
});

test("owner-only like counts remain private on both first and older pages", () => {
  seed(40);
  for (const userId of [1, 2]) {
    const first = store.listPostPageFor({ userId }, 1);
    const second = store.listPostPageFor({ userId }, 1, store.parsePostCursor(first.nextCursor));
    for (const post of [...first.posts, ...second.posts]) {
      assert.equal(Object.hasOwn(post, "likeCount"), userId === 1);
      assert.equal(post.isOwner, userId === 1);
    }
  }
});

test("deleting an archived photo never refunds the posting window", () => {
  const created = store.createPostFor({ userId: 1 }, { description: null, photoFile: "quota.jpg" });
  store.deletePostFor({ userId: 1 }, Number(created.post.id));
  assert.equal(store.quotaFor({ userId: 1 }).nextAllowedAt, created.nextAllowedAt);
  assert.throws(() => store.createPostFor({ userId: 1 }, { description: null, photoFile: "again.jpg" }), store.QuotaExceededError);
});

test("malformed, repeated, oversized and unsafe cursors are rejected", async () => {
  const cookie = await cookieFor(1);
  for (const value of ["bad", "-1:2", "1:0", "1:1.5", "1:9007199254740992", "1:" + "9".repeat(100)]) {
    assert.equal(store.parsePostCursor(value), null);
    const response = await fetch(`${base}/api/users/1/posts?page=1&before=${encodeURIComponent(value)}`, { headers: { cookie } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_cursor");
  }
  const repeated = await fetch(`${base}/api/users/1/posts?page=1&before=1:1&before=2:2`, { headers: { cookie } });
  assert.equal(repeated.status, 400);
});

test("HTTP archive contract preserves older bundles, auth and stranger locks", async () => {
  seed(40);
  const cookie = await cookieFor(1);
  const request = (url, cookies = cookie) => fetch(`${base}${url}`, { headers: { cookie: cookies } });
  const legacy = await request("/api/users/1/posts");
  assert.equal((await legacy.json()).posts.length, 40);
  const first = await (await request("/api/users/1/posts?page=1")).json();
  assert.equal(first.posts.length, 36);
  const second = await (await request(`/api/users/1/posts?page=1&before=${first.nextCursor}`)).json();
  assert.equal(second.posts.length, 4);
  assert.equal(second.nextCursor, null);
  assert.equal((await request("/api/users/1/posts?page=1", "")).status, 401);
  const stranger = await request("/api/users/1/posts?page=1", await cookieFor(3));
  assert.equal(stranger.status, 403);
  assert.equal((await stranger.json()).code, "not_friends");
  assert.equal((await request("/api/users/999/posts?page=1")).status, 404);
});
