$pipeName = 'verge-mihomo-sidecar-release-e8c83592979b521747713f2406b6a72be5c9148e752aa1dfd880fe7f19407a51'
$secret = 'set-your-secret'

$nodes = @('US-N-1','US-N-4','US-N-5','SG-N-4','SG-N-5','TW-N-住宅-8','HK-N-1','HK-N-4','JP-N-5','KR-N-4','TW-N-住宅-9','US-N-2')

function Test-NodeDelay {
    param($Name, $PipeName, $Secret)
    $path = "/proxies/$([uri]::EscapeDataString($Name))/delay?timeout=4000&url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204"
    $ps = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $ps.Connect(3000)
        $req = "GET $path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $Secret`r`nConnection: close`r`n`r`n"
        $b = [System.Text.Encoding]::UTF8.GetBytes($req); $ps.Write($b, 0, $b.Length); $ps.Flush()
        $ms = New-Object System.IO.MemoryStream
        $buf = New-Object byte[] 8192
        while ($true) {
            try { $n = $ps.Read($buf, 0, $buf.Length) } catch { break }
            if ($n -le 0) { break }
            $ms.Write($buf, 0, $n)
        }
        $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        $i = $raw.IndexOf("`r`n`r`n")
        $body = if ($i -ge 0) { $raw.Substring($i + 4) } else { $raw }
        if ($raw -match 'Transfer-Encoding:\s*chunked') {
            $o = New-Object System.Text.StringBuilder; $p = 0
            while ($p -lt $body.Length) {
                $nl = $body.IndexOf("`r`n", $p); if ($nl -lt 0) { break }
                $hx = $body.Substring($p, $nl - $p).Trim(); if (-not $hx) { break }
                try { $len = [Convert]::ToInt32($hx, 16) } catch { break }
                if ($len -eq 0) { break }
                [void]$o.Append($body.Substring($nl + 2, [Math]::Min($len, $body.Length - ($nl + 2))))
                $p = $nl + 2 + $len + 2
            }
            $body = $o.ToString()
        }
        $j = $null; try { $j = $body | ConvertFrom-Json } catch { }
        return [pscustomobject]@{
            Node    = $Name
            Delay   = if ($j -and $j.delay) { $j.delay } else { $null }
            Message = if ($j -and $j.message) { $j.message } else { '' }
        }
    } catch {
        return [pscustomobject]@{ Node = $Name; Delay = $null; Message = "pipe-error: $($_.Exception.Message)" }
    } finally { $ps.Dispose() }
}

$jobs = foreach ($n in $nodes) {
    Start-Job -ScriptBlock ${function:Test-NodeDelay} -ArgumentList $n, $pipeName, $secret
}
$out = $jobs | Wait-Job -Timeout 120 | Receive-Job
$jobs | Remove-Job -Force
$out | Sort-Object { if ($null -eq $_.Delay) { 1 } else { 0 } }, Node | Format-Table -AutoSize | Out-String -Width 160
