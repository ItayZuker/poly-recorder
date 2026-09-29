import { compress } from "@mongodb-js/zstd";
import fs from "fs/promises";
import path from "path";
import { replayRawToBookLines } from "../clob-book-line.js";
import { fetchUpDownMarketAtWindow } from "../market-pair.js";
import { getDataDir } from "./data-dir.js";
import { readRecordedWindowTokenIds } from "./recorded-window-mongo-repository.js";
import { readJsonlZstLines } from "./tick-zst.js";

const ZSTD_LEVEL = 3;

export interface SeriesBookRewriteStats {
  series: string;
  windowsConverted: number;
  windowsSkipped: number;
  rawFilesDeleted: number;
  bookBytesWritten: number;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function seriesIdFromFolder(folder: string): string {
  return folder.replace(/_/g, "-");
}

async function replaceWithTemp(target: string, tmp: string): Promise<void> {
  const st = await fs.stat(tmp);
  if (st.size === 0) {
    await fs.rm(tmp, { force: true });
    throw new Error(`Refusing empty book file for ${target}`);
  }
  const bak = `${target}.bak`;
  try {
    await fs.rename(target, bak);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rename(bak, target).catch(() => undefined);
    throw err;
  }
  await fs.rm(bak, { force: true });
}

async function resolveTokens(
  series: string,
  windowStart: number,
): Promise<{ yesTokenId: string; noTokenId: string } | null> {
  const header = await readRecordedWindowTokenIds(series, windowStart);
  if (header.yesTokenId && header.noTokenId) {
    return { yesTokenId: header.yesTokenId, noTokenId: header.noTokenId };
  }
  try {
    const pair = await fetchUpDownMarketAtWindow(series, windowStart);
    const yesTokenId = pair.yesTokenId.trim();
    const noTokenId = pair.noTokenId.trim();
    if (yesTokenId && noTokenId) return { yesTokenId, noTokenId };
  } catch (err) {
    console.error(
      `[book] ${series} ${windowStart}: token lookup failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return null;
}

async function convertWindow(series: string, windowDir: string, windowStart: number): Promise<"converted" | "skipped"> {
  const rawZst = path.join(windowDir, "clob-raw.jsonl.zst");
  const bookZst = path.join(windowDir, "clob-book.jsonl.zst");
  const liveRaw = path.join(windowDir, "clob-raw.jsonl");
  const liveBook = path.join(windowDir, "clob-book.jsonl");
  if ((await fileSize(rawZst)) === 0) return "skipped";
  if ((await fileSize(bookZst)) > 0) return "skipped";
  if ((await fileSize(liveRaw)) > 0 || (await fileSize(liveBook)) > 0) {
    console.error(`[book] ${series} ${windowStart}: skipped (live JSONL still open)`);
    return "skipped";
  }

  const tokens = await resolveTokens(series, windowStart);
  if (!tokens) {
    console.error(`[book] ${series} ${windowStart}: skipped (missing yesTokenId/noTokenId)`);
    return "skipped";
  }

  let rows: Array<{ tMs?: unknown; payload?: unknown }>;
  try {
    rows = await readJsonlZstLines(rawZst);
  } catch (err) {
    console.error(
      `[book] ${series} ${windowStart}: left raw file (${err instanceof Error ? err.message : String(err)})`,
    );
    return "skipped";
  }

  const lines = replayRawToBookLines(rows, tokens.yesTokenId, tokens.noTokenId);
  if (lines.length === 0) {
    console.error(`[book] ${series} ${windowStart}: skipped (rebuild produced zero ticks)`);
    return "skipped";
  }

  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const tmp = `${bookZst}.slim.tmp`;
  try {
    const packed = await compress(Buffer.from(text), ZSTD_LEVEL);
    await fs.writeFile(tmp, packed);
    await replaceWithTemp(bookZst, tmp);
    await fs.rm(rawZst, { force: true });
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    console.error(
      `[book] ${series} ${windowStart}: left raw file (${err instanceof Error ? err.message : String(err)})`,
    );
    return "skipped";
  }
  return "converted";
}

export async function rewriteRawWindowsToBook(dataDir = getDataDir()): Promise<SeriesBookRewriteStats[]> {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const stats: SeriesBookRewriteStats[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ticksRoot = path.join(dataDir, entry.name, "ticks");
    let windows: string[] = [];
    try {
      windows = await fs.readdir(ticksRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw err;
    }
    const seriesId = seriesIdFromFolder(entry.name);
    const series: SeriesBookRewriteStats = {
      series: entry.name,
      windowsConverted: 0,
      windowsSkipped: 0,
      rawFilesDeleted: 0,
      bookBytesWritten: 0,
    };
    const queue = windows.slice();
    const workers = Array.from({ length: 3 }, async () => {
      for (;;) {
        const name = queue.pop();
        if (!name) return;
        const windowStart = Number(name);
        if (!Number.isFinite(windowStart)) continue;
        const dir = path.join(ticksRoot, name);
        const rawZst = path.join(dir, "clob-raw.jsonl.zst");
        if ((await fileSize(rawZst)) === 0) continue;
        const beforeBook = await fileSize(path.join(dir, "clob-book.jsonl.zst"));
        const result = await convertWindow(seriesId, dir, windowStart);
        if (result === "converted") {
          series.windowsConverted += 1;
          series.rawFilesDeleted += 1;
          series.bookBytesWritten += await fileSize(path.join(dir, "clob-book.jsonl.zst"));
        } else if (beforeBook === 0) {
          series.windowsSkipped += 1;
        }
      }
    });
    await Promise.all(workers);
    if (series.windowsConverted === 0 && series.windowsSkipped === 0) continue;
    console.log(
      `[book] ${series.series}: windows converted ${series.windowsConverted}, windows skipped ${series.windowsSkipped}, raw files deleted ${series.rawFilesDeleted}, book bytes written ${series.bookBytesWritten}`,
    );
    stats.push(series);
  }
  return stats;
}
