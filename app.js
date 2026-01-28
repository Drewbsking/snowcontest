let chartRef = null;
let currentController = null; // to cancel in-flight fetches
let guessHistogramChart = null;
let holidayGuessChart = null;
let guessCsvObjectUrl = null;

const MEASURABLE_SNOW_THRESHOLD = 0.1;
const HOLIDAY_POT_PER_HOLIDAY = 10; // dollars/points split evenly among correct "snow" guesses per holiday

function setLoading(isLoading) {
  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = isLoading ? 'flex' : 'none';
  if (isLoading) {
    const noSnowEl = document.getElementById('no-snow-message');
    if (noSnowEl) {
      noSnowEl.style.display = 'none';
    }
  }
}

// Known guess sheets (some older seasons may not have a sheet; set file: null)
const guessSheetConfigs = [
  { startYear: 2012, file: null },
  { startYear: 2013, file: null },
  { startYear: 2014, file: null },
  { startYear: 2015, file: null },
  { startYear: 2016, file: null },
  { startYear: 2017, file: null },
  { startYear: 2018, file: null },
  { startYear: 2019, file: 'Guesses/2019-2020 RCOC Snow Contest(Sheet1).csv' },
  { startYear: 2020, file: 'Guesses/2020-2021 RCOC Snow Contest(Sheet1).csv' },
  { startYear: 2021, file: 'Guesses/2021-2022 RCOC Snow Contest(Sheet1).csv' },
  { startYear: 2022, file: 'Guesses/2022-2023 RCOC Snow Contest(Sheet1).csv' },
  { startYear: 2023, file: 'Guesses/2023-2024 RCOC Snow Contest(Sheet1).csv' },
  { startYear: 2024, file: 'Guesses/2024-2025 RCOC Snow Contest(Sheet1).csv' },
  { startYear: 2025, file: 'Guesses/2025-2026 RCOC Snow Contest(Sheet1).csv' }
];

const guessCache = new Map();
const seasonDataCache = new Map();
let currentResultsToken = 0;

// Cache TTL: 15 minutes for active season, 1 hour for recent seasons, infinite for old seasons
const CACHE_TTL_ACTIVE = 15 * 60 * 1000; // 15 minutes
const CACHE_TTL_RECENT = 60 * 60 * 1000; // 1 hour

// Reusable canvas pattern to shade missing ACIS days
let missingFillPattern = null;
function getMissingPattern(ctx) {
  if (missingFillPattern) return missingFillPattern;
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = patternCanvas.height = 8;
  const pctx = patternCanvas.getContext('2d');
  pctx.fillStyle = 'rgba(251,191,36,0.16)'; // soft amber base
  pctx.fillRect(0, 0, 8, 8);
  pctx.strokeStyle = 'rgba(217,119,6,0.55)'; // darker amber stripes
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(0, 8);
  pctx.lineTo(8, 0);
  pctx.stroke();
  missingFillPattern = ctx.createPattern(patternCanvas, 'repeat');
  return missingFillPattern;
}

/**
 * Check if cached entry is still fresh
 * @param {Object} cacheEntry - { data, timestamp }
 * @param {number} startYear - Season start year
 * @returns {boolean} - True if cache is fresh
 */
function isCacheFresh(cacheEntry, startYear) {
  if (!cacheEntry || !cacheEntry.timestamp) return false;

  const now = Date.now();
  const age = now - cacheEntry.timestamp;

  // Determine current season year
  const nowDate = new Date();
  const nowMonth = nowDate.getMonth() + 1; // 1-12
  const currentSeasonYear = (nowMonth >= 7) ? nowDate.getFullYear() : (nowDate.getFullYear() - 1);

  // Active season: 15 minute TTL
  if (startYear === currentSeasonYear) {
    return age < CACHE_TTL_ACTIVE;
  }

  // Recent seasons (last 2 years): 1 hour TTL
  if (startYear >= currentSeasonYear - 2) {
    return age < CACHE_TTL_RECENT;
  }

  // Historical seasons: never expire (they don't change)
  return true;
}

/**
 * Get data from season cache with freshness check
 * @param {number} year - Season start year
 * @returns {Object|null} - Cached data or null if not fresh
 */
function getCachedSeasonData(year) {
  const entry = seasonDataCache.get(year);
  if (!entry) return null;

  // Handle old cache entries that don't have timestamp (backward compatibility)
  if (!entry.timestamp) {
    return entry; // Return as-is, will be replaced with fresh data on next fetch
  }

  if (isCacheFresh(entry, year)) {
    return entry.data;
  }

  // Cache is stale, remove it
  seasonDataCache.delete(year);
  return null;
}

/**
 * Set data in season cache with timestamp
 * @param {number} year - Season start year
 * @param {Object} data - Season data
 */
function setCachedSeasonData(year, data) {
  seasonDataCache.set(year, {
    data: data,
    timestamp: Date.now()
  });
}

/**
 * Get data from guess cache with freshness check
 * @param {number} year - Season start year
 * @returns {Object|null} - Cached guess data or null if not fresh
 */
function getCachedGuessData(year) {
  const entry = guessCache.get(year);
  if (!entry) return null;

  // Handle old cache entries that don't have timestamp (backward compatibility)
  if (!entry.timestamp) {
    return entry; // Return as-is, will be replaced with fresh data on next fetch
  }

  if (isCacheFresh(entry, year)) {
    return entry.data;
  }

  // Cache is stale, remove it
  guessCache.delete(year);
  return null;
}

/**
 * Set data in guess cache with timestamp
 * @param {number} year - Season start year
 * @param {Object} data - Guess data
 */
function setCachedGuessData(year, data) {
  guessCache.set(year, {
    data: data,
    timestamp: Date.now()
  });
}

// Reveal control: hide current season guesses until noon ET on Nov 7, 2025
const GUESS_REVEAL_UTC = '2025-11-07T17:00:00Z'; // 12:00 PM ET
function isGuessRevealOpen(startYear) {
  return startYear !== 2025 || Date.now() >= Date.parse(GUESS_REVEAL_UTC);
}
function getRevealLabelET() {
  try {
    return new Date(GUESS_REVEAL_UTC).toLocaleString(undefined, {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    }) + ' ET';
  } catch (_e) {
    return 'Nov 7, 2025 12:00 PM ET';
  }
}

const guessStatEls = {
  avgValue: document.getElementById('guess-avg-value'),
  avgNote: document.getElementById('guess-avg-note'),
  lowValue: document.getElementById('guess-low-value'),
  lowNote: document.getElementById('guess-low-note'),
  highValue: document.getElementById('guess-high-value'),
  highNote: document.getElementById('guess-high-note')
};

const contestantCountEls = {
  value: document.getElementById('contestant-count-value'),
  note: document.getElementById('contestant-count-note')
};

const guessCsvLinkEl = document.getElementById('guess-csv-link');

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function cancelElementAnimation(el) {
  if (!el || !el._animationFrame) return;
  cancelAnimationFrame(el._animationFrame);
  el._animationFrame = null;
}

function resetAnimatedNumber(el, fallback = '--') {
  if (!el) return;
  cancelElementAnimation(el);
  if (el.dataset) {
    delete el.dataset.animatedValue;
  }
  el.textContent = fallback;
}

function animateNumberText(el, value, {
  format = (val) => Math.round(val).toString(),
  duration = 900,
  easing = easeOutCubic,
  fallback = '--',
  precision = 1e-4,
  startValue
} = {}) {
  if (!el) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    resetAnimatedNumber(el, fallback);
    return;
  }
  let start = Number.isFinite(parseFloat(el?.dataset?.animatedValue))
    ? parseFloat(el.dataset.animatedValue)
    : null;
  if (!Number.isFinite(start)) {
    const parsedExisting = parseFloat((el.textContent || '').replace(/[^0-9.\-]/g, ''));
    start = Number.isFinite(parsedExisting) ? parsedExisting : startValue;
  }
  if (!Number.isFinite(start)) {
    start = 0;
  }
  const delta = numeric - start;
  if (Math.abs(delta) < precision) {
    cancelElementAnimation(el);
    el.textContent = format(numeric);
    if (el.dataset) {
      el.dataset.animatedValue = String(numeric);
    }
    return;
  }

  cancelElementAnimation(el);
  let initialTimestamp;
  const step = (ts) => {
    if (initialTimestamp === undefined) {
      initialTimestamp = ts;
    }
    const elapsed = ts - initialTimestamp;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easing(progress);
    const current = start + delta * eased;
    el.textContent = format(current);
    if (progress < 1) {
      el._animationFrame = requestAnimationFrame(step);
      return;
    }
    el.textContent = format(numeric);
    el._animationFrame = null;
  };
  if (el.dataset) {
    el.dataset.animatedValue = String(numeric);
  }
  el._animationFrame = requestAnimationFrame(step);
}

function disableGuessCsvLink() {
  if (!guessCsvLinkEl) return;
  if (guessCsvObjectUrl) {
    URL.revokeObjectURL(guessCsvObjectUrl);
    guessCsvObjectUrl = null;
  }
  guessCsvLinkEl.href = '#';
  guessCsvLinkEl.removeAttribute('download');
  guessCsvLinkEl.setAttribute('aria-disabled', 'true');
}

function updateGuessCsvLink(startYear) {
  if (!guessCsvLinkEl) return;
  if (guessCsvObjectUrl) {
    URL.revokeObjectURL(guessCsvObjectUrl);
    guessCsvObjectUrl = null;
  }
  const cfg = Number.isFinite(startYear)
    ? guessSheetConfigs.find(c => c.startYear === startYear)
    : null;
  if (!cfg || !cfg.file) {
    disableGuessCsvLink();
    return;
  }
  const fileName = (cfg.file.split('/').pop()) || `guesses_${startYear}-${startYear + 1}.csv`;
  guessCsvLinkEl.href = cfg.file;
  guessCsvLinkEl.setAttribute('download', fileName);
  guessCsvLinkEl.removeAttribute('aria-disabled');
}

function setGuessCsvDownloadData(csvText, fileName) {
  if (!guessCsvLinkEl || !csvText) return;
  if (guessCsvObjectUrl) {
    URL.revokeObjectURL(guessCsvObjectUrl);
  }
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  guessCsvObjectUrl = URL.createObjectURL(blob);
  guessCsvLinkEl.href = guessCsvObjectUrl;
  if (fileName) {
    guessCsvLinkEl.setAttribute('download', fileName);
  } else {
    guessCsvLinkEl.removeAttribute('download');
  }
  guessCsvLinkEl.removeAttribute('aria-disabled');
}

function formatGuessNameList(entries, options = {}) {
  const { limit = 3 } = options;
  const names = (entries || [])
    .map(entry => (entry && entry.name ? entry.name.trim() : 'Unknown'))
    .filter((name, idx, arr) => name && arr.indexOf(name) === idx);
  if (!names.length) return '—';
  const shouldLimit = Number.isFinite(limit) && limit > 0;
  if (shouldLimit && names.length > limit) {
    const remaining = names.length - limit;
    return `${names.slice(0, limit).join(', ')} +${remaining} more`;
  }
  return names.join(', ');
}

