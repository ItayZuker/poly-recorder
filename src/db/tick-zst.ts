import { compress, decompress } from "@mongodb-js/zstd";
import fs from "fs/promises";
import { slimJsonlDocument, tickKindFromPath } from "../tick-slim.js";
import {
  chainlinkTicksPath,
  chainlinkTicksZstPath,
  clobBookTicksPath,
  clobBookTicksZstPath,
  clobRawTicksPath,
  clobRawTicksZstPath,
} from "./data-dir.js";

const ZSTD_LEVEL = 3;

async function fileNonEmpty(filePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // best effort
  }
}

async function jsonlToZst(jsonlPath: string, zstPath: string): Promise<void> {
  const raw = await fs.readFile(jsonlPath);
  if (raw.length === 0) {
    throw new Error(`Empty JSONL: ${jsonlPath}`);
  }
  const kind = tickKindFromPath(jsonlPath);
  const body = kind
    ? Buffer.from(slimJsonlDocument(kind, raw.toString("utf8")).text)
    : raw;
  if (body.length === 0) {
    throw new Error(`Empty JSONL after slim: ${jsonlPath}`);
  }
  const packed = await compress(body, ZSTD_LEVEL);
  // Atomic publish: a reader on another host (NFS/EFS) must never see a partial .zst.
  // Write to a temp name in the same directory, then rename over the final path.
  const tmpPath = `${zstPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmpPath, packed);
    await fs.rename(tmpPath, zstPath);
  } catch (err) {
    await removeFile(tmpPath);
    throw err;
  }
}

/** Replay: decompress a `.jsonl.zst` to UTF-8 JSONL text. */
export async function readJsonlZstText(zstPath: string): Promise<string> {
  const packed = await fs.readFile(zstPath);
  const raw = await decompress(packed);
  return raw.toString("utf8");
}

export async function readJsonlZstLines<T>(zstPath: string): Promise<T[]> {
  try {
    const text = await readJsonlZstText(zstPath);
    if (!text.trim()) return [];
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

/** After Gamma: publish the book (or legacy raw) plus Chainlink, then delete live JSONL. */
export async function publishWindowTicksToZst(
  series: string,
  windowStart: number,
): Promise<"published" | "skipped"> {
  const bookJsonl = clobBookTicksPath(series, windowStart);
  const rawJsonl = clobRawTicksPath(series, windowStart);
  const chainJsonl = chainlinkTicksPath(series, windowStart);
  const [hasBook, hasRaw, hasChain] = await Promise.all([
    fileNonEmpty(bookJsonl),
    fileNonEmpty(rawJsonl),
    fileNonEmpty(chainJsonl),
  ]);
  if (!hasChain || (!hasBook && !hasRaw)) {
    await deleteWindowJsonlTicks(series, windowStart);
    return "skipped";
  }
  if (hasBook) {
    await jsonlToZst(bookJsonl, clobBookTicksZstPath(series, windowStart));
  } else {
    await jsonlToZst(rawJsonl, clobRawTicksZstPath(series, windowStart));
  }
  await jsonlToZst(chainJsonl, chainlinkTicksZstPath(series, windowStart));
  await deleteWindowJsonlTicks(series, windowStart);
  return "published";
}

export async function windowHasLiveJsonlTicks(
  series: string,
  windowStart: number,
): Promise<boolean> {
  const [hasBook, hasRaw, hasChain] = await Promise.all([
    fileNonEmpty(clobBookTicksPath(series, windowStart)),
    fileNonEmpty(clobRawTicksPath(series, windowStart)),
    fileNonEmpty(chainlinkTicksPath(series, windowStart)),
  ]);
  return hasBook || hasRaw || hasChain;
}

export async function windowHasReplayZst(
  series: string,
  windowStart: number,
): Promise<boolean> {
  const [hasBook, hasRaw, hasChain] = await Promise.all([
    fileNonEmpty(clobBookTicksZstPath(series, windowStart)),
    fileNonEmpty(clobRawTicksZstPath(series, windowStart)),
    fileNonEmpty(chainlinkTicksZstPath(series, windowStart)),
  ]);
  return (hasBook || hasRaw) && hasChain;
}

/** After 20m with no Gamma: drop live JSONL so Dest cannot replay it. */
export async function deleteWindowJsonlTicks(
  series: string,
  windowStart: number,
): Promise<void> {
  await Promise.all([
    removeFile(clobBookTicksPath(series, windowStart)),
    removeFile(clobRawTicksPath(series, windowStart)),
    removeFile(chainlinkTicksPath(series, windowStart)),
  ]);
}
