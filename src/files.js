/**
 * File storage for Matrix Server.
 *
 * Big files (up to 1 GB by default) are NEVER sent through this server.
 * The server only hands out short-lived presigned URLs for an
 * S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, MinIO...),
 * and the app uploads/downloads directly to/from the bucket. That keeps
 * RAM use tiny (important on a 512 MB free host) and bandwidth off the
 * host's quota.
 *
 * Flow:
 *   1. POST /files/init            {filename, mimetype, size}
 *        -> {fileId, uploadUrl, uploadHeaders, expiresIn, maxBytes}
 *   2. App PUTs the raw bytes to uploadUrl with uploadHeaders.
 *   3. POST /files/:id/complete    -> verifies the object exists and the
 *                                     size matches, marks it complete.
 *   4. GET  /files/:id             -> JSON metadata + fresh download URL
 *      GET  /files/:id/download    -> 302 redirect to the download URL
 *   5. DELETE /files/:id           -> removes object + metadata
 */

const crypto = require("crypto");
const express = require("express");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 1024 * 1024 * 1024); // 1 GB
const UPLOAD_URL_TTL = 2 * 60 * 60; // seconds — slow phone uploads of big files
const DOWNLOAD_URL_TTL = 60 * 60;
const INIT_LIMIT_PER_HOUR = Number(process.env.FILE_INIT_LIMIT_PER_HOUR || 30);

function storageConfigured() {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY
  );
}

let _client = null;
function s3() {
  if (!_client) {
    _client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
      // Newer SDK versions add checksum params that some S3-compatible
      // services reject; only send them when a service requires it.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _client;
}

const bucket = () => process.env.S3_BUCKET;
const objectKey = (id) => `files/${id}`;
const metaKey = (id) => `filemeta:${id}`;
const ID_RE = /^[a-f0-9]{32}$/;

function cleanFilename(name) {
  const base = String(name || "file").split(/[\\/]/).pop().replace(/[\u0000-\u001f"]/g, "").trim();
  return (base || "file").slice(0, 200);
}

function cleanMime(m) {
  const s = String(m || "").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(s) && s.length <= 100
    ? s
    : "application/octet-stream";
}

// Tiny in-memory per-IP limiter for /files/init (open server, so this
// stops one client from filling the free bucket in minutes).
const hits = new Map();
function initRateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || "unknown";
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= INIT_LIMIT_PER_HOUR) {
    return res.status(429).json({ error: "Too many uploads, try again later" });
  }
  recent.push(now);
  hits.set(ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of hits) {
    const recent = ts.filter((t) => now - t < 3600 * 1000);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function createFilesRouter(pool) {
  const router = express.Router();
  router.use(express.json({ limit: "10kb" }));

  router.use((req, res, next) => {
    if (!storageConfigured()) {
      return res.status(503).json({
        error: "File storage is not configured on this server (set the S3_* environment variables)",
      });
    }
    next();
  });

  async function getMeta(id) {
    const r = await pool.query("SELECT value FROM kv_store WHERE key = $1", [metaKey(id)]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : null;
  }
  async function setMeta(id, meta) {
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [metaKey(id), JSON.stringify(meta)]
    );
  }

  router.post("/init", initRateLimit, async (req, res) => {
    try {
      const size = Number(req.body && req.body.size);
      if (!Number.isInteger(size) || size < 1) {
        return res.status(400).json({ error: "size (bytes) is required" });
      }
      if (size > MAX_FILE_BYTES) {
        return res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES} bytes)` });
      }
      const filename = cleanFilename(req.body.filename);
      const mimetype = cleanMime(req.body.mimetype);
      const id = crypto.randomBytes(16).toString("hex");

      // Content-Type and Content-Length are part of the signature, so the
      // upload must match what was declared here — it can't be used to
      // push a bigger file than the limit allows.
      const uploadUrl = await getSignedUrl(
        s3(),
        new PutObjectCommand({
          Bucket: bucket(),
          Key: objectKey(id),
          ContentType: mimetype,
          ContentLength: size,
        }),
        {
          expiresIn: UPLOAD_URL_TTL,
          signableHeaders: new Set(["content-type", "content-length"]),
        }
      );

      await setMeta(id, { filename, mimetype, size, createdAt: Date.now(), complete: false });
      res.status(200).json({
        fileId: id,
        uploadUrl,
        uploadMethod: "PUT",
        uploadHeaders: { "Content-Type": mimetype },
        expiresIn: UPLOAD_URL_TTL,
        maxBytes: MAX_FILE_BYTES,
      });
    } catch (err) {
      console.error("POST /files/init error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/:id/complete", async (req, res) => {
    try {
      const id = req.params.id;
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      const meta = await getMeta(id);
      if (!meta) return res.status(404).json({ error: "unknown file" });
      let head;
      try {
        head = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: objectKey(id) }));
      } catch (e) {
        return res.status(409).json({ error: "upload not found in storage yet" });
      }
      if (Number(head.ContentLength) !== meta.size) {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: objectKey(id) })).catch(() => {});
        return res.status(409).json({ error: "uploaded size does not match declared size" });
      }
      meta.complete = true;
      await setMeta(id, meta);
      res.status(200).json({ fileId: id, filename: meta.filename, mimetype: meta.mimetype, size: meta.size });
    } catch (err) {
      console.error("POST /files/:id/complete error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  async function downloadUrl(id, meta) {
    return getSignedUrl(
      s3(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: objectKey(id),
        ResponseContentType: meta.mimetype,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      }),
      { expiresIn: DOWNLOAD_URL_TTL }
    );
  }

  router.get("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      const meta = await getMeta(id);
      if (!meta || !meta.complete) return res.status(404).json({ error: "not found" });
      res.status(200).json({
        fileId: id,
        filename: meta.filename,
        mimetype: meta.mimetype,
        size: meta.size,
        url: await downloadUrl(id, meta),
        expiresIn: DOWNLOAD_URL_TTL,
      });
    } catch (err) {
      console.error("GET /files/:id error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/:id/download", async (req, res) => {
    try {
      const id = req.params.id;
      if (!ID_RE.test(id)) return res.status(400).send("bad id");
      const meta = await getMeta(id);
      if (!meta || !meta.complete) return res.status(404).send("Not found");
      res.redirect(302, await downloadUrl(id, meta));
    } catch (err) {
      console.error("GET /files/:id/download error:", err);
      res.status(500).send("Server error: " + err.message);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: objectKey(id) })).catch(() => {});
      await pool.query("DELETE FROM kv_store WHERE key = $1", [metaKey(id)]);
      res.status(200).send("OK");
    } catch (err) {
      console.error("DELETE /files/:id error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createFilesRouter, storageConfigured, MAX_FILE_BYTES };
