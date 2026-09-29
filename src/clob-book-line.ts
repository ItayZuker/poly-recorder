import { takeLevels, RECORDING_BOOK_DEPTH } from "./book-depth.js";
import {
  mergeBestLevelsIntoDepth,
  parseBookSide,
  type BookLevel,
} from "./clob-service.js";

/** Published Replay book line. All four sides are always present. */
export interface ClobBookLine {
  tMs: number;
  yesBids: BookLevel[];
  yesAsks: BookLevel[];
  noBids: BookLevel[];
  noAsks: BookLevel[];
}

interface SideBook {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
}

function emptySide(): SideBook {
  return { bids: [], asks: [] };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Sort, drop empty levels, keep the best 5. */
export function topBookLevels(levels: BookLevel[] | undefined, side: "bid" | "ask"): BookLevel[] {
  const parsed = (levels ?? [])
    .map((level) => ({
      price: finiteNumber(level.price),
      size: finiteNumber(level.size),
    }))
    .filter((level): level is BookLevel => level.price != null && level.size != null && level.size > 0);
  parsed.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return parsed.slice(0, RECORDING_BOOK_DEPTH).map((level) => ({ price: level.price, size: level.size }));
}

export function bookSidesKey(line: Pick<ClobBookLine, "yesBids" | "yesAsks" | "noBids" | "noAsks">): string {
  return JSON.stringify({
    yesBids: line.yesBids,
    yesAsks: line.yesAsks,
    noBids: line.noBids,
    noAsks: line.noAsks,
  });
}

function sideFromCache(bids: BookLevel[] | undefined, asks: BookLevel[] | undefined): {
  bids: BookLevel[];
  asks: BookLevel[];
} {
  return {
    bids: topBookLevels(bids, "bid"),
    asks: topBookLevels(asks, "ask"),
  };
}

export function makeBookLine(
  tMs: number,
  yesBids: BookLevel[] | undefined,
  yesAsks: BookLevel[] | undefined,
  noBids: BookLevel[] | undefined,
  noAsks: BookLevel[] | undefined,
): ClobBookLine {
  const yes = sideFromCache(yesBids, yesAsks);
  const no = sideFromCache(noBids, noAsks);
  return {
    tMs,
    yesBids: yes.bids,
    yesAsks: yes.asks,
    noBids: no.bids,
    noAsks: no.asks,
  };
}

function snapshot(tMs: number, yes: SideBook, no: SideBook): ClobBookLine {
  const yesTrim = trimSide(yes);
  const noTrim = trimSide(no);
  return {
    tMs,
    yesBids: topBookLevels(yesTrim.bids, "bid"),
    yesAsks: topBookLevels(yesTrim.asks, "ask"),
    noBids: topBookLevels(noTrim.bids, "bid"),
    noAsks: topBookLevels(noTrim.asks, "ask"),
  };
}

function trimSide(side: SideBook): SideBook {
  const merged = mergeBestLevelsIntoDepth(side);
  return {
    ...merged,
    bids: takeLevels(merged.bids, RECORDING_BOOK_DEPTH),
    asks: takeLevels(merged.asks, RECORDING_BOOK_DEPTH),
  };
}

function applyBook(side: SideBook, message: Record<string, unknown>): void {
  const bids = Array.isArray(message.bids)
    ? parseBookSide(message.bids as Array<{ price?: unknown; size?: unknown; amount?: unknown }>, "bid")
    : undefined;
  const asks = Array.isArray(message.asks)
    ? parseBookSide(message.asks as Array<{ price?: unknown; size?: unknown; amount?: unknown }>, "ask")
    : undefined;
  if (bids && bids.length > 0) {
    side.bids = takeLevels(bids, RECORDING_BOOK_DEPTH);
    const top = side.bids[0];
    side.bestBid = top?.price;
    side.bestBidSize = top?.size;
  }
  if (asks && asks.length > 0) {
    side.asks = takeLevels(asks, RECORDING_BOOK_DEPTH);
    const top = side.asks[0];
    side.bestAsk = top?.price;
    side.bestAskSize = top?.size;
  }
}

function applyBest(side: SideBook, bestBidRaw: unknown, bestAskRaw: unknown): void {
  const bestBid = finiteNumber(bestBidRaw);
  const bestAsk = finiteNumber(bestAskRaw);
  if (bestBid != null) side.bestBid = bestBid;
  if (bestAsk != null) side.bestAsk = bestAsk;
  const merged = mergeBestLevelsIntoDepth(side);
  const bids = takeLevels(merged.bids, RECORDING_BOOK_DEPTH);
  const asks = takeLevels(merged.asks, RECORDING_BOOK_DEPTH);
  side.bids = bids;
  side.asks = asks;
  side.bestBid = merged.bestBid;
  side.bestAsk = merged.bestAsk;
  side.bestBidSize = merged.bestBidSize;
  side.bestAskSize = merged.bestAskSize;
}

function applyMessage(yes: SideBook, no: SideBook, yesTokenId: string, noTokenId: string, message: Record<string, unknown>): void {
  const eventType = typeof message.event_type === "string" ? message.event_type : "";
  const assetId = typeof message.asset_id === "string" ? message.asset_id : "";
  const sideFor = (id: string): SideBook | undefined => {
    if (id === yesTokenId) return yes;
    if (id === noTokenId) return no;
    return undefined;
  };

  if (eventType === "book") {
    const side = sideFor(assetId);
    if (side) applyBook(side, message);
    return;
  }
  if (eventType === "best_bid_ask") {
    const side = sideFor(assetId);
    if (side) applyBest(side, message.best_bid, message.best_ask);
    return;
  }
  if (eventType === "last_trade_price") {
    return;
  }
  if (eventType === "price_change" && Array.isArray(message.price_changes)) {
    for (const change of message.price_changes) {
      if (!change || typeof change !== "object") continue;
      const rec = change as Record<string, unknown>;
      const id = typeof rec.asset_id === "string" ? rec.asset_id : "";
      const side = sideFor(id);
      if (side) applyBest(side, rec.best_bid, rec.best_ask);
    }
  }
}

/**
 * Replay slim or full raw CLOB lines into YES/NO book snapshots.
 * One line each time the top 5 on any side changes.
 */
export function replayRawToBookLines(
  rows: Array<{ tMs?: unknown; payload?: unknown }>,
  yesTokenId: string,
  noTokenId: string,
): ClobBookLine[] {
  const yes = emptySide();
  const no = emptySide();
  const out: ClobBookLine[] = [];
  let previous = "";
  const ordered = rows
    .filter((row) => finiteNumber(row.tMs) != null)
    .slice()
    .sort((a, b) => Number(a.tMs) - Number(b.tMs));

  for (const row of ordered) {
    const tMs = finiteNumber(row.tMs);
    if (tMs == null) continue;
    const payload = row.payload;
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      applyMessage(yes, no, yesTokenId, noTokenId, message as Record<string, unknown>);
    }
    const line = snapshot(tMs, yes, no);
    const key = bookSidesKey(line);
    if (key === previous) continue;
    previous = key;
    const empty =
      line.yesBids.length === 0 &&
      line.yesAsks.length === 0 &&
      line.noBids.length === 0 &&
      line.noAsks.length === 0;
    if (empty) continue;
    out.push(line);
  }
  return out;
}
