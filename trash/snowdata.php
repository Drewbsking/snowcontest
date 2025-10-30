<?php
// snowdata.php (cached version)

// OUTPUT HEADERS
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
date_default_timezone_set('America/Detroit');

// -------------------- CONFIG --------------------
$WFO = 'DTX'; // NWS Detroit/Pontiac CWA (office in White Lake, MI)
$CACHE_TTL_SECONDS = 900; // 15 min cache per season file

// Contest season logic (Nov 1 -> Mar 31)
if (isset($_GET['startYear']) && preg_match('/^\d{4}$/', $_GET['startYear'])) {
    $startYear = intval($_GET['startYear']);
} else {
    $nowY = intval(date('Y'));
    $nowM = intval(date('n')); // 1-12
    $startYear = ($nowM >= 11) ? $nowY : ($nowY - 1);
}

$START_DATE   = $startYear . '-11-01';
$END_DATE     = ($startYear + 1) . '-03-31';
$SEASON_LABEL = $startYear . '-' . ($startYear + 1);

// -------------------- CACHE SETUP --------------------
$cacheDir = __DIR__ . '/cache';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0775, true);
}
$cacheFile = $cacheDir . '/snow_' . $startYear . '.json';

// If cache exists and is "fresh", just return it and exit
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $CACHE_TTL_SECONDS)) {
    readfile($cacheFile);
    exit;
}

// -------------------- HELPERS --------------------
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

// pull snowfall for a given station id and date range
function get_station_snow_data($sid, $startDate, $endDate) {
    $data_url =
        'https://data.rcc-acis.org/StnData?' .
        http_build_query([
            'sid'    => $sid,
            'sdate'  => $startDate,
            'edate'  => $endDate,
            'elems'  => 'snow',
            'output' => 'json'
        ]);
    return fetch_json($data_url);
}

// score a station to choose best candidate
function score_station($stationNameUpper, $stnData) {
    // prefer text that hints it's the White Lake / DTX forecast office
    $priorityWords = ['WHITE', 'LAKE', 'NWS', 'PONTIAC', 'DTX'];

    $nameScore = 0;
    foreach ($priorityWords as $w) {
        if (strpos($stationNameUpper, $w) !== false) {
            $nameScore += 1;
        }
    }

    // count how many valid snowfall entries exist
    $validCount = 0;
    if (isset($stnData['data']) && is_array($stnData['data'])) {
        foreach ($stnData['data'] as $row) {
            $snowRaw = $row[1] ?? 'M';
            if ($snowRaw !== 'M') {
                $validCount++;
            }
        }
    }

    return ($nameScore * 1000) + $validCount;
}

// -------------------- 1. GET STATIONS IN DTX --------------------
$meta_url =
    'https://data.rcc-acis.org/StnMeta?' .
    http_build_query([
        'cwa'    => $GLOBALS['WFO'],
        'meta'   => 'name,sids,ll,elev',
        'output' => 'json'
    ]);

$meta = fetch_json($meta_url);
if (!$meta || !isset($meta['meta']) || !is_array($meta['meta'])) {
    $payload = [
        'error'        => 'ACIS StnMeta lookup failed',
        'season_label' => $SEASON_LABEL,
        'start_date'   => $START_DATE,
        'end_date'     => $END_DATE,
        'debug_url'    => $meta_url
    ];
    echo json_encode($payload);
    exit;
}

// -------------------- 2. TRY EACH STATION, PICK BEST --------------------
$best = null;
$bestScore = -1;

foreach ($meta['meta'] as $station) {
    if (empty($station['sids']) || !is_array($station['sids'])) {
        continue;
    }

    // ACIS returns multiple IDs per station in "sids", like:
    // "USW00014822 6", "KDTX 5", etc.
    // We just grab the first, strip off the trailing code after the space.
    $firstSidRaw = $station['sids'][0];
    $parts = explode(' ', $firstSidRaw);
    $sid = $parts[0];
    if (!$sid) {
        continue;
    }

    $stnData = get_station_snow_data($sid, $START_DATE, $END_DATE);
    if (!$stnData || !isset($stnData['data'])) {
        continue;
    }

    $stationName      = $station['name'] ?? '';
    $stationNameUpper = strtoupper($stationName);

    $score = score_station($stationNameUpper, $stnData);
    if ($score > $bestScore) {
        $bestScore = $score;
        $best = [
            'sid'   => $sid,
            'name'  => $stationName,
            'acis'  => $stnData
        ];
    }
}

// If no usable station found, return soft error (and don't cache)
if (!$best) {
    $payload = [
        'error'        => 'No station in ACIS had snowfall data for that season',
        'season_label' => $SEASON_LABEL,
        'start_date'   => $START_DATE,
        'end_date'     => $END_DATE
    ];
    echo json_encode($payload);
    exit;
}

// -------------------- 3. BUILD DAILY & CUMULATIVE --------------------
$daily = [];
$cumTotal = 0.0;

foreach ($best['acis']['data'] as $row) {
    // Example row: ["2025-01-01","0.5"]
    $date    = $row[0] ?? null;
    $snowRaw = $row[1] ?? 'M';

    if ($snowRaw === 'M') {
        $snowIn = null;        // missing
    } elseif ($snowRaw === 'T') {
        $snowIn = 0.0;         // trace (<0.1")
        $cumTotal += 0.0;
    } else {
        $snowIn = floatval($snowRaw);
        $cumTotal += $snowIn;
    }

    $daily[] = [
        'date' => $date,
        'snow' => $snowIn,
        'cum'  => $cumTotal
    ];
}

// -------------------- 4. FINAL PAYLOAD + CACHE WRITE --------------------
$payload = [
    'station_name'   => $best['name'],
    'station_sid'    => $best['sid'],
    'season_label'   => $SEASON_LABEL,
    'start_date'     => $START_DATE,
    'end_date'       => $END_DATE,
    'total_snow_in'  => $cumTotal,
    'daily'          => $daily
];

// Write/update cache *after* we have good data
@file_put_contents($cacheFile, json_encode($payload));

echo json_encode($payload);
