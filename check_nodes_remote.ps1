$ProgressPreference = 'SilentlyContinue'
$h = @{ 'Accept' = 'application/json'; 'User-Agent' = 'curl/8' }
$proxy = 'http://127.0.0.1:7897'

$targets = @(
    @{ label = 'nsg4 (OPEN locally)';  host = '18.142.125.225:443' },
    @{ label = 'nus2 (timeout)';       host = '18.222.30.77:443' },
    @{ label = 'njp2 (timeout)';       host = '13.231.217.220:443' },
    @{ label = 'ntw1 (timeout)';       host = '36.227.244.33:443' },
    @{ label = 'njp1 (refused)';       host = '54.92.126.128:443' }
)

$started = @()
foreach ($t in $targets) {
    try {
        $u = "https://check-host.net/check-tcp?host=$($t.host)&max_nodes=3"
        $r = Invoke-RestMethod -Uri $u -Headers $h -Proxy $proxy -TimeoutSec 25
        $started += [pscustomobject]@{ Label = $t.label; Host = $t.host; Id = $r.request_id; Nodes = $r.nodes }
        "started: $($t.label) -> $($r.request_id)"
    } catch { "start failed: $($t.label) : $($_.Exception.Message)" }
}

Start-Sleep -Seconds 10

foreach ($s in $started) {
    $nodeMap = @{}
    foreach ($p in $s.Nodes.PSObject.Properties) { $nodeMap[$p.Name] = ($p.Value -join '/') }
    try {
        $res = Invoke-RestMethod -Uri "https://check-host.net/check-result/$($s.Id)" -Headers $h -Proxy $proxy -TimeoutSec 25
        "`n=== $($s.Label)  [$($s.Host)] ==="
        foreach ($k in $res.PSObject.Properties.Name) {
            $v = $res.$k
            if ($null -eq $v) { "{0,-26} pending" -f $nodeMap[$k]; continue }
            $s2 = ($v | ForEach-Object {
                if ($_.PSObject.Properties.Name -contains 'error') { "FAIL($($_.error))" } else { "OK $([math]::Round([double]$_.time,3))s" }
            }) -join ', '
            "{0,-26} {1}" -f $nodeMap[$k], $s2
        }
    } catch { "poll failed: $($s.Label) : $($_.Exception.Message)" }
}
