const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

// Exercise the actual PHP endpoint with a controlled clock and local ACIS response.
const source = fs.readFileSync(path.join(__dirname, '..', 'snowdata.php'), 'utf8');
const harness = `<?php
namespace SnowCacheRegression;
use \\DateTimeImmutable;
$_GET = ['startYear' => '2025'];
if (getenv('TEST_FORMAT')) $_GET['format'] = getenv('TEST_FORMAT');
function time() { return (int)getenv('TEST_NOW'); }
function date($format, $timestamp = null) { return \\date($format, $timestamp ?? time()); }
function header($value) { \\file_put_contents(__DIR__ . '/headers.txt', $value . "\\n", FILE_APPEND); }
function file_get_contents($file, ...$args) {
    if (str_starts_with($file, 'https://data.rcc-acis.org/')) {
        \\file_put_contents(__DIR__ . '/fetched.txt', 'yes');
        return \\file_get_contents(__DIR__ . '/upstream.json');
    }
    return \\file_get_contents($file, ...$args);
}
`;

function runEndpoint({ now, cachedAt, complete = true, version = 2, format = '', upstreamError = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-cache-test-'));
  const cacheFile = path.join(dir, 'cache', 'snow_2025.json');
  try {
    fs.mkdirSync(path.dirname(cacheFile));
    fs.writeFileSync(path.join(dir, 'endpoint.php'), source.replace('<?php', harness));
    const data = [];
    for (let d = new Date('2025-07-01T00:00:00Z'); d < new Date('2026-07-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      data.push([d.toISOString().slice(0, 10), d.getUTCMonth() === 5 && d.getUTCDate() === 30 ? '2.0' : '0.0']);
    }
    fs.writeFileSync(path.join(dir, 'upstream.json'), JSON.stringify(upstreamError ? { error: 'Unavailable' } : { data }));
    fs.writeFileSync(cacheFile, JSON.stringify({
      cache_version: version, data_complete: complete,
      season_start: '2025-07-01', season_end: '2026-06-30', seasonal_total_in: 1,
      daily: [{ date: '2025-07-01', snow: 1, seasonal_cum: 1 }]
    }));
    fs.utimesSync(cacheFile, new Date(cachedAt), new Date(cachedAt));
    const output = execFileSync('php', [path.join(dir, 'endpoint.php')], {
      encoding: 'utf8', env: { ...process.env, TEST_NOW: String(Date.parse(now) / 1000), TEST_FORMAT: format }
    });
    return {
      output, fetched: fs.existsSync(path.join(dir, 'fetched.txt')),
      headers: fs.readFileSync(path.join(dir, 'headers.txt'), 'utf8'),
      cached: JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    };
  } finally {
    for (const file of ['endpoint.php', 'upstream.json', 'headers.txt', 'fetched.txt', 'cache/snow_2025.json']) {
      const target = path.join(dir, file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(path.join(dir, 'cache'));
    fs.rmdirSync(dir);
  }
}

for (const scenario of [
  { name: 'active cache stays fresh for an hour', now: '2026-06-30T23:50:00-04:00', cachedAt: '2026-06-30T23:30:00-04:00', fetched: false },
  { name: 'midnight invalidates a cache generated before season close', now: '2026-07-01T00:00:00-04:00', cachedAt: '2026-06-30T23:59:00-04:00', fetched: true },
  { name: 'first week refreshes hourly', now: '2026-07-02T12:00:00-04:00', cachedAt: '2026-07-02T10:59:00-04:00', fetched: true },
  { name: 'incomplete historical data retries hourly', now: '2026-11-02T12:00:00-05:00', cachedAt: '2026-11-02T10:59:00-05:00', complete: false, fetched: true },
  { name: 'complete historical cache is reused within a day', now: '2026-11-02T12:00:00-05:00', cachedAt: '2026-11-02T01:00:00-05:00', fetched: false },
  { name: 'historical totals refresh after a day', now: '2026-11-02T12:00:00-05:00', cachedAt: '2026-11-01T11:59:00-05:00', fetched: true },
  { name: 'legacy cache is invalidated immediately', now: '2026-11-02T12:00:00-05:00', cachedAt: '2026-11-02T11:59:00-05:00', version: 1, fetched: true }
]) {
  test(scenario.name, () => {
    const result = runEndpoint(scenario);
    assert.equal(result.fetched, scenario.fetched);
    assert.equal(JSON.parse(result.output).seasonal_total_in, scenario.fetched ? 2 : 1);
    assert.match(result.headers, /max-age=900, must-revalidate/);
    assert.doesNotMatch(result.headers, /immutable|31536000/);
    if (scenario.fetched) assert.equal(result.cached.data_complete, true);
  });
}

test('CSV uses the same post-season invalidation as JSON', () => {
  const result = runEndpoint({ now: '2026-07-01T00:00:00-04:00', cachedAt: '2026-06-30T23:59:00-04:00', format: 'csv' });
  assert.equal(result.fetched, true);
  assert.match(result.output, /2026-06-30,2,2/);
});

test('upstream failures do not replace cached data or become browser-cached errors', () => {
  const result = runEndpoint({ now: '2026-07-01T00:00:00-04:00', cachedAt: '2026-06-30T23:59:00-04:00', upstreamError: true });
  assert.ok(JSON.parse(result.output).error);
  assert.match(result.headers, /Cache-Control: no-store/);
  assert.equal(result.cached.seasonal_total_in, 1);
});
