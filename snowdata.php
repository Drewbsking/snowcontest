<?php
// snowdata.php (fast, single-station, smart cache)
//
// Uses ACIS StnData with a known station SID "208941"
// which corresponds to WHITE LAKE 4E and produced the snowfall
// time series you saved in snow_2024.json. :contentReference[oaicite:3]{index=3}
//
// We define a "contest season" as Dec 1 (startYear)
// through Mar 31 (startYear+1). Seasonal totals span Jul 1 (startYear)
// through Jun 30 (startYear+1). You can request any startYear
// via ?startYear=2024, ?startYear=2025, etc.
//
// We cache per-season JSON so normal users get instant loads,
// and we only refresh active-season data ~once/hour.
//
// ACIS "snow" element is daily snowfall in inches.
// "M" = missing, "T" = trace (<0.1"), which we treat as 0.0 for totals.

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
date_default_timezone_set('America/Detroit');

// -------- CONFIG: lock to your station from the JSON you provided --------
$STATION_SID  = '208941';          // from your snow_2024.json station_sid
$STATION_NAME = 'WHITE LAKE 4E';   // from your snow_2024.json station_name  :contentReference[oaicite:4]{index=4}

// -------- Determine which contest season we're serving --------
if (isset($_GET['startYear']) && preg_match('/^\d{4}$/', $_GET['startYear'])) {
    $startYear = intval($_GET['startYear']);
} else {
    // default: figure out "current" contest season
    // If we're in Dec, season startYear = this year.
    // Otherwise (Jan–Nov), we are in the season that started last year.
    $nowY = intval(date('Y'));
    $nowM = intval(date('n')); // 1..12
    $startYear = ($nowM >= 12) ? $nowY : ($nowY - 1);
}

// Key date windows
$CONTEST_START_DATE  = $startYear . '-12-01';
$CONTEST_END_DATE    = ($startYear + 1) . '-03-31';
$SEASONAL_START_DATE = $startYear . '-07-01';
$SEASONAL_END_DATE   = ($startYear + 1) . '-06-30';
$SEASON_LABEL        = $startYear . '-' . ($startYear + 1);

// Figure out if this season is currently "active" (seasonal window)
$today = date('Y-m-d');
$isActiveSeason = ($today >= $SEASONAL_START_DATE && $today <= $SEASONAL_END_DATE);

// Cache policy
// Active season: refresh at most once/hour (3600s)
// Past seasons: basically permanent (~1 year)
$CACHE_TTL_SECONDS = $isActiveSeason ? 3600 : 31536000; // 1h vs ~1yr

// Ensure cache directory exists
$cacheDir = __DIR__ . '/cache';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0775, true);
}
$cacheFile = $cacheDir . '/snow_' . $startYear . '.json';

// Serve cached if still fresh AND already has the updated contest fields
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $CACHE_TTL_SECONDS)) {
    $cachedRaw = @file_get_contents($cacheFile);
    $cached = $cachedRaw ? json_decode($cachedRaw, true) : null;

    $firstDaily = $cached['daily'][0] ?? null;
    $hasDailyFields = $firstDaily
        && array_key_exists('contest_cum', $firstDaily)
        && array_key_exists('seasonal_cum', $firstDaily);

    $hasNewFields = $cached
        && isset($cached['contest_total_snow_in'])
        && isset($cached['seasonal_total_in'])
        && (($cached['contest_start'] ?? null) === $CONTEST_START_DATE)
        && $hasDailyFields;

    if ($hasNewFields) {
        echo $cachedRaw;
        exit;
    }
}

// -------- Helper to call ACIS --------
function fetch_json($url) {
    $opts = [
        'http' => [
            'method'  => 'GET',
            'header'  => "User-Agent: snowfall-widget\r\n"
        ]
    ];
    $ctx  = stream_context_create($opts);
    $raw  = @file_get_contents($url, false, $ctx);
    if ($raw === false) {
        return null;
    }
    return json_decode($raw, true);
}

function get_station_snow_data($sid, $startDate, $endDate) {
    // ACIS StnData docs: sid=<station>, elems=snow returns
    // daily snowfall in inches for each calendar day.
    // "M" = missing; "T" = trace (<0.1"). We treat "T" as 0.0.
    $url = 'https://data.rcc-acis.org/StnData?' . http_build_query([
        'sid'    => $sid,
        'sdate'  => $startDate,
        'edate'  => $endDate,
        'elems'  => 'snow',
        'output' => 'json'
    ]);
    return fetch_json($url);
}

// -------- Pull from ACIS for THIS station only --------
$stnData = get_station_snow_data($STATION_SID, $SEASONAL_START_DATE, $SEASONAL_END_DATE);

if (!$stnData || !isset($stnData['data'])) {
    // soft error, don't cache the error
    echo json_encode([
        'error'        => 'No snowfall data returned from ACIS',
        'station_sid'  => $STATION_SID,
        'season_label' => $SEASON_LABEL,
        'start_date'   => $CONTEST_START_DATE,
        'end_date'     => $CONTEST_END_DATE
    ]);
    exit;
}

// -------- Build daily + cumulative arrays (full seasonal span) --------
$rowsByDate = [];
foreach ($stnData['data'] as $row) {
    $dateKey = $row[0] ?? null;
    if ($dateKey) {
        $rowsByDate[$dateKey] = $row[1] ?? 'M';
    }
}

$daily = [];
$contestCum = 0.0;
$seasonalCum = 0.0;

$cursor = new DateTimeImmutable($SEASONAL_START_DATE);
$seasonEndDt = new DateTimeImmutable($SEASONAL_END_DATE);

for ($dt = $cursor; $dt <= $seasonEndDt; $dt = $dt->modify('+1 day')) {
    $date = $dt->format('Y-m-d');
    $snowRaw = $rowsByDate[$date] ?? 'M';

    if ($snowRaw === 'M') {
        $snowIn = null;      // no report that day
    } elseif ($snowRaw === 'T') {
        $snowIn = 0.0;       // trace counts as 0
    } else {
        $snowIn = floatval($snowRaw);
    }

    if ($snowIn !== null) {
        $seasonalCum += $snowIn;
        if ($date >= $CONTEST_START_DATE && $date <= $CONTEST_END_DATE) {
            $contestCum += $snowIn;
        }
    }

    $daily[] = [
        'date'         => $date,
        'snow'         => $snowIn,
        'contest_cum'  => ($date >= $CONTEST_START_DATE && $date <= $CONTEST_END_DATE)
            ? $contestCum
            : null,
        'seasonal_cum' => $seasonalCum
    ];
}

$contestTotal = $contestCum;
$seasonalTotal = $seasonalCum;

// -------- Final payload structure --------
$payload = [
    'station_name'   => $STATION_NAME,
    'station_sid'    => $STATION_SID,
    'season_label'   => $SEASON_LABEL,
    'start_date'     => $CONTEST_START_DATE,
    'end_date'       => $CONTEST_END_DATE,
    'total_snow_in'  => $contestTotal,
    'contest_start'             => $CONTEST_START_DATE,
    'contest_end'               => $CONTEST_END_DATE,
    'contest_total_snow_in'     => $contestTotal,
    'seasonal_start'            => $SEASONAL_START_DATE,
    'seasonal_end'              => $SEASONAL_END_DATE,
    'seasonal_total_in'         => $seasonalTotal,
    'daily'                     => $daily
];

// Cache it (success only)
@file_put_contents($cacheFile, json_encode($payload));

// Send to browser
echo json_encode($payload);
