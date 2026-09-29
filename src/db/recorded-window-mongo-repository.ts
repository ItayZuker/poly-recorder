import type { PtbHistoryEntry, RecordedWindowDocument, WindowOutcome } from "../types.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "recorded_windows";

/** Window summary in Mongo — dest Replay reads the original slim fields; extras are ignored. */
export interface RecordedWindowSummary {
  series: string;
  windowStart: number;
  windowEnd: number;
  savedAt: string;
  ptbCrossings?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  windowOutcome?: WindowOutcome;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  /** Window open / PTB (for Open Replay metrics). */
  prevCloseAsset?: number;
  /** Last asset mark for the window (Open Replay close). */
  assetPrice?: number;
  ptbHistory?: PtbHistoryEntry[];
  gammaPtb?: number;
  ptbChainlink?: number;
  ptbTwap30?: number;
  ptbTwap60?: number;
  slug?: string;
  question?: string;
  conditionId?: string;
  yesPrice?: number;
  noPrice?: number;
  assetGap?: number;
  tickCount?: number;
  clobRawCount?: number;
  clobBookCount?: number;
  chainlinkCount?: number;
}

export type RecordedWindowWrite = Omit<RecordedWindowDocument, "_id" | "updatedAt"> & {
  updatedAt?: string;
};

type MongoRecordedWindowDoc = {
  _id?: string | undefined;
  series?: string;
  marketSeries?: string;
  windowStart?: number;
  windowEnd?: number;
  savedAt?: string | Date;
  updatedAt?: string | Date;
  ptbCrossings?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  windowOutcome?: WindowOutcome | null;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  prevCloseAsset?: number;
  assetPrice?: number;
  ptbHistory?: unknown;
  gammaPtb?: number;
  ptbChainlink?: number;
  ptbTwap30?: number;
  ptbTwap60?: number;
  slug?: string;
  question?: string;
  conditionId?: string;
  yesPrice?: number;
  noPrice?: number;
  assetGap?: number;
  tickCount?: number;
  clobRawCount?: number;
  clobBookCount?: number;
  chainlinkCount?: number;
  /** Legacy nested payload from older sim writers. */
  window?: {
    windowStart?: number;
    windowEnd?: number;
    savedAt?: string;
    ptbCrossings?: number;
    rangeTop?: number;
    rangeBottom?: number;
    uniqueTraders?: number;
    newWallets?: number;
    windowOutcome?: WindowOutcome | null;
    minAssetPrice?: number;
    maxAssetPrice?: number;
    assetRange?: number;
    prevCloseAsset?: number;
    assetPrice?: number;
  };
};

/** Fields Replay no longer reads. Removed from every header. */
export const REMOVED_RECORDED_WINDOW_FIELDS = [
  "question",
  "slug",
  "conditionId",
  "marketSeries",
  "yesTokenId",
  "noTokenId",
  "yesPrice",
  "noPrice",
  "uniqueTraders",
  "newWallets",
  "knownWallets",
  "tickCount",
  "clobRawCount",
  "clobBookCount",
  "chainlinkCount",
  "ptbCrossings",
  "assetGap",
  "rangeTop",
  "rangeBottom",
  "assetRange",
  "ptbHistory",
  "updatedAt",
  "window",
] as const;

const WINDOW_SUMMARY_PROJECTION = {
  _id: 1,
  series: 1,
  windowStart: 1,
  windowEnd: 1,
  savedAt: 1,
  windowOutcome: 1,
  minAssetPrice: 1,
  maxAssetPrice: 1,
  prevCloseAsset: 1,
  assetPrice: 1,
  gammaPtb: 1,
  ptbChainlink: 1,
  ptbTwap30: 1,
  ptbTwap60: 1,
  "window.windowStart": 1,
  "window.windowEnd": 1,
  "window.savedAt": 1,
  "window.windowOutcome": 1,
  "window.minAssetPrice": 1,
  "window.maxAssetPrice": 1,
  "window.prevCloseAsset": 1,
  "window.assetPrice": 1,
  "window.gammaPtb": 1,
  "window.ptbChainlink": 1,
  "window.ptbTwap30": 1,
  "window.ptbTwap60": 1,
} as const;

