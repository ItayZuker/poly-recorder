import {
  dayHourFromWindowStart,
  getWeekHistoryCutoffUtcSec,
  selectLatestDayHourWindows,
} from "./day-hour-slots.js";
import { getMarket } from "./db/market-repository.js";
import {
  classifyWindowChips,
  listTickWindowStarts,
  type WindowChipState,
} from "./db/tick-repository.js";
import { recordingManager } from "./recording-manager.js";
import { clampRetentionDays, HOT_RETENTION_DAYS } from "./retention.js";

export const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekDayId = (typeof WEEK_DAYS)[number];

export interface HourSlotCoverage {
  day: WeekDayId;
  hour: number;
  recorded: number;
  expected: number;
  /** Index 0 is :00 in the hour; length is 12 (5m) or 4 (15m). */
  windows: WindowChipState[];
}

export interface HistoryHourCoverage {
  hour: number;
  windows: WindowChipState[];
}

/** One UTC calendar day in a retention window longer than a week. */
export interface HistoryDayCoverage {
  /** YYYY-MM-DD UTC. */
  dayKey: string;
  day: WeekDayId;
  /** Day/month, e.g. "5/10". */
  dateLabel: string;
  hours: HistoryHourCoverage[];
}

export interface WeekCoverage {
  series: string;
  timeframeMinutes: 5 | 15;
  expectedPerHour: number;
  weekStart: number;
  /** How many days of tick files this market keeps. */
  retentionDays: number;
  slots: HourSlotCoverage[];
  /**
   * Set when retentionDays > 7. Oldest day first, today last.
   * Hours with no tick files are "missing" (red); nothing is copied from last week.
   */
  days?: HistoryDayCoverage[];
  /** Current window is receiving both raw CLOB and Chainlink. */
  liveBothSockets: boolean;
}

const UTC_DAY_TO_ID: WeekDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Monday 00:00 UTC of the current UTC week, unix seconds. */
export function utcWeekMondaySec(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const fromMon = (d.getUTCDay() + 6) % 7;
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - fromMon) / 1000,
  );
}

export function expectedWindowsPerHour(timeframeMinutes: number): 4 | 12 {
  return timeframeMinutes === 15 ? 4 : 12;
}

