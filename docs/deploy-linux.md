# Deploy: Lightsail Ubuntu 24.04 + EFS + systemd

Assumptions:

- Instance user is `ubuntu`.
- The shared EFS volume is already mounted at `/mnt/poly-data` and owned by `ubuntu`
  (`ls -ld /mnt/poly-data` shows `ubuntu ubuntu`). The Replay host mounts the same volume read-only.
- The repo will live at `/home/ubuntu/poly-recorder`, cloned over SSH with a GitHub deploy key.
- Node 20 from NodeSource is currently installed; step 1 upgrades it in place.

Each step is one copy-pasteable block. Run them in order.

## 1. Node 22

The code uses the global `WebSocket` (unflagged only in Node 22+) and `mongodb` /
`@mongodb-js/zstd` require Node ≥ 20.19. Node 22 LTS covers both.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs && node -v
```

Expected last line: `v22.x.y` (e.g. `v22.14.0`). If it still prints `v20.x`, run
`sudo apt-get install -y --only-upgrade nodejs` and check again.

## 2. Deploy key + clone

Generate a key on the instance, then add the **public** key in GitHub:
repo → **Settings → Deploy keys → Add deploy key**, title `lightsail-poly-recorder`,
paste the output of the `cat` line, leave **Allow write access** unchecked (read-only).
Then clone. Replace `YOUR_ORG/YOUR_REPO` with the GitHub path.

```bash
ssh-keygen -t ed25519 -C "poly-recorder@lightsail" -f ~/.ssh/poly-recorder-deploy -N "" \
  && cat ~/.ssh/poly-recorder-deploy.pub \
  && printf '\nHost github.com\n  IdentityFile ~/.ssh/poly-recorder-deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config \
  && chmod 600 ~/.ssh/config \
  && ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null \
  && echo "--- paste the key above into GitHub Deploy keys, then press Enter ---" && read -r _ \
  && git clone git@github.com:YOUR_ORG/YOUR_REPO.git /home/ubuntu/poly-recorder
```

## 3. Build

`npm ci` installs `@mongodb-js/zstd`, which downloads a prebuilt Linux binary from GitHub.
If the instance has no GitHub egress it falls back to compiling; in that case run
`sudo apt install -y build-essential python3` first.

```bash
cd /home/ubuntu/poly-recorder && npm ci && npm run build && ls dist/server.js
```

## 4. `.env`

Only the variables the code reads. `MONGODB_DB` defaults to `poly_recorder`, `CLOB_HOST`
to `https://clob.polymarket.com`, `CHAIN_ID` to `137`; leave them out unless you need to
override. Replace the `MONGODB_URI` placeholder with the Atlas connection string
(same cluster as dest / CRM). `RECORDER_ROLE` is required: `recorder` marks this as the one
live recorder; every other checkout of the repo (your PC) must use `viewer`. The process
refuses to start if it is missing or misspelled. systemd's
`EnvironmentFile` does not expand `${VAR}` or strip quotes the way a shell does, so keep
values unquoted.

```bash
cat > /home/ubuntu/poly-recorder/.env <<'EOF'
DATA_DIR=/mnt/poly-data
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
PORT=3849
RECORDER_ROLE=recorder
EOF
chmod 600 /home/ubuntu/poly-recorder/.env
```

## 5. systemd unit

`RequiresMountsFor=/mnt/poly-data` makes systemd wait for the EFS mount and stop the
service if the mount goes away. The recorder also refuses to start if `DATA_DIR` does not
exist, so it can never fall back to writing on the root disk.

```bash
sudo tee /etc/systemd/system/poly-recorder.service >/dev/null <<'EOF'
[Unit]
Description=Poly Recorder (Polymarket up/down tick recorder)
After=network-online.target remote-fs.target
Wants=network-online.target
RequiresMountsFor=/mnt/poly-data

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/poly-recorder
EnvironmentFile=/home/ubuntu/poly-recorder/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
```

