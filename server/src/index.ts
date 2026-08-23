import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import { authRouter } from "./auth.js";
import { postsRouter, uploadsDir } from "./posts.js";

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const isProd = process.env.NODE_ENV === "production";

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
    credentials: true,
  }),
);
// Photos arrive as base64 data URLs in the JSON body, so the default 100kb cap
// is far too small.
app.use(express.json({ limit: "12mb" }));
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.SESSION_SECRET || "dev-secret-change-me"],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
  }),
);

app.use("/api/auth", authRouter);
app.use("/api/posts", postsRouter);

app.use("/uploads", express.static(uploadsDir, { immutable: true, maxAge: "1y" }));

// Unmatched API and photo requests must 404 rather than fall through to the
// SPA fallback below, which would answer them with index.html.
app.use(["/api", "/uploads"], (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

if (isProd) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = path.join(__dirname, "../../app/dist");
  app.use(express.static(staticDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
