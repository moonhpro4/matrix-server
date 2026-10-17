/**
 * Matrix Server — open-source, free, unlimited key-value backend.
 *
 * Originally built to power Matrix Messenger, but it's generic on
 * purpose: any app that needs simple persistent key-value storage can
 * use this. Fork it, deploy your own, build a different messenger, a
 * cloud storage service, whatever.
 *
 * API:
 *   GET    /kv/:key    -> 200 with raw value, or 404 if not found
 *   PUT    /kv/:key    -> stores the raw request body as the value
 *   DELETE /kv/:key    -> deletes the key
 *   GET    /search?q=  -> find accounts by partial username
 *   POST   /files/init (+ /files/:id/complete, GET/DELETE /files/:id)
 *                      -> large file storage via presigned URLs (see files.js)
 *   GET    /rryyt      -> live status page for the real running backend
 *   GET    /           -> basic info page
 */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { createFilesRouter, storageConfigured, MAX_FILE_BYTES } = require("./files");

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render's proxy: needed so req.ip is the real client IP.
app.set("trust proxy", 1);

// Database SSL is controlled explicitly (never by the PGSSLMODE env var):
//   DB_SSL=true   -> use SSL (Neon, Supabase, Render's *external* DB URL)
//   anything else -> no SSL (Render/Railway *internal* DB URLs, local dev)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
});

// Hosted Postgres drops idle connections. Without this handler an idle
// disconnect emits an unhandled 'error' event and crashes the process.
pool.on("error", (err) => {
  console.error("Idle Postgres client error (ignored, pool will reconnect):", err.message);
});

// Open CORS — this is meant to be freely usable by any app/website.
app.use(cors());

// File uploads/downloads go straight to object storage (see files.js),
// so they never pass through this server's memory.
app.use("/files", createFilesRouter(pool));

// The plain key-value API holds whole values in RAM, so keep its cap
// modest (a 512 MB free host cannot buffer a 1 GB body). Raise it only
// if you run on a bigger instance.
app.use(express.text({ type: "*/*", limit: process.env.KV_BODY_LIMIT || "50mb" }));

let dbReady = false;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  dbReady = true;
  console.log("Database ready — kv_store table exists.");
}

// ---------------- KV API ----------------

app.get("/kv/:key", async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM kv_store WHERE key = $1", [req.params.key]);
    if (result.rows.length === 0) {
      return res.status(404).send("Not found");
    }
    res.status(200).send(result.rows[0].value);
  } catch (err) {
    console.error("GET /kv error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});

app.put("/kv/:key", async (req, res) => {
  try {
    const value = typeof req.body === "string" ? req.body : String(req.body);
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, value]
    );
    res.status(200).send("OK");
  } catch (err) {
    console.error("PUT /kv error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});

app.delete("/kv/:key", async (req, res) => {
  try {
    await pool.query("DELETE FROM kv_store WHERE key = $1", [req.params.key]);
    res.status(200).send("OK");
  } catch (err) {
    console.error("DELETE /kv error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});

// ---------------- Search ----------------
// Finds account keys (user:<subdomain>:<username>) where the username
// portion partially matches the query, across ALL subdomains. Used so
// searching "matrix" finds every account with "matrix" in the username,
// not just an exact "name@subdomain" match.

app.get("/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) return res.status(200).json({ results: [] });

  try {
    // Keys look like: user:<subdomain>:<username>
    // Match if the username portion (after the second colon) contains q.
    const result = await pool.query(
      `SELECT key FROM kv_store
       WHERE key LIKE 'user:%'
       AND split_part(key, ':', 3) LIKE $1
       LIMIT 20`,
      [`%${q}%`]
    );

    const identities = result.rows.map((row) => {
      const parts = row.key.split(":");
      const subdomain = parts[1];
      const username = parts.slice(2).join(":"); // in case username ever contains ':'
      return `${username}@${subdomain}`;
    });

    res.status(200).json({ results: identities });
  } catch (err) {
    console.error("GET /search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Status / info pages ----------------

app.get("/rryyt", async (req, res) => {
  let keyCount = null;
  let dbConnected = false;
  try {
    const result = await pool.query("SELECT COUNT(*) FROM kv_store");
    keyCount = result.rows[0].count;
    dbConnected = true;
  } catch (err) {
    dbConnected = false;
  }

  res.status(200).json({
    service: "matrix-server",
    status: "running",
    dbReady,
    dbConnected,
    keyCount,
    fileStorageConfigured: storageConfigured(),
    maxFileBytes: MAX_FILE_BYTES,
    uptimeSeconds: Math.floor(process.uptime()),
    poweredBy: "https://github.com/moonhpro4/matrix-server",
    usedBy: "https://github.com/moonhpro4/matrix-messenger",
  });
});

app.get("/", (req, res) => {
  res.status(200).json({
    name: "matrix-server",
    description:
      "Open-source, free, unlimited key-value backend. Originally built for Matrix Messenger, free to reuse for anything.",
    endpoints: [
      "GET /kv/:key",
      "PUT /kv/:key",
      "DELETE /kv/:key",
      "GET /search?q=",
      "POST /files/init",
      "POST /files/:id/complete",
      "GET /files/:id",
      "GET /files/:id/download",
      "DELETE /files/:id",
      "GET /rryyt",
    ],
    source: "https://github.com/moonhpro4/matrix-server",
  });
});

app.listen(PORT, async () => {
  console.log(`matrix-server listening on port ${PORT}`);
  // Retry: on free hosts the database can take a moment to wake up.
  for (let attempt = 1; !dbReady; attempt++) {
    try {
      await initDb();
    } catch (err) {
      console.error(`Failed to initialize database (attempt ${attempt}):`, err.message);
      await new Promise((r) => setTimeout(r, Math.min(30000, attempt * 3000)));
    }
  }
});
