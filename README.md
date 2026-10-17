# Matrix Server

An open-source, free, unlimited key-value backend server.

It was originally built to power [Matrix Messenger](https://github.com/moonhpro4/matrix-messenger), but it's intentionally generic — there's nothing messenger-specific about it. Fork it, deploy your own copy, and build whatever you want on top: another messenger, a cloud storage service, a notes app, anything that needs simple persistent key-value storage.

## Live status

The running backend exposes a live status page at **`/rryyt`** — shows whether the database is connected, how many keys are stored, and uptime.

## API

```
GET    /kv/:key    -> 200 with the raw value, or 404 if not found
PUT    /kv/:key    -> stores the request body as the value for that key
DELETE /kv/:key    -> deletes the key
GET    /rryyt      -> live status page
GET    /           -> basic info
```

No authentication, no rate limits, no cost — that's the point. Use it for anything.

## Running your own copy

1. Clone this repo
2. Deploy to [Railway](https://railway.app) (or anywhere that runs Node.js)
3. Add a Postgres database and link it — Railway sets `DATABASE_URL` automatically
4. `npm install && npm start`

## Tech stack

- Node.js + Express
- PostgreSQL for storage

## License

MIT — do anything you want with it.

## Large files (up to 1 GB)

Files never pass through the server. `POST /files/init` returns a short-lived
presigned URL for an S3-compatible bucket and the client uploads straight to
it, so a small free host can handle 1 GB files.

| Step | Request | Result |
|------|---------|--------|
| 1 | `POST /files/init` `{"filename","mimetype","size"}` | `{fileId, uploadUrl, uploadHeaders, expiresIn, maxBytes}` |
| 2 | `PUT <uploadUrl>` with the raw bytes and `uploadHeaders` | 200 from the bucket |
| 3 | `POST /files/:id/complete` | checks the stored size matches, marks complete |
| 4 | `GET /files/:id` or `GET /files/:id/download` | metadata + fresh download URL / 302 redirect |
| 5 | `DELETE /files/:id` | removes the file |

Chat messages should only store `{fileId, filename, mimetype, size}`, not the file.
`/kv` values are capped at `KV_BODY_LIMIT` (default 50 MB) because they are held in RAM.

## Deploy on Render (free)

1. Create a Postgres database. Free Render Postgres expires after 30 days, so a
   permanent free database such as Neon or Supabase is a better fit. Copy its
   connection string.
2. Create a Cloudflare R2 bucket (private) and an API token with Object Read & Write.
3. Render dashboard -> New -> Blueprint -> select this repo. Fill in the prompted
   variables (see `render.yaml`).
4. Open `https://<your-service>.onrender.com/rryyt` - `dbConnected` and
   `fileStorageConfigured` should both be `true`.

### Environment variables

| Name | Purpose |
|------|---------|
| `DATABASE_URL` | Postgres connection string |
| `DB_SSL` | `true` to use SSL to the database (Neon/Supabase), otherwise off |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | file storage |
| `S3_REGION` | default `auto` (R2) |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO-style endpoints |
| `MAX_FILE_BYTES` | default 1073741824 (1 GB) |
| `FILE_INIT_LIMIT_PER_HOUR` | per-IP upload limit, default 30 |
| `KV_BODY_LIMIT` | max size of a `/kv` value, default `50mb` |

Browser clients that upload directly need a CORS rule on the bucket allowing
`PUT`/`GET` with the `Content-Type` header. Native apps do not.