function formatClosestGuessList(entries) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const formatted = [];
  const seen = new Set();

  entries.forEach(entry => {
    if (!entry) return;
    const name = entry.name ? String(entry.name).trim() : 'Unknown';
    const guess = Number.isFinite(entry.guess) ? formatInches(entry.guess) : '';
    const key = `${name}|${guess}`;
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    const label = guess ? `${name} (${guess}")` : name;
    formatted.push(label);
  });

  if (!formatted.length) return '';
  if (formatted.length > 3) {
    const remaining = formatted.length - 3;
    return `${formatted.slice(0, 3).join(', ')} +${remaining} more`;
  }
  return formatted.join(', ');
}

function findClosestToAverage(entries, target, epsilon = 1e-6) {
  if (!Array.isArray(entries) || !entries.length || !Number.isFinite(target)) {
    return [];
  }
  let bestDelta = Infinity;
  const closest = [];
  entries.forEach(entry => {
    if (!entry || !Number.isFinite(entry.guess)) return;
    const delta = Math.abs(entry.guess - target);
    if (delta + epsilon < bestDelta) {
      bestDelta = delta;
      closest.length = 0;
      closest.push(entry);
    } else if (Math.abs(delta - bestDelta) < epsilon) {
      closest.push(entry);
    }
  });
  return closest;
}

function setGuessStatsMessage(message) {
  if (!guessStatEls.avgValue) return;
  resetAnimatedNumber(guessStatEls.avgValue);
  guessStatEls.avgNote.textContent = message;
  resetAnimatedNumber(guessStatEls.lowValue);
  guessStatEls.lowNote.textContent = message;
  resetAnimatedNumber(guessStatEls.highValue);
  guessStatEls.highNote.textContent = message;
  setContestantCountMessage(message);
  renderGuessHistogram([]);
  renderHolidayGuessChart([], null);
}

function setContestantCountMessage(message) {
  if (!contestantCountEls.value) return;
  resetAnimatedNumber(contestantCountEls.value);
  if (contestantCountEls.note) contestantCountEls.note.textContent = message;
}

function setContestantCountData(guesses) {
  if (!contestantCountEls.value) return;
  const total = Array.isArray(guesses) ? guesses.length : 0;
  if (!total) {
    setContestantCountMessage('No guesses submitted yet.');
    return;
  }
  animateNumberText(contestantCountEls.value, total, {
    format: (val) => Math.round(val).toString(),
    fallback: '--'
  });
  if (contestantCountEls.note) {
    contestantCountEls.note.textContent = `${total === 1 ? 'contestant' : 'contestants'} this season`;
  }
}

function setGuessStatsData(guesses, startYear) {
  if (!guessStatEls.avgValue) return;
  const valid = (guesses || []).filter(entry => entry && Number.isFinite(entry.guess));
  if (!valid.length) {
    setGuessStatsMessage('No guesses submitted yet.');
    return;
  }
  setContestantCountData(valid);

  const sum = valid.reduce((acc, entry) => acc + entry.guess, 0);
  const avg = sum / valid.length;
  animateNumberText(guessStatEls.avgValue, avg, {
    format: (val) => formatInches(val),
    fallback: '--'
  });
  const avgNoteParts = [`${valid.length} ${valid.length === 1 ? 'entry' : 'entries'}`];
  const closestEntries = findClosestToAverage(valid, avg);
  const closestLabel = formatClosestGuessList(closestEntries);
  if (closestLabel) {
    avgNoteParts.push(`Closest to avg: ${closestLabel}`);
  }
  guessStatEls.avgNote.textContent = avgNoteParts.join(' · ');

  const epsilon = 1e-6;
  const minValue = Math.min(...valid.map(entry => entry.guess));
  const maxValue = Math.max(...valid.map(entry => entry.guess));
  const minEntries = valid.filter(entry => Math.abs(entry.guess - minValue) < epsilon);
  const maxEntries = valid.filter(entry => Math.abs(entry.guess - maxValue) < epsilon);

  animateNumberText(guessStatEls.lowValue, minValue, {
    format: (val) => formatInches(val),
    fallback: '--'
  });
  const lowNames = formatGuessNameList(minEntries);
  guessStatEls.lowNote.textContent = lowNames === '—' ? '—' : `by ${lowNames}`;

  animateNumberText(guessStatEls.highValue, maxValue, {
    format: (val) => formatInches(val),
    fallback: '--'
  });
  const highNames = formatGuessNameList(maxEntries);
  guessStatEls.highNote.textContent = highNames === '—' ? '—' : `by ${highNames}`;

  renderGuessHistogram(valid);
  renderHolidayGuessChart(valid, startYear);
}

function determineLastDataDate(dailyRows) {
  if (!Array.isArray(dailyRows)) return null;
  for (let i = dailyRows.length - 1; i >= 0; i--) {
    const row = dailyRows[i];
    if (!row) continue;
    const dateStr = row.date;
    const snowVal = row.snow;
    if (dateStr && (snowVal !== null && snowVal !== 'M')) {
      const parsed = parseISODate(dateStr);
      if (parsed) return parsed;
    }
  }
  return null;
}

function renderGuessHistogram(entries) {
  const canvas = document.getElementById('guessHistogram');
  if (!canvas) return;
  if (guessHistogramChart) {
    guessHistogramChart.destroy();
    guessHistogramChart = null;
  }
  if (!Array.isArray(entries) || !entries.length) {
    return;
  }

  const ctx = canvas.getContext('2d');
  const values = entries.map(entry => entry.guess).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return;

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = Math.max(maxVal - minVal, 1);
  const desiredBins = Math.min(10, Math.max(4, Math.round(Math.sqrt(values.length))));
  const binSize = normalizeBinSize(span, desiredBins);
  const start = Math.floor(minVal / binSize) * binSize;
  const end = Math.ceil(maxVal / binSize) * binSize;
  const binCount = Math.max(1, Math.ceil((end - start) / binSize));
  const counts = new Array(binCount).fill(0);

  values.forEach(val => {
    const idx = Math.min(binCount - 1, Math.floor((val - start) / binSize));
    if (idx >= 0 && idx < counts.length) {
      counts[idx] += 1;
    }
  });

  const labels = counts.map((_, idx) => {
    const lo = start + idx * binSize;
    const hi = lo + binSize;
    return formatGuessRange(lo, hi, binSize);
  });

  guessHistogramChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Guess count',
          data: counts,
          backgroundColor: 'rgba(56,189,248,0.35)',
          borderColor: 'rgba(56,189,248,0.65)',
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 36,
          hoverBackgroundColor: 'rgba(56,189,248,0.5)'
        }
      ]
    },
    options: {
      animation: {
        duration: 900,
        easing: 'easeOutQuart'
      },
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: {
            color: 'rgba(51,65,85,0.35)'
          },
          ticks: {
            color: 'rgba(148,163,184,0.95)',
            autoSkip: false,
            maxRotation: 0,
            font: {
              size: 11
            }
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: 'rgba(51,65,85,0.3)'
          },
          ticks: {
            precision: 0,
            color: 'rgba(148,163,184,0.95)'
          }
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label ?? '',
            label: (item) => `${item.parsed.y} guess${item.parsed.y === 1 ? '' : 'es'}`
          }
        }
      }
    }
  });
}

function renderHolidayGuessChart(entries, startYear) {
  const canvas = document.getElementById('holidayGuessChart');
  if (!canvas) return;
  if (holidayGuessChart) {
    holidayGuessChart.destroy();
    holidayGuessChart = null;
  }
  if (!Array.isArray(entries) || !entries.length) return;

  const holidays = getHolidayListForSeason(parseInt(startYear, 10));
  const labels = holidays.map(h => h.label);
  const yesCounts = new Array(labels.length).fill(0);
  const noCounts = new Array(labels.length).fill(0);

  entries.forEach(entry => {
    const h = entry.holidays || {};
    holidays.forEach((holiday, idx) => {
      const key = holiday.key;
      const val = h[key];
      if (val === true) yesCounts[idx] += 1;
      else if (val === false) noCounts[idx] += 1;
    });
  });

  // Convert to percentages per holiday
  const totals = yesCounts.map((y, i) => y + noCounts[i]);
  const yesPct = yesCounts.map((y, i) => (totals[i] > 0 ? Math.round((y / totals[i]) * 100) : 0));
  const noPct = noCounts.map((n, i) => (totals[i] > 0 ? Math.round((n / totals[i]) * 100) : 0));

  const ctx = canvas.getContext('2d');
  holidayGuessChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Yes',
          data: yesPct,
          backgroundColor: 'rgba(16,185,129,0.45)',
          borderColor: 'rgba(16,185,129,0.8)',
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 36
        },
        {
          label: 'No',
          data: noPct,
          backgroundColor: 'rgba(248,113,113,0.45)',
          borderColor: 'rgba(248,113,113,0.8)',
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 36
        }
      ]
    },
    options: {
      animation: { duration: 900, easing: 'easeOutQuart' },
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: false,
          grid: { color: 'rgba(51,65,85,0.35)' },
          ticks: { color: 'rgba(148,163,184,0.95)', maxRotation: 0, autoSkip: false, font: { size: 11 } }
        },
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: 'rgba(51,65,85,0.3)' },
          ticks: {
            precision: 0,
            color: 'rgba(148,163,184,0.95)',
            callback: (val) => `${val}%`
          }
        }
      },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label ?? '',
            label: (ctx) => {
              const i = ctx.dataIndex;
              const isYes = ctx.dataset.label === 'Yes';
              const count = isYes ? yesCounts[i] : noCounts[i];
              const total = totals[i] || 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return `${ctx.dataset.label}: ${pct}% (${count}/${total})`;
            }
          }
        }
      }
    }
  });
}

function normalizeBinSize(span, desiredBins) {
  const rawSize = span / Math.max(desiredBins, 1);
  const steps = [0.5, 1, 2, 5, 10, 20, 25, 50];
  for (const step of steps) {
    if (rawSize <= step) return step;
  }
  return steps[steps.length - 1];
}

function formatGuessRange(lo, hi, binSize) {
  const decimals = binSize < 1 ? 1 : 0;
  const format = (value) => value.toFixed(decimals).replace(/\.0$/, '');
  return `${format(lo)}–${format(hi)}"`;
}

function formatInches(value) {
  if (value == null || Number.isNaN(value)) {
    return '--';
  }
  const rounded = Math.round(value * 10) / 10;
  let str = rounded.toFixed(1);
  if (str.endsWith('.0')) {
    str = str.slice(0, -2);
  }
  return str;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return '$0.00';
  const rounded = Math.round(value * 100) / 100;
  const str = rounded.toFixed(2);
  return `$${str.replace(/\.00$/, '.00')}`;
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#39;';
      default: return ch;
    }
  });
}

function describeMargin(margin) {
  if (margin == null || Number.isNaN(margin)) {
    return '';
  }
  if (margin < 1e-6) {
    return 'exact match';
  }
  return `within ${formatInches(margin)}"`;
}

