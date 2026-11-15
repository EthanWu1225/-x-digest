$pipeName = 'verge-mihomo-sidecar-release-e8c83592979b521747713f2406b6a72be5c9148e752aa1dfd880fe7f19407a51'
$secret = 'set-your-secret'

function Invoke-ClashApi {
    param([string]$Path, [string]$Method = 'GET', [int]$ConnectTimeout = 3000, [int]$ReadTimeoutMs = 60000)
    $ps = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $ps.Connect($ConnectTimeout)
        $req = "$Method $Path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $secret`r`nConnection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($req)
        $ps.Write($bytes, 0, $bytes.Length)
        $ps.Flush()

        $ms = New-Object System.IO.MemoryStream
        $buf = New-Object byte[] 16384
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            if (-not $ps.IsConnected -and $ms.Length -gt 0) { break }
            if ($sw.ElapsedMilliseconds -gt $ReadTimeoutMs) { break }
            try { $n = $ps.Read($buf, 0, $buf.Length) } catch { break }
            if ($n -le 0) { break }
            $ms.Write($buf, 0, $n)
        }
        $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        $ms.Dispose()

        $idx = $raw.IndexOf("`r`n`r`n")
        if ($idx -lt 0) { return @{ status = 'no-response'; raw = $raw } }
        $head = $raw.Substring(0, $idx)
        $body = $raw.Substring($idx + 4)
        $status = if ($head -match '^HTTP/1\.1 (\d+)') { [int]$Matches[1] } else { 0 }

        if ($head -match 'Transfer-Encoding:\s*chunked') {
            $out = New-Object System.Text.StringBuilder
            $pos = 0
            while ($pos -lt $body.Length) {
                $nl = $body.IndexOf("`r`n", $pos)
                if ($nl -lt 0) { break }
                $lenHex = $body.Substring($pos, $nl - $pos).Trim()
                if (-not $lenHex) { break }
                try { $len = [Convert]::ToInt32($lenHex, 16) } catch { break }
                if ($len -eq 0) { break }
                $avail = [Math]::Min($len, $body.Length - ($nl + 2))
                if ($avail -le 0) { break }
                [void]$out.Append($body.Substring($nl + 2, $avail))
                $pos = $nl + 2 + $len + 2
            }
            $body = $out.ToString()
        }
        return @{ status = $status; body = $body; head = $head }
    } finally { $ps.Dispose() }
}

$r = Invoke-ClashApi '/group/GLOBAL/delay?timeout=4000&url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204' -ReadTimeoutMs 120000
"status: $($r.status)  bodylen: $($r.body.Length)"
$map = $null
try { $map = $r.body | ConvertFrom-Json } catch { "parse fail: $($r.body.Substring(0,[Math]::Min(300,$r.body.Length)))" }

if ($map) {
    $rows = foreach ($p in $map.PSObject.Properties) { [pscustomobject]@{ Node = $p.Name; Delay = $p.Value } }
    "alive: $(@($rows | Where-Object { $_.Delay -gt 0 }).Count) / $($rows.Count)"
    "`n=== ALIVE ==="
    $rows | Where-Object { $_.Delay -gt 0 } | Sort-Object Delay | Format-Table -AutoSize | Out-String -Width 120
    "`n=== DEAD ==="
    ($rows | Where-Object { -not ($_.Delay -gt 0) } | Sort-Object Node | ForEach-Object { $_.Node }) -join ', '
}
