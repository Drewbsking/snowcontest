<?php
// snowdata.php (fast, single-station, smart cache)
//
// Uses ACIS StnData with a known station SID "208941"
// which corresponds to WHITE LAKE 4E and produced the snowfall
// time series you saved in snow_2024.json. :contentReference[oaicite:3]{index=3}
//
// The snowfall "season" spans Jul 1 (startYear) through Jun 30 (startYear+1).
// You can request any startYear via ?startYear=2024, ?startYear=2025, etc.
//
// We cache per-season JSON so normal users get instant loads,
// and we only refresh active-season data ~once/hour.
//
// ACIS "snow" element is daily snowfall in inches.
// "M" = missing, "T" = trace (<0.1"), which we treat as 0.0 for totals.

// detect csv output early
$wantCsv = isset($_GET['format']) && strtolower($_GET['format']) === 'csv';

if ($wantCsv) {
    header('Content-Type: text/csv; charset=UTF-8');
} else {
    header('Content-Type: application/json');
}
header('Access-Control-Allow-Origin: *');

// Note: Cache-Control header will be set later after we determine if season is active
date_default_timezone_set('America/Detroit');

// -------- CONFIG: lock to your station from the JSON you provided --------
$STATION_SID  = '208941';          // from your snow_2024.json station_sid
$STATION_NAME = 'WHITE LAKE 4E';   // from your snow_2024.json station_name  :contentReference[oaicite:4]{index=4}

// -------- Determine which snowfall season we're serving --------
if (isset($_GET['startYear']) && preg_match('/^\d{4}$/', $_GET['startYear'])) {
    $startYear = intval($_GET['startYear']);
} else {
    // default: figure out the current snow season.
    // Season starts Jul 1. Jan–Jun belong to the prior Jul start.
    $nowY = intval(date('Y'));
    $nowM = intval(date('n')); // 1..12
    $startYear = ($nowM >= 7) ? $nowY : ($nowY - 1);
}

// Key date window (full seasonal span)
$SEASON_START_DATE = $startYear . '-07-01';
$SEASON_END_DATE   = ($startYear + 1) . '-06-30';
$SEASON_LABEL      = $startYear . '-' . ($startYear + 1);

// Figure out if this season is currently "active" (seasonal window)
$today = date('Y-m-d');
$isActiveSeason = ($today >= $SEASON_START_DATE && $today <= $SEASON_END_DATE);

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

