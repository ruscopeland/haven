# Kill API (port 8000) and Engine (node from marker-engine)
$conn = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
foreach ($c in $conn) {
    if ($c.OwningProcess -gt 0) {
        Write-Output "Killing API PID $($c.OwningProcess)"
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
$engines = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*marker-engine*' }
foreach ($e in $engines) {
    Write-Output "Killing Engine PID $($e.ProcessId)"
    Stop-Process -Id $e.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Write-Output "Done."
