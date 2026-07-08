# Check if onchain_collector.py is running
$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*onchain_collector*' }
if ($procs) {
    foreach ($p in $procs) {
        Write-Output "Collector still running PID $($p.ProcessId) - killing"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
} else {
    Write-Output "Collector not running."
}
