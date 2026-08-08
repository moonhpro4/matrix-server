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
 *   GET    /rryyt      -> live status page for the real running backend
 *   GET    /           -> basic info page
 */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// Railway injects DATABASE_URL automatically once Postgres is linked.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Open CORS — this is meant to be freely usable by any app/website.
app.use(cors());
app.use(express.text({ type: "*/*", limit: "10mb" }));

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
    endpoints: ["GET /kv/:key", "PUT /kv/:key", "DELETE /kv/:key", "GET /rryyt"],
    source: "https://github.com/moonhpro4/matrix-server",
  });
});

app.listen(PORT, async () => {
  console.log(`matrix-server listening on port ${PORT}`);
  try {
    await initDb();
  } catch (err) {
    console.error("Failed to initialize database:", err);
  }
});