function seriesFromDoc(doc: MongoRecordedWindowDoc): string | null {
  if (typeof doc.series === "string" && doc.series.length > 0) return doc.series;
  if (typeof doc.marketSeries === "string" && doc.marketSeries.length > 0) return doc.marketSeries;
  if (typeof doc._id === "string" && doc._id.includes(":")) {
    return doc._id.slice(0, doc._id.lastIndexOf(":"));
  }
  return null;
}

function savedAtToString(value: string | Date | undefined, fallback: number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return String(fallback);
}

function normalizeDoc(doc: MongoRecordedWindowDoc): RecordedWindowSummary | null {
  const nested = doc.window;
  const series = seriesFromDoc(doc);
  const windowStart = doc.windowStart ?? nested?.windowStart;
  if (!series || windowStart == null || !Number.isFinite(windowStart)) return null;

  const windowEnd = doc.windowEnd ?? nested?.windowEnd ?? windowStart;
  const savedAt = savedAtToString(doc.savedAt ?? nested?.savedAt, windowStart);
  const windowOutcome = doc.windowOutcome ?? nested?.windowOutcome;

  const out: RecordedWindowSummary = {
    series,
    windowStart,
    windowEnd,
    savedAt,
  };

  const minAssetPrice = doc.minAssetPrice ?? nested?.minAssetPrice;
  const maxAssetPrice = doc.maxAssetPrice ?? nested?.maxAssetPrice;
  const prevCloseAsset = doc.prevCloseAsset ?? nested?.prevCloseAsset;
  const assetPrice = doc.assetPrice ?? nested?.assetPrice;

  if (minAssetPrice != null && Number.isFinite(minAssetPrice)) out.minAssetPrice = minAssetPrice;
  if (maxAssetPrice != null && Number.isFinite(maxAssetPrice)) out.maxAssetPrice = maxAssetPrice;
  if (prevCloseAsset != null && Number.isFinite(prevCloseAsset)) out.prevCloseAsset = prevCloseAsset;
  if (assetPrice != null && Number.isFinite(assetPrice)) out.assetPrice = assetPrice;
  if (doc.gammaPtb != null && Number.isFinite(doc.gammaPtb)) out.gammaPtb = doc.gammaPtb;
  if (doc.ptbChainlink != null && Number.isFinite(doc.ptbChainlink)) {
    out.ptbChainlink = doc.ptbChainlink;
  }
  if (doc.ptbTwap30 != null && Number.isFinite(doc.ptbTwap30)) out.ptbTwap30 = doc.ptbTwap30;
  if (doc.ptbTwap60 != null && Number.isFinite(doc.ptbTwap60)) out.ptbTwap60 = doc.ptbTwap60;
  if (windowOutcome === "up" || windowOutcome === "down") out.windowOutcome = windowOutcome;

  return out;
}

export function summaryToRecordedWindow(summary: RecordedWindowSummary): RecordedWindowDocument {
  return {
    _id: `${summary.series}:${summary.windowStart}`,
    windowStart: summary.windowStart,
    windowEnd: summary.windowEnd,
    savedAt: summary.savedAt,
    updatedAt: summary.savedAt,
    assetPrice: summary.assetPrice,
    prevCloseAsset: summary.prevCloseAsset,
    gammaPtb: summary.gammaPtb,
    ptbChainlink: summary.ptbChainlink,
    ptbTwap30: summary.ptbTwap30,
    ptbTwap60: summary.ptbTwap60,
    assetGap: summary.assetGap,
    windowOutcome: summary.windowOutcome,
    minAssetPrice: summary.minAssetPrice,
    maxAssetPrice: summary.maxAssetPrice,
    tickCount: summary.tickCount ?? 0,
  };
}

function setNum(target: MongoRecordedWindowDoc, key: keyof MongoRecordedWindowDoc, value: unknown): void {
  const n = Number(value);
  if (Number.isFinite(n)) (target as Record<string, unknown>)[key as string] = n;
}

