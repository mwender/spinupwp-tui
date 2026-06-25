<?php
    // --- Server load (1-min average) -------------------------------------------
    $load = @file_get_contents("/proc/loadavg");
    $load = $load ? explode(' ', $load)[0] : '';
    if (!$load && function_exists('exec')) {
        $reguptime = trim(@exec("uptime"));
        if ($reguptime && preg_match("/, *(\d) (users?), .*: (.*), (.*), (.*)/", $reguptime, $m)) $load = $m[3];
    }

    // --- Uptime ----------------------------------------------------------------
    $uptime_text = @file_get_contents("/proc/uptime");
    $uptime = $uptime_text ? substr($uptime_text, 0, strpos($uptime_text, " ")) : '';
    if (!$uptime && function_exists('shell_exec')) $uptime = @shell_exec("cut -d. -f1 /proc/uptime");
    $days  = floor($uptime / 60 / 60 / 24);
    $hours = str_pad($uptime / 60 / 60 % 24, 2, "0", STR_PAD_LEFT);
    $mins  = str_pad($uptime / 60 % 60, 2, "0", STR_PAD_LEFT);
    $secs  = str_pad($uptime % 60, 2, "0", STR_PAD_LEFT);

    // Reusable on any server: derive the name from the request host, not a literal.
    $host = $_SERVER['HTTP_HOST'] ?? gethostname();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title><?= htmlspecialchars($host) ?></title>
    <style>
        :root {
            --bg: #fafafa; --card: #ffffff; --line: #ececec;
            --ink: #1b1b1f; --muted: #6b7280; --faint: #9ca3af;
            --ok: #16a34a; --accent: #111827;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #0b0d10; --card: #14171c; --line: #232830;
                --ink: #e8eaed; --muted: #9aa3af; --faint: #6b7280;
                --ok: #34d399; --accent: #e8eaed;
            }
        }
        * { box-sizing: border-box; }
        body, html { height: 100%; margin: 0; }
        body {
            display: flex; align-items: center; justify-content: center;
            background: var(--bg); color: var(--ink);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
        }
        .card {
            width: min(92vw, 440px);
            padding: 40px 44px;
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 14px;
        }
        /* Swap in a logo by setting a background-image here, or replace the dot. */
        .status {
            display: inline-flex; align-items: center; gap: 8px;
            font-size: 12px; letter-spacing: .08em; text-transform: uppercase;
            color: var(--muted);
        }
        .dot {
            width: 9px; height: 9px; border-radius: 50%; background: var(--ok);
            box-shadow: 0 0 0 0 var(--ok); animation: pulse 2.4s infinite;
        }
        @keyframes pulse {
            0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); }
            70%  { box-shadow: 0 0 0 10px transparent; }
            100% { box-shadow: 0 0 0 0 transparent; }
        }
        @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
        h1 {
            margin: 18px 0 4px; font-size: 22px; font-weight: 600;
            letter-spacing: -.01em; word-break: break-all;
        }
        .sub { margin: 0 0 28px; color: var(--muted); font-size: 14px; }
        .metrics {
            display: flex; gap: 14px; padding-top: 22px;
            border-top: 1px solid var(--line);
        }
        .metric { flex: 1; }
        .metric .k { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
        /* The <load> / <uptime> tags below are machine-readable (WHMCS uptime
           checker parses them) — keep the tag names; style them as the display. */
        load, uptime {
            display: block; margin-top: 5px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 15px; color: var(--ink);
        }
    </style>
</head>
<body>
    <main class="card">
        <span class="status"><span class="dot"></span>Online</span>
        <h1><?= htmlspecialchars($host) ?></h1>
        <p class="sub">This server is up and running.</p>
        <div class="metrics">
            <div class="metric">
                <div class="k">Uptime</div>
                <?php echo "<uptime>{$days}d {$hours}:{$mins}:{$secs}</uptime>"; ?>
            </div>
            <div class="metric">
                <div class="k">Load (1m)</div>
                <?php echo "<load>" . htmlspecialchars($load) . "</load>"; ?>
            </div>
        </div>
    </main>
</body>
</html>
