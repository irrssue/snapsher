import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { authRouter } from "./auth.js";
import { postsRouter, uploadsRouter } from "./posts.js";
import { friendsRouter, usersRouter } from "./friends.js";
import { avatarsRouter } from "./avatars.js";
import { rateLimit } from "./rateLimit.js";
import { attachSession, requireCsrfToken, startSessionSweeper } from "./sessions.js";
import { enforceTrustedOrigin, errorHandler, notFound, securityHeaders } from "./security.js";

const app = express();

// Don't advertise the stack in every response.
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", config.trustProxy);

app.use(securityHeaders);

// Production serves the SPA from this same origin, so CORS only has work to do
// when a separate dev origin is configured.
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

  app.get("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

app.use(errorHandler);

startSessionSweeper();

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
