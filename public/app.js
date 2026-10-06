const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const marketSelect = document.getElementById("market-select");
const grid = document.getElementById("week-grid");
const weekWrap = grid.parentElement;

let markets = [];
let selectedSeries = "btc-5m";
let expectedPerHour = 12;
let liveBothSockets = false;
/** "week" or "history:<expected>:<day keys>" — rebuild the grid only when this changes. */
let gridSignature = "";

function padHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Monday 00:00 UTC of the current UTC week. */
function utcWeekMondayMs(now = new Date()) {
  const fromMon = (now.getUTCDay() + 6) % 7;
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - fromMon);
}

/** Numeric UTC date for a weekday column in the current week, e.g. "5/10". */
function dayHeaderDateLabel(dayIndex, now = new Date()) {
  const date = new Date(utcWeekMondayMs(now) + dayIndex * 86_400_000);
  return `${date.getUTCDate()}/${date.getUTCMonth() + 1}`;
}

function currentUtcDayHour() {
  const now = new Date();
  const day = DAYS[(now.getUTCDay() + 6) % 7];
  return { day, hour: now.getUTCHours() };
}

function currentChipIndex(expected) {
  const winMin = expected === 4 ? 15 : 5;
  return Math.floor(new Date().getUTCMinutes() / winMin);
}

function makeDayHeader(day, dateLabel, dayKey) {
  const head = document.createElement("div");
  head.className = "week-day";
  head.dataset.day = day;
  if (dayKey) head.dataset.dayKey = dayKey;
  const name = document.createElement("span");
  name.className = "week-day-name";
  name.textContent = DAY_LABEL[day] || day;
  const date = document.createElement("span");
  date.className = "week-day-date";
  date.textContent = dateLabel;
  head.append(name, date);
  return head;
}

function setHistoryLayout(on, dayCount) {
  weekWrap.classList.toggle("is-history", on);
  grid.classList.toggle("is-history", on);
  if (on) grid.style.setProperty("--day-count", String(dayCount));
  else grid.style.removeProperty("--day-count");
}

function buildGrid() {
  grid.replaceChildren();
  const corner = document.createElement("div");
  corner.className = "week-corner";
  corner.textContent = "UTC";
  grid.appendChild(corner);
  DAYS.forEach((day, dayIndex) => {
    grid.appendChild(makeDayHeader(day, dayHeaderDateLabel(dayIndex)));
  });
  for (let hour = 0; hour < 24; hour += 1) {
    const label = document.createElement("div");
    label.className = "week-hour";
    label.dataset.hour = String(hour);
    label.textContent = padHour(hour);
    grid.appendChild(label);
    for (const day of DAYS) {
      const slot = document.createElement("div");
      slot.className = "week-slot";
      slot.dataset.day = day;
      slot.dataset.hour = String(hour);
      fillSlotWindows(slot, 12);
      grid.appendChild(slot);
    }
  }
}

function setRecording(on) {
  grid.classList.toggle("is-recording", on);
  paintNow();
}

function paintNow() {
  const now = currentUtcDayHour();
  grid.querySelectorAll(".is-now").forEach((el) => el.classList.remove("is-now"));
  grid.querySelectorAll(".week-slot-win.is-live").forEach((el) => el.classList.remove("is-live"));
  grid.querySelector(`.week-hour[data-hour="${now.hour}"]`)?.classList.add("is-now");
  const history = grid.classList.contains("is-history");
  let slot;
  if (history) {
    const key = new Date().toISOString().slice(0, 10);
    grid.querySelector(`.week-day[data-day-key="${key}"]`)?.classList.add("is-now");
    slot = grid.querySelector(`.week-slot[data-day-key="${key}"][data-hour="${now.hour}"]`);
  } else {
    grid.querySelector(`.week-day[data-day="${now.day}"]`)?.classList.add("is-now");
    DAYS.forEach((day, dayIndex) => {
      const date = grid.querySelector(`.week-day[data-day="${day}"] .week-day-date`);
      if (date) date.textContent = dayHeaderDateLabel(dayIndex);
    });
    slot = grid.querySelector(`.week-slot[data-day="${now.day}"][data-hour="${now.hour}"]`);
  }
  if (!grid.classList.contains("is-recording") || !liveBothSockets) return;
  if (!slot) return;
  const chips = slot.querySelectorAll(".week-slot-win");
  const chip = chips[currentChipIndex(chips.length || expectedPerHour)];
  if (!chip) return;
  chip.classList.add("is-live");
  chip.classList.remove("is-missing", "is-pending", "is-recorded");
}

function fillSlotWindows(slot, expected) {
  const chips = slot.querySelectorAll(".week-slot-win");
  if (chips.length === expected) return;
  slot.replaceChildren();
  for (let i = 0; i < expected; i += 1) {
    const chip = document.createElement("div");
    chip.className = "week-slot-win is-missing";
    slot.appendChild(chip);
  }
}

