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
  const stationSelect = document.getElementById('stationSelect');
  const stationHint = document.getElementById('active-station-hint');
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

  let chartRef = null;
  let threadexChartRef = null;
  let csvUrl = null;
  let threadexCsvUrl = null;
  let currentToken = 0;
  const seasonCache = new Map();
  let lastDailyRangeData = null;
  let lastThreadexData = null;

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

  function formatISODate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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

  function determineSeasonStartYearForDate(dateStr) {
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    return month >= 7 ? year : year - 1;
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
    lastDailyRangeData = null;
    lastThreadexData = null;
  }

  async function fetchSeason(startYear) {
    if (!Number.isFinite(startYear)) return null;
    if (seasonCache.has(startYear)) {
      return seasonCache.get(startYear);
    }
    const promise = fetch(`snowdata.php?startYear=${encodeURIComponent(startYear)}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load snowfall data for ${startYear}`);
        }
        return res.json();
      })
      .then((json) => {
        if (json.error) {
          throw new Error(json.error);
        }
        return json;
      });
    seasonCache.set(startYear, promise);
    return promise;
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

  function drawThreadExChart(labels, monthlyValues, cumulativeValues) {
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
            title: { display: true, text: 'Monthly (in)' },
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

  function updateSourceText(startISO, endISO, seasons) {
    if (!sourceEl) return;
    const uniqueSeasons = Array.from(new Set(seasons)).sort((a, b) => a - b);
    sourceEl.textContent = `Data: NOAA ACIS – Official Measurement Site · Seasons ${uniqueSeasons.map((y) => `${y}-${y + 1}`).join(', ')}`;
    if (footerUpdatedEl) {
      footerUpdatedEl.textContent = `Range: ${formatDateLabel(startISO)} → ${formatDateLabel(endISO)}`;
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

  function updateThreadexExport(m) {
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
    const header = ['year_month', 'monthly_snow_in', 'cumulative_snow_in'];
    const rows = m.labels.map((label, idx) => {
      const monthly = m.monthlyValues[idx];
      const cum = m.cumulativeValues[idx];
      return [label, monthly == null ? '' : monthly.toFixed(2), cum.toFixed(2)];
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
      link.download = `detroit_threadex_${m.labels[0]}_${m.labels[m.labels.length - 1]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }

  function updateStationView() {
    const choice = stationSelect ? stationSelect.value : 'wl';
    const dailyCard = document.getElementById('range-chart-card');
    const mlyCard = document.getElementById('threadex-chart-card');
    if (choice === 'threadex') {
      if (dailyCard) dailyCard.style.display = 'none';
      if (mlyCard) mlyCard.style.display = '';
      if (stationHint) stationHint.textContent = 'Showing Detroit Area THREADEx (Monthly)';
    } else {
      if (dailyCard) dailyCard.style.display = '';
      if (mlyCard) mlyCard.style.display = 'none';
      if (stationHint) stationHint.textContent = 'Showing Official Measurement Site (Daily)';
    }
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
      const startYear = determineSeasonStartYearForDate(startISO);
      const endYear = determineSeasonStartYearForDate(endISO);
      if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) {
        throw new Error('Unable to determine seasons for the selected dates.');
      }

      const seasons = [];
      for (let year = startYear; year <= endYear; year += 1) {
        seasons.push(year);
      }

      const seasonData = await Promise.all(seasons.map(fetchSeason));
      if (token !== currentToken) {
        return;
      }

      const dailyRows = seasonData
        .filter(Boolean)
        .flatMap((season) => Array.isArray(season?.daily) ? season.daily : []);

      const rangeData = computeRangeData(dailyRows, startISO, endISO);

      if (!rangeData.labels.length) {
        resetChart();
        resetSummary();
        if (emptyStateEl) {
          emptyStateEl.textContent = 'No snowfall data exists for the selected window.';
          emptyStateEl.style.display = 'flex';
        }
        showMessage('No snowfall data exists for the selected window.', 'info');
        return;
      }

      if (emptyStateEl) {
        emptyStateEl.style.display = 'none';
      }

      drawChart(rangeData.labels, rangeData.dailyValues, rangeData.cumulativeValues);
      updateSummary(rangeData, startISO, endISO);
      updateSourceText(startISO, endISO, seasons);
      lastDailyRangeData = rangeData;
      updateExport(rangeData);
      showMessage(`Loaded ${rangeData.labels.length} day${rangeData.labels.length === 1 ? '' : 's'} of data.`, 'success');

      // Detroit Area (THREADEx) monthly overlay
      if (threadexLoading) threadexLoading.hidden = false;
      try {
        const m = await fetchThreadExMonthly(startISO, endISO);
        lastThreadexData = m;
        drawThreadExChart(m.labels, m.monthlyValues, m.cumulativeValues);
        if (threadexSourceEl) {
          threadexSourceEl.textContent = `Source: NOAA ACIS – Detroit Area (THREADEx v9) · Months ${m.labels.length ? `${m.labels[0]} → ${m.labels[m.labels.length - 1]}` : '—'}`;
        }
        updateThreadexExport(m);
      } catch (e) {
        console.error('THREADEx load failed', e);
        if (threadexSourceEl) threadexSourceEl.textContent = 'Detroit Area (THREADEx) unavailable for this range.';
      } finally {
        if (threadexLoading) threadexLoading.hidden = true;
      }
      // ensure selected station visibility
      updateStationView();
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
  if (stationSelect) {
    stationSelect.addEventListener('change', updateStationView);
    // init view on load
    updateStationView();
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', handleReset);
  }
})();
