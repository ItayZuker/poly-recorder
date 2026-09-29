import fs from "fs/promises";
import path from "path";

const DEFAULT_DATA_DIR = "data";

let dataDir: string | null = null;

export function getDataDir(): string {
  if (!dataDir) {
    const configured = process.env.DATA_DIR?.trim();
    dataDir = path.resolve(configured || DEFAULT_DATA_DIR);
  }
  return dataDir;
}

/**
 * A configured DATA_DIR must already exist. Never `mkdir -p` it: if a network
 * mount (EFS/NFS) is not up yet, that would silently create a local directory
 * and write ticks the Replay host never sees. The unconfigured default (`data/`)
 * is still created for local development.
 */
export async function initStorage(): Promise<void> {
  const dir = getDataDir();
  if (!process.env.DATA_DIR?.trim()) {
    await fs.mkdir(dir, { recursive: true });
    return;
  }
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `DATA_DIR ${dir} is not accessible (${code ?? String(err)}). ` +
        "Is the volume mounted? Refusing to create it.",
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`DATA_DIR ${dir} exists but is not a directory`);
  }
}

/** Legacy path — read once to migrate into Mongo `markets`. */
export function marketsFilePath(): string {
  return path.join(getDataDir(), "markets.json");
}

export function marketDir(series: string): string {
  return path.join(getDataDir(), series.replace(/-/g, "_"));
}

export function marketTicksDir(series: string): string {
  return path.join(marketDir(series), "ticks");
}

export function windowTicksDir(series: string, windowStart: number): string {
  return path.join(marketTicksDir(series), String(windowStart));
}

export function clobRawTicksPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "clob-raw.jsonl");
}

export function clobRawTicksZstPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "clob-raw.jsonl.zst");
}

export function clobBookTicksPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "clob-book.jsonl");
}

export function clobBookTicksZstPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "clob-book.jsonl.zst");
}

export function chainlinkTicksPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "chainlink.jsonl");
}

export function chainlinkTicksZstPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "chainlink.jsonl.zst");
}

export function marketWindowsDir(series: string): string {
  return path.join(marketDir(series), "windows");
}

/** Legacy zip folder — no longer created; retention deletes it if present. */
export function marketArchiveDir(series: string): string {
  return path.join(marketDir(series), "archive");
}

export async function ensureMarketDirs(series: string): Promise<void> {
  await Promise.all([
    fs.mkdir(marketTicksDir(series), { recursive: true }),
    fs.mkdir(marketWindowsDir(series), { recursive: true }),
  ]);
}

export function parseWindowStartFromFilename(filename: string): number | null {
  const match = /^(\d+)(?:\.(json|jsonl))?$/.exec(filename);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
