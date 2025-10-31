const contestHighlightPlugin = {
  id: 'contestHighlight',
  beforeDatasetsDraw(chart) {
    const cfg = chart.options?.plugins?.contestHighlight;
    if (!cfg?.enabled) return;

    const xScale = chart.scales?.x;
    if (!xScale || !chart.chartArea) return;

    const startIndex = cfg.startIndex;
    const endIndex = cfg.endIndex;
    if (startIndex == null || endIndex == null || startIndex < 0 || endIndex < 0) {
      return;
    }

    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);
    const step = getCategoryStep(xScale);
    const leftCenter = xScale.getPixelForTick(start);
    const rightCenter = xScale.getPixelForTick(end);
    const leftEdge = Math.max(xScale.left, leftCenter - step / 2);
    const rightEdge = Math.min(xScale.right, rightCenter + step / 2);
    if (rightEdge <= leftEdge) return;

    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = cfg.color || 'rgba(13,148,136,0.28)';
    ctx.fillRect(leftEdge, top, rightEdge - leftEdge, bottom - top);
    ctx.restore();
  }
};

function getCategoryStep(scale) {
  if (!scale || !scale.ticks || scale.ticks.length <= 1) {
    return scale?.width ?? 0;
  }
  const first = scale.getPixelForTick(0);
  const second = scale.getPixelForTick(1);
  const step = Math.abs(second - first);
  if (step > 0) return step;
  return scale.width / Math.max(scale.ticks.length, 1);
}

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
  { startYear: 2019, file: '19-20Guesses.xlsx' },
  { startYear: 2020, file: '20-21Guesses.xlsx' },
  { startYear: 2021, file: '21-22Guesses.xlsx' },
  { startYear: 2022, file: '22-23Guesses.xlsx' },
  { startYear: 2023, file: '23-24Guesses.xlsx' },
  { startYear: 2024, file: '24-25Guesses.xlsx' },
  { startYear: 2025, file: '25-26Guesses.xlsx' }
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
let guessCsvUrl = null;

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
  if (guessCsvUrl) {
    URL.revokeObjectURL(guessCsvUrl);
    guessCsvUrl = null;
  }
  guessCsvLinkEl.href = '#';
  guessCsvLinkEl.removeAttribute('download');
  guessCsvLinkEl.setAttribute('aria-disabled', 'true');
}

