const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function loadPage(page, csv) {
  const context = vm.createContext({
    document: { getElementById: () => null },
    console,
    fetch: async file => ({ ok: true, text: async () => csv ?? read(file) })
  });
  vm.runInContext(read('guess-utils.js'), context);
  const code = page === 'dashboard'
    ? read('app.js').split('// init page')[0]
    : read('winners.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(code, context);
  return context;
}

test('official guesses round half up to tenths, including decimal boundaries', () => {
  const context = loadPage('dashboard');
  for (const [input, expected] of [
    ['48.15', 48.2], ['48.149', 48.1], ['48.151', 48.2],
    ['48.25', 48.3], ['48.95', 49], ['4.55', 4.6],
    ['50.5', 50.5], ['0', 0], [48.15, 48.2],
    ['', null], [' ', null], [null, null], ['invalid', null]
  ]) {
    assert.equal(context.parseOfficialGuess(input), expected, String(input));
  }
});

for (const page of ['dashboard', 'past winners']) {
  test(`${page} scores rounded guesses as ties and excludes blank guesses`, async () => {
    const context = loadPage(page, 'Name,Alias,Guess\nBrandon,,48.15\nOther,,48.2\nBlank,,');
    const result = await context.fetchGuessSheet({ file: 'fixture.csv' });
    const entries = page === 'dashboard' ? result.entries : result;
    assert.equal(entries.length, 2);
    assert.ok(entries.every(entry => entry.guess === 48.2));
    const scored = context.pickAbsoluteClosestResult(entries, 48.2);
    assert.equal(scored.winners.length, 2);
    assert.equal(scored.margin, 0);
    if (page === 'dashboard') {
      const exported = context.parseCsv(result.sanitizedCsv);
      assert.equal(exported[1][2], '48.2');
      assert.equal(exported[2][2], '48.2');
      assert.equal(context.computeRunningContestantCount(entries, 48.2), 2);
    }
  });

  test(`${page} retains all 2025-26 entrants and Miller's win`, async () => {
    const context = loadPage(page);
    const result = await context.fetchGuessSheet({
      file: 'Guesses/2025-2026 RCOC Snow Contest(Sheet1).csv'
    });
    const entries = page === 'dashboard' ? result.entries : result;
    assert.equal(entries.length, 10);
    assert.equal(entries.find(entry => entry.name === 'Paint in the snow').guess, 48.2);
    const scored = context.pickAbsoluteClosestResult(entries, 58.4);
    assert.equal(scored.winners.length, 1);
    assert.equal(scored.winners[0].name, 'Jeremy Miller');
    assert.ok(Math.abs(scored.margin - 5) < 1e-6);
  });
}