function buildWindowSet(
  series: string,
  window: RecordedWindowWrite,
): { $set: MongoRecordedWindowDoc; $unset?: Record<string, ""> } {
  const $set: MongoRecordedWindowDoc = {
    series,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    savedAt: window.savedAt,
  };
  setNum($set, "minAssetPrice", window.minAssetPrice);
  setNum($set, "maxAssetPrice", window.maxAssetPrice);
  setNum($set, "prevCloseAsset", window.prevCloseAsset);
  setNum($set, "assetPrice", window.assetPrice);
  if (window.gammaPtb != null && Number.isFinite(window.gammaPtb)) {
    $set.gammaPtb = window.gammaPtb;
  }
  setNum($set, "ptbChainlink", window.ptbChainlink);
  setNum($set, "ptbTwap30", window.ptbTwap30);
  setNum($set, "ptbTwap60", window.ptbTwap60);
  if (window.windowOutcome === "up" || window.windowOutcome === "down") {
    $set.windowOutcome = window.windowOutcome;
  }

  const $unset: Record<string, ""> = {};
  for (const field of REMOVED_RECORDED_WINDOW_FIELDS) $unset[field] = "";
  return { $set, $unset };
}

const NESTED_KEPT_FIELDS = [
  "series",
  "windowStart",
  "windowEnd",
  "savedAt",
  "windowOutcome",
  "assetPrice",
  "prevCloseAsset",
  "ptbChainlink",
  "ptbTwap30",
  "ptbTwap60",
  "gammaPtb",
  "minAssetPrice",
  "maxAssetPrice",
] as const;

function keptValue(value: unknown): unknown | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

/**
 * Copy kept fields that live only inside `window`, then drop every field Replay
 * no longer reads. Does not delete documents or clear settled outcomes / PTB / min / max.
 */
export async function slimRecordedWindowDocuments(): Promise<{ scanned: number; updated: number }> {
  const mongo = await getMongoClient();
  const collection = mongo.db(getMongoDbName()).collection(COLLECTION);
  const cursor = collection.find({});
  let scanned = 0;
  let updated = 0;
  const ops: Array<{
    updateOne: {
      filter: { _id: unknown };
      update: { $set?: Record<string, unknown>; $unset: Record<string, ""> };
    };
  }> = [];

  const flush = async (): Promise<void> => {
    if (ops.length === 0) return;
    const result = await collection.bulkWrite(ops as never, { ordered: false });
    updated += result.modifiedCount ?? 0;
    ops.length = 0;
  };

  for await (const doc of cursor) {
    scanned += 1;
    const record = doc as Record<string, unknown>;
    const nested =
      record.window && typeof record.window === "object" && !Array.isArray(record.window)
        ? (record.window as Record<string, unknown>)
        : undefined;
    const $set: Record<string, unknown> = {};
    if (nested) {
      for (const field of NESTED_KEPT_FIELDS) {
        if (keptValue(record[field]) != null) continue;
        const lifted = keptValue(nested[field]);
        if (lifted == null) continue;
        if (field === "windowOutcome" && lifted !== "up" && lifted !== "down") continue;
        $set[field] = lifted;
      }
    }
    if (keptValue($set.series ?? record.series) == null) {
      const fromMarket = keptValue(record.marketSeries);
      const fromId =
        typeof record._id === "string" && record._id.includes(":")
          ? record._id.slice(0, record._id.lastIndexOf(":"))
          : undefined;
      const series = fromMarket ?? fromId;
      if (typeof series === "string" && series.length > 0) $set.series = series;
    }
    const outcome = keptValue($set.windowOutcome ?? record.windowOutcome);
    const $unset: Record<string, ""> = {};
    for (const field of REMOVED_RECORDED_WINDOW_FIELDS) $unset[field] = "";
    if (outcome !== "up" && outcome !== "down" && record.windowOutcome != null && $set.windowOutcome == null) {
      $unset.windowOutcome = "";
    }
    const update: { $set?: Record<string, unknown>; $unset: Record<string, ""> } = { $unset };
    if (Object.keys($set).length > 0) update.$set = $set;
    ops.push({ updateOne: { filter: { _id: record._id }, update } });
    if (ops.length >= 500) await flush();
  }
  await flush();
  return { scanned, updated };
}

/** Read token ids already stored on the header. Does not write the document. */
export async function readRecordedWindowTokenIds(
  series: string,
  windowStart: number,
): Promise<{ yesTokenId?: string; noTokenId?: string }> {
  const mongo = await getMongoClient();
  const doc = await mongo
    .db(getMongoDbName())
    .collection<{ _id: string; yesTokenId?: string; noTokenId?: string }>(COLLECTION)
    .findOne(
      { _id: `${series}:${windowStart}` },
      { projection: { yesTokenId: 1, noTokenId: 1 } },
    );
  const yesTokenId = typeof doc?.yesTokenId === "string" ? doc.yesTokenId.trim() : "";
  const noTokenId = typeof doc?.noTokenId === "string" ? doc.noTokenId.trim() : "";
  return {
    yesTokenId: yesTokenId || undefined,
    noTokenId: noTokenId || undefined,
  };
}

