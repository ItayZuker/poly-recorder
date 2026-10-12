/** Published Replay tick lines: only the fields the trading app still reads. */

import { RECORDING_BOOK_DEPTH } from "./book-depth.js";

const BOOK_LEVELS = RECORDING_BOOK_DEPTH;

export type TickFileKind = "chainlink" | "clob-raw" | "clob-book";

export class TickSlimParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TickSlimParseError";
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function keepValue(value: unknown): unknown | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function isCompactChainlink(doc: Record<string, unknown>): boolean {
  return doc.tMs === undefined && doc.assetPrice === undefined && doc.windowStart === undefined &&
    (doc["1"] != null || doc["2"] != null || doc["3"] != null);
}

/**
 * Pre-derived compact layout: ptbCrossings is "6", running low/high are "7"/"8".
 * Current layout keeps ptbCrossings at "5" and the running low/high at "6"/"7".
 */
function isLegacyCompactChainlink(doc: Record<string, unknown>): boolean {
  return doc["8"] !== undefined || doc["9"] !== undefined || doc["10"] !== undefined || doc["11"] !== undefined;
}

function usesNamedChainlinkKeys(doc: Record<string, unknown>): boolean {
  return (
    doc.tMs !== undefined ||
    doc.assetPrice !== undefined ||
    doc.windowStart !== undefined ||
    doc.windowEnd !== undefined ||
    doc.prevCloseAsset !== undefined ||
    doc.ptbCrossings !== undefined ||
    doc.minAssetPrice !== undefined ||
    doc.maxAssetPrice !== undefined ||
    doc.priceToBeatSource !== undefined ||
    doc.assetGap !== undefined ||
    doc.assetRange !== undefined ||
    doc.rangeTop !== undefined ||
    doc.rangeBottom !== undefined
  );
}

function dropKey(doc: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(doc, key)) return false;
  delete doc[key];
  return true;
}

/**
 * Remove the running low/high from one Chainlink tick.
 * Named lines lose minAssetPrice and maxAssetPrice.
 * Current numeric lines lose "6" and "7". Legacy numeric lines lose "7" and "8"
 * so ptbCrossings at "6" stays.
 */
export function stripChainlinkRangeFields(doc: Record<string, unknown>): boolean {
  if (usesNamedChainlinkKeys(doc)) {
    const droppedMin = dropKey(doc, "minAssetPrice");
    const droppedMax = dropKey(doc, "maxAssetPrice");
    return droppedMin || droppedMax;
  }
  if (isLegacyCompactChainlink(doc)) {
    const droppedMin = dropKey(doc, "7");
    const droppedMax = dropKey(doc, "8");
    return droppedMin || droppedMax;
  }
  const droppedMin = dropKey(doc, "6");
  const droppedMax = dropKey(doc, "7");
  return droppedMin || droppedMax;
}

/** Chainlink line stored on disk: time and asset price. Window fields stay on the Mongo header. */
export function slimChainlinkTick(doc: Record<string, unknown>): Record<string, unknown> {
  const compact = isCompactChainlink(doc);
  const tMs = finiteNumber(compact ? doc["2"] : doc.tMs);
  const assetPrice = finiteNumber(compact ? doc["3"] : doc.assetPrice);
  const out: Record<string, unknown> = {};
  if (tMs !== undefined) out.tMs = tMs;
  if (assetPrice !== undefined) out.assetPrice = assetPrice;
  return out;
}

/**
 * Drop running low/high from each Chainlink JSONL line. Other fields stay.
 * Throws TickSlimParseError on a line that is not a JSON object.
 */
