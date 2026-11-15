$pipeName = 'verge-mihomo-sidecar-release-e8c83592979b521747713f2406b6a72be5c9148e752aa1dfd880fe7f19407a51'
$secret = 'set-your-secret'

$nodes = @('HK-N-1','HK-N-2','HK-N-3','HK-N-4','HK-N-5','JP-U-1','JP-U-2','JP-U-3','JP-U-4','JP-U-5')

function Test-NodeDelay {
    param($Name, $PipeName, $Secret)
    $path = "/proxies/$([uri]::EscapeDataString($Name))/delay?timeout=4000&url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204"
    $ps = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $ps.Connect(3000)
        $req = "GET $path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $Secret`r`nConnection: close`r`n`r`n"
        $b = [System.Text.Encoding]::UTF8.GetBytes($req); $ps.Write($b, 0, $b.Length); $ps.Flush()
        $sr = New-Object System.IO.StreamReader($ps, [System.Text.Encoding]::UTF8)
        $raw = $sr.ReadToEnd()
        $i = $raw.IndexOf("`r`n`r`n")
        $body = if ($i -ge 0) { $raw.Substring($i + 4) } else { $raw }
        if ($raw.Substring(0, [Math]::Max($i,0)) -match 'chunked') {
            $o = New-Object System.Text.StringBuilder; $p = 0
            while ($p -lt $body.Length) {
                $nl = $body.IndexOf("`r`n", $p); if ($nl -lt 0) { break }
                $hx = $body.Substring($p, $nl - $p).Trim(); if (-not $hx) { break }
                $len = [Convert]::ToInt32($hx, 16); if ($len -eq 0) { break }
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
        return [pscustomobject]@{ Node = $Name; Delay = $null; Message = "pipe-error" }
    } finally { $ps.Dispose() }
}

$jobs = foreach ($n in $nodes) { Start-Job -ScriptBlock ${function:Test-NodeDelay} -ArgumentList $n, $pipeName, $secret }
$out = $jobs | Wait-Job -Timeout 90 | Receive-Job
$jobs | Remove-Job -Force
$out | Sort-Object { if ($null -eq $_.Delay) { 1 } else { 0 } }, Node | Format-Table Node, Delay, Message -AutoSize | Out-String -Width 120
