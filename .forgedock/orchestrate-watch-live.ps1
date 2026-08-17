param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$RepoPath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$StopPath
)

$ErrorActionPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$active = @{}
$files = @{}

function Write-Observation([string]$Kind, [hashtable]$Data) {
  $record = [ordered]@{
    at = [DateTimeOffset]::UtcNow.ToString('o')
    kind = $Kind
    data = $Data
  }
  [IO.File]::AppendAllText($LogPath, (($record | ConvertTo-Json -Compress -Depth 6) + "`n"), $utf8)
}

function Get-WatchedFiles {
  $paths = @(
    (Join-Path $RepoPath '.forgedock\state.db'),
    (Join-Path $RepoPath '.forgedock\state.db-wal'),
    (Join-Path $RepoPath '.forgedock\state.db-shm'),
    (Join-Path $RepoPath '.forgedock\observations.db'),
    (Join-Path $RepoPath '.forgedock\observations.db-wal'),
    (Join-Path $RepoPath '.forgedock\observations.db-shm'),
    (Join-Path $RepoPath '.forgedock\lease-witness.json')
  )
  $items = @($paths | ForEach-Object { Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue })
  $items += @(Get-ChildItem -LiteralPath (Join-Path $RepoPath '.forgedock\tasks') -File -Recurse -ErrorAction SilentlyContinue)
  $items += @(Get-ChildItem -LiteralPath (Join-Path $RepoPath '.forgedock\graph') -File -Recurse -ErrorAction SilentlyContinue)
  return $items
}

Write-Observation 'observer_started' @{ rootPid = $RootPid; repoPath = $RepoPath }

while (-not (Test-Path -LiteralPath $StopPath)) {
  $processes = @(Get-CimInstance Win32_Process)
  $descendants = @{}
  foreach ($process in $processes) {
    if ([int]$process.ProcessId -eq $RootPid) { $descendants[$RootPid] = $process }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $processes) {
      $pidValue = [int]$process.ProcessId
      $parentValue = [int]$process.ParentProcessId
      if ($descendants.ContainsKey($parentValue) -and -not $descendants.ContainsKey($pidValue)) {
        $parentProcess = $descendants[$parentValue]
        $childCreated = [DateTime]$process.CreationDate
        $parentCreated = [DateTime]$parentProcess.CreationDate
        # Win32_Process retains only a numeric parent PID. If that parent has
        # exited and Windows reuses its PID, an older unrelated process can
        # otherwise appear beneath the current terminal tree. A real child
        # cannot predate its parent process.
        if ($childCreated -ge $parentCreated) {
          $descendants[$pidValue] = $process
          $changed = $true
        }
      }
    }
  }

  foreach ($pidValue in $descendants.Keys) {
    if (-not $active.ContainsKey($pidValue)) {
      $process = $descendants[$pidValue]
      Write-Observation 'process_started' @{
        pid = [int]$process.ProcessId
        parentPid = [int]$process.ParentProcessId
        name = [string]$process.Name
        commandLine = [string]$process.CommandLine
        creationDate = [string]$process.CreationDate
      }
    }
  }
  foreach ($pidValue in @($active.Keys)) {
    if (-not $descendants.ContainsKey($pidValue)) {
      Write-Observation 'process_exited' @{ pid = [int]$pidValue }
    }
  }
  $active = $descendants

  $currentFiles = @{}
  foreach ($item in @(Get-WatchedFiles)) {
    $relative = $item.FullName.Substring($RepoPath.Length).TrimStart('\')
    $fingerprint = "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
    $currentFiles[$relative] = $fingerprint
    if (-not $files.ContainsKey($relative)) {
      Write-Observation 'file_created' @{ path = $relative; length = [long]$item.Length; modifiedUtc = $item.LastWriteTimeUtc.ToString('o') }
    } elseif ($files[$relative] -ne $fingerprint) {
      Write-Observation 'file_changed' @{ path = $relative; length = [long]$item.Length; modifiedUtc = $item.LastWriteTimeUtc.ToString('o') }
    }
  }
  foreach ($relative in @($files.Keys)) {
    if (-not $currentFiles.ContainsKey($relative)) {
      Write-Observation 'file_removed' @{ path = $relative }
    }
  }
  $files = $currentFiles
  Start-Sleep -Milliseconds 250
}

Write-Observation 'observer_stopped' @{ rootPid = $RootPid }