/** Upsert one window header (full local-JSON field set; dest ignores unknown keys). */
export async function upsertRecordedWindowSummary(
  series: string,
  window: RecordedWindowWrite,
): Promise<void> {
  const mongo = await getMongoClient();
  const _id = `${series}:${window.windowStart}`;
  await mongo
    .db(getMongoDbName())
    .collection<MongoRecordedWindowDoc>(COLLECTION)
    .updateOne({ _id }, buildWindowSet(series, window), { upsert: true });
}

export async function upsertRecordedWindowSummaries(
  series: string,
  windows: RecordedWindowWrite[],
): Promise<number> {
  if (windows.length === 0) return 0;
  const mongo = await getMongoClient();
  const ops = windows.map((window) => ({
    updateOne: {
      filter: { _id: `${series}:${window.windowStart}` },
      update: buildWindowSet(series, window),
      upsert: true,
    },
  }));
  const result = await mongo
    .db(getMongoDbName())
    .collection<MongoRecordedWindowDoc>(COLLECTION)
    .bulkWrite(ops, { ordered: false });
  return (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0) + (result.matchedCount ?? 0);
}

/** Delete one Mongo recorded_windows summary. */
export async function deleteRecordedWindowSummary(
  series: string,
  windowStart: number,
): Promise<void> {
  const mongo = await getMongoClient();
  const _id = `${series}:${windowStart}`;
  await mongo
    .db(getMongoDbName())
    .collection<MongoRecordedWindowDoc>(COLLECTION)
    .deleteOne({ _id });
}

/** Delete Mongo recorded_windows summaries older than cutoff (optionally one series). */
export async function deleteRecordedWindowsBefore(
  cutoffUtc: number,
  series?: string,
): Promise<number> {
  const mongo = await getMongoClient();
  const filter: { windowStart: { $lt: number }; series?: string } = {
    windowStart: { $lt: cutoffUtc },
  };
  if (series) filter.series = series;
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .deleteMany(filter);
  return result.deletedCount ?? 0;
}

/**
 * Fetch rolling-window summaries for Replay slot counts.
 * Projects only summary fields — never ticks.
 */
export async function listRecordedWindowsSince(
  cutoffUtc: number,
  series?: string,
): Promise<RecordedWindowSummary[]> {
  const mongo = await getMongoClient();
  const filter: { windowStart: { $gte: number }; series?: string } = {
    windowStart: { $gte: cutoffUtc },
  };
  if (series) filter.series = series;
  const docs = await mongo
    .db(getMongoDbName())
    .collection<MongoRecordedWindowDoc>(COLLECTION)
    .find(filter, { projection: WINDOW_SUMMARY_PROJECTION })
    .sort({ windowStart: 1 })
    .batchSize(5_000)
    .toArray();

  const out: RecordedWindowSummary[] = [];
  for (const doc of docs) {
    const normalized = normalizeDoc(doc);
    if (!normalized) continue;
    // Legacy docs may lack `series` on the filter field — keep series-wide scans intact.
    if (series && normalized.series !== series) continue;
    out.push(normalized);
  }
  return out;
}

/** One window summary from Mongo. */
export async function getRecordedWindowSummary(
  series: string,
  windowStart: number,
): Promise<RecordedWindowSummary | null> {
  const ser = String(series || "").trim();
  const ws = Math.floor(Number(windowStart));
  if (!ser || !Number.isFinite(ws) || ws <= 0) return null;
  const mongo = await getMongoClient();
  const doc = await mongo
    .db(getMongoDbName())
    .collection<MongoRecordedWindowDoc>(COLLECTION)
    .findOne({ _id: `${ser}:${ws}` }, { projection: WINDOW_SUMMARY_PROJECTION });
  if (!doc) return null;
  const normalized = normalizeDoc(doc);
  if (!normalized || normalized.series !== ser) return null;
  return normalized;
}

export async function listRecordedWindowStarts(
  series: string,
  cutoffUtc = 0,
): Promise<number[]> {
  const windows = await listRecordedWindowsSince(cutoffUtc, series);
  return windows.map((window) => window.windowStart);
}
