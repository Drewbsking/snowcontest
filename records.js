const SEASON_START_YEARS = [
  2012, 2013, 2014, 2015, 2016, 2017, 2018,
  2019, 2020, 2021, 2022, 2023, 2024, 2025
];
const MEASURABLE_THRESHOLD = 0.1;
const HEAVY_DAY_THRESHOLD = 2.0;
const MAJOR_DAY_THRESHOLD = 6.0;

const summaryEl = document.getElementById('record-summary');
const loadingEl = document.getElementById('records-loading');
const tableBodyEl = document.querySelector('#season-record-table tbody');
const footerUpdatedEl = document.getElementById('data-updated');
const totalsChartEl = document.getElementById('season-total-chart');
const totalsDateEl = document.getElementById('season-total-date');

function seasonLabel(year) {
  return `${year}-${year + 1}`;
}

function formatDateLabel(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string'
    ? new Date(`${dateInput}T00:00:00`)
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

function formatInches(value) {
  if (value == null || Number.isNaN(value)) return '--';
  const rounded = Math.round(value * 10) / 10;
  const str = rounded.toFixed(1);
  return str.endsWith('.0') ? str.slice(0, -2) : str;
}

function parseISODate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getNthWeekdayOfMonth(year, month1to12, weekday0to6, nth) {
  const firstOfMonth = new Date(year, month1to12 - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const offset = (7 + weekday0to6 - firstWeekday) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  const candidate = new Date(year, month1to12 - 1, day);
  if (candidate.getMonth() !== month1to12 - 1) return null;
  return candidate;
}

function getHolidayListForSeason(startYear) {
  const nextYear = startYear + 1;
  return [
    { key: 'thanksgiving', label: 'Thanksgiving', date: getNthWeekdayOfMonth(startYear, 11, 4, 4) },
    { key: 'christmas', label: 'Christmas', date: new Date(startYear, 11, 25) },
    { key: 'newyear', label: "New Year’s Day", date: new Date(nextYear, 0, 1) },
    { key: 'mlk', label: 'MLK Day', date: getNthWeekdayOfMonth(nextYear, 1, 1, 3) },
    { key: 'presidents', label: "Presidents Day", date: getNthWeekdayOfMonth(nextYear, 2, 1, 3) }
  ].map((holiday) => ({
    ...holiday,
    iso: holiday.date ? holiday.date.toISOString().slice(0, 10) : null
  }));
}

function determineLastDataDate(dailyRows) {
  if (!Array.isArray(dailyRows)) return null;
  for (let i = dailyRows.length - 1; i >= 0; i -= 1) {
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

function computeSeasonStats(json, startYear) {
  const daily = Array.isArray(json?.daily) ? json.daily : [];
  const label = seasonLabel(startYear);

  const firstIndex = daily.findIndex((row) => typeof row?.snow === 'number' && !Number.isNaN(row.snow) && row.snow >= MEASURABLE_THRESHOLD);
  let lastIndex = -1;
  for (let i = daily.length - 1; i >= 0; i -= 1) {
    const row = daily[i];
    if (typeof row?.snow === 'number' && !Number.isNaN(row.snow) && row.snow >= MEASURABLE_THRESHOLD) {
      lastIndex = i;
      break;
    }
  }

  const firstSnow = firstIndex >= 0 ? parseISODate(daily[firstIndex].date) : null;
  const lastSnow = lastIndex >= 0 ? parseISODate(daily[lastIndex].date) : null;

  let heavyDayCount = 0;
  let majorDayCount = 0;
  let streakLength = 0;
  let streakStart = null;
  let streakEnd = null;
  let streakTotal = 0;
  let longestStreak = { length: 0, start: null, end: null };
  let longestStreakTotal = 0;
  let longestStreakCount = 0;
  let largestDaily = { value: null, date: null };
  let totalSnow = 0;

  const finalizeStreak = () => {
    if (streakLength <= 0) return;
    if (streakLength > longestStreak.length) {
      longestStreak = {
        length: streakLength,
        start: streakStart,
        end: streakEnd
      };
      longestStreakTotal = streakTotal;
      longestStreakCount = 1;
    } else if (streakLength === longestStreak.length) {
      longestStreakCount += 1;
      if (streakTotal > longestStreakTotal) {
        longestStreak = {
          length: streakLength,
          start: streakStart,
          end: streakEnd
        };
        longestStreakTotal = streakTotal;
      }
    }
    streakLength = 0;
    streakStart = null;
    streakEnd = null;
    streakTotal = 0;
  };

  daily.forEach((row) => {
    const day = parseISODate(row?.date);
    const snow = typeof row?.snow === 'number' && !Number.isNaN(row.snow) ? row.snow : null;
    if (snow != null) {
      totalSnow += snow;
    }
    if (snow != null && snow >= HEAVY_DAY_THRESHOLD) {
      heavyDayCount += 1;
    }
    if (snow != null && snow >= MAJOR_DAY_THRESHOLD) {
      majorDayCount += 1;
    }
    if (snow != null && (largestDaily.value == null || snow > largestDaily.value)) {
      largestDaily = { value: snow, date: day };
    }
    if (snow != null && snow >= MEASURABLE_THRESHOLD) {
      if (streakLength === 0) {
        streakStart = day;
      }
      streakLength += 1;
      streakTotal += snow;
      streakEnd = day;
    } else if (streakLength > 0) {
      finalizeStreak();
    }
  });
  finalizeStreak();

  let longest = { length: 0, start: null, end: null };
  if (firstIndex >= 0 && lastIndex >= firstIndex) {
    let streakStart = null;
    let streakEnd = null;
    let streakLength = 0;

    const finalize = () => {
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

    for (let i = firstIndex; i <= lastIndex; i += 1) {
      const row = daily[i];
      const snow = row?.snow;
      const day = parseISODate(row?.date);
      const hasNumber = typeof snow === 'number' && !Number.isNaN(snow);
      if (!hasNumber) {
        finalize();
        continue;
      }
      if (snow < MEASURABLE_THRESHOLD) {
        if (!streakStart) streakStart = day;
        streakEnd = day;
        streakLength += 1;
      } else {
        finalize();
      }
    }
    finalize();
  }

  const holidays = getHolidayListForSeason(startYear).map((holiday) => {
    let amount = null;
    let measurable = false;
    if (holiday.iso) {
      const row = daily.find((entry) => entry?.date === holiday.iso);
      if (row && typeof row.snow === 'number' && !Number.isNaN(row.snow)) {
        amount = row.snow;
        measurable = row.snow >= MEASURABLE_THRESHOLD;
      }
    }
    return {
      ...holiday,
      amount,
      measurable
    };
  });

  const holidayHits = holidays.reduce((acc, holiday) => acc + (holiday.measurable ? 1 : 0), 0);

  return {
    startYear,
    label,
    firstSnow,
    lastSnow,
    heavyDayCount,
    longestLull: longest,
    longestStreak,
    longestStreakTotal,
    longestStreakCount,
    largestDaily,
    totalSnow,
    majorDayCount,
    holidays,
    holidayHits,
    holidayTotal: holidays.length,
    allHolidaysSnowed: holidays.length > 0 && holidayHits === holidays.length,
    dataLastUpdated: determineLastDataDate(daily)
  };
}

function renderSummary(records) {
  if (!summaryEl) return;
  summaryEl.innerHTML = '';

  const byFirstSnow = records.filter((rec) => rec.firstSnow instanceof Date);
  const byLastSnow = records.filter((rec) => rec.lastSnow instanceof Date);

  const earliestFirst = byFirstSnow.reduce((best, current) => {
    if (!best) return current;
    return current.firstSnow < best.firstSnow ? current : best;
  }, null);

  const latestFirst = byFirstSnow.reduce((best, current) => {
    if (!best) return current;
    return current.firstSnow > best.firstSnow ? current : best;
  }, null);

  const earliestLast = byLastSnow.reduce((best, current) => {
    if (!best) return current;
    return current.lastSnow < best.lastSnow ? current : best;
  }, null);

  const latestLast = byLastSnow.reduce((best, current) => {
    if (!best) return current;
    return current.lastSnow > best.lastSnow ? current : best;
  }, null);

  const longestDrought = records.reduce((best, current) => {
    if (!best) return current;
    return (current.longestLull?.length ?? 0) > (best.longestLull?.length ?? 0) ? current : best;
  }, null);

  const longestStreakRecord = records.reduce((best, current) => {
    if (!best) return current;
    return (current.longestStreak?.length ?? 0) > (best.longestStreak?.length ?? 0) ? current : best;
  }, null);

  const largestDailyRecord = records.reduce((best, current) => {
    const currentVal = current.largestDaily?.value ?? null;
    if (currentVal == null) return best;
    if (!best) return current;
    const bestVal = best.largestDaily?.value ?? null;
    return bestVal == null || currentVal > bestVal ? current : best;
  }, null);

  const snowiestSeason = records.reduce((best, current) => {
    const currentTotal = current.totalSnow ?? 0;
    if (!best) return current;
    const bestTotal = best.totalSnow ?? 0;
    return currentTotal > bestTotal ? current : best;
  }, null);

  const mostHeavyDays = records.reduce((best, current) => {
    if (!best) return current;
    return current.heavyDayCount > best.heavyDayCount ? current : best;
  }, null);

  const mostMajorDays = records.reduce((best, current) => {
    if (!best) return current;
    return current.majorDayCount > best.majorDayCount ? current : best;
  }, null);

  const cleanSweepSeasons = records.filter((rec) => rec.allHolidaysSnowed);

  const cards = [];

  const timelineEvents = [];
  if (earliestFirst?.firstSnow) {
    timelineEvents.push({
      title: 'Earliest First Snow',
      date: earliestFirst.firstSnow,
      season: earliestFirst.label,
      type: 'earliest-first'
    });
  }
  if (latestFirst?.firstSnow) {
    timelineEvents.push({
      title: 'Latest First Snow',
      date: latestFirst.firstSnow,
      season: latestFirst.label,
      type: 'latest-first'
    });
  }
  if (earliestLast?.lastSnow) {
    timelineEvents.push({
      title: 'Earliest Last Snow',
      date: earliestLast.lastSnow,
      season: earliestLast.label,
      type: 'earliest-last'
    });
  }
  if (latestLast?.lastSnow) {
    timelineEvents.push({
      title: 'Latest Last Snow',
      date: latestLast.lastSnow,
      season: latestLast.label,
      type: 'latest-last'
    });
  }

  if (timelineEvents.length) {
    const sortedEvents = timelineEvents.slice().sort((a, b) => a.date - b.date);
    const timeline = document.createElement('div');
    timeline.className = 'record-timeline';
    const track = document.createElement('div');
    track.className = 'timeline-track';
    track.setAttribute('role', 'list');

    sortedEvents.forEach((event) => {
      const item = document.createElement('div');
      item.className = `timeline-event ${event.type ? `is-${event.type}` : ''}`.trim();
      item.setAttribute('role', 'listitem');
      item.setAttribute('aria-label', `${event.title}: ${formatDateLabel(event.date)} (${event.season})`);

      const dot = document.createElement('span');
      dot.className = 'timeline-dot';

      const textWrap = document.createElement('div');
      textWrap.className = 'timeline-event-text';

      const labelEl = document.createElement('span');
      labelEl.className = 'timeline-event-label';
      labelEl.textContent = event.title;

      const dateEl = document.createElement('span');
      dateEl.className = 'timeline-event-date';
      dateEl.textContent = formatDateLabel(event.date);

      const seasonEl = document.createElement('span');
      seasonEl.className = 'timeline-event-season';
      seasonEl.textContent = event.season;

      textWrap.appendChild(labelEl);
      textWrap.appendChild(dateEl);
      textWrap.appendChild(seasonEl);

      item.appendChild(dot);
      item.appendChild(textWrap);
      track.appendChild(item);
    });

    timeline.appendChild(track);
    summaryEl.appendChild(timeline);
  }

  if (longestDrought && (longestDrought.longestLull?.length ?? 0) > 0) {
    const lull = longestDrought.longestLull;
    const range = lull.start && lull.end
      ? `${formatDateLabel(lull.start)} → ${formatDateLabel(lull.end)}`
      : '';
    cards.push({
      title: 'Longest Snow Drought',
      value: `${lull.length} day${lull.length === 1 ? '' : 's'}`,
      detail: range ? `${longestDrought.label} · ${range}` : longestDrought.label
    });
  }

  if (longestStreakRecord && (longestStreakRecord.longestStreak?.length ?? 0) > 0) {
    const streak = longestStreakRecord.longestStreak;
    const range = streak.start && streak.end
      ? `${formatDateLabel(streak.start)} → ${formatDateLabel(streak.end)}`
      : '';
    cards.push({
      title: 'Longest Snow Streak',
      value: `${streak.length} day${streak.length === 1 ? '' : 's'}`,
      detail: range ? `${longestStreakRecord.label} · ${range}` : longestStreakRecord.label
    });
  }

  if (largestDailyRecord && largestDailyRecord.largestDaily?.value != null) {
    const largest = largestDailyRecord.largestDaily;
    const valueLabel = `${formatInches(largest.value)}"`;
    cards.push({
      title: 'Largest Daily Snowfall',
      value: valueLabel,
      detail: largest.date ? `${largestDailyRecord.label} · ${formatDateLabel(largest.date)}` : largestDailyRecord.label
    });
  }

  if (snowiestSeason) {
    cards.push({
      title: 'Snowiest Season',
      value: `${formatInches(snowiestSeason.totalSnow)}"`,
      detail: snowiestSeason.label
    });
  }

  if (mostHeavyDays) {
    cards.push({
      title: 'Most 2+" Days',
      value: `${mostHeavyDays.heavyDayCount}`,
      detail: mostHeavyDays.label
    });
  }

  if (mostMajorDays) {
    cards.push({
      title: 'Most 6+" Days',
      value: `${mostMajorDays.majorDayCount}`,
      detail: mostMajorDays.label
    });
  }

  if (cleanSweepSeasons.length) {
    cards.push({
      title: 'Holiday Clean Sweep',
      value: `${cleanSweepSeasons.length} season${cleanSweepSeasons.length === 1 ? '' : 's'}`,
      detail: cleanSweepSeasons.map((rec) => rec.label).join(' · ')
    });
  } else {
    cards.push({
      title: 'Holiday Clean Sweep',
      value: 'None yet',
      detail: 'Awaiting a season with measurable snow on every holiday.'
    });
  }

  cards.forEach((card) => {
    const item = document.createElement('div');
    item.className = 'record-summary-item';
    const labelDiv = document.createElement('div');
    labelDiv.className = 'record-label';
    labelDiv.textContent = card.title;
    const valueDiv = document.createElement('div');
    valueDiv.className = 'record-value';
    valueDiv.textContent = card.value;
    item.appendChild(labelDiv);
    item.appendChild(valueDiv);
    if (card.detail) {
      const detailDiv = document.createElement('div');
      detailDiv.className = 'record-detail';
      detailDiv.textContent = card.detail;
      item.appendChild(detailDiv);
    }
    summaryEl.appendChild(item);
  });
}

function renderTable(records) {
  if (!tableBodyEl) return;
  tableBodyEl.innerHTML = '';
  const sorted = [...records].sort((a, b) => b.startYear - a.startYear);

  sorted.forEach((rec) => {
    const row = document.createElement('tr');

    const longest = rec.longestLull?.length > 0
      ? `${rec.longestLull.length} day${rec.longestLull.length === 1 ? '' : 's'}${rec.longestLull.start && rec.longestLull.end ? ` (${formatDateLabel(rec.longestLull.start)} → ${formatDateLabel(rec.longestLull.end)})` : ''}`
      : '—';
    const streak = rec.longestStreak?.length > 0
      ? `${rec.longestStreak.length} day${rec.longestStreak.length === 1 ? '' : 's'}${rec.longestStreak.start && rec.longestStreak.end ? ` (${formatDateLabel(rec.longestStreak.start)} → ${formatDateLabel(rec.longestStreak.end)})` : ''}`
      : '—';
    const streakState = rec.longestStreak?.length > 0 && rec.longestStreakCount > 1
      ? `Tied (${rec.longestStreakCount} streaks)`
      : '—';
    const streakTotal = rec.longestStreak?.length > 0
      ? `${formatInches(rec.longestStreakTotal)}"`
      : '—';
    const largestDay = rec.largestDaily?.value != null
      ? `${formatInches(rec.largestDaily.value)}"${rec.largestDaily.date ? ` (${formatDateLabel(rec.largestDaily.date)})` : ''}`
      : '—';

    const holidayText = `${rec.holidayHits}/${rec.holidayTotal}` + (rec.allHolidaysSnowed ? ' ✓' : '');

    const cells = [
      rec.label,
      rec.firstSnow ? formatDateLabel(rec.firstSnow) : '—',
      rec.lastSnow ? formatDateLabel(rec.lastSnow) : '—',
      streak,
      streakState,
      streakTotal,
      longest,
      largestDay,
      `${formatInches(rec.totalSnow)}"`,
      rec.heavyDayCount ? String(rec.heavyDayCount) : '0',
      rec.majorDayCount ? String(rec.majorDayCount) : '0',
      holidayText
    ];

    cells.forEach((text) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
    });

    tableBodyEl.appendChild(row);
  });
}

function renderTotalsChart(records) {
  if (!totalsChartEl) return;
  totalsChartEl.innerHTML = '';
  const sorted = [...records].sort((a, b) => a.startYear - b.startYear);
  const maxTotal = sorted.reduce((max, rec) => {
    const total = rec.totalSnow ?? 0;
    return total > max ? total : max;
  }, 0);

  if (!maxTotal) {
    const empty = document.createElement('div');
    empty.className = 'record-chart-empty';
    empty.textContent = 'No snowfall totals available yet.';
    totalsChartEl.appendChild(empty);
    return;
  }

  sorted.forEach((rec) => {
    const total = rec.totalSnow ?? 0;
    const row = document.createElement('div');
    row.className = 'record-chart-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${rec.label}: ${formatInches(total)} inches`);

    const label = document.createElement('div');
    label.className = 'record-chart-bar-label';
    label.textContent = rec.label;

    const track = document.createElement('div');
    track.className = 'record-chart-bar-track';

    const fill = document.createElement('div');
    fill.className = 'record-chart-bar-fill';
    const percent = total > 0 ? Math.max((total / maxTotal) * 100, 6) : 0;
    fill.style.width = `${percent}%`;

    const value = document.createElement('div');
    value.className = 'record-chart-bar-value';
    value.textContent = `${formatInches(total)}"`;

    track.appendChild(fill);
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(value);
    totalsChartEl.appendChild(row);
  });
}

function renderTotalsDate() {
  if (!totalsDateEl) return;
  const today = new Date();
  const label = today.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  totalsDateEl.textContent = label;
}

async function fetchSeasonData(startYear) {
  const res = await fetch(`snowdata.php?startYear=${encodeURIComponent(startYear)}`);
  if (!res.ok) {
    throw new Error(`Failed to load season ${startYear}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error);
  }
  return json;
}

async function initRecords() {
  try {
    const fetchPromises = SEASON_START_YEARS.map((year) => fetchSeasonData(year)
      .then((json) => computeSeasonStats(json, year))
      .catch((err) => {
        console.error('Failed to compute stats for season', year, err);
        return null;
      }));

    const results = await Promise.all(fetchPromises);
    const records = results.filter(Boolean);

    if (!records.length) {
      if (loadingEl) {
        loadingEl.textContent = 'Unable to load season records right now.';
      }
      return;
    }

    if (loadingEl) {
      loadingEl.hidden = true;
    }
    if (summaryEl) {
      summaryEl.hidden = false;
    }

    renderSummary(records);
    renderTable(records);
    renderTotalsChart(records);
    renderTotalsDate();

    if (footerUpdatedEl) {
      const latestDate = records.reduce((best, rec) => {
        if (!rec.dataLastUpdated) return best;
        if (!best) return rec.dataLastUpdated;
        return rec.dataLastUpdated > best ? rec.dataLastUpdated : best;
      }, null);
      const label = latestDate ? formatDateLabel(latestDate) : null;
      footerUpdatedEl.textContent = label
        ? `Data updated ${label}`
        : `Aggregated from ${records.length} season${records.length === 1 ? '' : 's'}`;
    }
  } catch (err) {
    console.error('Failed to initialize records page', err);
    if (loadingEl) {
      loadingEl.textContent = 'Unable to load season records right now.';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRecords, { once: true });
} else {
  initRecords();
}