function updateGuessCsvLink(startYear, entries) {
  if (!guessCsvLinkEl) return;
  if (guessCsvUrl) {
    URL.revokeObjectURL(guessCsvUrl);
    guessCsvUrl = null;
  }
  if (!Number.isFinite(startYear) || !Array.isArray(entries) || !entries.length) {
    disableGuessCsvLink();
    return;
  }

  const header = ['Name', 'Department', 'Guess (inches)'];
  const dataRows = entries.map(entry => {
    const name = entry?.name ? String(entry.name).trim() : '';
    const dept = entry?.dept ? String(entry.dept).trim() : '';
    const guess = Number.isFinite(entry?.guess) ? String(entry.guess) : '';
    return [name, dept, guess];
  });

  const csvLines = [header, ...dataRows].map(row => row.map(cell => {
    const safe = cell == null ? '' : String(cell);
    const escaped = safe.replace(/"/g, '""');
    return `"${escaped}"`;
  }).join(',')).join('\r\n');

  const blob = new Blob([csvLines], { type: 'text/csv;charset=utf-8;' });
  guessCsvUrl = URL.createObjectURL(blob);
  guessCsvLinkEl.href = guessCsvUrl;
  guessCsvLinkEl.setAttribute('download', `snowfall_guesses_${startYear}-${startYear + 1}.csv`);
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
  disableGuessCsvLink();
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
  updateGuessCsvLink(startYear, valid);
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

function describeMargin(margin, wentOver) {
  if (margin == null || Number.isNaN(margin)) {
    return '';
  }
  if (wentOver) {
    return `over by ${formatInches(margin)}"`;
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

async function fetchGuessSheet(config) {
  if (typeof XLSX === 'undefined') {
    throw new Error('XLSX library not loaded');
  }
  const res = await fetch(config.file);
  if (!res.ok) {
    throw new Error(`Failed to load ${config.file}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: null
  });
  if (!rows.length) {
    return [];
  }
  const header = rows[0].map(cell => {
    if (cell == null) return '';
    return String(cell).trim().toLowerCase();
  });
  const normalized = header.map(h => h.replace(/[^a-z0-9]/g, ''));
  const nameIdx = normalized.findIndex(h => h.includes('name') || h.includes('guesser'));
  const guessIdx = normalized.findIndex(h => (h.startsWith('guess') && h !== 'guesser') || h === 'snowguess' || h === 'totalguess');
  const deptIdx = normalized.findIndex(h => h.includes('dist') || h.includes('dept'));

  return rows.slice(1).map(row => {
    const rawName = nameIdx >= 0 ? row[nameIdx] : row[0];
    const rawGuess = guessIdx >= 0 ? row[guessIdx] : row[2];
    const rawDept = deptIdx >= 0 ? row[deptIdx] : null;
    const name = rawName == null ? '' : String(rawName).trim();
    const guessVal = typeof rawGuess === 'number'
      ? rawGuess
      : parseFloat(String(rawGuess).replace(/[^0-9.\-]/g, ''));
    return {
      name,
      dept: rawDept == null ? '' : String(rawDept).trim(),
      guess: Number.isFinite(guessVal) ? guessVal : null
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

function pickPriceIsRightResult(guesses, target) {
  if (!Array.isArray(guesses) || !Number.isFinite(target)) {
    return { winners: [], margin: null, allOver: false };
  }

  const epsilon = 1e-6;
  const eligible = [];
  const over = [];

  guesses.forEach(entry => {
    if (!entry || !Number.isFinite(entry.guess)) {
      return;
    }
    const delta = target - entry.guess;
    if (delta >= -epsilon) {
      eligible.push({ entry, margin: Math.max(delta, 0) });
    } else {
      over.push({ entry, margin: Math.abs(delta) });
    }
  });

  if (eligible.length) {
    const minMargin = Math.min(...eligible.map(item => item.margin));
    const winners = eligible
      .filter(item => Math.abs(item.margin - minMargin) < epsilon)
      .map(item => ({
        ...item.entry,
        margin: item.margin,
        wentOver: false
      }));
    return { winners, margin: minMargin, allOver: false };
  }

  if (over.length) {
    const minOver = Math.min(...over.map(item => item.margin));
    const closest = over
      .filter(item => Math.abs(item.margin - minOver) < epsilon)
      .map(item => ({
        ...item.entry,
        margin: item.margin,
        wentOver: true
      }));
    return { winners: closest, margin: minOver, allOver: true };
  }

  return { winners: [], margin: null, allOver: false };
}

async function updateContestResults(startYearInput, seasonDataOverride) {
  const seasonTitleEl = document.getElementById('contest-results-season');
  const officialEl = document.getElementById('official-result-body');
  const seasonalEl = document.getElementById('seasonal-result-body');

  if (!seasonTitleEl || !officialEl || !seasonalEl) {
    return;
  }

  setGuessStatsMessage('Loading guesses…');

  const token = ++currentResultsToken;
  const parsedYear = parseInt(startYearInput, 10);
  const fallbackLabel = Number.isFinite(parsedYear) ? `${parsedYear}-${parsedYear + 1}` : null;

  seasonTitleEl.innerHTML = fallbackLabel
    ? `<strong>${escapeHtml('Season ' + fallbackLabel)}</strong>`
    : 'Select a season to view standings.';
  officialEl.textContent = 'Loading official standings…';
  seasonalEl.textContent = 'Loading seasonal standings…';

  if (!Number.isFinite(parsedYear)) {
    officialEl.textContent = 'Select a season above to view contest results.';
    seasonalEl.textContent = 'Select a season above to view contest results.';
    setGuessStatsMessage('Select a season to view guesses.');
    return;
  }

  const config = guessSheetConfigs.find(cfg => cfg.startYear === parsedYear);
  if (!config) {
    officialEl.innerHTML = 'No guess sheet was found for this season.';
    seasonalEl.innerHTML = 'No guess sheet was found for this season.';
    setGuessStatsMessage('Guess sheet not found for this season.');
    return;
  }

  let guesses = guessCache.get(parsedYear);
  if (!guesses) {
    try {
      guesses = await fetchGuessSheet(config);
      guessCache.set(parsedYear, guesses);
    } catch (err) {
      console.error('Failed loading guesses for season', parsedYear, err);
      if (token !== currentResultsToken) return;
      officialEl.innerHTML = 'Unable to load guesses for this season.';
      seasonalEl.innerHTML = 'Unable to load guesses for this season.';
      setGuessStatsMessage('Unable to load guess data.');
      return;
    }
  }
  if (token !== currentResultsToken) return;

  if (!guesses.length) {
    const msg = 'No guesses submitted yet.';
    officialEl.innerHTML = msg;
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
      officialEl.innerHTML = 'Unable to load snowfall totals right now.';
      seasonalEl.innerHTML = 'Unable to load snowfall totals right now.';
      return;
    }
  }
  if (token !== currentResultsToken) return;

  const seasonLabel = seasonData?.season_label || fallbackLabel || `Season ${parsedYear}-${parsedYear + 1}`;
  seasonTitleEl.innerHTML = `<strong>${escapeHtml(seasonLabel)}</strong>`;

  const contestStartStr = seasonData?.contest_start || seasonData?.start_date;
  const contestEndStr = seasonData?.contest_end || seasonData?.end_date;
  const seasonalStartStr = seasonData?.seasonal_start || contestStartStr;
  const seasonalEndStr = seasonData?.seasonal_end || contestEndStr;
  const daily = Array.isArray(seasonData?.daily) ? seasonData.daily : [];
  const dataLastUpdated = determineLastDataDate(daily);
  const today = new Date();

  const contestStart = parseISODate(contestStartStr);
  const contestEnd = parseISODate(contestEndStr);
  const officialStart = contestStart ? new Date(contestStart.getTime()) : null;
  if (officialStart) {
    officialStart.setDate(officialStart.getDate() + 1);
  }
  const officialStartStr = officialStart ? formatISODate(officialStart) : contestStartStr;
  const contestStage = (officialStart || contestStart) && (contestEnd || officialStart || contestStart)
    ? getStage(today, officialStart || contestStart, contestEnd || officialStart || contestStart)
    : 'unknown';

  const officialTotal = computeWindowTotal(
    daily,
    officialStartStr || contestStartStr,
    contestEndStr || officialStartStr
  );

  const seasonalStart = parseISODate(seasonalStartStr);
  const seasonalEnd = parseISODate(seasonalEndStr);
  const seasonalStage = (seasonalStart && seasonalEnd)
    ? getStage(today, seasonalStart, seasonalEnd)
    : 'unknown';
  const seasonalTotal = computeWindowTotal(
    daily,
    seasonalStartStr,
    seasonalEndStr || seasonalStartStr
  );

  let officialMessage = '';
  if (contestStage === 'pre') {
    const startLabel = formatDateLabel(officialStart || contestStart);
    officialMessage = `Contest opens on ${startLabel || 'Dec 2'}. We'll post leaders once snowfall is recorded.`;
  } else if (contestStage === 'unknown') {
    officialMessage = 'Contest window dates are unavailable for this season.';
  } else if (officialTotal == null) {
    officialMessage = 'Snowfall data is unavailable for this season.';
  } else {
    const officialResult = pickPriceIsRightResult(guesses, officialTotal);
    if (!officialResult.winners.length && !officialResult.allOver) {
      officialMessage = 'No leader could be determined.';
    } else if (officialResult.allOver) {
      const names = officialResult.winners.map(formatGuesserDisplay).join(', ');
      const marginLabel = describeMargin(officialResult.margin, true);
      const totalLabel = contestStage === 'done' ? 'Final contest total' : 'Contest total so far';
      const contextText = contestStage === 'done'
        ? 'Contest completed — no qualifying winner (all guesses exceeded the final total).'
        : 'No qualifying leader yet — every guess is still above the current total.';
      officialMessage = `${contextText} Closest over guess: <span class="result-highlight">${names}</span> · ${totalLabel}: ${formatInches(officialTotal)}"${marginLabel ? ` · ${marginLabel}` : ''}`;
    } else {
      const names = officialResult.winners.map(formatGuesserDisplay).join(', ');
      const marginLabel = describeMargin(officialResult.margin, false);
      const label = contestStage === 'done' ? 'Official winner' : 'Current leader';
      const totalLabel = contestStage === 'done' ? 'Final contest total' : 'Contest total so far';
      officialMessage = `${label}${officialResult.winners.length > 1 ? 's' : ''}: <span class="result-highlight">${names}</span> · ${totalLabel}: ${formatInches(officialTotal)}"${marginLabel ? ` · ${marginLabel}` : ''}`;
    }
  }
  if (!officialMessage) {
    officialMessage = 'No information available for this season.';
  }
  officialEl.innerHTML = officialMessage;

  let seasonalMessage = '';
  if (seasonalStage === 'pre') {
    const startLabel = formatDateLabel(seasonalStart);
    seasonalMessage = `Snow year begins on ${startLabel || 'Jul 1'}. We'll post standings once the season starts.`;
  } else if (seasonalStage === 'unknown') {
    seasonalMessage = 'Seasonal window dates are unavailable for this season.';
  } else if (seasonalTotal == null) {
    seasonalMessage = 'Seasonal snowfall data is unavailable for this season.';
  } else {
    const seasonalResult = pickPriceIsRightResult(guesses, seasonalTotal);
    if (!seasonalResult.winners.length && !seasonalResult.allOver) {
      seasonalMessage = 'No leader could be determined.';
    } else if (seasonalResult.allOver) {
      const names = seasonalResult.winners.map(formatGuesserDisplay).join(', ');
      const marginLabel = describeMargin(seasonalResult.margin, true);
      const totalLabel = seasonalStage === 'done' ? 'Final seasonal total' : 'Seasonal total so far';
      const contextText = seasonalStage === 'done'
        ? 'Snow year completed — no qualifying unofficial winner (all guesses exceeded the final total).'
        : 'No unofficial leader yet — every guess is still above the current total.';
      seasonalMessage = `${contextText} Closest over guess: <span class="result-highlight">${names}</span> · ${totalLabel}: ${formatInches(seasonalTotal)}"${marginLabel ? ` · ${marginLabel}` : ''}`;
    } else {
      const names = seasonalResult.winners.map(formatGuesserDisplay).join(', ');
      const marginLabel = describeMargin(seasonalResult.margin, false);
      const label = seasonalStage === 'done' ? 'Unofficial winner' : 'Unofficial leader';
      const totalLabel = seasonalStage === 'done' ? 'Final seasonal total' : 'Seasonal total so far';
      seasonalMessage = `${label}${seasonalResult.winners.length > 1 ? 's' : ''}: <span class="result-highlight">${names}</span> · ${totalLabel}: ${formatInches(seasonalTotal)}"${marginLabel ? ` · ${marginLabel}` : ''}`;
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

// Build dropdown with recent contest seasons
// Season runs Dec 1 (YYYY) -> Mar 31 (YYYY+1)
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

  const now = new Date();
  const month = now.getMonth() + 1; // 1..12
  const year = now.getFullYear();

  // Once we reach Jul 1, consider the upcoming contest season (Dec -> Mar) for this year.
  // For Jan–Jun, we remain in the season that began the previous Dec.
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
      document.getElementById('station-label').textContent = 'Data error';
      document.getElementById('season-label').textContent  = '';
      document.getElementById('contest-date-label').textContent = '';
      document.getElementById('seasonal-range-label').textContent = '';
      resetAnimatedNumber(document.getElementById('contest-total-value'));
      resetAnimatedNumber(document.getElementById('seasonal-total-value'));
      resetAnimatedNumber(document.getElementById('largest-storm-value'));
      document.getElementById('largest-storm-note').textContent = 'Unable to load';
      console.error(json.error);

      drawChart([], [], [], [], null);
      if (Number.isFinite(parsedStartYear)) {
        seasonDataCache.delete(parsedStartYear);
        updateContestResults(parsedStartYear, null);
      }
      setLoading(false);
      return;
    }

    // Update totals card
    document.getElementById('station-label').textContent =
      json.station_name || 'White Lake Station';

    document.getElementById('season-label').textContent =
      'Season ' + (json.season_label || '');

    const contestStart = json.contest_start || json.start_date;
    const contestEnd = json.contest_end || json.end_date;
    const seasonalStart = json.seasonal_start || contestStart;
    const seasonalEnd = json.seasonal_end || contestEnd;

    document.getElementById('contest-date-label').textContent =
      'Contest: ' + contestStart + ' → ' + contestEnd;

    document.getElementById('seasonal-range-label').textContent =
      'Seasonal Snow Year: ' + seasonalStart + ' → ' + seasonalEnd;
    const srcEl = document.getElementById('data-source');
    if (srcEl) {
      const sid = json.station_sid ? ` (SID ${json.station_sid})` : '';
      srcEl.textContent = `Source: NOAA ACIS – ${json.station_name || 'White Lake 4E'}${sid}`;
    }

    const contestTotalRaw = json.contest_total_snow_in ?? json.total_snow_in ?? 0;
    animateNumberText(
      document.getElementById('contest-total-value'),
      contestTotalRaw,
      {
        format: (val) => Number(val).toFixed(1),
        fallback: '--',
        startValue: 0
      }
    );

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
    const contestCum = [];
    const seasonalCum = [];
    const measurableThreshold = 0.1;
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
      contestCum.push(row.contest_cum === null ? null : row.contest_cum);
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
        }
      }
    });

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

    drawChart(labels, dailySnow, contestCum, seasonalCum, {
      start: contestStart,
      end: contestEnd
    });
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
    document.getElementById('station-label').textContent = 'Network error';
    document.getElementById('season-label').textContent = '';
    document.getElementById('contest-date-label').textContent = '';
    document.getElementById('seasonal-range-label').textContent = '';
    resetAnimatedNumber(document.getElementById('contest-total-value'));
    resetAnimatedNumber(document.getElementById('seasonal-total-value'));
    resetAnimatedNumber(document.getElementById('largest-storm-value'));
    document.getElementById('largest-storm-note').textContent = 'Unable to load';
    drawChart([], [], [], [], null);
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
function drawChart(labels, dailySnow, contestCum, seasonalCum, highlightRange) {
  const ctx = document.getElementById('snowChart').getContext('2d');
  const noSnowEl = document.getElementById('no-snow-message');

  if (chartRef) {
    chartRef.destroy();
  }

  let highlightOpts = { enabled: false };
  if (highlightRange && Array.isArray(labels) && labels.length > 0) {
    const startIndex = labels.indexOf(highlightRange.start);
    const endIndex = labels.lastIndexOf(highlightRange.end);
    if (startIndex !== -1 && endIndex !== -1) {
      highlightOpts = {
        enabled: true,
        startIndex,
        endIndex,
        color: 'rgba(13,148,136,0.28)'
      };
    }
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

  const chartPlugins = [contestHighlightPlugin];
  if (resolvedZoomPlugin) {
    chartPlugins.push(resolvedZoomPlugin);
  }

  const pluginOptions = {
    legend: {
      labels: {
        color: 'rgba(226,232,240,1)' // slate-200
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
    },
    contestHighlight: highlightOpts
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
          label: 'Contest Cumulative (in)',
          data: contestCum,
          yAxisID: 'yCum',
          borderColor: 'rgba(244,114,182,1)',
          backgroundColor: 'rgba(244,114,182,0.2)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
          fill: false
        },
        {
          type: 'line',
          label: 'Seasonal Cumulative (in)',
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

// Subtle snow generator
(function makeSnow() {
  const container = document.querySelector('.snow-layer');
  if (!container) return;

  const FLAKE_COUNT = 30;

  for (let i = 0; i < FLAKE_COUNT; i++) {
    const flake = document.createElement('div');
    flake.className = 'snowflake';
    flake.textContent = '✻';

    const startXvw = Math.random() * 100;
    const driftVw = Math.random() * 10 - 5;
    const opacity = (0.4 + Math.random() * 0.4).toFixed(2);
    const sizeRem = (0.4 + Math.random() * 0.6).toFixed(2);
    const duration = (8 + Math.random() * 8).toFixed(2);
    const delay = (Math.random() * 8).toFixed(2);

    flake.style.left = `${startXvw}vw`;
    flake.style.setProperty('--x', '0vw');
    flake.style.setProperty('--x-end', `${driftVw}vw`);
    flake.style.setProperty('--o', opacity);
    flake.style.fontSize = `${sizeRem}rem`;
    flake.style.animationDuration = `${duration}s`;
    flake.style.animationDelay = `${delay}s`;

    container.appendChild(flake);
  }
})();

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