// Serve cached if still fresh AND already has the updated seasonal fields
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $CACHE_TTL_SECONDS)) {
    $cachedRaw = @file_get_contents($cacheFile);
    $cached = $cachedRaw ? json_decode($cachedRaw, true) : null;

    $firstDaily = $cached['daily'][0] ?? null;
    $hasDailyFields = $firstDaily
        && array_key_exists('seasonal_cum', $firstDaily);

    $hasNewFields = $cached
        && isset($cached['seasonal_total_in'])
        && (($cached['season_start'] ?? null) === $SEASON_START_DATE)
        && $hasDailyFields;

    if ($hasNewFields) {
        // Ensure back-compat keys even when serving cached data
        $upgrade = function($payload) use ($SEASON_START_DATE, $SEASON_END_DATE) {
            if (!$payload) return $payload;
            // Add/normalize daily contest_cum mirroring seasonal_cum
            if (isset($payload['daily']) && is_array($payload['daily'])) {
                foreach ($payload['daily'] as $i => $row) {
                    $seasonalCum = $row['seasonal_cum'] ?? null;
                    if (!array_key_exists('contest_cum', $row)) {
                        $payload['daily'][$i]['contest_cum'] = $seasonalCum;
                    }
                }
            }
            // Add top-level aliases
            $seasonTotal = $payload['seasonal_total_in'] ?? null;
            $payload['season_start'] = $payload['season_start'] ?? $SEASON_START_DATE;
            $payload['season_end']   = $payload['season_end']   ?? $SEASON_END_DATE;
            $payload['start_date']   = $payload['start_date']   ?? $payload['season_start'];
            $payload['end_date']     = $payload['end_date']     ?? $payload['season_end'];
            $payload['total_snow_in'] = $payload['total_snow_in'] ?? $seasonTotal;
            $payload['contest_start'] = $payload['contest_start'] ?? $payload['season_start'];
            $payload['contest_end']   = $payload['contest_end']   ?? $payload['season_end'];
            $payload['contest_total_snow_in'] = $payload['contest_total_snow_in'] ?? $seasonTotal;
            $payload['seasonal_start'] = $payload['seasonal_start'] ?? $payload['season_start'];
            $payload['seasonal_end']   = $payload['seasonal_end']   ?? $payload['season_end'];
            return $payload;
        };

        // Set Cache-Control header before serving cached data
        if ($isActiveSeason) {
            // Active season: cache for 15 minutes, must revalidate
            header('Cache-Control: public, max-age=900, must-revalidate');
        } else {
            // Historical season: cache for 1 year, immutable
            header('Cache-Control: public, max-age=31536000, immutable');
        }

        if ($wantCsv && $cached) {
            // stream CSV from cached JSON
            $fn = 'snow_' . $startYear . '.csv';
            header('Content-Disposition: attachment; filename=' . $fn);
            $out = fopen('php://output', 'w');
            fputcsv($out, ['date','snow','seasonal_cum']);
            $payload = $upgrade($cached);
            foreach (($payload['daily'] ?? []) as $row) {
                fputcsv($out, [
                    $row['date'] ?? '',
                    is_null($row['snow'] ?? null) ? '' : $row['snow'],
                    is_null($row['seasonal_cum'] ?? null) ? '' : $row['seasonal_cum']
                ]);
            }
            fclose($out);
            exit;
        } else {
            $payload = $upgrade($cached);
            echo json_encode($payload);
            exit;
        }
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
$stnData = get_station_snow_data($STATION_SID, $SEASON_START_DATE, $SEASON_END_DATE);

if (!$stnData || !isset($stnData['data'])) {
    // soft error, don't cache the error
    echo json_encode([
        'error'        => 'No snowfall data returned from ACIS',
        'station_sid'  => $STATION_SID,
        'season_label' => $SEASON_LABEL,
        'season_start' => $SEASON_START_DATE,
        'season_end'   => $SEASON_END_DATE
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
$seasonalCum = 0.0;

$cursor = new DateTimeImmutable($SEASON_START_DATE);
$seasonEndDt = new DateTimeImmutable($SEASON_END_DATE);

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
    }

    $daily[] = [
        'date'         => $date,
        'snow'         => $snowIn,
        // Back-compat: keep both keys; contest_cum mirrors seasonal_cum (full-season only)
        'contest_cum'  => $seasonalCum,
        'seasonal_cum' => $seasonalCum
    ];
}

$seasonalTotal = $seasonalCum;

// -------- Final payload structure --------
$payload = [
    'station_name'   => $STATION_NAME,
    'station_sid'    => $STATION_SID,
    'season_label'   => $SEASON_LABEL,
    // New canonical keys (full-season)
    'season_start'   => $SEASON_START_DATE,
    'season_end'     => $SEASON_END_DATE,
    'seasonal_total_in' => $seasonalTotal,
    // Back-compat aliases and fields so existing tools keep working
    'start_date'     => $SEASON_START_DATE,
    'end_date'       => $SEASON_END_DATE,
    'total_snow_in'  => $seasonalTotal,
    'contest_start'  => $SEASON_START_DATE,
    'contest_end'    => $SEASON_END_DATE,
    'contest_total_snow_in' => $seasonalTotal,
    'seasonal_start' => $SEASON_START_DATE,
    'seasonal_end'   => $SEASON_END_DATE,
    'daily'          => $daily
];

// Cache it (success only)
@file_put_contents($cacheFile, json_encode($payload));

// Set Cache-Control header before serving fresh data
if ($isActiveSeason) {
    // Active season: cache for 15 minutes, must revalidate
    header('Cache-Control: public, max-age=900, must-revalidate');
} else {
    // Historical season: cache for 1 year, immutable
    header('Cache-Control: public, max-age=31536000, immutable');
}

if ($wantCsv) {
    $fn = 'snow_' . $startYear . '.csv';
    header('Content-Disposition: attachment; filename=' . $fn);
    $out = fopen('php://output', 'w');
    fputcsv($out, ['date','snow','seasonal_cum']);
    foreach ($payload['daily'] as $row) {
        fputcsv($out, [
            $row['date'] ?? '',
            is_null($row['snow'] ?? null) ? '' : $row['snow'],
            is_null($row['seasonal_cum'] ?? null) ? '' : $row['seasonal_cum']
        ]);
    }
    fclose($out);
    exit;
}

// Send JSON to browser
echo json_encode($payload);