export function stripChainlinkRangeJsonl(text: string): { text: string; changed: boolean; lines: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let changed = false;
  let linesIn = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    linesIn += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new TickSlimParseError(
        `line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TickSlimParseError(`line ${i + 1}: expected a JSON object`);
    }
    const doc = parsed as Record<string, unknown>;
    if (stripChainlinkRangeFields(doc)) {
      changed = true;
      out.push(JSON.stringify(doc));
    } else {
      out.push(line);
    }
  }
  return { text: out.join("\n"), changed, lines: linesIn };
}

function slimLevels(
  raw: unknown,
  side: "bid" | "ask",
): Array<{ price: unknown; size: unknown }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const levels: Array<{ price: unknown; size: unknown; n: number }> = [];
  for (const level of raw) {
    if (!level || typeof level !== "object" || Array.isArray(level)) continue;
    const rec = level as Record<string, unknown>;
    const price = rec.price;
    const size = rec.size ?? rec.amount;
    const priceN = finiteNumber(price);
    const sizeN = finiteNumber(size);
    if (priceN == null || sizeN == null || sizeN <= 0) continue;
    levels.push({ price, size, n: priceN });
  }
  levels.sort((a, b) => (side === "bid" ? b.n - a.n : a.n - b.n));
  const top = levels.slice(0, BOOK_LEVELS).map(({ price, size }) => ({ price, size }));
  return top.length > 0 ? top : undefined;
}

function slimBookMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  const assetId = typeof msg.asset_id === "string" && msg.asset_id ? msg.asset_id : undefined;
  const bids = slimLevels(msg.bids, "bid");
  const asks = slimLevels(msg.asks, "ask");
  const bestBid = keepValue(msg.best_bid);
  const bestAsk = keepValue(msg.best_ask);
  if (!assetId || (!bids && !asks && bestBid === undefined && bestAsk === undefined)) return null;
  const out: Record<string, unknown> = { event_type: "book", asset_id: assetId };
  if (bids) out.bids = bids;
  if (asks) out.asks = asks;
  if (bestBid !== undefined) out.best_bid = bestBid;
  if (bestAsk !== undefined) out.best_ask = bestAsk;
  return out;
}

function slimBestBidAsk(msg: Record<string, unknown>): Record<string, unknown> | null {
  const assetId = typeof msg.asset_id === "string" && msg.asset_id ? msg.asset_id : undefined;
  const bestBid = keepValue(msg.best_bid);
  const bestAsk = keepValue(msg.best_ask);
  if (!assetId || (bestBid === undefined && bestAsk === undefined)) return null;
  const out: Record<string, unknown> = { event_type: "best_bid_ask", asset_id: assetId };
  if (bestBid !== undefined) out.best_bid = bestBid;
  if (bestAsk !== undefined) out.best_ask = bestAsk;
  return out;
}

function slimLastTrade(msg: Record<string, unknown>): Record<string, unknown> | null {
  const assetId = typeof msg.asset_id === "string" && msg.asset_id ? msg.asset_id : undefined;
  const price = keepValue(msg.price);
  if (!assetId || price === undefined) return null;
  return { event_type: "last_trade_price", asset_id: assetId, price };
}

function slimPriceChange(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(msg.price_changes)) return null;
  const changes: Array<Record<string, unknown>> = [];
  for (const change of msg.price_changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) continue;
    const rec = change as Record<string, unknown>;
    const assetId = typeof rec.asset_id === "string" && rec.asset_id ? rec.asset_id : undefined;
    if (!assetId) continue;
    const bestBid = keepValue(rec.best_bid);
    const bestAsk = keepValue(rec.best_ask);
    if (bestBid === undefined && bestAsk === undefined) continue;
    const row: Record<string, unknown> = { asset_id: assetId };
    if (bestBid !== undefined) row.best_bid = bestBid;
    if (bestAsk !== undefined) row.best_ask = bestAsk;
    changes.push(row);
  }
  if (changes.length === 0) return null;
  const out: Record<string, unknown> = { event_type: "price_change", price_changes: changes };
  if (typeof msg.asset_id === "string" && msg.asset_id) out.asset_id = msg.asset_id;
  return out;
}

function slimUnknownMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  const bids = slimLevels(msg.bids, "bid");
  const asks = slimLevels(msg.asks, "ask");
  const bestBid = keepValue(msg.best_bid);
  const bestAsk = keepValue(msg.best_ask);
  const price = keepValue(msg.price);
  const nested = Array.isArray(msg.price_changes) ? slimPriceChange(msg) : null;
  if (!bids && !asks && bestBid === undefined && bestAsk === undefined && price === undefined && !nested) {
    return null;
  }
  const out: Record<string, unknown> = {};
  if (typeof msg.event_type === "string" && msg.event_type) out.event_type = msg.event_type;
  if (typeof msg.asset_id === "string" && msg.asset_id) out.asset_id = msg.asset_id;
  if (bids) out.bids = bids;
  if (asks) out.asks = asks;
  if (bestBid !== undefined) out.best_bid = bestBid;
  if (bestAsk !== undefined) out.best_ask = bestAsk;
  if (price !== undefined) out.price = price;
  if (nested?.price_changes) out.price_changes = nested.price_changes;
  return out;
}

export function slimClobPayload(payload: unknown): unknown | null {
  if (Array.isArray(payload)) {
    const messages = payload
      .map((message) => slimClobMessage(message))
      .filter((message) => message != null);
    return messages.length > 0 ? messages : null;
  }
  return slimClobMessage(payload);
}

function slimClobMessage(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const msg = message as Record<string, unknown>;
  const eventType = typeof msg.event_type === "string" ? msg.event_type : "";
  if (eventType === "book") return slimBookMessage(msg);
  if (eventType === "best_bid_ask") return slimBestBidAsk(msg);
  if (eventType === "last_trade_price") return slimLastTrade(msg);
  if (eventType === "price_change") return slimPriceChange(msg);
  return slimUnknownMessage(msg);
}

function oneBookLevel(
  price: unknown,
  size: unknown,
): Array<{ price: number; size: number }> {
  const priceN = finiteNumber(price);
  const sizeN = finiteNumber(size);
  if (priceN == null || sizeN == null || sizeN <= 0) return [];
  return [{ price: priceN, size: sizeN }];
}

function bookSide(
  raw: unknown,
  side: "bid" | "ask",
): Array<{ price: number; size: number }> {
  const levels = slimLevels(raw, side);
  if (!levels) return [];
  const out: Array<{ price: number; size: number }> = [];
  for (const level of levels) {
    const price = finiteNumber(level.price);
    const size = finiteNumber(level.size);
    if (price == null || size == null || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

/**
 * Published book line: `{ tMs, yesBids, yesAsks, noBids, noAsks }` with the
 * recording depth. Window bounds stay on the Mongo header.
 * Returns null when the line has no time or no levels.
 */
export function slimClobBookTick(doc: Record<string, unknown>): Record<string, unknown> | null {
  const hasNamedArrays =
    Array.isArray(doc.yesBids) ||
    Array.isArray(doc.yesAsks) ||
    Array.isArray(doc.noBids) ||
    Array.isArray(doc.noAsks);
  const hasNamedTop =
    doc.tMs !== undefined ||
    doc.yesBid !== undefined ||
    doc.yesAsk !== undefined ||
    doc.noBid !== undefined ||
    doc.noAsk !== undefined;

  let tMs: number | undefined;
  let yesBids: Array<{ price: number; size: number }>;
  let yesAsks: Array<{ price: number; size: number }>;
  let noBids: Array<{ price: number; size: number }>;
  let noAsks: Array<{ price: number; size: number }>;

  if (hasNamedArrays || hasNamedTop) {
    tMs = finiteNumber(doc.tMs);
    if (hasNamedArrays) {
      yesBids = bookSide(doc.yesBids, "bid");
      yesAsks = bookSide(doc.yesAsks, "ask");
      noBids = bookSide(doc.noBids, "bid");
      noAsks = bookSide(doc.noAsks, "ask");
    } else {
      yesBids = oneBookLevel(doc.yesBid, doc.yesBidSize);
      yesAsks = oneBookLevel(doc.yesAsk, doc.yesAskSize);
      noBids = oneBookLevel(doc.noBid, doc.noBidSize);
      noAsks = oneBookLevel(doc.noAsk, doc.noAskSize);
    }
  } else {
    tMs = finiteNumber(doc["2"]);
    yesBids = oneBookLevel(doc["4"], doc["6"]);
    yesAsks = oneBookLevel(doc["5"], doc["7"]);
    noBids = oneBookLevel(doc["9"], doc["11"]);
    noAsks = oneBookLevel(doc["10"], doc["12"]);
  }

  if (tMs === undefined) return null;
  if (yesBids.length + yesAsks.length + noBids.length + noAsks.length === 0) return null;
  return { tMs, yesBids, yesAsks, noBids, noAsks };
}

/** `{ tMs, payload }` or null when the message cannot change the book. */
export function slimClobRawTick(doc: Record<string, unknown>): Record<string, unknown> | null {
  const payload = slimClobPayload(doc.payload);
  if (payload == null) return null;
  const out: Record<string, unknown> = {};
  const tMs = finiteNumber(doc.tMs);
  if (tMs !== undefined) out.tMs = tMs;
  out.payload = payload;
  return out;
}

export function slimJsonlDocument(
  kind: TickFileKind,
  text: string,
): { text: string; linesIn: number; linesOut: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let linesIn = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    linesIn += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new TickSlimParseError(
        `line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TickSlimParseError(`line ${i + 1}: expected a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    const slim =
      kind === "chainlink"
        ? slimChainlinkTick(record)
        : kind === "clob-book"
          ? slimClobBookTick(record)
          : slimClobRawTick(record);
    if (slim == null) continue;
    out.push(JSON.stringify(slim));
  }
  return {
    text: out.length > 0 ? `${out.join("\n")}\n` : "",
    linesIn,
    linesOut: out.length,
  };
}

export function tickKindFromPath(filePath: string): TickFileKind | null {
  const base = filePath.replace(/\\/g, "/");
  if (base.endsWith("/chainlink.jsonl") || base.endsWith("/chainlink.jsonl.zst")) return "chainlink";
  if (base.endsWith("/clob-book.jsonl") || base.endsWith("/clob-book.jsonl.zst")) return "clob-book";
  if (base.endsWith("/clob-raw.jsonl") || base.endsWith("/clob-raw.jsonl.zst")) return "clob-raw";
  return null;
}