function applyChipState(chip, state) {
  const recorded = state === "recorded" || state === true;
  const pending = state === "pending";
  chip.classList.toggle("is-recorded", recorded);
  chip.classList.toggle("is-pending", pending);
  chip.classList.toggle("is-missing", !recorded && !pending);
  chip.classList.remove("is-live");
}

function paintSlot(slot, flags, expected) {
  fillSlotWindows(slot, expected);
  slot.querySelectorAll(".week-slot-win").forEach((chip, i) => applyChipState(chip, flags[i]));
}

function ensureWeekGrid() {
  if (gridSignature === "week") return;
  gridSignature = "week";
  setHistoryLayout(false);
  buildGrid();
}

function ensureHistoryGrid(days, expected) {
  const signature = `history:${expected}:${days.map((day) => day.dayKey).join(",")}`;
  if (gridSignature === signature) return;
  gridSignature = signature;
  setHistoryLayout(true, days.length);
  grid.replaceChildren();
  const corner = document.createElement("div");
  corner.className = "week-corner";
  corner.textContent = "UTC";
  grid.appendChild(corner);
  for (const day of days) {
    grid.appendChild(makeDayHeader(day.day, day.dateLabel, day.dayKey));
  }
  for (let hour = 0; hour < 24; hour += 1) {
    const label = document.createElement("div");
    label.className = "week-hour";
    label.dataset.hour = String(hour);
    label.textContent = padHour(hour);
    grid.appendChild(label);
    for (const day of days) {
      const slot = document.createElement("div");
      slot.className = "week-slot";
      slot.dataset.day = day.day;
      slot.dataset.dayKey = day.dayKey;
      slot.dataset.hour = String(hour);
      fillSlotWindows(slot, expected);
      grid.appendChild(slot);
    }
  }
  requestAnimationFrame(() => {
    if (weekWrap) weekWrap.scrollLeft = weekWrap.scrollWidth;
  });
}

function paintCoverage(payload) {
  expectedPerHour = Number(payload.expectedPerHour) || 12;
  const expected = expectedPerHour;
  const retentionDays = Number(payload.retentionDays) || 7;
  const history = retentionDays > 7 && Array.isArray(payload.days) ? payload.days : null;
  if (history) {
    ensureHistoryGrid(history, expected);
    for (const day of history) {
      for (const hour of day.hours ?? []) {
        const slot = grid.querySelector(
          `.week-slot[data-day-key="${day.dayKey}"][data-hour="${hour.hour}"]`,
        );
        if (!slot) continue;
        paintSlot(slot, Array.isArray(hour.windows) ? hour.windows : [], expected);
      }
    }
  } else {
    ensureWeekGrid();
    const byKey = new Map(
      (payload.slots ?? []).map((s) => [`${s.day}:${s.hour}`, s]),
    );
    for (const day of DAYS) {
      for (let hour = 0; hour < 24; hour += 1) {
        const slot = grid.querySelector(`.week-slot[data-day="${day}"][data-hour="${hour}"]`);
        if (!slot) continue;
        const row = byKey.get(`${day}:${hour}`);
        const flags = Array.isArray(row?.windows) ? row.windows : [];
        paintSlot(slot, flags, expected);
      }
    }
  }
  liveBothSockets = payload.liveBothSockets === true;
  if (typeof payload.recordingEnabled === "boolean") {
    setRecording(payload.recordingEnabled);
  }
  paintNow();
}

function fillMarkets(list) {
  markets = Array.isArray(list) ? list : [];
  marketSelect.replaceChildren();
  for (const market of markets) {
    const opt = document.createElement("option");
    opt.value = market._id;
    opt.textContent = market.label || market._id;
    marketSelect.appendChild(opt);
  }
  if (!markets.some((m) => m._id === selectedSeries) && markets[0]) {
    selectedSeries = markets[0]._id;
  }
  marketSelect.value = selectedSeries;
  const selected = markets.find((m) => m._id === selectedSeries);
  setRecording(Boolean(selected?.recordingEnabled));
}

async function loadMarkets() {
  const res = await fetch("/api/markets");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load markets");
  fillMarkets(data.markets);
}

async function loadCoverage() {
  const res = await fetch(`/api/week-coverage?series=${encodeURIComponent(selectedSeries)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load coverage");
  paintCoverage(data);
}

marketSelect.addEventListener("change", () => {
  selectedSeries = marketSelect.value;
  void loadCoverage();
});

buildGrid();
paintNow();

void (async () => {
  try {
    await loadMarkets();
    await loadCoverage();
  } catch (err) {
    console.error(err);
  }
  setInterval(() => {
    void loadCoverage().catch(() => {});
  }, 5_000);
  setInterval(() => {
    void loadMarkets().catch(() => {});
  }, 30_000);
  setInterval(paintNow, 5_000);
})();
