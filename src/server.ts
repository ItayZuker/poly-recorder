import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { closeMongoClient } from "./db/mongo-client.js";
import { getDataDir, initStorage, ensureMarketDirs } from "./db/data-dir.js";
import {
  listMarkets,
  getMarket,
  updateMarket,
} from "./db/market-repository.js";
import { SEED_MARKETS } from "./collections.js";
import { recordingManager } from "./recording-manager.js";
import { startArchiveScheduler, stopArchiveScheduler } from "./archive-service.js";
import { logService } from "./log-service.js";
import { getWeekCoverage } from "./week-coverage.js";
import { backfillLocalWindowsToMongo } from "./db/backfill-windows-to-mongo.js";
import {
  getRecorderRole,
  isRecorderRoleValid,
  isViewerRole,
  RECORDER_ROLES,
} from "./recording-enabled.js";

const PORT = Number(process.env.PORT) || 3849;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseSeries(raw: unknown): string {
  const series = String(raw ?? "").trim();
  if (!SEED_MARKETS.some((m) => m.series === series)) {
    throw new Error("Unknown series");
  }
  return series;
}

/** Fail fast on missing config instead of logging "sync failed" every 30s forever. */
function assertRequiredEnv(): void {
  if (!process.env.MONGODB_URI?.trim()) {
    console.error(
      "Fatal: MONGODB_URI is not set. Put it in .env (or the systemd EnvironmentFile) and restart.",
    );
    process.exit(1);
  }
  // Required: an unset or misspelled role must never become a second live recorder.
  if (!isRecorderRoleValid()) {
    const raw = process.env.RECORDER_ROLE;
    console.error(
      raw == null || raw.trim() === ""
        ? `Fatal: RECORDER_ROLE is not set. Add RECORDER_ROLE=recorder (the one live recorder) ` +
            `or RECORDER_ROLE=viewer (read-only) to .env and restart.`
        : `Fatal: RECORDER_ROLE=${JSON.stringify(raw)} is not valid. Use one of: ${RECORDER_ROLES.join(", ")}.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  assertRequiredEnv();
  const role = getRecorderRole();
  const viewer = isViewerRole();
  await initStorage();
  await Promise.all(SEED_MARKETS.map((m) => ensureMarketDirs(m.series)));
  if (!viewer) {
    const backfilled = await backfillLocalWindowsToMongo();
    if (backfilled > 0) {
      logService.info("recorder", `Backfilled ${backfilled} window header(s) from local JSON to Mongo`);
    }
  }

  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      etag: false,
      lastModified: false,
      setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      role,
      dataDir: getDataDir(),
    });
  });

  app.get("/api/markets", async (_req, res) => {
    try {
      const markets = await listMarkets();
      res.json({
        role,
        markets: markets.map((m) => ({
          _id: m._id,
          label: m.label,
          timeframeMinutes: m.timeframeMinutes,
          recordingEnabled: m.recordingEnabled === true,
        })),
        dataDir: getDataDir(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/api/markets/:series/recording", async (req, res) => {
    if (viewer) {
      res.status(403).json({
        error: "This instance is a viewer (RECORDER_ROLE=viewer); change Recording on the live recorder.",
      });
      return;
    }
    try {
      const series = parseSeries(req.params.series);
      const enabled = req.body?.recordingEnabled === true;
      const updated = await updateMarket(series, { recordingEnabled: enabled });
      if (!updated) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      await recordingManager.sync();
      res.json({
        _id: updated._id,
        recordingEnabled: updated.recordingEnabled === true,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/week-coverage", async (req, res) => {
    try {
      const series = parseSeries(req.query.series);
      const market = await getMarket(series);
      if (!market) {
        res.status(404).json({ error: "Market not found" });
        return;
      }
      const coverage = await getWeekCoverage(series);
      res.json({
        ...coverage,
        recordingEnabled: market.recordingEnabled === true,
        label: market.label,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(PORT, () => {
    logService.info("server", `Poly Recorder listening on http://localhost:${PORT}`);
    logService.info("server", `DATA_DIR=${getDataDir()}`);
    logService.info("server", `RECORDER_ROLE=${role}`);
    if (viewer) {
      logService.warn(
        "server",
        "Viewer mode: recording, retention and Mongo header writes are disabled on this instance",
      );
      return;
    }
    void recordingManager.sync().catch((err) => {
      logService.warn("recorder", `Initial sync failed: ${String(err)}`);
    });
    startArchiveScheduler();
    setInterval(() => {
      void recordingManager.sync().catch((err) => {
        logService.warn("recorder", `Periodic sync failed: ${String(err)}`);
      });
    }, 30_000).unref?.();
  });

  // Must finish well inside systemd TimeoutStopSec (30s); hard-exit if it does not.
  const SHUTDOWN_HARD_EXIT_MS = 25_000;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logService.warn("server", `${signal} received again — shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    logService.info("server", `${signal} received — finalizing and flushing before exit`);
    setTimeout(() => {
      console.error("Shutdown did not finish in time; exiting anyway");
      process.exit(1);
    }, SHUTDOWN_HARD_EXIT_MS).unref();

    stopArchiveScheduler();
    try {
      await recordingManager.shutdownAll();
    } catch (err) {
      logService.error("server", `Shutdown error: ${String(err)}`);
    }
    await closeMongoClient().catch(() => {});
    logService.info("server", "Shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
