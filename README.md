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
