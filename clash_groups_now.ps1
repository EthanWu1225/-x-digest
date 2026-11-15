$pipeName = 'verge-mihomo-sidecar-release-e8c83592979b521747713f2406b6a72be5c9148e752aa1dfd880fe7f19407a51'
$secret = 'set-your-secret'

function Get-ClashJson {
    param([string]$Path)
    $ps = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $ps.Connect(3000)
        $req = "GET $Path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $secret`r`nConnection: close`r`n`r`n"
        $b = [System.Text.Encoding]::UTF8.GetBytes($req)
        $ps.Write($b, 0, $b.Length); $ps.Flush()
        $ms = New-Object System.IO.MemoryStream
        $buf = New-Object byte[] 65536
        while ($true) {
            try { $n = $ps.Read($buf, 0, $buf.Length) } catch { break }
            if ($n -le 0) { break }
            $ms.Write($buf, 0, $n)
        }
        $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        $ms.Dispose()
        $i = $raw.IndexOf("`r`n`r`n")
        if ($i -lt 0) { return $null }
        $head = $raw.Substring(0, $i)
        $body = $raw.Substring($i + 4)
        if ($head -match 'Transfer-Encoding:\s*chunked') {
            $o = New-Object System.Text.StringBuilder
            $p = 0
            while ($p -lt $body.Length) {
                $nl = $body.IndexOf("`r`n", $p); if ($nl -lt 0) { break }
                $hx = $body.Substring($p, $nl - $p).Trim(); if (-not $hx) { break }
                try { $len = [Convert]::ToInt32($hx, 16) } catch { break }
                if ($len -eq 0) { break }
                $take = [Math]::Min($len, $body.Length - ($nl + 2))
                if ($take -le 0) { break }
                [void]$o.Append($body.Substring($nl + 2, $take))
                $p = $nl + 2 + $len + 2
            }
            $body = $o.ToString()
        }
        return ($body | ConvertFrom-Json)
    } finally { $ps.Dispose() }
}

$cfg = Get-ClashJson '/configs'
"mode = $($cfg.mode)   tun = $($cfg.tun.enable)   mixed-port = $($cfg.'mixed-port')"

$all = Get-ClashJson '/proxies'
$show = '主代理','自动选择','负载均衡','黑名单网站','中国大陆网站','HK自动选择','TW自动选择','Google','Telegram','Netflix'
foreach ($n in $show) {
    $p = $all.proxies.$n
    if ($p) {
        $now = if ($p.now) { $p.now } else { '-' }
        $cnt = if ($p.all) { $p.all.Count } else { 0 }
        "{0,-14} type={1,-10} now={2,-14} 备选 {3} 个" -f $n, $p.type, $now, $cnt
    }
}
"`n=== GLOBAL 里被隐藏的项数 / 节点总数 ==="
"all proxies: $($all.proxies.PSObject.Properties.Count)"
