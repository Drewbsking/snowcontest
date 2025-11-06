(() => {
  const MEASURABLE_THRESHOLD = 0.1;
  const chartCanvas = document.getElementById('rangeChart');
  const form = document.getElementById('range-form');
  const startInput = document.getElementById('range-start');
  const endInput = document.getElementById('range-end');
  const resetBtn = document.getElementById('range-reset');
  const messageEl = document.getElementById('range-message');
  const loadingOverlay = document.getElementById('range-loading');
  const emptyStateEl = document.getElementById('range-empty');
  const exportBtn = document.getElementById('range-export');
  const sourceEl = document.getElementById('range-source');
  const rangeResetZoomBtn = document.getElementById('range-reset-zoom');
  const datasetSelect = document.getElementById('datasetSelect');
  const aggSelect = document.getElementById('aggSelect');
  const activeRangeHint = document.getElementById('active-range-hint');
  // THREADEx elements
  const threadexCanvas = document.getElementById('threadexChart');
  const threadexLoading = document.getElementById('threadex-loading');
  const threadexSourceEl = document.getElementById('threadex-source');
  const threadexResetZoomBtn = document.getElementById('threadex-reset-zoom');
  const footerUpdatedEl = document.getElementById('data-updated');

  const totalValueEl = document.getElementById('range-total');
  const totalNoteEl = document.getElementById('range-total-note');
  const peakValueEl = document.getElementById('range-peak');
  const peakNoteEl = document.getElementById('range-peak-note');
  const daysLabelEl = document.getElementById('range-days-label');
  const peakLabelEl = document.getElementById('range-peak-label');

  let chartRef = null;
  let threadexChartRef = null;
  let csvUrl = null;
  let threadexCsvUrl = null;
  let currentToken = 0;

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

  function formatYearMonthISO(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function formatInches(value) {
    if (value == null || Number.isNaN(value)) return '--';
    const rounded = Math.round(value * 10) / 10;
    const str = rounded.toFixed(1);
    return str.endsWith('.0') ? str.slice(0, -2) : str;
  }

  function normalizeSnowValue(raw) {
    let value = raw;
    if (Array.isArray(value)) {
      [value] = value;
    }
    if (value === null || value === undefined || value === '' || value === 'M') {
      return null;
    }
    if (value === 'T') {
      return 0;
    }
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function fetchThreadExDaily(startISO, endISO) {
    const payload = {
      sid: 'DTWthr 9',
      sdate: startISO,
      edate: endISO,
      meta: ['name', 'state', 'sids'],
      elems: [{ name: 'snow', units: 'inch', maxmissing: 10, prec: 3 }],
      output: 'json'
    };

    const res = await fetch('https://data.rcc-acis.org/StnData', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error('Failed to load Detroit Area THREADEx daily data.');
    }

    const json = await res.json();
    const rows = [];
    (json?.data || []).forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return;
      const [date, raw] = entry;
      if (!date) return;
      rows.push({ date, snow: normalizeSnowValue(raw) });
    });

    return {
      rows,
      stationName: json?.meta?.name || 'Detroit Area (THREADEx)'
    };
  }

  // White Lake 4E via local seasonal PHP endpoint
  const seasonCache = new Map();
  function determineSeasonStartYearForDate(dateStr) {
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    return month >= 7 ? year : year - 1;
  }
  async function fetchSeason(startYear) {
    if (!Number.isFinite(startYear)) return null;
    if (seasonCache.has(startYear)) {
      return seasonCache.get(startYear);
    }
    const promise = fetch(`snowdata.php?startYear=${encodeURIComponent(startYear)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load snowfall data for ${startYear}`);
        return res.json();
      })
      .then((json) => {
        if (json.error) throw new Error(json.error);
        return json;
      });
    seasonCache.set(startYear, promise);
    return promise;
  }

  // Aggregators
  function aggregateMonthlyFromDaily(dailyRows, startISO, endISO) {
    const filtered = dailyRows
      .filter((r) => r && r.date && r.date >= startISO && r.date <= endISO)
      .sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const map = new Map(); // ym -> sum
    filtered.forEach((r) => {
      const ym = r.date.slice(0,7);
      const prev = map.get(ym) || 0;
      const val = typeof r.snow === 'number' ? r.snow : 0;
      map.set(ym, prev + (Number.isFinite(val) ? val : 0));
    });
    const labels = Array.from(map.keys()).sort();
    const monthlyValues = labels.map((k) => map.get(k));
    const cumulativeValues = [];
    let cum = 0;
    monthlyValues.forEach((v) => { cum += v || 0; cumulativeValues.push(cum); });
    return { labels, monthlyValues, cumulativeValues };
  }

  function aggregateSeasonFromDaily(dailyRows, startISO, endISO) {
    const filtered = dailyRows
      .filter((r) => r && r.date && r.date >= startISO && r.date <= endISO)
      .sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const map = new Map(); // seasonStartYear -> sum
    filtered.forEach((r) => {
      const seasonY = determineSeasonStartYearForDate(r.date);
      const prev = map.get(seasonY) || 0;
      const val = typeof r.snow === 'number' ? r.snow : 0;
      map.set(seasonY, prev + (Number.isFinite(val) ? val : 0));
    });
    const years = Array.from(map.keys()).sort((a,b) => a-b);
    const labels = years.map((y) => `${y}-${y+1}`);
    const values = years.map((y) => map.get(y));
    const cumulativeValues = [];
    let cum = 0;
    values.forEach((v) => { cum += v || 0; cumulativeValues.push(cum); });
    return { labels, values, cumulativeValues };
  }

  function aggregateSeasonFromMonthly(mly) {
    const map = new Map(); // seasonStartYear -> sum
    mly.labels.forEach((ym, idx) => {
      const [y, m] = ym.split('-').map((p) => parseInt(p, 10));
      const seasonY = (m >= 7) ? y : (y - 1);
      const prev = map.get(seasonY) || 0;
      const val = mly.monthlyValues[idx];
      map.set(seasonY, prev + (Number.isFinite(val) ? val : 0));
    });
    const years = Array.from(map.keys()).sort((a,b) => a-b);
    const labels = years.map((y) => `${y}-${y+1}`);
    const values = years.map((y) => map.get(y));
    const cumulativeValues = [];
    let cum = 0;
    values.forEach((v) => { cum += v || 0; cumulativeValues.push(cum); });
    return { labels, values, cumulativeValues };
  }


  function showMessage(text, type = 'info') {
    if (!messageEl) return;
    messageEl.textContent = text || '';
    messageEl.dataset.type = type;
  }

  function setLoading(isLoading) {
    if (loadingOverlay) {
      loadingOverlay.hidden = !isLoading;
      loadingOverlay.style.display = isLoading ? 'flex' : 'none';
    }
    if (isLoading && emptyStateEl) {
      emptyStateEl.style.display = 'none';
    }
    if (exportBtn) {
      exportBtn.disabled = true;
    }
    const threadexExportBtn = document.getElementById('threadex-export');
    if (threadexExportBtn) threadexExportBtn.disabled = true;
    if (isLoading && rangeResetZoomBtn) {
      rangeResetZoomBtn.disabled = true;
    }
    if (isLoading && threadexResetZoomBtn) {
      threadexResetZoomBtn.disabled = true;
    }
  }

  function resetSummary() {
    if (totalValueEl) totalValueEl.textContent = '--';
    if (totalNoteEl) totalNoteEl.textContent = 'Awaiting selection';
    if (peakValueEl) peakValueEl.textContent = '--';
    if (peakNoteEl) peakNoteEl.textContent = 'No data yet';
  }

  function resetChart() {
    if (chartRef) {
      chartRef.destroy();
      chartRef = null;
    }
    if (threadexChartRef) {
      threadexChartRef.destroy();
      threadexChartRef = null;
    }
    if (rangeResetZoomBtn) {
      rangeResetZoomBtn.disabled = true;
      rangeResetZoomBtn.onclick = null;
    }
    if (threadexResetZoomBtn) {
      threadexResetZoomBtn.disabled = true;
      threadexResetZoomBtn.onclick = null;
    }
    if (emptyStateEl) {
      emptyStateEl.textContent = 'Select a date range to begin.';
      emptyStateEl.style.display = 'flex';
    }
    if (sourceEl) {
      sourceEl.textContent = 'Awaiting selection';
    }
    if (threadexSourceEl) {
      threadexSourceEl.textContent = 'Awaiting selection';
    }
    if (threadexLoading) {
      threadexLoading.hidden = true;
    }
    if (csvUrl) {
      URL.revokeObjectURL(csvUrl);
      csvUrl = null;
    }
    if (threadexCsvUrl) {
      URL.revokeObjectURL(threadexCsvUrl);
      threadexCsvUrl = null;
    }
    if (exportBtn) {
      exportBtn.disabled = true;
    }
    const threadexExportBtn = document.getElementById('threadex-export');
    if (threadexExportBtn) threadexExportBtn.disabled = true;
  }

  function computeRangeData(dailyRows, startISO, endISO) {
    const filtered = dailyRows
      .filter((row) => row && row.date && row.date >= startISO && row.date <= endISO)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let cumulative = 0;
    const labels = [];
    const dailyValues = [];
    const cumulativeValues = [];
    let totalSnow = 0;
    let peakValue = null;
    let peakDate = null;

    filtered.forEach((row) => {
      labels.push(row.date);
      const snow = typeof row.snow === 'number' && !Number.isNaN(row.snow) ? row.snow : null;
      dailyValues.push(snow);
      if (snow != null) {
        cumulative += snow;
        totalSnow += snow;
        if (peakValue == null || snow > peakValue) {
          peakValue = snow;
          peakDate = row.date;
        }
      }
      cumulativeValues.push(cumulative);
    });

    return {
      labels,
      dailyValues,
      cumulativeValues,
      totalSnow,
      peakValue,
      peakDate,
      filtered
    };
  }

  function drawChart(labels, dailyValues, cumulativeValues) {
    if (!chartCanvas) return;
    if (chartRef) {
      chartRef.destroy();
    }

    const barColors = dailyValues.map((value) => {
      if (typeof value === 'number' && !Number.isNaN(value)) {
        return value >= MEASURABLE_THRESHOLD
          ? 'rgba(56,189,248,0.8)'
          : 'rgba(148,163,184,0.5)';
      }
      return 'rgba(148,163,184,0.18)';
    });

    chartRef = new Chart(chartCanvas.getContext('2d'), {
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Daily Snowfall (in)',
            data: dailyValues,
            yAxisID: 'yDaily',
            backgroundColor: barColors,
            borderRadius: 3,
            borderSkipped: false
          },
          {
            type: 'line',
            label: 'Cumulative (in)',
            data: cumulativeValues,
            yAxisID: 'yCum',
            borderColor: 'rgba(249,115,22,0.9)',
            backgroundColor: 'rgba(249,115,22,0.12)',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.25,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          zoom: {
            limits: {
              y: { min: 0 }
            },
            pan: {
              enabled: true,
              mode: 'x',
              modifierKey: 'shift'
            },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              drag: { enabled: false },
              mode: 'x'
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: 'rgba(148,163,184,1)'
            },
            grid: {
              color: 'rgba(51,65,85,0.4)'
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
              color: 'rgba(51,65,85,0.35)'
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
    if (rangeResetZoomBtn) {
      rangeResetZoomBtn.disabled = false;
      rangeResetZoomBtn.onclick = () => {
        if (chartRef && typeof chartRef.resetZoom === 'function') {
          chartRef.resetZoom();
        }
      };
    }
  }

  function drawThreadExChart(labels, monthlyValues, cumulativeValues, leftAxisTitle = 'Monthly (in)') {
    if (!threadexCanvas) return;
    if (threadexChartRef) {
      threadexChartRef.destroy();
    }

    const barColors = monthlyValues.map((value) => {
      if (typeof value === 'number' && !Number.isNaN(value)) {
        return 'rgba(34,197,94,0.8)';
      }
      return 'rgba(148,163,184,0.18)';
    });

    threadexChartRef = new Chart(threadexCanvas.getContext('2d'), {
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Monthly Snowfall (in)',
            data: monthlyValues,
            yAxisID: 'yMonthly',
            backgroundColor: barColors,
            borderRadius: 3,
            borderSkipped: false
          },
          {
            type: 'line',
            label: 'Cumulative (in)',
            data: cumulativeValues,
            yAxisID: 'yCum',
            borderColor: 'rgba(56,189,248,1)',
            backgroundColor: 'rgba(56,189,248,0.18)',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.25,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          zoom: {
            limits: {
              y: { min: 0 }
            },
            pan: {
              enabled: true,
              mode: 'x',
              modifierKey: 'shift'
            },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              drag: { enabled: false },
              mode: 'x'
            }
          }
        },
        scales: {
          x: {
            ticks: { color: 'rgba(148,163,184,1)' },
            grid: { color: 'rgba(51,65,85,0.4)' }
          },
          yMonthly: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: leftAxisTitle },
            ticks: { color: 'rgba(226,232,240,1)' },
            grid: { color: 'rgba(51,65,85,0.35)' }
          },
          yCum: {
            type: 'linear',
            position: 'right',
            title: { display: true, text: 'Cumulative (in)' },
            ticks: { color: 'rgba(226,232,240,1)' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
    if (threadexResetZoomBtn) {
      threadexResetZoomBtn.disabled = false;
      threadexResetZoomBtn.onclick = () => {
        if (threadexChartRef && typeof threadexChartRef.resetZoom === 'function') {
          threadexChartRef.resetZoom();
        }
      };
    }
  }

  async function fetchThreadExMonthly(startISO, endISO) {
    // Convert to year-month bounds covering the inclusive range
    const startDate = new Date(`${startISO}T00:00:00`);
    const endDate = new Date(`${endISO}T00:00:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return { labels: [], monthlyValues: [], cumulativeValues: [] };
    const startYm = formatYearMonthISO(new Date(startDate.getFullYear(), startDate.getMonth(), 1));
    const endYm = formatYearMonthISO(new Date(endDate.getFullYear(), endDate.getMonth(), 1));

    const payload = {
      sid: 'DTWthr 9',
      sdate: startYm,
      edate: endYm,
      meta: ['name','state','sids'],
      elems: [{ name: 'snow', interval: 'mly', reduce: 'sum', units: 'inch', maxmissing: 3, prec: 3 }],
      output: 'json'
    };

    const res = await fetch('https://data.rcc-acis.org/StnData', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to load Detroit Area THREADEx data.');
    const json = await res.json();

    const labels = [];
    const monthlyValues = [];
    const cumulativeValues = [];
    let cum = 0;

    const withinRange = (y, mIdx) => {
      const d = new Date(y, mIdx, 1);
      return d >= new Date(`${startYm}-01T00:00:00`) && d <= new Date(`${endYm}-01T00:00:00`);
    };

    (json?.data || []).forEach(([year, months]) => {
      const y = parseInt(year, 10);
      if (!Array.isArray(months)) return;
      for (let i = 0; i < 12; i += 1) {
        if (!withinRange(y, i)) continue;
        const raw = months[i];
        let val = null;
        if (raw === 'M') {
          val = null; // monthly sum not computed due to missing data
        } else if (raw === 'T') {
          val = 0.0; // trace counts as 0
        } else if (raw != null && raw !== '') {
          const parsed = parseFloat(raw);
          val = Number.isFinite(parsed) ? parsed : null;
        }
        const label = `${y}-${String(i + 1).padStart(2, '0')}`;
        labels.push(label);
        monthlyValues.push(val);
        if (val != null) cum += val;
        cumulativeValues.push(cum);
      }
    });

    return { labels, monthlyValues, cumulativeValues };
  }

  function updateSummary(rangeData, startISO, endISO) {
    if (!rangeData) {
      resetSummary();
      return;
    }
    if (totalValueEl) {
      totalValueEl.textContent = `${formatInches(rangeData.totalSnow)}"`;
    }
    if (totalNoteEl) {
      totalNoteEl.textContent = `${formatDateLabel(startISO)} → ${formatDateLabel(endISO)} (${rangeData.labels.length} day${rangeData.labels.length === 1 ? '' : 's'})`;
    }
    if (peakValueEl) {
      peakValueEl.textContent = rangeData.peakValue != null ? `${formatInches(rangeData.peakValue)}"` : '--';
    }
    if (peakNoteEl) {
      peakNoteEl.textContent = rangeData.peakDate ? `On ${formatDateLabel(rangeData.peakDate)}` : 'No data for range';
    }
  }

  function updateSourceText(startISO, endISO, stationName) {
    if (!sourceEl) return;
    const startLabel = formatDateLabel(startISO);
    const endLabel = formatDateLabel(endISO);
    const resolvedName = stationName || 'Detroit Area (THREADEx)';
    sourceEl.textContent = `Source: NOAA ACIS – ${resolvedName} · ${startLabel} → ${endLabel}`;
    if (footerUpdatedEl) {
      footerUpdatedEl.textContent = `Range: ${startLabel} → ${endLabel}`;
    }
  }

  function updateActiveHintUI() {
    if (!activeRangeHint || !aggSelect || !datasetSelect) return;
    const aggMap = { daily: 'Daily', monthly: 'Monthly', yearly: 'Yearly' };
    const dsMap = { threadex: 'Detroit Area THREADEx', wl: 'White Lake 4E (Daily)' };
    activeRangeHint.textContent = `Showing ${dsMap[datasetSelect.value] || ''} · ${aggMap[aggSelect.value] || ''}`;
  }

  function updateSummaryForAggregate(kind, labels, values, startISO, endISO) {
    const total = values.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
    const idx = values.reduce((bestIdx, v, i, arr) => (arr[bestIdx] == null || (v != null && v > arr[bestIdx]) ? i : bestIdx), 0);
    const peakVal = values[idx] ?? null;
    const peakLabel = labels[idx] ?? null;
    if (totalValueEl) totalValueEl.textContent = `${formatInches(total)}"`;
    if (totalNoteEl) totalNoteEl.textContent = `${formatDateLabel(startISO)} → ${formatDateLabel(endISO)} (${labels.length} ${kind})`;
    if (daysLabelEl) {
      daysLabelEl.textContent = kind === 'day' ? 'Measured Days' : (kind === 'month' ? 'Months' : 'Seasons');
    }
    const plural = kind === 'day' ? 'days' : kind === 'month' ? 'months' : 'seasons';
    if (document.getElementById('range-days')) document.getElementById('range-days').textContent = `${labels.length}`;
    if (document.getElementById('range-days-note')) document.getElementById('range-days-note').textContent = `${labels.length} ${plural} in range`;
    if (peakLabelEl) peakLabelEl.textContent = kind === 'day' ? 'Daily Peak' : (kind === 'month' ? 'Peak Month' : 'Peak Season');
    if (peakValueEl) peakValueEl.textContent = peakVal != null ? `${formatInches(peakVal)}"` : '--';
    if (peakNoteEl) {
      let pretty = '';
      if (kind === 'month' && peakLabel) {
        const [y, m] = String(peakLabel).split('-');
        const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
        pretty = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      } else if (kind === 'season' && peakLabel) {
        pretty = peakLabel;
      } else if (kind === 'day' && peakLabel) {
        pretty = formatDateLabel(peakLabel);
      }
      peakNoteEl.textContent = peakLabel ? `On ${pretty}` : `No data for range`;
    }
  }

  function updateCardsVisibility() {
    const agg = aggSelect ? aggSelect.value : 'daily';
    const dailyCard = document.getElementById('range-chart-card');
    const aggCard = document.getElementById('threadex-chart-card');
    if (agg === 'daily') {
      if (dailyCard) dailyCard.style.display = '';
      if (aggCard) aggCard.style.display = 'none';
    } else {
      if (dailyCard) dailyCard.style.display = 'none';
      if (aggCard) aggCard.style.display = '';
    }
  }

  function updateExport(rangeData) {
    if (!exportBtn) return;
    if (csvUrl) {
      URL.revokeObjectURL(csvUrl);
      csvUrl = null;
    }
    if (!rangeData || !rangeData.labels.length) {
      exportBtn.disabled = true;
      return;
    }
    const header = ['date', 'daily_snow_in', 'cumulative_snow_in'];
    const cumulative = rangeData.cumulativeValues;
    const rows = rangeData.labels.map((label, idx) => {
      const daily = rangeData.dailyValues[idx];
      const cum = cumulative[idx];
      return [label, daily == null ? '' : daily.toFixed(2), cum.toFixed(2)];
    });
    const lines = [header, ...rows]
      .map((columns) => columns.map((value) => {
        const safe = value == null ? '' : String(value);
        const escaped = safe.replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(','))
      .join('\r\n');
    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    csvUrl = URL.createObjectURL(blob);
    exportBtn.disabled = false;
    exportBtn.onclick = () => {
      const link = document.createElement('a');
      link.href = csvUrl;
      link.download = `snow_range_${rangeData.labels[0]}_${rangeData.labels[rangeData.labels.length - 1]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }

  function updateSecondaryExport(m, filenamePrefix = 'monthly', labelHeader = 'year_month') {
    const btn = document.getElementById('threadex-export');
    if (!btn) return;
    if (threadexCsvUrl) {
      URL.revokeObjectURL(threadexCsvUrl);
      threadexCsvUrl = null;
    }
    if (!m || !m.labels || !m.labels.length) {
      btn.disabled = true;
      return;
    }
    const header = [labelHeader, 'snow_in', 'cumulative_snow_in'];
    const rows = m.labels.map((label, idx) => {
      const val = (m.monthlyValues ? m.monthlyValues[idx] : m.values[idx]);
      const cum = m.cumulativeValues[idx];
      return [label, val == null ? '' : val.toFixed(2), cum.toFixed(2)];
    });
    const lines = [header, ...rows]
      .map((columns) => columns.map((value) => {
        const safe = value == null ? '' : String(value);
        const escaped = safe.replace(/\"/g, '""');
        return `"${escaped}"`;
      }).join(','))
      .join('\r\n');
    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    threadexCsvUrl = URL.createObjectURL(blob);
    btn.disabled = false;
    btn.onclick = () => {
      const link = document.createElement('a');
      link.href = threadexCsvUrl;
      const start = m.labels[0];
      const end = m.labels[m.labels.length - 1];
      link.download = `${filenamePrefix}_${start}_${end}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const startISO = startInput?.value;
    const endISO = endInput?.value;

    if (!startISO || !endISO) {
      showMessage('Please choose both a start and end date.', 'error');
      return;
    }
    // No lower bound validation; allow any user-selected dates
    if (startISO > endISO) {
      showMessage('Start date must be on or before the end date.', 'error');
      return;
    }

    showMessage('');
    setLoading(true);
    const token = ++currentToken;

    try {
      const dataset = datasetSelect ? datasetSelect.value : 'threadex';
      const agg = aggSelect ? aggSelect.value : 'daily';
      updateActiveHintUI();
      updateCardsVisibility();

      if (agg === 'daily') {
        if (dataset === 'threadex') {
          const { rows: dailyRows, stationName } = await fetchThreadExDaily(startISO, endISO);
          if (token !== currentToken) return;
          const rangeData = computeRangeData(dailyRows, startISO, endISO);
          if (!rangeData.labels.length) {
            resetChart(); resetSummary();
            if (emptyStateEl) { emptyStateEl.textContent = 'No snowfall data exists for the selected window.'; emptyStateEl.style.display = 'flex'; }
            showMessage('No snowfall data exists for the selected window.', 'info');
            return;
          }
          if (emptyStateEl) emptyStateEl.style.display = 'none';
          drawChart(rangeData.labels, rangeData.dailyValues, rangeData.cumulativeValues);
          updateSummary(rangeData, startISO, endISO);
          updateSourceText(startISO, endISO, stationName);
          updateExport(rangeData);
          showMessage(`Loaded ${rangeData.labels.length} day${rangeData.labels.length === 1 ? '' : 's'} of data.`, 'success');
        } else {
          const startYear = determineSeasonStartYearForDate(startISO);
          const endYear = determineSeasonStartYearForDate(endISO);
          const years = []; for (let y = startYear; y <= endYear; y += 1) years.push(y);
          const seasonData = await Promise.all(years.map(fetchSeason));
          if (token !== currentToken) return;
          const dailyRows = seasonData.filter(Boolean).flatMap((s) => Array.isArray(s?.daily) ? s.daily : []);
          const rangeData = computeRangeData(dailyRows, startISO, endISO);
          if (!rangeData.labels.length) {
            resetChart(); resetSummary();
            if (emptyStateEl) { emptyStateEl.textContent = 'No snowfall data exists for the selected window.'; emptyStateEl.style.display = 'flex'; }
            showMessage('No snowfall data exists for the selected window.', 'info');
            return;
          }
          if (emptyStateEl) emptyStateEl.style.display = 'none';
          drawChart(rangeData.labels, rangeData.dailyValues, rangeData.cumulativeValues);
          updateSummary(rangeData, startISO, endISO);
          updateSourceText(startISO, endISO, 'White Lake 4E (Daily)');
          updateExport(rangeData);
          showMessage(`Loaded ${rangeData.labels.length} day${rangeData.labels.length === 1 ? '' : 's'} of data.`, 'success');
        }
      } else {
        if (threadexLoading) threadexLoading.hidden = false;
        if (dataset === 'threadex') {
          const m = await fetchThreadExMonthly(startISO, endISO);
          if (token !== currentToken) return;
          if (agg === 'monthly') {
            drawThreadExChart(m.labels, m.monthlyValues, m.cumulativeValues, 'Monthly (in)');
            updateSecondaryExport(m, 'monthly', 'year_month');
            updateSummaryForAggregate('month', m.labels, m.monthlyValues, startISO, endISO);
            if (threadexSourceEl) threadexSourceEl.textContent = `Source: NOAA ACIS – Detroit Area (THREADEx v9) · Months ${m.labels.length ? `${m.labels[0]} → ${m.labels[m.labels.length - 1]}` : '—'}`;
          } else {
            const yr = aggregateSeasonFromMonthly(m);
            drawThreadExChart(yr.labels, yr.values, yr.cumulativeValues, 'Seasonal (in)');
            updateSecondaryExport({ labels: yr.labels, values: yr.values, cumulativeValues: yr.cumulativeValues }, 'seasonal', 'season');
            updateSummaryForAggregate('season', yr.labels, yr.values, startISO, endISO);
            if (threadexSourceEl) threadexSourceEl.textContent = `Source: NOAA ACIS – Detroit Area (THREADEx v9) · Seasons ${yr.labels.length ? `${yr.labels[0]} → ${yr.labels[yr.labels.length - 1]}` : '—'}`;
          }
        } else {
          const startYear = determineSeasonStartYearForDate(startISO);
          const endYear = determineSeasonStartYearForDate(endISO);
          const years = []; for (let y = startYear; y <= endYear; y += 1) years.push(y);
          const seasonData = await Promise.all(years.map(fetchSeason));
          if (token !== currentToken) return;
          const dailyRows = seasonData.filter(Boolean).flatMap((s) => Array.isArray(s?.daily) ? s.daily : []);
          if (agg === 'monthly') {
            const mm = aggregateMonthlyFromDaily(dailyRows, startISO, endISO);
            drawThreadExChart(mm.labels, mm.monthlyValues, mm.cumulativeValues, 'Monthly (in)');
            updateSecondaryExport(mm, 'monthly', 'year_month');
            updateSummaryForAggregate('month', mm.labels, mm.monthlyValues, startISO, endISO);
            if (threadexSourceEl) threadexSourceEl.textContent = `Source: NOAA ACIS – White Lake 4E (Daily) · Months ${mm.labels.length ? `${mm.labels[0]} → ${mm.labels[mm.labels.length - 1]}` : '—'}`;
          } else {
            const yy = aggregateSeasonFromDaily(dailyRows, startISO, endISO);
            drawThreadExChart(yy.labels, yy.values, yy.cumulativeValues, 'Seasonal (in)');
            updateSecondaryExport({ labels: yy.labels, values: yy.values, cumulativeValues: yy.cumulativeValues }, 'seasonal', 'season');
            updateSummaryForAggregate('season', yy.labels, yy.values, startISO, endISO);
            if (threadexSourceEl) threadexSourceEl.textContent = `Source: NOAA ACIS – White Lake 4E (Daily) · Seasons ${yy.labels.length ? `${yy.labels[0]} → ${yy.labels[yy.labels.length - 1]}` : '—'}`;
          }
        }
        if (threadexLoading) threadexLoading.hidden = true;
      }
    } catch (err) {
      console.error('Failed to load custom range', err);
      resetChart();
      resetSummary();
      showMessage(err.message || 'Unable to load data for that range.', 'error');
    } finally {
      if (token === currentToken) {
        setLoading(false);
      }
    }
  }

  function handleReset() {
    startInput.value = '';
    endInput.value = '';
    showMessage('');
    resetSummary();
    resetChart();
  }

  if (form) {
    form.addEventListener('submit', handleSubmit);
  }
  if (datasetSelect) {
    datasetSelect.addEventListener('change', () => {
      updateActiveHintUI();
      updateCardsVisibility();
    });
  }
  if (aggSelect) {
    aggSelect.addEventListener('change', () => {
      updateActiveHintUI();
      updateCardsVisibility();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', handleReset);
  }
  // set initial UI state
  updateActiveHintUI();
  updateCardsVisibility();
})();
