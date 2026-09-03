import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { authRouter } from "./auth.js";
import { postsRouter, uploadsRouter } from "./posts.js";
import { startUploadSweeper } from "./postsStore.js";
import { friendsRouter, usersRouter } from "./friends.js";
import { avatarsRouter } from "./avatars.js";
import { rateLimit } from "./rateLimit.js";
import { attachSession, requireCsrfToken, startSessionSweeper } from "./sessions.js";
import { enforceTrustedOrigin, errorHandler, notFound, securityHeaders } from "./security.js";
import { startVerificationSweeper } from "./verificationStore.js";

const app = express();

// Don't advertise the stack in every response.
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", config.trustProxy);

app.use(securityHeaders);

/**
 * One-shot check that the tunnel is actually forwarding a client address.
 *
 * `trust proxy = loopback` is what turns `X-Forwarded-For` into a real client
 * IP; if the header ever stops arriving, `req.ip` reads 127.0.0.1 for *every*
 * request and the failure is completely silent. The consequences are not: one
 * caller exhausts the global API budget for the whole site, and five failed
 * sign-ins against any known address lock that account for everyone — the
 * remote denial of service config.ts's lockout notes reason so carefully to
 * avoid. Logged rather than enforced, since refusing traffic over a missing
 * header would turn a degraded rate limiter into an outage.
 */
let forwardingChecked = false;
app.use((req, _res, next) => {
  if (!forwardingChecked && config.isProd) {
    forwardingChecked = true;
    if (!req.get("x-forwarded-for")) {
      console.error(
        "!!  [config] No X-Forwarded-For on the first request — every client is sharing one rate-limit key.",
      );
    }
  }
  next();
});

/**
 * Everything dynamic sits behind this chain, in this order: count the request,
 * resolve who is making it, then prove it came from our own front end before
 * any handler — or any body parser — sees it. The SPA bundle skips the chain
 * entirely, and photos are counted separately from the API so that loading a
 * feed full of images can't exhaust a reader's budget for the API itself.
 */
const dynamicPaths = ["/api", "/uploads"];
app.use("/api", rateLimit(config.rateLimits.api));
app.use("/uploads", rateLimit(config.rateLimits.photos));

/**
 * Production serves the SPA from this same origin, so CORS only has work to do
 * when a separate dev origin is configured.
 *
 * Mounted *below* the two limiters, because `cors` answers a preflight itself
 * and never calls `next()`. Above them, every `OPTIONS` — which is every
 * cross-origin write the SPA makes — was served without being counted by
 * anything, so a caller could hold the process busy for free through the one
 * path in the app that deliberately does no work.
 */
if (config.clientOrigins.length > 0) {
  app.use(
    cors({
      origin: config.clientOrigins,
      credentials: true,
      // Must list every method the SPA actually issues: the avatar upload is a
      // PUT and un-friending is a DELETE, and a preflight that doesn't see them
      // here is refused outright. Same-origin production never reaches this,
      // which is exactly why the omission stayed invisible.
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token"],
      maxAge: 600,
    }),
  );
}

app.use(dynamicPaths, attachSession);
app.use(dynamicPaths, enforceTrustedOrigin);
app.use(dynamicPaths, requireCsrfToken);

app.use("/api/auth", authRouter);
app.use("/api/posts", postsRouter);
app.use("/api/friends", friendsRouter);
app.use("/api/users", usersRouter);
// Mounted ahead of the generic photo router so /uploads/avatars/* resolves
// here instead of being tried as a post's photo filename.
app.use("/uploads/avatars", avatarsRouter);
app.use("/uploads", uploadsRouter);

// Unmatched API and photo requests must 404 rather than fall through to the
// SPA fallback below, which would answer them with index.html.
app.use(dynamicPaths, notFound);

if (config.isProd) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.join(__dirname, "../../app/dist");

  app.use(
    express.static(staticDir, {
      index: false,
      maxAge: "1y",
      setHeaders(res, filePath) {
        // Asset filenames are content-hashed; index.html is not, and a stale
        // one would pin users to a deleted bundle.
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  // Express 5's path matcher requires an explicit named wildcard. This is the
  // SPA fallback, so it intentionally includes `/` as well as nested routes.
  app.get("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

app.use(errorHandler);

/**
 * Every async route handler is wrapped in `asyncRoute`, so a rejected promise
 * inside a request becomes a 500. Nothing covers what runs *outside* the
 * request path: the three sweeper timers, and the `fs.promises` calls that
 * continue after a response is sent. On Node 22 an unhandled rejection
 * terminates the process by default.
 *
 * Logging without exiting is the right trade here for the reason security.ts
 * already gives about routes: every rate limiter, every lockout and all the
 * sign-in brute-force protection lives in memory, so a crash is a free reset of
 * all of it — and an attacker who can provoke one on demand (filling the disk
 * until a photo write throws, say) clears their own accumulated lockouts every
 * time. A process left running with one failed background task is a smaller
 * problem than a process that restarts on request.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception", err);
});

startSessionSweeper();
startVerificationSweeper();
startUploadSweeper();

function announce() {
  console.log(
    `Server listening on http://${config.host || "0.0.0.0"}:${config.port} ` +
      `(${config.isProd ? "production" : "development"}, ` +
      `secure cookies ${config.cookieSecure ? "on" : "off"})`,
  );
}

if (config.host) {
  app.listen(config.port, config.host, announce);
} else {
  app.listen(config.port, announce);
}
