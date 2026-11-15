param([string]$ProfilePath, [int]$TimeoutMs = 8000)

$names = Select-String -Path $ProfilePath -Pattern '^\s*server:\s*(\S+)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value } |
    Where-Object { $_ -like '*.sncet.com' } | Sort-Object -Unique

$targets = @()
foreach ($h in $names) {
    try {
        $ips = @(Resolve-DnsName -Name $h -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
        if ($ips.Count -gt 0) { $targets += [pscustomobject]@{ Host = $h; IP = $ips[0]; All = ($ips -join ',') } }
    } catch { }
}

$list = New-Object System.Collections.ArrayList
foreach ($t in $targets) {
    $c = New-Object System.Net.Sockets.TcpClient
    $task = $c.ConnectAsync([string]$t.IP, [int]443)
    [void]$list.Add([pscustomobject]@{ Host = $t.Host; IP = $t.IP; C = $c; Task = $task; SW = [System.Diagnostics.Stopwatch]::StartNew() })
}

$tasks = [System.Threading.Tasks.Task[]]($list | ForEach-Object { $_.Task })
try { [void][System.Threading.Tasks.Task]::WaitAll($tasks, $TimeoutMs) } catch { }

$rows = foreach ($j in $list) {
    $st = $j.Task.Status
    $ok = ($st -eq 'RanToCompletion') -and $j.C.Connected
    $note = ''
    if ($st -eq 'Faulted') {
        $e = $j.Task.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        $note = $e.Message
    }
    $j.C.Close()
    [pscustomobject]@{
        Host  = $j.Host
        IP    = $j.IP
        State = if ($ok) { 'OPEN' } elseif ($st -eq 'Faulted') { 'CLOSED/ERR' } else { 'TIMEOUT' }
        Ms    = [int]$j.SW.ElapsedMilliseconds
        Note  = $note
    }
}

"total: $($rows.Count)"
"OPEN        : $(@($rows | Where-Object State -eq 'OPEN').Count)"
"CLOSED/ERR  : $(@($rows | Where-Object State -eq 'CLOSED/ERR').Count)"
"TIMEOUT     : $(@($rows | Where-Object State -eq 'TIMEOUT').Count)"
"===== detail ====="
$rows | Sort-Object State, Host | Format-Table -AutoSize | Out-String -Width 200
