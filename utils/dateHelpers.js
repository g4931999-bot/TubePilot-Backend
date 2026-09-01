// -----------------------------------------------------------------------
// Shared IST (Indian Standard Time, UTC+5:30) date/time helpers.
//
// These used to be duplicated inline inside cron/scheduler.js. Pulled out
// here so routes/video.js (daily post-limit checks, bulk-upload slot
// assignment) and cron/scheduler.js (Drive auto-upload timing) always agree
// on what "today" / "tomorrow" / "this calendar day" means in IST — two
// slightly different implementations of the same date math is exactly the
// kind of thing that causes hard-to-notice off-by-one-day bugs later.
// -----------------------------------------------------------------------

const IST_OFFSET_MINUTES = 5 * 60 + 30;

// Current IST wall-clock time as "HH:MM" plus the IST-shifted Date object
// (still internally UTC-ticked, but its UTC hour/minute/date fields equal
// the IST wall-clock fields — matches the original scheduler.js behavior).
const getCurrentISTHHMM = () => {
  const nowUtcMs = Date.now();
  const istMs = nowUtcMs + IST_OFFSET_MINUTES * 60 * 1000;
  const istDate = new Date(istMs);
  const hh = String(istDate.getUTCHours()).padStart(2, '0');
  const mm = String(istDate.getUTCMinutes()).padStart(2, '0');
  return { hhmm: `${hh}:${mm}`, istDate };
};

// Today's date as an IST calendar-day string "YYYY-MM-DD".
const getCurrentISTDateStr = () => getCurrentISTHHMM().istDate.toISOString().slice(0, 10);

// Builds the real UTC Date instant corresponding to a given IST calendar
// date + "HH:MM" wall-clock time.
const buildISTInstant = (istDateStr, hhmm) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  const asIfUTC = new Date(`${istDateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
  return new Date(asIfUTC.getTime() - IST_OFFSET_MINUTES * 60 * 1000);
};

// Converts any Date/timestamp into the IST calendar-day string it falls on.
const toISTDateStr = (dateInput) => {
  const d = new Date(dateInput);
  const istMs = d.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
};

// Adds N days to an IST calendar-date string (N can be negative).
const addDaysToDateStr = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetweenDateStrings = (fromStr, toStr) => {
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
};

// [start, end) UTC instants that bound a given IST calendar day — handy for
// Mongo range queries like { scheduledAt: { $gte: start, $lt: end } }.
const getISTDayRangeUTC = (dateStr) => {
  const start = buildISTInstant(dateStr, '00:00');
  const end = buildISTInstant(addDaysToDateStr(dateStr, 1), '00:00');
  return { start, end };
};

module.exports = {
  IST_OFFSET_MINUTES,
  getCurrentISTHHMM,
  getCurrentISTDateStr,
  buildISTInstant,
  toISTDateStr,
  addDaysToDateStr,
  daysBetweenDateStrings,
  getISTDayRangeUTC
};