## 6. Enable, start, watch the log

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now poly-recorder && journalctl -u poly-recorder -f
```

A healthy first minute looks like this (order may vary slightly):

```text
[server] Poly Recorder listening on http://localhost:3849
[server] DATA_DIR=/mnt/poly-data
[server] RECORDER_ROLE=recorder
[retention] Scheduler started (delete tick/window data older than 7 days)
[recorder] Recording started for btc-5m            <- printed twice per market with Recording = On in Mongo
[clob] WebSocket connected
[recorder] Window started 09:35:00 for btc-5m
[recorder] Chainlink PTB for btc-5m @ 64123.45     <- first proof the Chainlink RTDS socket is delivering prices
[recorder] 30s TWAP PTB for btc-5m @ 64120.10
[recorder] 60s TWAP PTB for btc-5m @ 64118.70
```

The Chainlink feed itself logs nothing on connect; the `PTB` lines above (and, at the first
window close, `Window saved … (N raw, M chainlink)` with `M > 0`) are the signal. Repeated
`[clob] Reconnecting in 2000 ms` with no `WebSocket connected` means the `WebSocket` global is
missing — Node is still 20 (redo step 1).

Ticks are appended silently every 1.5 s; confirm with
`ls -l /mnt/poly-data/btc_5m/ticks/*/` — `clob-book.jsonl` and `chainlink.jsonl` should be
growing in the newest window folder. If no market has Recording = On yet, the log stops
after the `[retention]` line; flip a market On in the UI (`http://<instance-ip>:3849`, or
via CRM) and the `Recording started` lines appear within 30 s.

Most likely failures:

1. **Mongo unreachable — instance IP not whitelisted in Atlas.** You see, repeated every 30 s:

   ```text
   [recorder] Initial sync failed: MongoServerSelectionError: ... (Could not connect to any servers ...)
   [recorder] Periodic sync failed: MongoServerSelectionError: ...
   ```

   Fix: Atlas → Network Access → Add IP Address → the instance's public (static) IP, or the
   VPC-peered CIDR. No restart needed; the next 30 s sync succeeds. If the message is instead
   `Fatal: MONGODB_URI is not set` or `Fatal: RECORDER_ROLE is not set` (exit code 1,
   restarts every 5 s), that `.env` line is missing or misspelled.

2. **DATA_DIR not mounted.** The service exits immediately with:

   ```text
   Fatal startup error: Error: DATA_DIR /mnt/poly-data is not accessible (ENOENT). Is the volume mounted? Refusing to create it.
   ```

   (or systemd itself refuses with `Dependency failed for Poly Recorder` because
   `RequiresMountsFor` is unmet). Fix: `mount | grep poly-data`; if absent, `sudo mount -a`
   and check the `/etc/fstab` entry for the EFS target (`_netdev,nofail` recommended), then
   `sudo systemctl restart poly-recorder`. If the mount exists but the error is `EACCES`,
   `sudo chown ubuntu:ubuntu /mnt/poly-data`.

## 7. Verify a published window

Wait for a window to close (5 min markets: `:00/:05/:10 …` UTC) plus the Gamma settlement
delay (usually under a minute, up to 20 min). Live windows show `.jsonl`; published windows
show only the two `.jsonl.zst` files. The `mongosh` line needs the same URI as `.env`.

```bash
ls -l /mnt/poly-data/*/ticks/ | tail -n 20 && echo "--- newest btc-5m window ---" && ls -l "$(ls -d /mnt/poly-data/btc_5m/ticks/*/ | sort | tail -n 2 | head -n 1)" && echo "--- Mongo header ---" && mongosh "$(grep '^MONGODB_URI=' /home/ubuntu/poly-recorder/.env | cut -d= -f2-)" --quiet --eval 'db.getSiblingDB("poly_recorder").recorded_windows.find({series:"btc-5m"}).sort({windowStart:-1}).limit(2).toArray()'
```

Expected: the second-newest window folder (the newest is still live) contains
`clob-book.jsonl.zst` and `chainlink.jsonl.zst` and nothing else; the Mongo query returns
documents with `_id: "btc-5m:<windowStart>"`, `windowOutcome: "up"|"down"`, `savedAt`, and
the PTB / min / max fields. The `.zst` files are written to a temp name and renamed, so the
Replay host never sees a partial file. (If `mongosh` is not installed:
`sudo apt install -y mongodb-mongosh` after adding the MongoDB apt repo, or check the
collection in Atlas → Browse Collections instead.)

## 8. Update procedure

Stopping first lets the recorder finalize a window that has already ended and flush the
last buffered ticks (it exits within `TimeoutStopSec=30`). A window in progress resumes
from its Mongo header on restart with only the downtime gap missing.

```bash
cd ~/poly-recorder && sudo systemctl stop poly-recorder && git pull && npm ci && npm run build && sudo systemctl start poly-recorder && journalctl -u poly-recorder -n 30 --no-pager
```

## Reminder

Do not run the old Windows recorder at the same time. Both write the same Mongo
`recorded_windows` headers (last writer wins) and a window discarded on one host deletes the
other host's header. Stop the Windows service before turning Recording On here.
