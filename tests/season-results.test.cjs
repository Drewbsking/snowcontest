const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function contextFor(page) {
  const context = vm.createContext({
    document: { getElementById: () => null },
    console: { warn() {}, error() {} }
  });
  vm.runInContext(read('guess-utils.js'), context);
  vm.runInContext(page === 'dashboard'
    ? read('app.js').split('// init page')[0]
    : read('winners.html').match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return context;
}

test('dashboard includes the entire last day and completes at July 1 midnight', () => {
  const context = contextFor('dashboard');
  for (const [now, expected] of [
    ['2025-06-30T23:59:59', 'pre'],
    ['2025-07-01T00:00:00', 'active'],
    ['2026-06-30T00:00:00', 'active'],
    ['2026-06-30T12:00:00', 'active'],
    ['2026-06-30T23:59:59.999', 'active'],
    ['2026-07-01T00:00:00', 'done']
  ]) {
    context.nowIso = now;
    assert.equal(vm.runInContext(
      "getStage(new Date(nowIso), parseISODate('2025-07-01'), parseISODate('2026-06-30'))",
      context
    ), expected, now);
  }
});

async function loadWinners(now, failedYear, failure) {
  const context = contextFor('winners');
  context.nowIso = now;
  vm.runInContext(`Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [nowIso])); }
    static now() { return new Date().getTime(); }
  }`, context);
  const loading = { style: {} };
  const container = {};
  context.document.getElementById = id => id === 'loading-text' ? loading : container;
  const cards = [];
  const requested = [];
  context.renderSeasonCard = (_, info) => cards.push(info);
  context.fetch = async url => {
    if (!url.startsWith('snowdata.php')) {
      return { ok: true, text: async () => read(url) };
    }
    assert.ok(url.includes('v=2'), 'bypass old immutable browser responses');
    const year = Number(new URL(url, 'https://example.test/').searchParams.get('startYear'));
    requested.push(year);
    if (year === failedYear) {
      if (failure === 'network') throw new Error('Network failed');
      if (failure === 'api') return { ok: true, json: async () => ({ error: 'ACIS unavailable' }) };
      return { ok: false };
    }
    return { ok: true, json: async () => ({
      season_start: `${year}-07-01`, season_end: `${year + 1}-06-30`,
      seasonal_total_in: 58.4
    }) };
  };
  await context.loadWinners();
  return { cards, loading, requested };
}

test('Past Winners keeps June 30 active and completes on July 1', async () => {
  for (const now of ['2026-06-30T12:00:00', '2026-06-30T23:59:59.999']) {
    const { cards } = await loadWinners(now);
    const season = cards.find(card => card.startYear === 2025);
    assert.equal(season.statusText, 'Season in progress.');
    assert.match(season.seasonText, /Season leader/);
  }
  const { cards } = await loadWinners('2026-07-01T00:00:00');
  const season = cards.find(card => card.startYear === 2025);
  assert.match(season.statusText, /Season completed/);
  assert.match(season.seasonText, /Season winner.*Jeremy Miller/);
});

for (const failure of ['network', 'http', 'api']) {
  test(`Past Winners continues after an old season ${failure} failure`, async () => {
    const { cards, loading, requested } = await loadWinners('2026-11-02T12:00:00', 2012, failure);
    assert.equal(requested.length, 15);
    assert.equal(cards.length, 15);
    assert.equal(cards[0].startYear, 2026);
    assert.match(cards.find(card => card.startYear === 2025).seasonText, /Season winner.*Jeremy Miller/);
    assert.equal(cards.at(-1).statusText, 'Data unavailable.');
    assert.equal(loading.style.display, 'none');
  });
}
