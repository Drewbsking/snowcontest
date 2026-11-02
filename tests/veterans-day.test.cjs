const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function loadPage(page = 'dashboard', csv) {
  const elements = {};
  const charts = [];
  const context = vm.createContext({
    document: {
      getElementById: id => elements[id] || null,
      querySelector: () => null,
      readyState: 'loading', addEventListener() {},
      createElement: () => ({ classList: { add() {} } })
    },
    console,
    Chart: function (_, config) { charts.push(config); this.destroy = () => {}; },
    fetch: async file => ({ ok: true, text: async () => csv ?? read(file) })
  });
  vm.runInContext(read('guess-utils.js'), context);
  const code = page === 'dashboard' ? read('app.js').split('// init page')[0]
    : page === 'records' ? read('records.js')
    : read('winners.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(code, context);
  return { context, elements, charts };
}

for (const page of ['dashboard', 'records']) {
  test(`${page} adds November 11 starting in 2026-27`, () => {
    const { context } = loadPage(page);
    assert.equal(context.getHolidayListForSeason(2025).length, 5);
    for (const year of [2026, 2027]) {
      const holidays = context.getHolidayListForSeason(year);
      assert.equal(holidays.length, 6);
      assert.equal(holidays[0].key, 'veterans');
      assert.equal(holidays[0].iso, `${year}-11-11`);
    }
    if (page === 'records') {
      const stats = context.computeSeasonStats({ daily: [{ date: '2026-11-11', snow: 0.1 }] }, 2026);
      assert.equal(stats.holidayTotal, 6);
      assert.equal(stats.holidayHits, 1);
    }
  });
}

test('form export reads Veterans Day Yes/No and leaves unanswered calls ungraded', async () => {
  for (const header of ['Veterans Day', "Veteran’s Day", 'Will it snow on the following holidays?.Veterans Day']) {
    const { context } = loadPage('dashboard', `Name,Guess,${header}\nYes One,48.15,Yes\nNo One,40,No\nBlank,30,`);
    const { entries } = await context.fetchGuessSheet({ file: 'fixture.csv' });
    assert.deepEqual(Array.from(entries, entry => entry.holidays.veterans), [true, false, null]);
    assert.equal(entries[0].guess, 48.2);
  }
  const { context } = loadPage();
  const previous = await context.fetchGuessSheet({ file: 'Guesses/2025-2026 RCOC Snow Contest(Sheet1).csv' });
  assert.ok(previous.entries.every(entry => entry.holidays.veterans === null));
});

test('Veterans Day appears in badges, consensus, results, and the $10 payout', () => {
  const { context, elements, charts } = loadPage();
  const badges = [];
  elements['holiday-badges'] = { appendChild: badge => badges.push(badge) };
  elements.holidayGuessChart = { getContext: () => ({}) };
  elements['holiday-result-body'] = {};
  elements['holiday-payout-body'] = {};
  const guesses = [
    { name: 'Yes One', holidays: { veterans: true } },
    { name: 'Yes Two', holidays: { veterans: true } },
    { name: 'No One', holidays: { veterans: false } },
    { name: 'Blank', holidays: { veterans: null } }
  ];
  const daily = [{ date: '2026-11-11', snow: 0.1 }];
  context.renderHolidayBadges(2026, daily);
  assert.equal(badges.length, 6);
  assert.match(badges[0].innerHTML, /Veterans Day/);
  context.renderHolidayGuessChart(guesses, 2026);
  assert.equal(charts[0].data.labels[0], 'Veterans Day');
  assert.equal(charts[0].data.datasets[0].data[0], 67);
  assert.equal(charts[0].data.datasets[1].data[0], 33);
  context.renderHolidayResults(2026, daily, guesses, true);
  assert.match(elements['holiday-result-body'].innerHTML, /Veterans Day/);
  assert.match(elements['holiday-result-body'].innerHTML, /Yes One/);
  assert.doesNotMatch(elements['holiday-result-body'].innerHTML, /No One|Blank/);
  context.renderHolidayPayouts(2026, daily, guesses, true);
  assert.equal((elements['holiday-payout-body'].innerHTML.match(/\$5\.00/g) || []).length, 2);
  context.renderHolidayPayouts(2026, [{ date: '2026-11-11', snow: 0 }], guesses, true);
  assert.match(elements['holiday-payout-body'].innerHTML, /No One/);
  assert.match(elements['holiday-payout-body'].innerHTML, /\$10\.00/);
  context.renderHolidayPayouts(2026, [{ date: '2026-11-11', snow: null }], guesses, true);
  assert.equal(elements['holiday-payout-body'].textContent, 'No holiday payouts yet.');
  context.renderHolidayPayouts(2025, [{ date: '2025-11-11', snow: 1 }], guesses, true);
  assert.equal(elements['holiday-payout-body'].textContent, 'No holiday payouts yet.');
});

test('2026-27 is connected to an empty import template with the new holiday column', async () => {
  const file = 'Guesses/2026-2027 RCOC Snow Contest(Sheet1).csv';
  assert.match(read(file), /Veterans Day/);
  for (const page of ['dashboard', 'winners']) {
    const { context } = loadPage(page);
    const config = vm.runInContext('guessSheetConfigs.find(config => config.startYear === 2026)', context);
    assert.equal(config.file, file);
    const result = await context.fetchGuessSheet(config);
    assert.equal((page === 'dashboard' ? result.entries : result).length, 0);
  }
});
