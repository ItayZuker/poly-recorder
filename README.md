# Poly Recorder

Standalone recorder for Polymarket 5 Min / 15 Min up/down markets. It writes ticks under `DATA_DIR` and the same Mongo `markets.recordingEnabled` flag Admin CRM uses.

Do **not** record the same series on dest and this app at the same time (they would write the same files).

Only one instance may be the live recorder. Every other checkout (e.g. a developer PC) must run with `RECORDER_ROLE=viewer`: it serves the coverage board from its local `DATA_DIR` but never records, never prunes, never writes `recorded_windows`, and its Recording switch is disabled. Two recorders on the same Mongo overwrite and delete each other's window headers.

## Setup

1. Copy `.env.example` to `.env`
2. Set `MONGODB_URI` (same cluster as dest / CRM) and `DATA_DIR` (where tick files go — dest Replay reads this folder, e.g. `/mnt/poly-data` on the shared EFS mount). A configured `DATA_DIR` must already exist; the recorder refuses to create it so an unmounted volume cannot silently redirect ticks to local disk.
3. `npm install` (Node 22+)
4. `npm start` — http://localhost:3849

For the Linux / systemd deployment see [docs/deploy-linux.md](docs/deploy-linux.md).

## UI

- **Poly Recorder** header (same height as dest)
- Market dropdown
- Recording on/off is set in the CRM app. This app only reads Mongo `recordingEnabled` (polls every 30s) and does not change it.
- Full-width UTC week grid: red = missing windows, green bar = recorded count (12 per hour on 5 Min, 4 on 15 Min)

## Env

| Variable | Meaning |
|----------|---------|
| `MONGODB_URI` | Shared Mongo |
| `MONGODB_DB` | Default `poly_recorder` |
| `DATA_DIR` | Tick / window files (must exist; e.g. `/mnt/poly-data`) |
| `PORT` | Default `3849` |
| `RECORDER_ROLE` | **Required.** `recorder` (the one live instance) or `viewer`. Unset or anything else refuses to start. |
| `SITE_PASSWORD` | Optional. When set, the browser UI requires this password. Recording continues either way. |