function formatDateLabel(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string'
    ? new Date(dateInput + 'T00:00:00')
    : dateInput instanceof Date
      ? dateInput
      : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function parseISODate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// --- Holiday helpers ---
function getNthWeekdayOfMonth(year, month1to12, weekday0to6, nth) {
  // weekday: 0=Sun..6=Sat, nth: 1..5
  const firstOfMonth = new Date(year, month1to12 - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const offset = (7 + weekday0to6 - firstWeekday) % 7; // days from the 1st to first desired weekday
  const day = 1 + offset + (nth - 1) * 7;
  const result = new Date(year, month1to12 - 1, day);
  if (result.getMonth() !== month1to12 - 1) return null; // overflow
  return result;
}

function getHolidayListForSeason(startYear) {
  // Season spans Jul 1 (startYear) -> Jun 30 (startYear+1)
  const holidays = [];
  const nextYear = startYear + 1;
  // Thanksgiving: 4th Thu in Nov of startYear
  const thanksgiving = getNthWeekdayOfMonth(startYear, 11, 4, 4);
  holidays.push({ key: 'thanksgiving', label: 'Thanksgiving', date: thanksgiving });
  // Christmas: Dec 25, startYear
  holidays.push({ key: 'christmas', label: 'Christmas', date: new Date(startYear, 11, 25) });
  // New Year’s Day: Jan 1, nextYear
  holidays.push({ key: 'newyear', label: "New Year’s Day", date: new Date(nextYear, 0, 1) });
  // MLK Day: 3rd Monday in Jan, nextYear (weekday=1)
  holidays.push({ key: 'mlk', label: 'MLK Day', date: getNthWeekdayOfMonth(nextYear, 1, 1, 3) });
  // Presidents Day: 3rd Monday in Feb, nextYear (weekday=1)
  holidays.push({ key: 'presidents', label: "Presidents Day", date: getNthWeekdayOfMonth(nextYear, 2, 1, 3) });
  return holidays.map(h => ({ ...h, iso: h.date ? formatISODate(h.date) : null }));
}

function renderHolidayBadges(startYear, daily) {
  const container = document.getElementById('holiday-badges');
  if (!container) return;
  container.innerHTML = '';
  const measurableThreshold = MEASURABLE_SNOW_THRESHOLD;
  const holidays = getHolidayListForSeason(parseInt(startYear, 10));

  holidays.forEach(h => {
    let amount = null; // null = missing/not found; number = inches
    if (h.iso) {
      const row = Array.isArray(daily) ? daily.find(r => r && r.date === h.iso) : null;
      if (row) {
        amount = (typeof row.snow === 'number' && !Number.isNaN(row.snow)) ? row.snow : null;
      }
    }

    const badge = document.createElement('span');
    badge.className = 'holiday-badge';

    if (amount == null) {
      badge.classList.add('is-missing');
      badge.title = `${h.label} – data unavailable`;
      badge.innerHTML = `${escapeHtml(h.label)} <span class="amt">—</span>`;
    } else {
      const yes = amount >= measurableThreshold;
      badge.classList.add(yes ? 'is-yes' : 'is-no');
      const amt = `${formatInches(amount)}\"`;
      badge.title = `${h.label} – ${yes ? 'Measurable snow' : 'No measurable snow'} (${amt})`;
      badge.innerHTML = `${escapeHtml(h.label)} <span class="amt">${amt}</span>`;
    }

    container.appendChild(badge);
  });
}

function computeHolidayOutcomes(startYear, daily) {
  const holidays = getHolidayListForSeason(parseInt(startYear, 10));
  const today = new Date();

  return holidays.map(h => {
    const dateObj = parseISODate(h.iso);
    const row = Array.isArray(daily) ? daily.find(r => r && r.date === h.iso) : null;
    const hasSnowValue = typeof row?.snow === 'number' && !Number.isNaN(row.snow);
    const amount = hasSnowValue ? row.snow : null;
    const status = (() => {
      if (hasSnowValue) return 'resolved';
      if (dateObj && today < dateObj) return 'upcoming';
      return 'missing';
    })();
    const outcome = hasSnowValue ? (amount >= MEASURABLE_SNOW_THRESHOLD) : null;
    return { ...h, dateObj, amount, status, outcome };
  });
}

function renderHolidayResults(startYear, daily, guesses, revealOpen) {
  const holidayResultEl = document.getElementById('holiday-result-body');
  if (!holidayResultEl) return;

  const parsedYear = parseInt(startYear, 10);
  if (!Number.isFinite(parsedYear)) {
    holidayResultEl.textContent = 'Select a season to see holiday calls.';
    setContestantCountMessage('Select a season to see contestants.');
    return;
  }

  if (!revealOpen) {
    holidayResultEl.textContent = `Holiday picks hidden until ${getRevealLabelET()}.`;
    setContestantCountMessage(`Contestants hidden until ${getRevealLabelET()}.`);
    return;
  }

  if (!Array.isArray(daily) || !daily.length) {
    holidayResultEl.textContent = 'Holiday snowfall data unavailable for this season.';
    return;
  }

  const outcomes = computeHolidayOutcomes(parsedYear, daily);
  if (!outcomes.length) {
    holidayResultEl.textContent = 'Holiday calendar unavailable for this season.';
    setContestantCountMessage('Contestant count unavailable.');
    return;
  }

  if (!Array.isArray(guesses) || !guesses.length) {
    holidayResultEl.textContent = 'No holiday guesses submitted yet.';
    setContestantCountMessage('No guesses submitted yet.');
    return;
  }

  const rowsHtml = outcomes.map(outcome => {
    const dateLabel = formatDateLabel(outcome.dateObj);
    const amountLabel = Number.isFinite(outcome.amount) ? `${formatInches(outcome.amount)}"` : '—';
    const statusLabel = (() => {
      if (outcome.outcome === true) return `Snow (${amountLabel})`;
      if (outcome.outcome === false) return `No measurable snow (${amountLabel})`;
      if (outcome.status === 'upcoming') return `Pending${dateLabel ? ` (${dateLabel})` : ''}`;
      return 'Snow data unavailable';
    })();

    const correctEntries = outcome.outcome == null
      ? []
      : (guesses || []).filter(entry => entry?.holidays && entry.holidays[outcome.key] === outcome.outcome);

    const winnerLabel = (() => {
      if (outcome.status === 'upcoming') return 'Awaiting holiday';
      if (outcome.outcome == null) return 'Unable to grade guesses';
      if (!correctEntries.length) return 'No correct calls';
      const names = formatGuessNameList(correctEntries, { limit: Infinity });
      if (!names || names === '—') return 'No correct calls';
      return `Correct: <span class="result-highlight">${escapeHtml(names)}</span>`;
    })();

    return `
      <div class="holiday-result-row">
        <div class="holiday-result-label">${escapeHtml(outcome.label)}</div>
        <div class="holiday-result-meta">${escapeHtml(statusLabel)}</div>
        <div class="holiday-result-winners">${winnerLabel}</div>
      </div>
    `;
  }).join('');

  holidayResultEl.innerHTML = `<div class="holiday-result-list">${rowsHtml}</div>`;
}

function setHolidayPayoutMessage(message) {
  const el = document.getElementById('holiday-payout-body');
  if (!el) return;
  el.textContent = message;
}

function renderHolidayPayouts(startYear, daily, guesses, revealOpen) {
  const payoutEl = document.getElementById('holiday-payout-body');
  if (!payoutEl) return;

  const parsedYear = parseInt(startYear, 10);
  if (!Number.isFinite(parsedYear)) {
    setHolidayPayoutMessage('Select a season to view holiday payouts.');
    return;
  }

  if (!revealOpen) {
    setHolidayPayoutMessage(`Holiday payouts hidden until ${getRevealLabelET()}.`);
    return;
  }

  if (!Array.isArray(daily) || !daily.length) {
    setHolidayPayoutMessage('Holiday snowfall data unavailable for this season.');
    return;
  }

  if (!Array.isArray(guesses) || !guesses.length) {
    setHolidayPayoutMessage('No guesses submitted yet.');
    return;
  }

  const outcomes = computeHolidayOutcomes(parsedYear, daily);
  if (!outcomes.length) {
    setHolidayPayoutMessage('Holiday calendar unavailable for this season.');
    return;
  }

  const winnings = new Map(); // name -> { amount, wins }

  outcomes.forEach(outcome => {
    if (outcome.outcome == null) return; // skip if the holiday result is unresolved
    const winners = (guesses || []).filter(entry => entry?.holidays && entry.holidays[outcome.key] === outcome.outcome);
    if (!winners.length) return; // pot unclaimed
    const share = HOLIDAY_POT_PER_HOLIDAY / winners.length;
    winners.forEach(entry => {
      const name = entry?.name ? String(entry.name).trim() || 'Anonymous' : 'Anonymous';
      const prev = winnings.get(name) || { amount: 0, wins: 0 };
      winnings.set(name, { amount: prev.amount + share, wins: prev.wins + 1 });
    });
  });

  if (!winnings.size) {
    setHolidayPayoutMessage('No holiday payouts yet.');
    return;
  }

  const rows = Array.from(winnings.entries())
    .map(([name, info]) => ({ name, amount: info.amount, wins: info.wins }))
    .sort((a, b) => (b.amount - a.amount) || a.name.localeCompare(b.name));

  const rowsHtml = rows.map(row => {
    const money = formatMoney(row.amount);
    const winLabel = row.wins === 1 ? 'holiday win' : 'holiday wins';
    return `
      <div class="holiday-result-row">
        <div class="holiday-result-label">${escapeHtml(row.name)}</div>
        <div class="holiday-result-meta">${money} · ${row.wins} ${winLabel}</div>
      </div>
    `;
  }).join('');

  payoutEl.innerHTML = `<div class="holiday-result-list">${rowsHtml}</div>`;
}

function computeWindowTotal(daily, startIso, endIso) {
  if (!Array.isArray(daily) || !startIso || !endIso) {
    return null;
  }
  let total = 0;
  let included = false;
  for (const row of daily) {
    const date = row?.date;
    if (!date || date < startIso || date > endIso) {
      continue;
    }
    included = true;
    const val = row.snow;
    if (typeof val === 'number' && !Number.isNaN(val)) {
      total += val;
    }
  }
  if (!included) {
    return null;
  }
  return total;
}

function getStage(now, start, end) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !(start instanceof Date) || Number.isNaN(start.getTime()) || !(end instanceof Date) || Number.isNaN(end.getTime())) {
    return 'unknown';
  }
  if (now < start) return 'pre';
  if (now > end) return 'done';
  return 'active';
}

function formatGuesserDisplay(entry) {
  if (!entry) return '';
  const name = escapeHtml(entry.name || '');
  const deptPart = entry.dept ? ` – ${escapeHtml(entry.dept)}` : '';
  return `${name}${deptPart} (${formatInches(entry.guess)}")`;
}

