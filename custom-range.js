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
  const footerUpdatedEl = document.getElementById('data-updated');

  const totalValueEl = document.getElementById('range-total');
  const totalNoteEl = document.getElementById('range-total-note');
  const daysValueEl = document.getElementById('range-days');
  const daysNoteEl = document.getElementById('range-days-note');
  const peakValueEl = document.getElementById('range-peak');
  const peakNoteEl = document.getElementById('range-peak-note');

  let chartRef = null;
  let csvUrl = null;
  let currentToken = 0;
  const seasonCache = new Map();

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
    }
    if (isLoading && emptyStateEl) {
      emptyStateEl.style.display = 'none';
    }
    if (exportBtn) {
      exportBtn.disabled = true;
    }
  }

  function resetSummary() {
    if (totalValueEl) totalValueEl.textContent = '--';
    if (totalNoteEl) totalNoteEl.textContent = 'Awaiting selection';
    if (daysValueEl) daysValueEl.textContent = '--';
    if (daysNoteEl) daysNoteEl.textContent = '≥0.1" days in range';
    if (peakValueEl) peakValueEl.textContent = '--';
    if (peakNoteEl) peakNoteEl.textContent = 'No data yet';
  }

  function resetChart() {
    if (chartRef) {
      chartRef.destroy();
      chartRef = null;
    }
    if (emptyStateEl) {
      emptyStateEl.textContent = 'Select a date range to begin.';
      emptyStateEl.style.display = 'flex';
    }
    if (sourceEl) {
      sourceEl.textContent = 'Awaiting selection';
    }
    if (csvUrl) {
      URL.revokeObjectURL(csvUrl);
      csvUrl = null;
    }
    if (exportBtn) {
      exportBtn.disabled = true;
    }
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
    let measurableDays = 0;
    let peakValue = null;
    let peakDate = null;

    filtered.forEach((row) => {
      labels.push(row.date);
      const snow = typeof row.snow === 'number' && !Number.isNaN(row.snow) ? row.snow : null;
      dailyValues.push(snow);
      if (snow != null) {
        cumulative += snow;
        if (snow >= MEASURABLE_THRESHOLD) {
          measurableDays += 1;
        }
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
      measurableDays,
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
    if (daysValueEl) {
      daysValueEl.textContent = String(rangeData.measurableDays);
    }
    if (daysNoteEl) {
      const share = rangeData.labels.length
        ? `${((rangeData.measurableDays / rangeData.labels.length) * 100).toFixed(0)}% of days`
        : '≥0.1" days in range';
      daysNoteEl.textContent = share;
    }
    if (peakValueEl) {
      peakValueEl.textContent = rangeData.peakValue != null ? `${formatInches(rangeData.peakValue)}"` : '--';
    }
    if (peakNoteEl) {
      peakNoteEl.textContent = rangeData.peakDate ? `On ${formatDateLabel(rangeData.peakDate)}` : 'No measurable days';
    }
  }

  function updateSourceText(startISO, endISO, seasons) {
    if (!sourceEl) return;
    const uniqueSeasons = Array.from(new Set(seasons)).sort((a, b) => a - b);
    sourceEl.textContent = `Data: NOAA ACIS – White Lake 4E · Seasons ${uniqueSeasons.map((y) => `${y}-${y + 1}`).join(', ')}`;
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

  async function handleSubmit(event) {
    event.preventDefault();
    const startISO = startInput?.value;
    const endISO = endInput?.value;

    if (!startISO || !endISO) {
      showMessage('Please choose both a start and end date.', 'error');
      return;
    }
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
      updateExport(rangeData);
      showMessage(`Loaded ${rangeData.labels.length} day${rangeData.labels.length === 1 ? '' : 's'} of data.`, 'success');
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
  if (resetBtn) {
    resetBtn.addEventListener('click', handleReset);
  }
})();
