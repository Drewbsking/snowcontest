let chartRef = null;
let currentController = null; // to cancel in-flight fetches
let guessHistogramChart = null;

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

const guessSheetConfigs = [
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

const guessStatEls = {
  avgValue: document.getElementById('guess-avg-value'),
  avgNote: document.getElementById('guess-avg-note'),
  lowValue: document.getElementById('guess-low-value'),
  lowNote: document.getElementById('guess-low-note'),
  highValue: document.getElementById('guess-high-value'),
  highNote: document.getElementById('guess-high-note')
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
  guessCsvLinkEl.href = '#';
  guessCsvLinkEl.removeAttribute('download');
  guessCsvLinkEl.setAttribute('aria-disabled', 'true');
}

function updateGuessCsvLink(startYear) {
  if (!guessCsvLinkEl) return;
  const cfg = Number.isFinite(startYear)
    ? guessSheetConfigs.find(c => c.startYear === startYear)
    : null;
  if (!cfg) {
    disableGuessCsvLink();
    return;
  }
  const fileName = (cfg.file.split('/').pop()) || `guesses_${startYear}-${startYear + 1}.csv`;
  guessCsvLinkEl.href = cfg.file;
  guessCsvLinkEl.setAttribute('download', fileName);
  guessCsvLinkEl.removeAttribute('aria-disabled');
}

function formatGuessNameList(entries) {
  const names = (entries || [])
    .map(entry => (entry && entry.name ? entry.name.trim() : 'Unknown'))
    .filter((name, idx, arr) => name && arr.indexOf(name) === idx);
  if (!names.length) return '—';
  if (names.length > 3) {
    const remaining = names.length - 3;
    return `${names.slice(0, 3).join(', ')} +${remaining} more`;
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
  renderGuessHistogram([]);
}

function setGuessStatsData(guesses, startYear) {
  if (!guessStatEls.avgValue) return;
  const valid = (guesses || []).filter(entry => entry && Number.isFinite(entry.guess));
  if (!valid.length) {
    setGuessStatsMessage('No guesses submitted yet.');
    return;
  }

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
  updateGuessCsvLink(startYear);
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
  const measurableThreshold = 0.1;
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

async function fetchGuessSheet(config) {
  const res = await fetch(config.file);
  if (!res.ok) {
    throw new Error(`Failed to load ${config.file}`);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (!rows || !rows.length) return [];

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

  return rows.slice(1).map(rawRow => {
    const get = (idx) => (idx >= 0 && idx < rawRow.length ? rawRow[idx] : null);
    const rawAlias = get(aliasIdx);
    const rawName = get(nameIdx);
    const rawEmail = get(emailIdx);
    const rawDept = get(deptIdx);
    const rawGuess = get(guessIdx);

    const name = (rawAlias ?? rawName ?? rawEmail ?? '').toString().trim();
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
      guess: guessVal
    };
  }).filter(entry => entry.name && entry.guess != null);
}

async function fetchSeasonTotals(startYear) {
  const res = await fetch('snowdata.php?startYear=' + encodeURIComponent(startYear));
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

  if (!seasonalEl) {
    return;
  }

  setGuessStatsMessage('Loading guesses…');

  const token = ++currentResultsToken;
  const parsedYear = parseInt(startYearInput, 10);
  seasonalEl.textContent = 'Loading season standings…';

  if (!Number.isFinite(parsedYear)) {
    seasonalEl.textContent = 'Select a season above to view standings.';
    setGuessStatsMessage('Select a season to view guesses.');
    return;
  }

  const config = guessSheetConfigs.find(cfg => cfg.startYear === parsedYear);
  if (!config) {
    seasonalEl.innerHTML = 'No guess sheet was found for this season.';
    setGuessStatsMessage('Guess sheet not found for this season.');
    return;
  }

  // Point the download link at the season's raw CSV, regardless of entries
  updateGuessCsvLink(parsedYear);

  let guesses = guessCache.get(parsedYear);
  if (!guesses) {
    try {
      guesses = await fetchGuessSheet(config);
      guessCache.set(parsedYear, guesses);
    } catch (err) {
      console.error('Failed loading guesses for season', parsedYear, err);
      if (token !== currentResultsToken) return;
      seasonalEl.innerHTML = 'Unable to load guesses for this season.';
      setGuessStatsMessage('Unable to load guess data.');
      return;
    }
  }
  if (token !== currentResultsToken) return;

  if (!guesses.length) {
    const msg = 'No guesses submitted yet.';
    seasonalEl.innerHTML = msg;
    setGuessStatsMessage('No guesses submitted yet.');
    return;
  }

  setGuessStatsData(guesses, parsedYear);

  if (seasonDataOverride) {
    seasonDataCache.set(parsedYear, seasonDataOverride);
  }

  let seasonData = seasonDataOverride || seasonDataCache.get(parsedYear);
  if (!seasonData) {
    try {
      seasonData = await fetchSeasonTotals(parsedYear);
      seasonDataCache.set(parsedYear, seasonData);
    } catch (err) {
      console.error('Failed loading snowfall data for season', parsedYear, err);
      if (token !== currentResultsToken) return;
      seasonalEl.innerHTML = 'Unable to load snowfall totals right now.';
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
  if (!seasonalMessage) {
    seasonalMessage = 'No information available for this season.';
  }
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

  const twoPlusValueEl = document.getElementById('two-plus-days-value');
  const twoPlusNoteEl = document.getElementById('two-plus-days-note');
  if (twoPlusValueEl) resetAnimatedNumber(twoPlusValueEl);
  if (twoPlusNoteEl) twoPlusNoteEl.textContent = 'Days with ≥2.0"';

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

  try {
    const res = await fetch(
      'snowdata.php?startYear=' + encodeURIComponent(startYear),
      { signal }
    );
    const json = await res.json();

    // if we aborted this request after sending it, just stop quietly
    if (signal.aborted) return;

    if (json.error) {
      const st = document.getElementById('station-label'); if (st) st.textContent = 'Data error';
      const sl = document.getElementById('season-label'); if (sl) sl.textContent = '';
      const sr = document.getElementById('seasonal-range-label'); if (sr) sr.textContent = '';
      resetAnimatedNumber(document.getElementById('seasonal-total-value'));
      resetAnimatedNumber(document.getElementById('largest-storm-value'));
      document.getElementById('largest-storm-note').textContent = 'Unable to load';
      console.error(json.error);

      drawChart([], [], []);
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
    const measurableThreshold = 0.1;
    const heavyThreshold = 2.0;
    let heavyDayCount = 0;
    let streakLength = 0;
    let streakStart = null;
    let longestStreakLength = 0;
    let longestStreakStart = null;
    let longestStreakEnd = null;
    let largestDailyValue = null;
    let largestDailyDate = null;
    let firstSnowDay = null;
    let lastSnowDay = null;
    let sumMeasurableSnow = 0;
    let countMeasurableDays = 0;

    json.daily.forEach(row => {
      const day = parseISODate(row.date);
      const snowValue = row.snow === null ? null : row.snow;

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
          if (streakLength > longestStreakLength) {
            longestStreakLength = streakLength;
            longestStreakStart = streakStart;
            longestStreakEnd = day;
          }
        }
        if (snowValue >= heavyThreshold) {
          heavyDayCount += 1;
        }
        if (day && snowValue < measurableThreshold && streakLength > 0) {
          streakLength = 0;
          streakStart = null;
        }
      } else if (streakLength > 0) {
        streakLength = 0;
        streakStart = null;
      }
    });

    // Render holiday badges with measured amounts
    renderHolidayBadges(startYear, json.daily);

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
        streakNoteEl.textContent = startLabel && endLabel
          ? `${startLabel} → ${endLabel}`
          : 'Longest run of ≥0.1" days';
      } else {
        resetAnimatedNumber(streakValueEl);
        streakNoteEl.textContent = 'Awaiting consecutive ≥0.1" snow days';
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

    drawChart(labels, dailySnow, seasonalCum);
    if (Number.isFinite(parsedStartYear)) {
      seasonDataCache.set(parsedStartYear, json);
      updateContestResults(parsedStartYear, json);
    } else {
      updateContestResults(startYear, json);
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
    resetAnimatedNumber(document.getElementById('largest-storm-value'));
    document.getElementById('largest-storm-note').textContent = 'Unable to load';
    drawChart([], [], []);
    if (Number.isFinite(parsedStartYear)) {
      seasonDataCache.delete(parsedStartYear);
      updateContestResults(parsedStartYear, null);
    } else {
      updateContestResults(startYear, null);
    }
    setLoading(false);
  }
}

// Draw or redraw Chart.js chart
function drawChart(labels, dailySnow, seasonalCum) {
  const canvas = document.getElementById('snowChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const noSnowEl = document.getElementById('no-snow-message');

  if (chartRef) {
    chartRef.destroy();
  }

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

  const animationDelay = (context) => {
    if (!context || context.type !== 'data' || context.mode !== 'default') {
      return 0;
    }
    const datasetIndex = context.datasetIndex ?? 0;
    const base = datasetIndex === 0 ? 20 : 35;
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
        }
      }
    }
  };

  if (resolvedZoomPlugin) {
    pluginOptions.zoom = {
      limits: {
        x: { min: 'original', max: 'original' },
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

  chartRef = new Chart(ctx, {
    plugins: chartPlugins,
    data: {
      labels,
      datasets: [
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
      ]
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
          ticks: {
            maxTicksLimit: 10,
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
