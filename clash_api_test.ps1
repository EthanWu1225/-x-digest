$pipeName = 'verge-mihomo-sidecar-release-e8c83592979b521747713f2406b6a72be5c9148e752aa1dfd880fe7f19407a51'
$secret = 'set-your-secret'

function Invoke-ClashApi {
    param([string]$Path, [string]$Method = 'GET')
    try {
        $ps = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
        $ps.Connect(3000)
        $req = "$Method $Path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $secret`r`nConnection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($req)
        $ps.Write($bytes, 0, $bytes.Length)
        $ps.Flush()
        $sr = New-Object System.IO.StreamReader($ps, [System.Text.Encoding]::UTF8)
        $resp = $sr.ReadToEnd()
        $sr.Dispose(); $ps.Dispose()
        $idx = $resp.IndexOf("`r`n`r`n")
        if ($idx -lt 0) { return $resp }
        $body = $resp.Substring($idx + 4)
        # chunked decoding
        if ($resp.Substring(0, $idx) -match 'Transfer-Encoding:\s*chunked') {
            $out = New-Object System.Text.StringBuilder
            $pos = 0
            while ($pos -lt $body.Length) {
                $nl = $body.IndexOf("`r`n", $pos)
                if ($nl -lt 0) { break }
                $lenHex = $body.Substring($pos, $nl - $pos).Trim()
                if (-not $lenHex) { break }
                $len = [Convert]::ToInt32($lenHex, 16)
                if ($len -eq 0) { break }
                [void]$out.Append($body.Substring($nl + 2, $len))
                $pos = $nl + 2 + $len + 2
            }
            return $out.ToString()
        }
        return $body
    } catch { return "PIPE-ERR: $($_.Exception.Message)" }
}

$v = Invoke-ClashApi '/version'
"/version -> $v"

$proxies = Invoke-ClashApi '/proxies'
$obj = $null
try { $obj = $proxies | ConvertFrom-Json } catch { "proxies JSON parse failed (len=$($proxies.Length))" }

if ($obj) {
    $global = $obj.proxies.GLOBAL
    "GLOBAL type=$($global.type) now=$($global.now) all=$($global.all.Count)"
    "`n=== per-node delay test (gstatic 204, 4s) ==="
    $rows = foreach ($name in $global.all) {
        $enc = [uri]::EscapeDataString($name)
        $r = Invoke-ClashApi "/proxies/$enc/delay?timeout=4000&url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204"
        $d = try { ($r | ConvertFrom-Json).delay } catch { $null }
        $msg = try { ($r | ConvertFrom-Json).message } catch { 'parse-err' }
        [pscustomobject]@{ Node = $name; Delay = $d; Message = $msg }
    }
    $rows | Sort-Object { if ($null -eq $_.Delay) { 1 } else { 0 } }, Node | Format-Table -AutoSize | Out-String -Width 160
}