function utcHourStartSec(dayKey: string, hour: number): number {
  return Math.floor(
    Date.parse(`${dayKey}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1000,
  );
}

function windowStatesForHourStart(
  byStart: Map<number, WindowChipState> | Set<number> | undefined,
  expected: number,
  winSec: number,
  hourStart: number,
): WindowChipState[] {
  return Array.from({ length: expected }, (_, i) => {
    const start = hourStart + i * winSec;
    if (byStart instanceof Map) return byStart.get(start) ?? "missing";
    if (byStart instanceof Set) return byStart.has(start) ? "recorded" : "missing";
    return "missing";
  });
}

function priorRecordedBySlot(recordedStarts: number[]): Map<string, Set<number>> {
  const prior = selectLatestDayHourWindows(
    recordedStarts.map((windowStart) => ({ windowStart })),
  );
  const priorBySlot = new Map<string, Set<number>>();
  for (const { windowStart } of prior) {
    const { slotKey } = dayHourFromWindowStart(windowStart);
    let set = priorBySlot.get(slotKey);
    if (!set) {
      set = new Set();
      priorBySlot.set(slotKey, set);
    }
    set.add(windowStart);
  }
  return priorBySlot;
}

function utcTodayStartSec(nowSec: number): number {
  const date = new Date(nowSec * 1000);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000,
  );
}

/** Calendar days covered by retention, oldest first, through today. No last-week fallback. */
async function buildRetentionDays(
  market: NonNullable<Awaited<ReturnType<typeof getMarket>>>,
  retentionDays: number,
  expected: number,
  winSec: number,
  nowSec: number,
): Promise<HistoryDayCoverage[]> {
  const todayStart = utcTodayStartSec(nowSec);
  const rangeStart = todayStart - (retentionDays - 1) * 86_400;
  const tickStarts = (await listTickWindowStarts(market._id)).filter(
    (windowStart) => windowStart >= rangeStart && windowStart < todayStart + 86_400,
  );
  const chipByStart = await classifyWindowChips(market, tickStarts, nowSec);
  const days: HistoryDayCoverage[] = [];
  for (let offset = 0; offset < retentionDays; offset += 1) {
    const dayStart = rangeStart + offset * 86_400;
    const date = new Date(dayStart * 1000);
    const hours: HistoryHourCoverage[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      hours.push({
        hour,
        windows: windowStatesForHourStart(
          chipByStart,
          expected,
          winSec,
          dayStart + hour * 3_600,
        ),
      });
    }
    days.push({
      dayKey: date.toISOString().slice(0, 10),
      day: UTC_DAY_TO_ID[date.getUTCDay()] ?? "sun",
      dateLabel: `${date.getUTCDate()}/${date.getUTCMonth() + 1}`,
      hours,
    });
  }
  return days;
}

/** This week's hour uses this week's files only once that hour starts; earlier hours stay last week. */
export async function getWeekCoverage(series: string): Promise<WeekCoverage> {
  const market = await getMarket(series);
  if (!market) {
    throw new Error(`Unknown series: ${series}`);
  }
  const timeframeMinutes: 5 | 15 = market.timeframeMinutes === 15 ? 15 : 5;
  const expected = expectedWindowsPerHour(timeframeMinutes);
  const winSec = timeframeMinutes * 60;
  const weekStart = utcWeekMondaySec();
  const nowSec = Math.floor(Date.now() / 1000);
  const retentionDays = clampRetentionDays(market.retentionDays);
  const liveBothSockets =
    recordingManager.getRecorder(market._id)?.isLiveBothSockets() === true;
  if (retentionDays > HOT_RETENTION_DAYS) {
    const days = await buildRetentionDays(market, retentionDays, expected, winSec, nowSec);
    return {
      series: market._id,
      timeframeMinutes,
      expectedPerHour: expected,
      weekStart,
      retentionDays,
      slots: [],
      days,
      liveBothSockets,
    };
  }
  const cutoff = getWeekHistoryCutoffUtcSec();

  const tickStarts = (await listTickWindowStarts(market._id)).filter(
    (windowStart) => windowStart >= cutoff,
  );
  const chipByStart = await classifyWindowChips(market, tickStarts, nowSec);
  const recordedStarts = [...chipByStart.entries()]
    .filter(([, state]) => state === "recorded")
    .map(([windowStart]) => windowStart);
  const priorBySlot = priorRecordedBySlot(
    recordedStarts.filter((windowStart) => windowStart < weekStart),
  );

  const slots: HourSlotCoverage[] = [];
  for (let dayIndex = 0; dayIndex < WEEK_DAYS.length; dayIndex += 1) {
    const day = WEEK_DAYS[dayIndex];
    for (let hour = 0; hour < 24; hour += 1) {
      const thisWeekHour = weekStart + dayIndex * 86_400 + hour * 3_600;
      let windows: WindowChipState[];
      if (nowSec >= thisWeekHour) {
        windows = windowStatesForHourStart(chipByStart, expected, winSec, thisWeekHour);
      } else {
        const priorStarts = priorBySlot.get(`${day}:${hour}`);
        const first = priorStarts?.values().next().value;
        const hourStart =
          first != null
            ? utcHourStartSec(dayHourFromWindowStart(first).dayKey, hour)
            : thisWeekHour;
        windows = windowStatesForHourStart(priorStarts, expected, winSec, hourStart);
      }
      slots.push({
        day,
        hour,
        recorded: windows.filter((state) => state === "recorded").length,
        expected,
        windows,
      });
    }
  }

  return {
    series: market._id,
    timeframeMinutes,
    expectedPerHour: expected,
    weekStart,
    retentionDays,
    slots,
    liveBothSockets,
  };
}
