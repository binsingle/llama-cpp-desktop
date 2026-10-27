import { isServerReadyLine } from './runtime-policy.mjs'

const READY_PROBE_INTERVAL_MS = 800
const READY_PROBE_TIMEOUT_MS = 2500
const READY_PROBE_MAX_MS = 60 * 60 * 1000
const READY_PROBE_SLOW_HINT_MS = 120 * 1000

export async function probeHttpReady(baseUrl, {
  fetchImpl = fetch,
  timeoutMs = READY_PROBE_TIMEOUT_MS,
} = {}) {
  for (const route of ['/health', '/v1/models', '/props']) {
    try {
      const response = await fetchImpl(`${baseUrl}${route}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const status = response.status
      try {
        await response.arrayBuffer()
      } catch {
        // A body read failure does not change whether the endpoint is ready.
      }
      if (status === 200) {
        return true
      }
      if (status !== 404) {
        return false
      }
    } catch {
      // The port may not be listening yet, or this route may be unavailable.
    }
  }
  return false
}

function describePortOwner(processes = []) {
  const owners = processes
    .map(process => {
      const name = String(process?.name || '未知进程')
      const pid = Number(process?.pid)
      return Number.isFinite(pid) ? `${name} (PID ${pid})` : name
    })
    .filter(Boolean)
  return owners.length ? owners.join(', ') : '未知进程'
}

export function createRuntimeSupervisor({
  inspectPort,
  probeHttp,
  spawnProcess,
  terminateProcessTree,
  emitStatus,
  emitLog = () => {},
  onOutput = () => {},
  onFlush = () => {},
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  let child = null
  let childGeneration = 0
  let stopping = false
  let launchPid = null
  let listenerPid = null
  let currentPort = null
  let directMode = true
  let status = {
    state: 'stopped',
    message: '服务未启动',
    pid: null,
    url: 'http://127.0.0.1:8080',
    startedAt: null,
  }

  function updateStatus(next) {
    status = { ...status, ...next }
    emitStatus(status)
    return status
  }

  function markReady(source, pid = null) {
    if (status.state !== 'starting') {
      return false
    }
    listenerPid = Number(pid) || (directMode ? Number(child?.pid) || null : null)
    updateStatus({
      state: 'running',
      message: '服务正在监听',
      pid: listenerPid,
      startedAt: status.startedAt,
    })
    emitLog(source === 'health'
      ? '就绪检测通过：接口探活成功，服务已开始监听。'
      : '就绪检测通过：收到 llama.cpp 监听日志。')
    return true
  }

  async function watchReady(generation, config, baseUrl) {
    const startedAtMs = now()
    let slowHintSent = false
    while (childGeneration === generation && status.state === 'starting') {
      const elapsed = now() - startedAtMs
      if (elapsed > READY_PROBE_MAX_MS) {
        updateStatus({ message: '等待监听超时，请检查模型大小与显存占用' })
        emitLog('就绪检测超时：服务进程仍在运行但接口没有响应，可点“检查端口”排查。')
        return false
      }
      if (!slowHintSent && elapsed > READY_PROBE_SLOW_HINT_MS) {
        slowHintSent = true
        emitLog(`已等待 ${Math.round(elapsed / 1000)} 秒仍未就绪，大模型首次加载可能较慢。`)
      }

      if (await probeHttp(baseUrl)) {
        if (childGeneration !== generation || status.state !== 'starting') {
          return false
        }
        const inspection = await inspectPort(Number(config.port) || 8080, launchPid)
        const owned = inspection?.processes?.find(process => process?.ownedByRoot)
        if (owned) {
          return markReady('health', owned.pid)
        }
      }
      if (childGeneration !== generation || status.state !== 'starting') {
        return false
      }
      await delay(READY_PROBE_INTERVAL_MS)
    }
    return false
  }

  async function start({ config, launch, directMode: requestedDirectMode, baseUrl }) {
    if (child && child.exitCode === null) {
      return status
    }
    if (isActive()) {
      return status
    }

    const port = Number(config.port) || 8080
    childGeneration += 1
    const generation = childGeneration
    stopping = false
    launchPid = null
    listenerPid = null
    currentPort = port
    directMode = Boolean(requestedDirectMode)
    updateStatus({
      state: 'starting',
      message: '正在检查端口与启动条件',
      pid: null,
      url: baseUrl,
      startedAt: new Date(now()).toISOString(),
    })

    const inspection = await inspectPort(port)
    if (childGeneration !== generation || status.state !== 'starting') {
      return status
    }
    if (inspection?.occupied) {
      const message = `端口 ${port} 已被 ${describePortOwner(inspection.processes)} 占用`
      updateStatus({ state: 'error', message, pid: null, url: baseUrl })
      throw new Error(message)
    }

    updateStatus({ message: '正在启动服务' })
    try {
      child = spawnProcess(launch.command, launch.args, launch.spawnOptions)
    } catch (error) {
      child = null
      launchPid = null
      const message = error instanceof Error ? error.message : String(error)
      updateStatus({ state: 'error', message, pid: null })
      throw error
    }

    launchPid = Number(child.pid) || null
    const spawnedChild = child
    updateStatus({ pid: launchPid || null })
    spawnedChild.stdout?.on('data', chunk => onOutput('stdout', chunk))
    spawnedChild.stderr?.on('data', chunk => onOutput('stderr', chunk))
    spawnedChild.once('error', error => {
      if (spawnedChild !== child) {
        return
      }
      childGeneration += 1
      child = null
      launchPid = null
      listenerPid = null
      const message = error instanceof Error ? error.message : String(error)
      updateStatus({ state: 'error', message, pid: null })
      onFlush()
      emitLog(`启动失败：${message}`)
    })
    spawnedChild.once('exit', code => {
      if (spawnedChild !== child) {
        return
      }
      const wasStopping = stopping
      const launcherDetached = !directMode && code === 0
      child = null
      stopping = false
      if (wasStopping) {
        childGeneration += 1
        listenerPid = null
        updateStatus({ state: 'stopped', message: '服务已停止', pid: null })
      } else if (launcherDetached) {
        updateStatus({
          state: status.state === 'running' ? 'running' : 'starting',
          message: status.state === 'running' ? '服务正在监听' : '启动器已退出，等待 llama-server 监听',
          pid: listenerPid,
        })
      } else {
        childGeneration += 1
        listenerPid = null
        updateStatus({
          state: 'error',
          message: `服务进程已退出：${code ?? 'unknown'}`,
          pid: null,
        })
      }
      onFlush()
      emitLog(status.message)
    })

    void watchReady(generation, config, baseUrl)
    return status
  }

  function isActive() {
    return ['starting', 'running', 'stopping'].includes(status.state)
  }

  return {
    start,
    async stop() {
      if (!isActive() && !child) {
        return status
      }
      childGeneration += 1
      stopping = true
      updateStatus({ state: 'stopping', message: '正在停止服务' })
      let targetPid = Number(child?.pid) || listenerPid
      if (!targetPid && launchPid) {
        const inspection = await inspectPort(currentPort, launchPid)
        targetPid = Number(inspection?.processes?.find(process => process?.ownedByRoot)?.pid) || launchPid
      }
      if (targetPid) {
        await terminateProcessTree(targetPid)
      }
      child = null
      launchPid = null
      listenerPid = null
      stopping = false
      updateStatus({ state: 'stopped', message: '服务已停止', pid: null })
      onFlush()
      emitLog('服务已停止')
      return status
    },
    handleLogLine(line) {
      if (!isServerReadyLine(line)) {
        return false
      }
      return markReady('log')
    },
    snapshot() {
      return status
    },
    isActive,
  }
}
