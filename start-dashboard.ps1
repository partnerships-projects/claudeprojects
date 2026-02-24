# ─────────────────────────────────────────────────────────────────────────────
# SalesHandy — Uncontacted Prospects Dashboard (PowerShell)
# ─────────────────────────────────────────────────────────────────────────────
#
# Usage:  Right-click this file → "Run with PowerShell"
#    or:  Open PowerShell → .\start-dashboard.ps1
#
# Then share the URL with your team: http://<your-ip>:8080
#
# No installation required — uses only built-in Windows components.
# ─────────────────────────────────────────────────────────────────────────────

$API_KEY    = if ($env:SALESHANDY_API_KEY) { $env:SALESHANDY_API_KEY } else { Read-Host "Enter your SalesHandy API key" }
$BASE_URL   = "https://leo-open-api-gateway.saleshandy.com"
$PORT       = 8080
$THRESHOLD  = 2000

# ── SalesHandy API call ──────────────────────────────────────────────────────

function Invoke-SaleshandyAPI {
    param([string]$Path)

    $headers = @{
        "Authorization" = "Bearer $API_KEY"
        "Content-Type"  = "application/json"
    }

    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL$Path" -Headers $headers -Method Get -ErrorAction Stop
        return $response
    } catch {
        Write-Host "  API Error on ${Path}: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# ── Fetch all active sequences + counts ───────────────────────────────────────

function Get-SequenceData {
    Write-Host "`n  Fetching sequences from SalesHandy..." -ForegroundColor Cyan

    $allSequences = @()
    $page = 1

    while ($true) {
        $data = Invoke-SaleshandyAPI "/api/v1/sequences?page=$page&limit=100"
        if ($null -eq $data) { break }

        $items = $null
        if ($data.data)       { $items = $data.data }
        elseif ($data.sequences) { $items = $data.sequences }
        elseif ($data.items)  { $items = $data.items }
        elseif ($data.results){ $items = $data.results }
        elseif ($data -is [System.Array]) { $items = $data }

        if ($null -eq $items -or $items.Count -eq 0) { break }

        $allSequences += $items
        if ($items.Count -lt 100) { break }
        if ($page -ge 50) { break }
        $page++
    }

    Write-Host "  Found $($allSequences.Count) sequences total." -ForegroundColor Green

    # Filter active
    $active = $allSequences | Where-Object {
        $status = if ($_.status) { $_.status.ToString().ToLower() } elseif ($_.state) { $_.state.ToString().ToLower() } else { "" }
        $status -eq "" -or $status -eq "active" -or $status -eq "running" -or $status -eq "live" -or $status -eq "1"
    }

    Write-Host "  Active sequences: $($active.Count)" -ForegroundColor Green

    $results = @()
    $i = 0

    foreach ($seq in $active) {
        $i++
        $id   = if ($seq.id) { $seq.id } elseif ($seq._id) { $seq._id } elseif ($seq.sequenceId) { $seq.sequenceId } else { "unknown" }
        $name = if ($seq.name) { $seq.name } elseif ($seq.title) { $seq.title } elseif ($seq.sequenceName) { $seq.sequenceName } else { "Sequence $id" }

        Write-Host "  [$i/$($active.Count)] $name..." -NoNewline

        # Try embedded count
        $count = $null
        foreach ($prop in @("notContactedCount","not_contacted_count","notContacted","not_contacted")) {
            if ($null -ne $seq.$prop) { $count = [int]$seq.$prop; break }
        }
        if ($null -eq $count -and $seq.prospects) {
            foreach ($prop in @("notContacted","not_contacted")) {
                if ($null -ne $seq.prospects.$prop) { $count = [int]$seq.prospects.$prop; break }
            }
        }
        if ($null -eq $count -and $seq.stats) {
            foreach ($prop in @("notContacted","not_contacted")) {
                if ($null -ne $seq.stats.$prop) { $count = [int]$seq.stats.$prop; break }
            }
        }
        if ($null -eq $count -and $seq.prospectStats) {
            foreach ($prop in @("notContacted","not_contacted")) {
                if ($null -ne $seq.prospectStats.$prop) { $count = [int]$seq.prospectStats.$prop; break }
            }
        }

        # Try detail endpoint
        if ($null -eq $count) {
            $detail = Invoke-SaleshandyAPI "/api/v1/sequences/$id"
            if ($null -ne $detail) {
                $s = if ($detail.data) { $detail.data } else { $detail }
                foreach ($prop in @("notContactedCount","not_contacted_count","notContacted","not_contacted")) {
                    if ($null -ne $s.$prop) { $count = [int]$s.$prop; break }
                }
                if ($null -eq $count -and $s.prospects) {
                    foreach ($prop in @("notContacted","not_contacted")) {
                        if ($null -ne $s.prospects.$prop) { $count = [int]$s.prospects.$prop; break }
                    }
                }
                if ($null -eq $count -and $s.stats) {
                    foreach ($prop in @("notContacted","not_contacted")) {
                        if ($null -ne $s.stats.$prop) { $count = [int]$s.stats.$prop; break }
                    }
                }
            }
        }

        # Try prospect list as last resort
        if ($null -eq $count) {
            foreach ($status in @("NOT_CONTACTED","notContacted","not_contacted")) {
                $pData = Invoke-SaleshandyAPI "/api/v1/sequences/$id/prospects?status=$status&limit=1"
                if ($null -ne $pData) {
                    $total = if ($null -ne $pData.total) { $pData.total }
                             elseif ($null -ne $pData.totalCount) { $pData.totalCount }
                             elseif ($null -ne $pData.total_count) { $pData.total_count }
                             elseif ($null -ne $pData.meta -and $null -ne $pData.meta.total) { $pData.meta.total }
                             elseif ($null -ne $pData.pagination -and $null -ne $pData.pagination.total) { $pData.pagination.total }
                             else { $null }
                    if ($null -ne $total) { $count = [int]$total; break }
                }
            }
        }

        if ($null -ne $count) {
            $color = if ($count -lt $THRESHOLD) { "Red" } else { "Green" }
            Write-Host " $($count.ToString('N0'))" -ForegroundColor $color
        } else {
            Write-Host " ?" -ForegroundColor Yellow
        }

        $results += [PSCustomObject]@{
            id                = $id
            name              = $name
            notContactedCount = $count
        }
    }

    return $results | Sort-Object { if ($null -ne $_.notContactedCount) { -$_.notContactedCount } else { 1 } }
}

# ── Build the HTML dashboard ──────────────────────────────────────────────────

function Build-HTML {
    param([array]$Sequences)

    $totalNotContacted = ($Sequences | Measure-Object -Property notContactedCount -Sum).Sum
    $belowCount = ($Sequences | Where-Object { $null -ne $_.notContactedCount -and $_.notContactedCount -lt $THRESHOLD }).Count
    $aboveCount = ($Sequences | Where-Object { $null -ne $_.notContactedCount -and $_.notContactedCount -ge $THRESHOLD }).Count
    $now = (Get-Date).ToString("MMM d, yyyy — h:mm tt")

    $allRows = ""
    $i = 0
    foreach ($s in $Sequences) {
        $i++
        $isRed = ($null -ne $s.notContactedCount -and $s.notContactedCount -lt $THRESHOLD)
        $cls = if ($isRed) { 'row-red' } else { '' }
        $countDisplay = if ($null -ne $s.notContactedCount) { $s.notContactedCount.ToString('N0') } else { '—' }
        $nameEscaped = [System.Web.HttpUtility]::HtmlEncode($s.name)
        $allRows += "<tr class=`"$cls`"><td class=`"num`">$i</td><td class=`"seq-name`">$nameEscaped</td><td class=`"num`">$countDisplay</td></tr>`n"
    }

    $flaggedRows = ""
    $flaggedSequences = $Sequences | Where-Object { $null -ne $_.notContactedCount -and $_.notContactedCount -lt $THRESHOLD } | Sort-Object notContactedCount
    $j = 0
    foreach ($s in $flaggedSequences) {
        $j++
        $countDisplay = $s.notContactedCount.ToString('N0')
        $nameEscaped = [System.Web.HttpUtility]::HtmlEncode($s.name)
        $flaggedRows += "<tr class=`"row-red`"><td class=`"num`">$j</td><td class=`"seq-name`">$nameEscaped</td><td class=`"num`">$countDisplay</td></tr>`n"
    }

    $flaggedSection = ""
    if ($belowCount -gt 0) {
        $flaggedSection = @"
    <div class="card">
        <div class="warning-label"><span class="warning-dot"></span> Sequences below $($THRESHOLD.ToString('N0')) — need more prospects</div>
        <table class="data-table">
            <thead><tr><th style="width:40px;">#</th><th>Sequence Name</th><th style="text-align:right;">Not Contacted</th></tr></thead>
            <tbody>$flaggedRows</tbody>
        </table>
    </div>
"@
    }

    $totalDisplay = if ($null -ne $totalNotContacted) { $totalNotContacted.ToString('N0') } else { '0' }

    return @"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="300">
    <title>Saleshandy — Uncontacted Prospects</title>
    <style>
        :root {
            --bg-primary: #0f1117; --bg-secondary: #1a1d29; --bg-card: #1e2235;
            --border: #2a2f45; --text-primary: #e8eaf0; --text-secondary: #8b8fa3;
            --text-muted: #5c6078; --accent-blue: #4f8df5; --accent-green: #34d399;
            --accent-red: #f87171; --accent-cyan: #22d3ee;
            --row-red-bg: rgba(248, 113, 113, 0.10); --row-red-border: rgba(248, 113, 113, 0.25);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; line-height: 1.5; }
        .page { max-width: 1100px; margin: 0 auto; padding: 40px 32px; }
        .header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
        .header h1 { font-size: 26px; font-weight: 700; }
        .header p { color: var(--text-secondary); font-size: 13px; margin-top: 4px; }
        .date-badge { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
        .refresh-note { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
        .summary-strip { display: flex; gap: 8px; margin-bottom: 28px; background: var(--bg-secondary); border-radius: 12px; padding: 16px 20px; border: 1px solid var(--border); }
        .summary-item { flex: 1; text-align: center; padding: 0 12px; border-right: 1px solid var(--border); }
        .summary-item:last-child { border-right: none; }
        .summary-item .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
        .summary-item .value { font-size: 24px; font-weight: 700; }
        .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; margin-bottom: 28px; }
        .card-title { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 16px; }
        .warning-label { font-size: 15px; font-weight: 700; color: var(--accent-red); margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
        .warning-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-red); display: inline-block; }
        .data-table { width: 100%; border-collapse: collapse; }
        .data-table th { text-align: left; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-weight: 600; }
        .data-table td { padding: 13px 14px; font-size: 14px; border-bottom: 1px solid rgba(42, 47, 69, 0.5); }
        .data-table tbody tr:hover { background: rgba(79, 141, 245, 0.04); }
        .data-table .num { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
        .data-table .seq-name { font-weight: 500; }
        .data-table tr.row-red { background: var(--row-red-bg); }
        .data-table tr.row-red td { color: var(--accent-red); border-bottom-color: var(--row-red-border); }
        .data-table tr.row-red:hover { background: rgba(248, 113, 113, 0.15); }
        @media (max-width: 768px) { .page { padding: 20px 16px; } .header { flex-direction: column; gap: 12px; } .summary-strip { flex-direction: column; } .summary-item { border-right: none; border-bottom: 1px solid var(--border); padding: 10px 0; } .summary-item:last-child { border-bottom: none; } }
    </style>
</head>
<body>
<div class="page">
    <div class="header">
        <div>
            <h1>Sequence — Uncontacted Prospects</h1>
            <p>Active Saleshandy sequences &amp; their "Not Contacted" prospect counts</p>
        </div>
        <div style="text-align:right;">
            <div class="date-badge">$now</div>
            <div class="refresh-note">Auto-refreshes every 5 minutes</div>
        </div>
    </div>

    <div class="summary-strip">
        <div class="summary-item"><div class="label">Total Sequences</div><div class="value" style="color:var(--accent-blue);">$($Sequences.Count)</div></div>
        <div class="summary-item"><div class="label">Total Not Contacted</div><div class="value" style="color:var(--accent-cyan);">$totalDisplay</div></div>
        <div class="summary-item"><div class="label">Below $($THRESHOLD.ToString('N0'))</div><div class="value" style="color:var(--accent-red);">$belowCount</div></div>
        <div class="summary-item"><div class="label">Above $($THRESHOLD.ToString('N0'))</div><div class="value" style="color:var(--accent-green);">$aboveCount</div></div>
    </div>

    <div class="card">
        <div class="card-title">All Active Sequences (sorted by count, descending)</div>
        <table class="data-table">
            <thead><tr><th style="width:40px;">#</th><th>Sequence Name</th><th style="text-align:right;">Not Contacted</th></tr></thead>
            <tbody>$allRows</tbody>
        </table>
    </div>

    $flaggedSection
</div>
</body>
</html>
"@
}

# ── HTTP Server ───────────────────────────────────────────────────────────────

Add-Type -AssemblyName System.Web

# Fetch data once at startup
$script:cachedHTML = $null
$script:lastFetch  = [datetime]::MinValue

function Update-Cache {
    $sequences = Get-SequenceData
    $script:cachedHTML = Build-HTML -Sequences $sequences
    $script:lastFetch = Get-Date
    Write-Host "`n  Dashboard ready! Data cached at $($script:lastFetch.ToString('h:mm:ss tt'))" -ForegroundColor Green
}

# Initial fetch
Update-Cache

# Start HTTP listener
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$PORT/")

try {
    $listener.Start()
} catch {
    Write-Host "`n  Port $PORT requires admin rights. Trying localhost only..." -ForegroundColor Yellow
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$PORT/")
    $listener.Start()
}

# Get local IPs
$localIPs = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
    ForEach-Object { $_.IPAddressToString }

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "  │   SalesHandy — Uncontacted Prospects Dashboard      │" -ForegroundColor Cyan
Write-Host "  ├─────────────────────────────────────────────────────┤" -ForegroundColor Cyan
Write-Host "  │   Local:   " -ForegroundColor Cyan -NoNewline
Write-Host "http://localhost:$PORT" -ForegroundColor White -NoNewline
Write-Host "$(' ' * (52 - 14 - "http://localhost:$PORT".Length))│" -ForegroundColor Cyan
foreach ($ip in $localIPs) {
    $url = "http://${ip}:$PORT"
    Write-Host "  │   Network: " -ForegroundColor Cyan -NoNewline
    Write-Host "$url" -ForegroundColor White -NoNewline
    Write-Host "$(' ' * (52 - 14 - $url.Length))│" -ForegroundColor Cyan
}
Write-Host "  ├─────────────────────────────────────────────────────┤" -ForegroundColor Cyan
Write-Host "  │   Share the Network URL with your team!             │" -ForegroundColor Cyan
Write-Host "  │   Auto-refreshes data every 5 minutes               │" -ForegroundColor Cyan
Write-Host "  │   Press Ctrl+C to stop                              │" -ForegroundColor Cyan
Write-Host "  └─────────────────────────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""

# Serve requests
try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $response = $context.Response

        # Refresh data every 5 minutes
        if ((Get-Date) - $script:lastFetch -gt [TimeSpan]::FromMinutes(5)) {
            Write-Host "  Refreshing data..." -ForegroundColor Cyan
            Update-Cache
        }

        $response.ContentType = "text/html; charset=utf-8"
        $buffer = [System.Text.Encoding]::UTF8.GetBytes($script:cachedHTML)
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.OutputStream.Close()

        $clientIP = $context.Request.RemoteEndPoint.Address
        Write-Host "  $($clientIP) opened the dashboard" -ForegroundColor DarkGray
    }
} finally {
    $listener.Stop()
    Write-Host "`n  Server stopped." -ForegroundColor Yellow
}