function parseCsv(text) {
  // Remove BOM if present
  if (text && text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\r') {
        // handle CRLF by looking ahead; finalize row on CR
        if (next === '\n') {
          // will be handled when loop hits \n; but finalize here to avoid double
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
          i++; // skip the \n
        } else {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        }
      } else {
        field += ch;
      }
    }
  }
  // flush last field/row if any characters remain
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function stringifyCsv(rows) {
  if (!Array.isArray(rows)) return '';
  return rows.map(row => {
    const cells = Array.isArray(row) ? row : [];
    return cells.map(cell => {
      const value = cell == null ? '' : String(cell);
      if (/["\r\n,]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(',');
  }).join('\r\n');
}

async function fetchGuessSheet(config) {
  if (!config || !config.file) {
    return { entries: [], sanitizedCsv: '' };
  }
  const res = await fetch(config.file);
  if (!res.ok) {
    throw new Error(`Failed to load ${config.file}`);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (!rows || !rows.length) {
    return { entries: [], sanitizedCsv: '' };
  }

  const header = rows[0].map(cell => (cell == null ? '' : String(cell)).trim().toLowerCase());
  const normalized = header.map(h => h.replace(/[^a-z0-9]/g, ''));

  // Prefer alias, then name, then email
  const aliasIdx = normalized.findIndex(h => h.includes('alias'));
  const nameIdx = normalized.findIndex(h => h === 'name' || h.includes('guesser'));
  const emailIdx = normalized.findIndex(h => h.includes('email'));

  // Department/Division detection
  const deptIdx = normalized.findIndex(h => h.includes('dept') || h.includes('division') || h.includes('dist'));

  // Guess column detection: match broader phrasing from the form
  const guessIdx = normalized.findIndex(h =>
    h.includes('totalseasonalsnowfall') ||
    (h.includes('snowfall') && h.includes('inches')) ||
    h.startsWith('guess') ||
    h === 'snowguess' || h === 'totalguess'
  );

  // Holiday Yes/No columns
  const columnIndexFor = (pred) => normalized.findIndex(pred);
  const holidayColIdx = {
    thanksgiving: columnIndexFor(h => h.includes('thanksgiving')),
    christmas: columnIndexFor(h => h.includes('christmas')),
    newyear: columnIndexFor(h => h.includes('newyear')), // matches 'newyearsday'
    mlk: columnIndexFor(h => h.includes('mlk')),
    presidents: columnIndexFor(h => h.includes('presidents'))
  };
  const parseYesNo = (val) => {
    if (val == null) return null;
    const s = String(val).trim().toLowerCase();
    if (!s) return null;
    if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return true;
    if (s === 'no' || s === 'n' || s === 'false' || s === '0') return false;
    return null;
  };
  const trimValue = (val) => (val == null ? '' : String(val).trim());

  const entries = rows.slice(1).map(rawRow => {
    const get = (idx) => (idx >= 0 && idx < rawRow.length ? rawRow[idx] : null);
    const rawAlias = get(aliasIdx);
    const rawName = get(nameIdx);
    const rawEmail = get(emailIdx);
    const rawDept = get(deptIdx);
    const rawGuess = get(guessIdx);

    const alias = trimValue(rawAlias);
    const fallbackName = trimValue(rawName);
    const name = alias || fallbackName || 'Anonymous';
    let guessVal = null;
    if (typeof rawGuess === 'number') {
      guessVal = rawGuess;
    } else if (rawGuess != null) {
      const parsed = parseFloat(String(rawGuess).replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(parsed)) guessVal = parsed;
    }

    return {
      name,
      dept: rawDept == null ? '' : String(rawDept).trim(),
      guess: guessVal,
      holidays: {
        thanksgiving: parseYesNo(get(holidayColIdx.thanksgiving)),
        christmas: parseYesNo(get(holidayColIdx.christmas)),
        newyear: parseYesNo(get(holidayColIdx.newyear)),
        mlk: parseYesNo(get(holidayColIdx.mlk)),
        presidents: parseYesNo(get(holidayColIdx.presidents))
      }
    };
  }).filter(entry => entry.name && entry.guess != null);

  const sanitizedRows = rows.map((row, idx) => {
    const clone = Array.isArray(row) ? row.slice() : [];
    if (idx > 0 && nameIdx >= 0 && aliasIdx >= 0) {
      const alias = trimValue(clone[aliasIdx]);
      if (alias) {
        clone[nameIdx] = alias;
      }
    }
    if (emailIdx >= 0) {
      clone[emailIdx] = idx === 0 ? 'Email (hidden)' : '';
    }
    return clone;
  });
  const sanitizedCsv = stringifyCsv(sanitizedRows);

  return { entries, sanitizedCsv };
}

async function fetchSeasonTotals(startYear) {
  // Determine if this is the current/active season
  const now = new Date();
  const nowMonth = now.getMonth() + 1; // 1-12
  const currentSeasonYear = (nowMonth >= 7) ? now.getFullYear() : (now.getFullYear() - 1);
  const isCurrentSeason = parseInt(startYear, 10) === currentSeasonYear;

  const fetchOptions = {};
  // Force fresh data for current season to avoid stale cache issues on mobile
  if (isCurrentSeason) {
    fetchOptions.cache = 'no-cache';
  }

  const res = await fetch('snowdata.php?startYear=' + encodeURIComponent(startYear), fetchOptions);
  if (!res.ok) {
    throw new Error(`Failed to load snowfall data for ${startYear}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error);
  }
  return json;
}

function pickAbsoluteClosestResult(guesses, target) {
  if (!Array.isArray(guesses) || !Number.isFinite(target)) {
    return { winners: [], margin: null };
  }

  const epsilon = 1e-6;
  let best = Infinity;
  const winners = [];

  guesses.forEach(entry => {
    if (!entry || !Number.isFinite(entry.guess)) {
      return;
    }
    const m = Math.abs(target - entry.guess);
    if (m + epsilon < best) {
      best = m;
      winners.length = 0;
      winners.push({ ...entry, margin: m });
    } else if (Math.abs(m - best) < epsilon) {
      winners.push({ ...entry, margin: m });
    }
  });

  if (!Number.isFinite(best)) {
    return { winners: [], margin: null };
  }
  return { winners, margin: best };
}

async function updateContestResults(startYearInput, seasonDataOverride) {
  const seasonalEl = document.getElementById('seasonal-result-body');
  const holidayResultEl = document.getElementById('holiday-result-body');
  const holidayPayoutEl = document.getElementById('holiday-payout-body');

  if (!seasonalEl) {
    return;
  }

  setGuessStatsMessage('Loading guesses…');
  if (holidayResultEl) {
    holidayResultEl.textContent = 'Loading holiday results…';
  }
  if (holidayPayoutEl) {
    holidayPayoutEl.textContent = 'Loading holiday payouts…';
  }

  const token = ++currentResultsToken;
  const parsedYear = parseInt(startYearInput, 10);
  seasonalEl.textContent = 'Loading season standings…';

  if (!Number.isFinite(parsedYear)) {
    seasonalEl.textContent = 'Select a season above to view standings.';
    setGuessStatsMessage('Select a season to view guesses.');
    if (holidayResultEl) {
      holidayResultEl.textContent = 'Select a season to see holiday calls.';
    }
    if (holidayPayoutEl) {
      holidayPayoutEl.textContent = 'Select a season to view holiday payouts.';
    }
    return;
  }

  const config = guessSheetConfigs.find(cfg => cfg.startYear === parsedYear);
  disableGuessCsvLink();

  const revealOpen = isGuessRevealOpen(parsedYear);
  let guesses = [];
  let sanitizedCsvText = '';
  if (revealOpen) {
    let cached = getCachedGuessData(parsedYear);
    if (!cached) {
      try {
        cached = await fetchGuessSheet(config);
        setCachedGuessData(parsedYear, cached);
      } catch (err) {
        console.error('Failed loading guesses for season', parsedYear, err);
        if (token !== currentResultsToken) return;
        cached = { entries: [], sanitizedCsv: '' };
      }
    }
    if (token !== currentResultsToken) return;
    if (Array.isArray(cached)) {
      guesses = cached;
      sanitizedCsvText = '';
    } else if (cached && typeof cached === 'object') {
      guesses = Array.isArray(cached.entries) ? cached.entries : [];
      sanitizedCsvText = typeof cached.sanitizedCsv === 'string' ? cached.sanitizedCsv : '';
    }
    if (!guesses.length) {
      setGuessStatsMessage(config && config.file ? 'No guesses submitted yet.' : 'Guess sheet not found for this season.');
    } else {
      setGuessStatsData(guesses, parsedYear);
    }
    const fileName = (config && config.file && config.file.split('/').pop()) || `guesses_${parsedYear}-${parsedYear + 1}.csv`;
    if (sanitizedCsvText) {
      setGuessCsvDownloadData(sanitizedCsvText, fileName);
    } else if (config && config.file) {
      updateGuessCsvLink(parsedYear);
    }
  } else {
    // Hide guesses until reveal time
    setGuessStatsMessage(`Guesses hidden until ${getRevealLabelET()}.`);
    disableGuessCsvLink();
    setHolidayPayoutMessage(`Holiday payouts hidden until ${getRevealLabelET()}.`);
  }

  if (seasonDataOverride) {
    setCachedSeasonData(parsedYear, seasonDataOverride);
  }

  let seasonData = seasonDataOverride || getCachedSeasonData(parsedYear);
  if (!seasonData) {
    try {
      seasonData = await fetchSeasonTotals(parsedYear);
      setCachedSeasonData(parsedYear, seasonData);
    } catch (err) {
      console.error('Failed loading snowfall data for season', parsedYear, err);
      if (token !== currentResultsToken) return;
      seasonalEl.innerHTML = 'Unable to load snowfall totals right now.';
      if (holidayResultEl) {
        holidayResultEl.textContent = 'Unable to load holiday results right now.';
      }
      setHolidayPayoutMessage('Unable to load holiday payouts right now.');
      return;
    }
  }
  if (token !== currentResultsToken) return;


  const seasonStartStr = seasonData?.season_start || seasonData?.seasonal_start || seasonData?.start_date;
  const seasonEndStr = seasonData?.season_end || seasonData?.seasonal_end || seasonData?.end_date;
  const daily = Array.isArray(seasonData?.daily) ? seasonData.daily : [];
  const dataLastUpdated = determineLastDataDate(daily);
  const today = new Date();

  const seasonStart = parseISODate(seasonStartStr);
  const seasonEnd = parseISODate(seasonEndStr);
  const seasonStage = (seasonStart && seasonEnd)
    ? getStage(today, seasonStart, seasonEnd)
    : 'unknown';

  let seasonTotal = Number.isFinite(seasonData?.seasonal_total_in)
    ? seasonData.seasonal_total_in
    : computeWindowTotal(daily, seasonStartStr, seasonEndStr || seasonStartStr);

  if (!Number.isFinite(seasonTotal)) {
    seasonTotal = null;
  }

  let seasonalMessage = '';
  if (seasonStage === 'pre') {
    const startLabel = formatDateLabel(seasonStart);
    seasonalMessage = `Snow year begins on ${startLabel || 'Jul 1'}. We'll post standings once the season starts.`;
  } else if (seasonStage === 'unknown') {
    seasonalMessage = 'Season window dates are unavailable for this season.';
  } else if (seasonTotal == null) {
    seasonalMessage = 'Seasonal snowfall data is unavailable for this season.';
  } else {
    if (!isGuessRevealOpen(parsedYear)) {
      const totalLabel = seasonStage === 'done' ? 'Final season total' : 'Season total so far';
      seasonalMessage = `Season leaders hidden until ${getRevealLabelET()}. ${totalLabel}: ${formatInches(seasonTotal)}"`;
    } else {
      const seasonalResult = pickAbsoluteClosestResult(guesses, seasonTotal);
      if (!seasonalResult.winners.length) {
        seasonalMessage = 'No leader could be determined.';
      } else {
        const names = seasonalResult.winners.map(formatGuesserDisplay).join(', ');
        const marginLabel = describeMargin(seasonalResult.margin);
        const label = seasonStage === 'done' ? 'Season winner' : 'Season leader';
        const totalLabel = seasonStage === 'done' ? 'Final season total' : 'Season total so far';
        seasonalMessage = `${label}${seasonalResult.winners.length > 1 ? 's' : ''}: <span class="result-highlight">${names}</span> · ${totalLabel}: ${formatInches(seasonTotal)}"${marginLabel ? ` · ${marginLabel}` : ''}`;
      }
    }
  }
  if (!seasonalMessage) {
    seasonalMessage = 'No information available for this season.';
  }

  renderHolidayResults(parsedYear, daily, guesses, revealOpen);
  renderHolidayPayouts(parsedYear, daily, guesses, revealOpen);
  seasonalEl.innerHTML = seasonalMessage;

  const footerUpdatedEl = document.getElementById('data-updated');
  if (footerUpdatedEl) {
    if (dataLastUpdated) {
      footerUpdatedEl.textContent = `Data updated ${formatDateLabel(dataLastUpdated)}`;
    } else {
      footerUpdatedEl.textContent = 'Data updated —';
    }
  }
}

// Build dropdown with recent snow seasons
// Season runs Jul 1 (YYYY) -> Jun 30 (YYYY+1)
function populateSeasonDropdown() {
  const seasonSelect = document.getElementById('seasonSelect');
  seasonSelect.innerHTML = '';

  const snowDroughtValueEl = document.getElementById('snow-drought-value');
  const snowDroughtNoteEl = document.getElementById('snow-drought-note');
  if (snowDroughtValueEl) resetAnimatedNumber(snowDroughtValueEl);
  if (snowDroughtNoteEl) snowDroughtNoteEl.textContent = 'Days since ≥0.1"';

  const avgSnowValueEl = document.getElementById('average-snow-value');
  const avgSnowNoteEl = document.getElementById('average-snow-note');
  if (avgSnowValueEl) resetAnimatedNumber(avgSnowValueEl);
  if (avgSnowNoteEl) avgSnowNoteEl.textContent = 'Across measurable days';

  const firstSnowValueEl = document.getElementById('first-snow-value');
  const firstSnowNoteEl = document.getElementById('first-snow-note');
  if (firstSnowValueEl) firstSnowValueEl.textContent = '--';
  if (firstSnowNoteEl) firstSnowNoteEl.textContent = 'Awaiting ≥0.1" snow';

  const lastSnowValueEl = document.getElementById('last-snow-value');
  const lastSnowNoteEl = document.getElementById('last-snow-note');
  if (lastSnowValueEl) lastSnowValueEl.textContent = '--';
  if (lastSnowNoteEl) lastSnowNoteEl.textContent = 'Awaiting ≥0.1" snow';

  const streakValueEl = document.getElementById('snow-streak-value');
  const streakNoteEl = document.getElementById('snow-streak-note');
  if (streakValueEl) resetAnimatedNumber(streakValueEl);
  if (streakNoteEl) streakNoteEl.textContent = 'Longest run of ≥0.1" days';
  const streakTotalValueEl = document.getElementById('snow-streak-total-value');
  const streakTotalNoteEl = document.getElementById('snow-streak-total-note');
  if (streakTotalValueEl) resetAnimatedNumber(streakTotalValueEl);
  if (streakTotalNoteEl) streakTotalNoteEl.textContent = 'Total during longest streak';

  const twoPlusValueEl = document.getElementById('two-plus-days-value');
  const twoPlusNoteEl = document.getElementById('two-plus-days-note');
  if (twoPlusValueEl) resetAnimatedNumber(twoPlusValueEl);
  if (twoPlusNoteEl) twoPlusNoteEl.textContent = 'Days with ≥2.0"';

  const sixPlusValueEl = document.getElementById('six-plus-days-value');
  const sixPlusNoteEl = document.getElementById('six-plus-days-note');
  if (sixPlusValueEl) resetAnimatedNumber(sixPlusValueEl);
  if (sixPlusNoteEl) sixPlusNoteEl.textContent = 'Days with ≥6.0"';

  const januaryTotalValueEl = document.getElementById('january-total-value');
  const januaryTotalNoteEl = document.getElementById('january-total-note');
  if (januaryTotalValueEl) resetAnimatedNumber(januaryTotalValueEl);
  if (januaryTotalNoteEl) januaryTotalNoteEl.textContent = 'Awaiting January data...';

  const now = new Date();
  const month = now.getMonth() + 1; // 1..12
  const year = now.getFullYear();

  // Once we reach Jul 1, consider the upcoming snow season for this year.
  // For Jan–Jun, we remain in the season that began the previous Jul.
  const currentStartYear = (month >= 7) ? year : (year - 1);

  const minSeasonYear = guessSheetConfigs.reduce(
    (min, cfg) => Math.min(min, cfg.startYear),
    currentStartYear
  );

  for (let y = currentStartYear; y >= minSeasonYear; y--) {
    const opt = document.createElement('option');
    opt.value = y.toString();
    opt.textContent = `${y}-${y + 1}`;
    seasonSelect.appendChild(opt);
  }
}

// Fetch data for a season and update UI
async function loadSeason(startYear) {
  // cancel any previous in-flight request
  if (currentController) {
    currentController.abort();
  }
  currentController = new AbortController();
  const { signal } = currentController;
  const parsedStartYear = parseInt(startYear, 10);

  setLoading(true);

  // Determine if this is the current/active season
  const now = new Date();
  const nowMonth = now.getMonth() + 1; // 1-12
  const currentSeasonYear = (nowMonth >= 7) ? now.getFullYear() : (now.getFullYear() - 1);
  const isCurrentSeason = parsedStartYear === currentSeasonYear;

  try {
    const fetchOptions = { signal };
    // Force fresh data for current season to avoid stale cache issues on mobile
    if (isCurrentSeason) {
      fetchOptions.cache = 'no-cache';
    }

    const res = await fetch(
      'snowdata.php?startYear=' + encodeURIComponent(startYear),
      fetchOptions
    );
    const json = await res.json();

    // if we aborted this request after sending it, just stop quietly
    if (signal.aborted) return;

    if (json.error) {
      const st = document.getElementById('station-label'); if (st) st.textContent = 'Data error';
      const sl = document.getElementById('season-label'); if (sl) sl.textContent = '';
      const sr = document.getElementById('seasonal-range-label'); if (sr) sr.textContent = '';
      resetAnimatedNumber(document.getElementById('seasonal-total-value'));
      resetAnimatedNumber(document.getElementById('january-total-value'));
      resetAnimatedNumber(document.getElementById('largest-storm-value'));
      const januaryNoteEl = document.getElementById('january-total-note');
      if (januaryNoteEl) januaryNoteEl.textContent = 'Unable to load';
      document.getElementById('largest-storm-note').textContent = 'Unable to load';
      console.error(json.error);

      updatePredictionDisplay(null);
      drawChart([], [], [], null, null, null, []);
      if (Number.isFinite(parsedStartYear)) {
        seasonDataCache.delete(parsedStartYear);
        updateContestResults(parsedStartYear, null);
      }
      setLoading(false);
      return;
    }

    // Update totals card
    {
      const el = document.getElementById('station-label');
      if (el) el.textContent = json.station_name || 'White Lake Station';
    }

    const seasonStart = json.season_start || json.seasonal_start || json.start_date;
    const seasonEnd = json.season_end || json.seasonal_end || json.end_date;

    {
      const el = document.getElementById('seasonal-range-label');
      if (el) el.textContent = 'Snow Year: ' + seasonStart + ' → ' + seasonEnd;
    }
    const srcEl = document.getElementById('data-source');
    if (srcEl) {
      const sid = json.station_sid ? ` (SID ${json.station_sid})` : '';
      srcEl.textContent = `Source: NOAA ACIS – ${json.station_name || 'White Lake 4E'}${sid}`;
    }

    const seasonalTotalRaw = json.seasonal_total_in ?? 0;
    animateNumberText(
      document.getElementById('seasonal-total-value'),
      seasonalTotalRaw,
      {
        format: (val) => Number(val).toFixed(1),
        fallback: '--',
        startValue: 0
      }
    );

    // update data links + source text
    const parsedYear = parseInt(startYear, 10);
    if (Number.isFinite(parsedYear)) {
      syncDataLinks(parsedYear);
    }

    // Prep chart arrays
    const labels = [];
    const dailySnow = [];
    const seasonalCum = [];
    const measurableThreshold = MEASURABLE_SNOW_THRESHOLD;
    const heavyThreshold = 2.0;
    const sixPlusThreshold = 6.0;
    let heavyDayCount = 0;
    let sixPlusDayCount = 0;
    let streakLength = 0;
    let streakStart = null;
    let streakEnd = null;
    let streakSnowTotal = 0;
    let longestStreakLength = 0;
    let longestStreakStart = null;
    let longestStreakEnd = null;
    let longestStreakSnowTotal = 0;
    let longestStreakCount = 0;
    let largestDailyValue = null;
    let largestDailyDate = null;
    let firstSnowDay = null;
    let lastSnowDay = null;
    let sumMeasurableSnow = 0;
    let countMeasurableDays = 0;
    let januaryTotal = 0;
    let januaryDataDays = 0;
    let januaryMissingDays = 0;
    let januaryYear = Number.isFinite(parsedStartYear) ? parsedStartYear + 1 : null;
    const missingDates = new Set();

    const finalizeStreak = () => {
      if (streakLength <= 0) return;
      if (streakLength > longestStreakLength) {
        longestStreakLength = streakLength;
        longestStreakStart = streakStart;
        longestStreakEnd = streakEnd;
        longestStreakSnowTotal = streakSnowTotal;
        longestStreakCount = 1;
      } else if (streakLength === longestStreakLength) {
        longestStreakCount += 1;
        if (streakSnowTotal > longestStreakSnowTotal) {
          longestStreakStart = streakStart;
          longestStreakEnd = streakEnd;
          longestStreakSnowTotal = streakSnowTotal;
        }
      }
      streakLength = 0;
      streakStart = null;
      streakEnd = null;
      streakSnowTotal = 0;
    };

    json.daily.forEach(row => {
      const day = parseISODate(row.date);
      const snowValue = row.snow === null ? null : row.snow;
      const isJanuary = day && day.getMonth() === 0;

      if (isJanuary && januaryYear == null && day) {
        januaryYear = day.getFullYear();
      }

      if (isJanuary) {
        if (typeof snowValue === 'number' && !Number.isNaN(snowValue)) {
          januaryTotal += snowValue;
          januaryDataDays += 1;
        } else if (snowValue == null) {
          januaryMissingDays += 1;
        }
      }

      if (snowValue === null) {
        missingDates.add(row.date);
      }

      labels.push(row.date);
      dailySnow.push(snowValue);
      seasonalCum.push(row.seasonal_cum ?? null);

      if (typeof snowValue === 'number' && !Number.isNaN(snowValue)) {
        if (largestDailyValue === null || snowValue > largestDailyValue) {
          largestDailyValue = snowValue;
          largestDailyDate = row.date;
        }
        if (day && snowValue >= measurableThreshold) {
          if (!firstSnowDay) firstSnowDay = day;
          lastSnowDay = day;
          sumMeasurableSnow += snowValue;
          countMeasurableDays += 1;
          if (streakLength === 0) {
            streakStart = day;
          }
          streakLength += 1;
          streakSnowTotal += snowValue;
          streakEnd = day;
        }
        if (snowValue >= heavyThreshold) {
          heavyDayCount += 1;
        }
        if (snowValue >= sixPlusThreshold) {
          sixPlusDayCount += 1;
        }
        if (day && snowValue < measurableThreshold && streakLength > 0) {
          finalizeStreak();
        }
      } else if (streakLength > 0) {
        finalizeStreak();
      }
    });
    finalizeStreak();

    // Render holiday badges with measured amounts
    renderHolidayBadges(startYear, json.daily);

    const januaryValueEl = document.getElementById('january-total-value');
    const januaryNoteEl = document.getElementById('january-total-note');
    if (januaryValueEl && januaryNoteEl) {
      const januaryLabel = januaryYear ? `Jan ${januaryYear}` : 'January';
      if (januaryDataDays > 0) {
        animateNumberText(januaryValueEl, januaryTotal, {
          format: (val) => Number(val).toFixed(1),
          fallback: '--'
        });
        if (januaryMissingDays > 0) {
          const dayLabel = januaryMissingDays === 1 ? 'day' : 'days';
          januaryNoteEl.textContent = `${januaryLabel} total (${januaryMissingDays} missing ${dayLabel})`;
        } else {
          januaryNoteEl.textContent = `${januaryLabel} snowfall total`;
        }
      } else {
        resetAnimatedNumber(januaryValueEl);
        januaryNoteEl.textContent = `Awaiting ${januaryLabel} data`;
      }
    }

    const largestStormValueEl = document.getElementById('largest-storm-value');
    const largestStormNoteEl = document.getElementById('largest-storm-note');
    if (largestDailyValue !== null) {
      animateNumberText(largestStormValueEl, largestDailyValue, {
        format: (val) => Number(val).toFixed(1),
        fallback: '--'
      });
      largestStormNoteEl.textContent = largestDailyDate ? `On ${largestDailyDate}` : '';
    } else {
      resetAnimatedNumber(largestStormValueEl);
      largestStormNoteEl.textContent = 'No measurable snow';
    }

    const avgSnowValueEl = document.getElementById('average-snow-value');
    const avgSnowNoteEl = document.getElementById('average-snow-note');
    if (avgSnowValueEl && avgSnowNoteEl) {
      if (countMeasurableDays > 0) {
        const avgSnow = sumMeasurableSnow / countMeasurableDays;
        animateNumberText(avgSnowValueEl, avgSnow, {
          format: (val) => formatInches(val),
          fallback: '--'
        });
        const dayLabel = countMeasurableDays === 1 ? 'day' : 'days';
        avgSnowNoteEl.textContent = `${countMeasurableDays} ${dayLabel} ≥0.1"`;
      } else {
        resetAnimatedNumber(avgSnowValueEl);
        avgSnowNoteEl.textContent = 'Awaiting ≥0.1" snow';
      }
    }

    const firstSnowValueEl = document.getElementById('first-snow-value');
    const firstSnowNoteEl = document.getElementById('first-snow-note');
    if (firstSnowValueEl && firstSnowNoteEl) {
      if (firstSnowDay) {
        firstSnowValueEl.textContent = formatDateLabel(firstSnowDay);
        if (lastSnowDay && lastSnowDay.getTime() === firstSnowDay.getTime()) {
          firstSnowNoteEl.textContent = 'First & only ≥0.1" day';
        } else {
          firstSnowNoteEl.textContent = 'First ≥0.1" snow';
        }
      } else {
        firstSnowValueEl.textContent = '--';
        firstSnowNoteEl.textContent = 'Awaiting ≥0.1" snow';
      }
    }

    const lastSnowValueEl = document.getElementById('last-snow-value');
    const lastSnowNoteEl = document.getElementById('last-snow-note');
    if (lastSnowValueEl && lastSnowNoteEl) {
      if (lastSnowDay) {
        lastSnowValueEl.textContent = formatDateLabel(lastSnowDay);
        if (firstSnowDay && lastSnowDay.getTime() === firstSnowDay.getTime()) {
          lastSnowNoteEl.textContent = 'Only ≥0.1" day so far';
        } else {
          lastSnowNoteEl.textContent = 'Most recent ≥0.1" snow';
        }
      } else {
        lastSnowValueEl.textContent = '--';
        lastSnowNoteEl.textContent = 'Awaiting ≥0.1" snow';
      }
    }

    const streakValueEl = document.getElementById('snow-streak-value');
    const streakNoteEl = document.getElementById('snow-streak-note');
    if (streakValueEl && streakNoteEl) {
      if (longestStreakLength > 0) {
        animateNumberText(streakValueEl, longestStreakLength, {
          format: (val) => Math.round(val).toString(),
          fallback: '--'
        });
        const startLabel = formatDateLabel(longestStreakStart);
        const endLabel = formatDateLabel(longestStreakEnd);
        const streakTieNote = longestStreakCount > 1
          ? ` · Tied (${longestStreakCount} streaks)`
          : '';
        streakNoteEl.textContent = startLabel && endLabel
          ? `${startLabel} → ${endLabel}${streakTieNote}`
          : `Longest run of ≥0.1" days${streakTieNote}`;
      } else {
        resetAnimatedNumber(streakValueEl);
        streakNoteEl.textContent = 'Awaiting consecutive ≥0.1" snow days';
      }
    }

    const streakTotalValueEl = document.getElementById('snow-streak-total-value');
    const streakTotalNoteEl = document.getElementById('snow-streak-total-note');
    if (streakTotalValueEl && streakTotalNoteEl) {
      if (longestStreakLength > 0) {
        animateNumberText(streakTotalValueEl, longestStreakSnowTotal, {
          format: (val) => Number(val).toFixed(1),
          fallback: '--'
        });
        const startLabel = formatDateLabel(longestStreakStart);
        const endLabel = formatDateLabel(longestStreakEnd);
        const streakTieNote = longestStreakCount > 1
          ? ` · Tied (${longestStreakCount} streaks)`
          : '';
        streakTotalNoteEl.textContent = startLabel && endLabel
          ? `${startLabel} → ${endLabel}${streakTieNote}`
          : `Total during longest streak${streakTieNote}`;
      } else {
        resetAnimatedNumber(streakTotalValueEl);
        streakTotalNoteEl.textContent = 'Awaiting consecutive ≥0.1" snow days';
      }
    }

    // 2+ inch day count (seasonal window)
    const twoPlusValueEl2 = document.getElementById('two-plus-days-value');
    const twoPlusNoteEl2 = document.getElementById('two-plus-days-note');
    if (twoPlusValueEl2 && twoPlusNoteEl2) {
      animateNumberText(twoPlusValueEl2, heavyDayCount, {
        format: (val) => Math.round(val).toString(),
        fallback: '--'
      });
      // keep the static note text
    }

    // 6+ inch day count (seasonal window)
    const sixPlusValueEl2 = document.getElementById('six-plus-days-value');
    const sixPlusNoteEl2 = document.getElementById('six-plus-days-note');
    if (sixPlusValueEl2 && sixPlusNoteEl2) {
      animateNumberText(sixPlusValueEl2, sixPlusDayCount, {
        format: (val) => Math.round(val).toString(),
        fallback: '--'
      });
      // keep the static note text
    }

    const droughtValueEl = document.getElementById('snow-drought-value');
    const droughtNoteEl = document.getElementById('snow-drought-note');
    if (droughtValueEl && droughtNoteEl) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const lastDataDate = json.daily.length
        ? parseISODate(json.daily[json.daily.length - 1].date)
        : null;
      let limitDate = parseISODate(json.seasonal_end || json.end_date) || lastDataDate || today;
      if (lastDataDate && lastDataDate < limitDate) {
        limitDate = lastDataDate;
      }
      if (today < limitDate) {
        limitDate = today;
      }

      if (!firstSnowDay) {
        animateNumberText(droughtValueEl, 0, {
          format: (val) => Math.round(val).toString(),
          fallback: '--'
        });
        droughtNoteEl.textContent = 'No ≥0.1" snow yet this season';
      } else if (!lastSnowDay || firstSnowDay.getTime() === lastSnowDay.getTime()) {
        animateNumberText(droughtValueEl, 0, {
          format: (val) => Math.round(val).toString(),
          fallback: '--'
        });
        droughtNoteEl.textContent = 'Only one ≥0.1" day so far';
      } else {
        let streakStart = null;
        let streakEnd = null;
        let streakLength = 0;
        let longest = { length: 0, start: null, end: null };

        const finalizeStreak = () => {
          if (streakLength > longest.length) {
            longest = {
              length: streakLength,
              start: streakStart,
              end: streakEnd
            };
          }
          streakStart = null;
          streakEnd = null;
          streakLength = 0;
        };

        json.daily.forEach(row => {
          const day = parseISODate(row.date);
          if (!day || day < firstSnowDay || day > lastSnowDay || day > limitDate) return;

          const snow = row.snow;
          if (typeof snow === 'number' && !Number.isNaN(snow)) {
            if (snow < measurableThreshold) {
              if (!streakStart) streakStart = day;
              streakEnd = day;
              streakLength += 1;
            } else {
              finalizeStreak();
            }
          } else {
            finalizeStreak();
          }
        });
        finalizeStreak();

        if (longest.length > 0) {
          animateNumberText(droughtValueEl, longest.length, {
            format: (val) => Math.round(val).toString(),
            fallback: '--'
          });
          const startLabel = formatDateLabel(longest.start);
          const endLabel = formatDateLabel(longest.end);
          droughtNoteEl.textContent = longest.start && longest.end
            ? `Longest lull: ${startLabel} → ${endLabel}`
            : 'Longest lull between events';
        } else {
          animateNumberText(droughtValueEl, 0, {
            format: (val) => Math.round(val).toString(),
            fallback: '--'
          });
          droughtNoteEl.textContent = 'No lull between first & last events';
        }
      }
    }

    // Calculate prediction for current/active seasons
    let prediction = null;
    const todayDate = new Date();
    const seasonStartDate = parseISODate(seasonStart);
    const seasonEndDate = parseISODate(seasonEnd);
    const isActiveSeason = seasonStartDate && seasonEndDate && todayDate >= seasonStartDate && todayDate <= seasonEndDate;

    if (isActiveSeason) {
      try {
        const lastDataDate = determineLastDataDate(json.daily) || todayDate;
        prediction = await calculateSnowfallPrediction(json, lastDataDate);
      } catch (err) {
        console.error('Failed to calculate prediction:', err);
      }
    }

    // Update prediction display
    updatePredictionDisplay(prediction);

    drawChart(labels, dailySnow, seasonalCum, firstSnowDay, lastSnowDay, prediction, missingDates);
    if (Number.isFinite(parsedStartYear)) {
      setCachedSeasonData(parsedStartYear, json);
      updateContestResults(parsedStartYear, json);
      updateLastUpdatedTimestamp(parsedStartYear);
    } else {
      updateContestResults(startYear, json);
      updateLastUpdatedTimestamp(parseInt(startYear, 10));
    }
    setLoading(false);

  } catch (err) {
    if (err.name === 'AbortError') {
      // we intentionally canceled the old request because user switched seasons
      return;
    }
    console.error('fetch failed', err);
    const st = document.getElementById('station-label'); if (st) st.textContent = 'Network error';
    const sl = document.getElementById('season-label'); if (sl) sl.textContent = '';
    const sr = document.getElementById('seasonal-range-label'); if (sr) sr.textContent = '';
    resetAnimatedNumber(document.getElementById('seasonal-total-value'));
    resetAnimatedNumber(document.getElementById('january-total-value'));
    resetAnimatedNumber(document.getElementById('largest-storm-value'));
    const januaryNoteEl = document.getElementById('january-total-note');
    if (januaryNoteEl) januaryNoteEl.textContent = 'Unable to load';
    document.getElementById('largest-storm-note').textContent = 'Unable to load';
    updatePredictionDisplay(null);
    drawChart([], [], [], null, null, null, []);
    if (Number.isFinite(parsedStartYear)) {
      seasonDataCache.delete(parsedStartYear);
      updateContestResults(parsedStartYear, null);
    } else {
      updateContestResults(startYear, null);
    }
    setLoading(false);
  }
}

/**
 * Update "Last updated" timestamp display
 * @param {number} startYear - Season start year
 */
function updateLastUpdatedTimestamp(startYear) {
  const lastUpdatedEl = document.getElementById('last-updated');
  const lastUpdatedSepEl = document.getElementById('last-updated-sep');

  if (!lastUpdatedEl) return;

  // Only show for current season
  const now = new Date();
  const nowMonth = now.getMonth() + 1; // 1-12
  const currentSeasonYear = (nowMonth >= 7) ? now.getFullYear() : (now.getFullYear() - 1);

  if (startYear === currentSeasonYear) {
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    lastUpdatedEl.textContent = `Updated: ${timeStr}`;
    lastUpdatedEl.style.display = '';
    if (lastUpdatedSepEl) lastUpdatedSepEl.style.display = '';
  } else {
    lastUpdatedEl.style.display = 'none';
    if (lastUpdatedSepEl) lastUpdatedSepEl.style.display = 'none';
  }
}

/**
 * Update prediction display box
 * @param {Object} prediction - Prediction data from calculateSnowfallPrediction
 */
function updatePredictionDisplay(prediction) {
  const predictionBox = document.getElementById('prediction-box');
  const predictionValue = document.getElementById('prediction-value');
  const predictionNote = document.getElementById('prediction-note');

  if (!predictionBox || !predictionValue || !predictionNote) {
    return;
  }

  if (!prediction) {
    predictionBox.style.display = 'none';
    return;
  }

  // Show the box
  predictionBox.style.display = '';

  // Format the range
  const lowStr = formatInches(prediction.low);
  const middleStr = formatInches(prediction.middle);
  const highStr = formatInches(prediction.high);

  // Animate to middle value
  animateNumberText(predictionValue, prediction.middle, {
    format: (val) => formatInches(val),
    fallback: '--'
  });

  // Update note with range
  predictionNote.textContent = `Range: ${lowStr}″–${highStr}″ (25th–75th percentile)`;
}

/**
 * Calculate snowfall prediction based on historical data (2012-2024)
 * Uses remaining average method with percentile ranges
 * @param {Object} currentSeasonData - Current season data with daily array
 * @param {Array} historicalSeasons - Array of historical season data objects
 * @param {Date} currentDate - Current date (or last data date)
 * @returns {Object} - { low, middle, high, projectionData, currentTotal }
 */
async function calculateSnowfallPrediction(currentSeasonData, currentDate) {
  if (!currentSeasonData || !currentDate) {
    return null;
  }

  const currentDateISO = formatISODate(currentDate);
  if (!currentDateISO) {
    return null;
  }

  // Get current season's snowfall to date
  const dailyData = currentSeasonData.daily || [];
  let currentTotal = 0;
  for (const row of dailyData) {
    if (row.date > currentDateISO) break;
    const snowVal = typeof row.snow === 'number' ? row.snow : 0;
    currentTotal += snowVal;
  }

  // Fetch historical seasons (2012-2024)
  const historicalYears = [];
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const currentSeasonYear = currentMonth >= 7 ? currentYear : currentYear - 1;

  for (let year = 2012; year <= 2024; year++) {
    // Don't include current season in historical data
    if (year !== currentSeasonYear) {
      historicalYears.push(year);
    }
  }

  // Fetch all historical season data in parallel
  const historicalDataPromises = historicalYears.map(async (year) => {
    let data = getCachedSeasonData(year);
    if (!data) {
      try {
        const res = await fetch('snowdata.php?startYear=' + encodeURIComponent(year));
        if (res.ok) {
          data = await res.json();
          if (!data.error) {
            setCachedSeasonData(year, data);
          }
        }
      } catch (err) {
        console.error(`Failed to fetch historical data for ${year}:`, err);
      }
    }
    return data;
  });

  const historicalSeasons = (await Promise.all(historicalDataPromises)).filter(Boolean);

  if (!historicalSeasons.length) {
    return null;
  }

  // For each historical season, calculate remaining snowfall from current date to end
  const remainingSnowfalls = [];

  historicalSeasons.forEach(season => {
    const daily = season.daily || [];
    let remainingTotal = 0;

    // Get month and day from current date
    const currentMonth = currentDate.getMonth() + 1; // 1-12
    const currentDay = currentDate.getDate();

    daily.forEach(row => {
      const rowDate = parseISODate(row.date);
      if (!rowDate) return;

      const rowMonth = rowDate.getMonth() + 1;
      const rowDay = rowDate.getDate();

      // Check if this date is after the current date in the season
      // Handle year wrap (season goes Jul-Jun)
      let isAfter = false;
      if (currentMonth >= 7) { // Jul-Dec
        if (rowMonth >= 7) {
          isAfter = (rowMonth > currentMonth) || (rowMonth === currentMonth && rowDay > currentDay);
        } else { // rowMonth is Jan-Jun (next year)
          isAfter = true;
        }
      } else { // currentMonth is Jan-Jun
        if (rowMonth >= 7) {
          isAfter = false; // Already passed
        } else {
          isAfter = (rowMonth > currentMonth) || (rowMonth === currentMonth && rowDay > currentDay);
        }
      }

      if (isAfter) {
        const snowVal = typeof row.snow === 'number' ? row.snow : 0;
        remainingTotal += snowVal;
      }
    });

    remainingSnowfalls.push(remainingTotal);
  });

  if (!remainingSnowfalls.length) {
    return null;
  }

  // Sort to calculate percentiles
  remainingSnowfalls.sort((a, b) => a - b);

  // Calculate percentiles
  const getPercentile = (arr, percentile) => {
    const index = (percentile / 100) * (arr.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (lower === upper) {
      return arr[lower];
    }
    return arr[lower] * (1 - weight) + arr[upper] * weight;
  };

  const p25 = getPercentile(remainingSnowfalls, 25);
  const p50 = getPercentile(remainingSnowfalls, 50);
  const p75 = getPercentile(remainingSnowfalls, 75);

  // Create projection data arrays (from current date to end of season)
  const seasonEndISO = currentSeasonData.season_end || currentSeasonData.seasonal_end;
  const projectionData = {
    low: [],
    middle: [],
    high: [],
    dates: []
  };

  // Generate daily projection points
  const seasonEnd = parseISODate(seasonEndISO);
  if (seasonEnd) {
    let projDate = new Date(currentDate);
    while (projDate <= seasonEnd) {
      const dateISO = formatISODate(projDate);

      // Calculate days from current date
      const daysFromNow = Math.round((projDate - currentDate) / (1000 * 60 * 60 * 24));

      // Linear interpolation from current total to final projection
      const totalDaysInProjection = Math.round((seasonEnd - currentDate) / (1000 * 60 * 60 * 24));
      const ratio = totalDaysInProjection > 0 ? daysFromNow / totalDaysInProjection : 0;

      projectionData.dates.push(dateISO);
      projectionData.low.push(currentTotal + (p25 * ratio));
      projectionData.middle.push(currentTotal + (p50 * ratio));
      projectionData.high.push(currentTotal + (p75 * ratio));

      // Move to next day
      projDate.setDate(projDate.getDate() + 1);
    }
  }

  return {
    low: currentTotal + p25,
    middle: currentTotal + p50,
    high: currentTotal + p75,
    currentTotal,
    projectionStartDate: currentDateISO,
    projectionData
  };
}

// Draw or redraw Chart.js chart
function drawChart(labels, dailySnow, seasonalCum, firstSnowDay = null, lastSnowDay = null, predictionData = null, missingDates = []) {
  const canvas = document.getElementById('snowChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const noSnowEl = document.getElementById('no-snow-message');

  if (chartRef) {
    chartRef.destroy();
  }

  // Calculate x-axis limits based on first/last snowfall
  let xAxisMin = undefined;
  let xAxisMax = undefined;
  if (firstSnowDay && lastSnowDay) {
    xAxisMin = formatISODate(firstSnowDay);
    xAxisMax = formatISODate(lastSnowDay);
  }

  const missingDateSet = new Set(
    missingDates instanceof Set ? missingDates : (Array.isArray(missingDates) ? missingDates : [])
  );
  const missingIndices = [];
  labels.forEach((label, idx) => {
    if (missingDateSet.has(label)) {
      missingIndices.push(idx);
    }
  });
  const missingPattern = missingIndices.length ? getMissingPattern(ctx) : null;

  const barColors = [];
  const barBorderColors = [];
  const barBorderWidths = [];
  const baseColor = 'rgba(34,197,94,0.85)';
  const baseBorder = 'rgba(134,239,172,0.9)';
  const highlightColor = 'rgba(248,113,113,0.95)';
  const highlightBorder = 'rgba(239,68,68,1)';
  const highlightWidth = 2;

  let maxDailySnow = null;
  dailySnow.forEach((value) => {
    if (typeof value === 'number' && !Number.isNaN(value)) {
      if (maxDailySnow === null || value > maxDailySnow) {
        maxDailySnow = value;
      }
    }
  });

  dailySnow.forEach((value) => {
    const isNumeric = typeof value === 'number' && !Number.isNaN(value);
    const isMax = isNumeric && maxDailySnow !== null && Math.abs(value - maxDailySnow) < 1e-9;
    if (!isNumeric) {
      barColors.push('rgba(34,197,94,0.15)');
      barBorderColors.push('rgba(134,239,172,0.2)');
      barBorderWidths.push(0);
      return;
    }
    if (isMax) {
      barColors.push(highlightColor);
      barBorderColors.push(highlightBorder);
      barBorderWidths.push(highlightWidth);
      return;
    }
    barColors.push(baseColor);
    barBorderColors.push(baseBorder);
    barBorderWidths.push(0);
  });

  const hasSnow = dailySnow.some(value => typeof value === 'number' && value > 0);
  if (noSnowEl) {
    const shouldShow = !hasSnow && Array.isArray(labels) && labels.length > 0;
    noSnowEl.style.display = shouldShow ? 'flex' : 'none';
  }

  let resolvedZoomPlugin = null;
  if (typeof window !== 'undefined') {
    const zoomGlobal = window.ChartZoom || window['chartjs-plugin-zoom'] || null;
    resolvedZoomPlugin = zoomGlobal && zoomGlobal.default ? zoomGlobal.default : zoomGlobal;
  }

  const chartPlugins = [];
  if (resolvedZoomPlugin) {
    chartPlugins.push(resolvedZoomPlugin);
  }
  if (missingIndices.length) {
    const missingShadingPlugin = {
      id: 'missingDataHighlight',
      beforeDatasetsDraw(chart) {
        const { ctx: pluginCtx, chartArea, scales } = chart;
        const xScale = scales?.x;
        if (!chartArea || !xScale) return;
        const areaHeight = chartArea.bottom - chartArea.top;
        if (areaHeight <= 0) return;

        const resolveBandWidth = () => {
          if (labels.length > 1 && typeof xScale.getPixelForValue === 'function') {
            const step = Math.abs(xScale.getPixelForValue(1) - xScale.getPixelForValue(0));
            if (Number.isFinite(step) && step > 0) return step;
          }
          if (labels.length > 1 && typeof xScale.getPixelForTick === 'function') {
            const step = Math.abs(xScale.getPixelForTick(1) - xScale.getPixelForTick(0));
            if (Number.isFinite(step) && step > 0) return step;
          }
          return labels.length ? (chartArea.width / labels.length) : chartArea.width;
        };

        const bandWidth = resolveBandWidth();
        const fallbackWidth = labels.length ? (chartArea.width / labels.length) : chartArea.width;

        pluginCtx.save();
        pluginCtx.fillStyle = missingPattern || 'rgba(217,119,6,0.18)';
        pluginCtx.strokeStyle = 'rgba(180,83,9,0.45)';
        pluginCtx.lineWidth = 1;

        missingIndices.forEach((idx) => {
          const center = xScale.getPixelForValue(idx);
          if (!Number.isFinite(center)) return;
          const width = Number.isFinite(bandWidth) && bandWidth > 0 ? bandWidth : fallbackWidth;
          const left = center - width / 2;
          pluginCtx.fillRect(left, chartArea.top, width, areaHeight);
          pluginCtx.strokeRect(left, chartArea.top, width, areaHeight);
        });

        pluginCtx.restore();
      }
    };
    chartPlugins.push(missingShadingPlugin);
  }

  const animationDelay = (context) => {
    if (!context || context.type !== 'data' || context.mode !== 'default') {
      return 0;
    }
    const datasetIndex = context.datasetIndex ?? 0;
    const dataset = context.chart?.data?.datasets?.[datasetIndex];
    if (dataset && dataset.label === 'Missing data (ACIS)') {
      return 0;
    }
    const base = (dataset && dataset.label === 'Daily Snowfall (in)') ? 20 : 35;
    return context.dataIndex * base;
  };

  const pluginOptions = {
    legend: {
      labels: {
        color: 'rgba(226,232,240,1)'
      }
    },
    tooltip: {
      callbacks: {
        title: (items) => {
          if (items.length > 0) {
            return items[0].label;
          }
        },
        beforeBody: (items) => {
          const idx = items?.[0]?.dataIndex;
          if (idx == null) return;
          if (missingDateSet.has(labels[idx])) {
            return ['ACIS reports missing data for this date.'];
          }
        }
      }
    }
  };

  if (resolvedZoomPlugin) {
    pluginOptions.zoom = {
      limits: {
        x: {
          min: xAxisMin || 'original',
          max: xAxisMax || 'original'
        },
        y: { min: 'original', max: 'original' }
      },
      pan: {
        enabled: true,
        mode: 'x',
        modifierKey: 'shift'
      },
      zoom: {
        wheel: {
          enabled: true
        },
        pinch: {
          enabled: true
        },
        mode: 'x'
      }
    };
  }

  const missingLegendDataset = missingIndices.length ? {
    type: 'bar',
    label: 'Missing data (ACIS)',
    data: new Array(labels.length).fill(null),
    yAxisID: 'yDaily',
    backgroundColor: missingPattern || 'rgba(217,119,6,0.2)',
    borderColor: 'rgba(180,83,9,0.55)',
    borderWidth: 0,
    barPercentage: 1,
    categoryPercentage: 1,
    order: -2,
    stack: 'missing-legend'
  } : null;

  // Build datasets array
  const datasets = [
    missingLegendDataset,
    {
      type: 'bar',
      label: 'Daily Snowfall (in)',
      data: dailySnow,
      yAxisID: 'yDaily',
      backgroundColor: barColors,
      borderColor: barBorderColors,
      borderWidth: barBorderWidths,
      borderRadius: 3
    },
    {
      type: 'line',
      label: 'Season Cumulative (in)',
      data: seasonalCum,
      yAxisID: 'yCum',
      borderColor: 'rgba(56,189,248,1)',
      backgroundColor: 'rgba(56,189,248,0.18)',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      fill: false
    }
  ].filter(Boolean);

  // Add prediction datasets if available
  if (predictionData && predictionData.projectionData) {
    const projDates = predictionData.projectionData.dates;
    const projLow = predictionData.projectionData.low;
    const projMiddle = predictionData.projectionData.middle;
    const projHigh = predictionData.projectionData.high;

    // Create sparse arrays aligned with main labels
    const alignedLow = new Array(labels.length).fill(null);
    const alignedMiddle = new Array(labels.length).fill(null);
    const alignedHigh = new Array(labels.length).fill(null);

    projDates.forEach((projDate, idx) => {
      const labelIndex = labels.indexOf(projDate);
      if (labelIndex >= 0) {
        alignedLow[labelIndex] = projLow[idx];
        alignedMiddle[labelIndex] = projMiddle[idx];
        alignedHigh[labelIndex] = projHigh[idx];
      }
    });

    // High projection line (upper bound) - red/pink shaded area above
    datasets.push({
      type: 'line',
      label: 'Projected High (75th percentile)',
      data: alignedHigh,
      yAxisID: 'yCum',
      borderColor: 'rgba(248,113,113,0.8)',
      backgroundColor: 'rgba(248,113,113,0.25)',
      borderWidth: 2,
      borderDash: [5, 5],
      pointRadius: 0,
      tension: 0.3,
      fill: '+1', // Fill to next dataset (middle)
      order: 1
    });

    // Middle projection line (median)
    datasets.push({
      type: 'line',
      label: 'Projected Median (50th percentile)',
      data: alignedMiddle,
      yAxisID: 'yCum',
      borderColor: 'rgba(34,197,94,0.9)',
      backgroundColor: 'rgba(34,197,94,0)',
      borderWidth: 2.5,
      borderDash: [5, 5],
      pointRadius: 0,
      tension: 0.3,
      fill: false,
      order: 2
    });

    // Low projection line (lower bound) - blue/purple shaded area below
    datasets.push({
      type: 'line',
      label: 'Projected Low (25th percentile)',
      data: alignedLow,
      yAxisID: 'yCum',
      borderColor: 'rgba(147,197,253,0.8)',
      backgroundColor: 'rgba(147,197,253,0.25)',
      borderWidth: 2,
      borderDash: [5, 5],
      pointRadius: 0,
      tension: 0.3,
      fill: '-1', // Fill to previous dataset (middle)
      order: 3
    });
  }

  chartRef = new Chart(ctx, {
    plugins: chartPlugins,
    data: {
      labels,
      datasets
    },
    options: {
      animation: {
        duration: 1200,
        easing: 'easeOutQuart'
      },
      animations: {
        x: {
          type: 'number',
          easing: 'easeOutQuart',
          duration: 900,
          delay: animationDelay
        },
        y: {
          type: 'number',
          easing: 'easeOutQuart',
          duration: 1200,
          delay: animationDelay
        },
        tension: {
          duration: 1200,
          easing: 'easeOutQuart',
          delay: animationDelay,
          from: 0
        }
      },
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: pluginOptions,
      scales: {
        x: {
          min: xAxisMin,
          max: xAxisMax,
          ticks: {
            maxTicksLimit: 10,
            maxRotation: 90,
            minRotation: 90,
            align: 'start',
            crossAlign: 'far',
            color: 'rgba(148,163,184,1)' // slate-400
          },
          grid: {
            color: 'rgba(51,65,85,0.4)' // slate-700-ish
          }
        },
        yDaily: {
          type: 'linear',
          position: 'left',
          title: {
            display: true,
            text: 'Daily (in)'
          },
          ticks: {
            color: 'rgba(226,232,240,1)'
          },
          grid: {
            color: 'rgba(51,65,85,0.4)'
          }
        },
        yCum: {
          type: 'linear',
          position: 'right',
          title: {
            display: true,
            text: 'Cumulative (in)'
          },
          ticks: {
            color: 'rgba(226,232,240,1)'
          },
          grid: {
            drawOnChartArea: false
          }
        }
      }
    }
  });
}

// init page
populateSeasonDropdown();

const seasonSelectEl = document.getElementById('seasonSelect');
const initialYearOption = seasonSelectEl.options[0]?.value;
if (initialYearOption) {
  updateContestResults(initialYearOption);
  loadSeason(initialYearOption);
  syncDataLinks(parseInt(initialYearOption, 10));
} else {
  updateContestResults(NaN);
}

// when the user changes the dropdown, load that year
seasonSelectEl.addEventListener('change', (e) => {
  const selectedYear = e.target.value;
  updateContestResults(selectedYear);
  loadSeason(selectedYear);
  syncDataLinks(parseInt(selectedYear, 10));
});

// refresh button to clear cache and reload current season
const refreshButtonEl = document.getElementById('refreshButton');
if (refreshButtonEl) {
  refreshButtonEl.addEventListener('click', async () => {
    const selectedYear = seasonSelectEl.value;
    if (!selectedYear) return;

    const parsedYear = parseInt(selectedYear, 10);
    if (!Number.isFinite(parsedYear)) return;

    // Disable button and show feedback
    refreshButtonEl.disabled = true;
    const originalText = refreshButtonEl.querySelector('.btn-refresh-text')?.textContent || 'Refresh';
    const textEl = refreshButtonEl.querySelector('.btn-refresh-text');
    if (textEl) textEl.textContent = 'Refreshing...';

    try {
      // Clear caches for this season
      seasonDataCache.delete(parsedYear);
      guessCache.delete(parsedYear);

      // Reload the season (will fetch fresh data)
      await Promise.all([
        updateContestResults(parsedYear),
        loadSeason(parsedYear)
      ]);

      // Show success feedback briefly
      if (textEl) textEl.textContent = 'Refreshed!';
      setTimeout(() => {
        if (textEl) textEl.textContent = originalText;
        refreshButtonEl.disabled = false;
      }, 1000);

    } catch (err) {
      console.error('Refresh failed:', err);
      if (textEl) textEl.textContent = 'Error';
      setTimeout(() => {
        if (textEl) textEl.textContent = originalText;
        refreshButtonEl.disabled = false;
      }, 2000);
    }
  });
}

function syncDataLinks(year) {
  const jsonLink = document.getElementById('json-link');
  const csvLink = document.getElementById('csv-link');
  if (!Number.isFinite(year)) return;
  const jsonHref = `snowdata.php?startYear=${encodeURIComponent(year)}`;
  const csvHref = `${jsonHref}&format=csv`;
  if (jsonLink) jsonLink.href = jsonHref;
  if (csvLink) {
    csvLink.href = csvHref;
    csvLink.setAttribute('download', `snow_${year}.csv`);
  }
}
