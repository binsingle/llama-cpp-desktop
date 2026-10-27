function asArray(value) {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function readField(value, name) {
  if (!value || typeof value !== 'object') return undefined
  const expected = String(name).toLowerCase()
  const key = Object.keys(value).find(candidate => candidate.toLowerCase() === expected)
  return key ? value[key] : undefined
}

function belongsToRoot(process, rootPid, processMap) {
  if (!process || !Number.isFinite(rootPid) || rootPid <= 0) {
    return false
  }
  let cursor = process
  const seen = new Set()
  while (cursor) {
    const pid = Number(readField(cursor, 'processId') ?? readField(cursor, 'pid'))
    if (!Number.isFinite(pid) || seen.has(pid)) {
      return false
    }
    if (pid === rootPid) {
      return true
    }
    seen.add(pid)
    const parentPid = Number(readField(cursor, 'parentProcessId') ?? readField(cursor, 'parentPid'))
    cursor = Number.isFinite(parentPid) ? processMap.get(parentPid) : null
  }
  return false
}

export function buildPortInspectionScript(port) {
  const targetPort = Number(port) || 8080
  return [
    '$connections = @()',
    `try { $connections = @(Get-NetTCPConnection -LocalPort ${targetPort} -ErrorAction Stop | Select-Object OwningProcess, State, LocalAddress) } catch { }`,
    'if ($connections.Count -eq 0) {',
    `  $connections = @(netstat.exe -ano -p tcp | ForEach-Object {`,
    '    $parts = @($_ -split "\\s+" | Where-Object { $_ })',
    '    if ($parts.Count -ge 5) {',
    '      $match = [regex]::Match([string]$parts[1], ":(\\d+)$")',
    `      if ($match.Success -and [int]$match.Groups[1].Value -eq ${targetPort}) {`,
    '        [pscustomobject]@{ OwningProcess = [int]$parts[4]; State = [string]$parts[3]; LocalAddress = [string]$parts[1] }',
    '      }',
    '    }',
    '  })',
    '}',
    'try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, Name) } catch {',
    '  $processes = @(Get-Process | Select-Object @{ Name = "ProcessId"; Expression = { $_.Id } }, @{ Name = "ParentProcessId"; Expression = { 0 } }, Name)',
    '}',
    '[pscustomobject]@{ connections = $connections; processes = $processes } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ')
}

export function createPortInspector({ runPowerShellJson, canBindPort }) {
  async function suggestedPort(startPort) {
    for (let port = startPort + 1; port < startPort + 40; port += 1) {
      if (await canBindPort(port)) return port
    }
    return startPort + 1
  }

  return async function inspectPort(port, rootPid = null) {
    const targetPort = Number(port) || 8080
    const expectedRootPid = Number(rootPid) || null
    const raw = await runPowerShellJson(buildPortInspectionScript(targetPort), {
      connections: [],
      processes: [],
    })
    const processMap = new Map(
      asArray(raw?.processes)
        .map(process => {
          const normalized = {
            processId: Number(readField(process, 'processId')),
            parentProcessId: Number(readField(process, 'parentProcessId')),
            name: String(readField(process, 'name') || 'unknown'),
          }
          return [normalized.processId, normalized]
        })
        .filter(([pid]) => Number.isFinite(pid)),
    )
    const processes = asArray(raw?.connections)
      .map(connection => {
        const pid = Number(readField(connection, 'owningProcess'))
        const process = processMap.get(pid)
        return {
          pid,
          parentPid: Number(process?.parentProcessId) || null,
          name: String(process?.name || 'unknown'),
          state: String(readField(connection, 'state') || ''),
          localAddress: String(readField(connection, 'localAddress') || ''),
          ownedByRoot: pid === expectedRootPid || belongsToRoot(process, expectedRootPid, processMap),
        }
      })
      .filter(process => Number.isFinite(process.pid) && process.pid > 0)
    const occupied = processes.length > 0 || !(await canBindPort(targetPort))
    return {
      checked: true,
      port: targetPort,
      occupied,
      processes,
      suggestedPort: occupied ? await suggestedPort(targetPort) : targetPort,
    }
  }
}
