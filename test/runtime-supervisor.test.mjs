import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRuntimeSupervisor } from '../desktop/lib/runtime-supervisor.mjs'

function createChild(pid = 4100) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

function createHarness(overrides = {}) {
  const statuses = []
  const logs = []
  const spawned = []
  const terminated = []
  const dependencies = {
    inspectPort: async () => ({ occupied: false, processes: [] }),
    probeHttp: async () => new Promise(() => {}),
    spawnProcess: () => {
      const child = createChild()
      spawned.push(child)
      return child
    },
    terminateProcessTree: async pid => {
      terminated.push(pid)
    },
    emitStatus: status => statuses.push(status),
    emitLog: message => logs.push(message),
    onOutput: () => {},
    onFlush: () => {},
    delay: async () => {},
    now: () => 1000,
    ...overrides,
  }
  return {
    supervisor: createRuntimeSupervisor(dependencies),
    statuses,
    logs,
    spawned,
    terminated,
  }
}

function startPayload(port = 8080) {
  return {
    config: { port, host: '127.0.0.1' },
    launch: {
      mode: 'direct',
      command: 'llama-server.exe',
      args: ['--port', String(port)],
      cwd: '.',
      preview: 'llama-server.exe --port 8080',
    },
    directMode: true,
    baseUrl: `http://127.0.0.1:${port}`,
  }
}

async function waitFor(predicate, message = 'condition did not become true') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(message)
}

test('start rejects an occupied port without spawning a server', async () => {
  const { supervisor, statuses, spawned } = createHarness({
    inspectPort: async port => ({
      port,
      occupied: true,
      processes: [{ pid: 88, name: 'other-server.exe' }],
    }),
  })

  await assert.rejects(
    () => supervisor.start(startPayload()),
    /8080.*other-server\.exe.*88/,
  )
  assert.equal(spawned.length, 0)
  assert.equal(supervisor.snapshot().state, 'error')
  assert.match(statuses.at(-1).message, /other-server\.exe/)
})

test('a spawn failure releases the child slot so startup can be retried', async () => {
  let attempt = 0
  const { supervisor, spawned } = createHarness({
    spawnProcess: () => {
      const child = createChild(4100 + attempt)
      attempt += 1
      spawned.push(child)
      if (attempt === 1) {
        queueMicrotask(() => child.emit('error', new Error('spawn EACCES')))
      }
      return child
    },
  })

  await supervisor.start(startPayload())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(supervisor.snapshot().state, 'error')
  assert.match(supervisor.snapshot().message, /spawn EACCES/)

  await supervisor.start(startPayload())
  assert.equal(spawned.length, 2)
  assert.equal(supervisor.snapshot().state, 'starting')
})

test('health readiness requires the listener to belong to the spawned process', async () => {
  const inspections_requested = []
  let inspections = 0
  const { supervisor, spawned } = createHarness({
    inspectPort: async (port, rootPid) => {
      inspections += 1
      inspections_requested.push({ port, rootPid })
      if (inspections === 1) {
        return { occupied: false, processes: [] }
      }
      if (inspections === 2) {
        return {
          occupied: true,
          processes: [{ pid: 99, name: 'unrelated.exe', ownedByRoot: false }],
        }
      }
      return {
        occupied: true,
        processes: [{ pid: 4100, name: 'llama-server.exe', ownedByRoot: true }],
      }
    },
    probeHttp: async () => true,
  })

  await supervisor.start(startPayload())
  await waitFor(() => supervisor.snapshot().state === 'running')

  assert.equal(spawned.length, 1)
  assert.equal(supervisor.snapshot().pid, 4100)
  assert.deepEqual(inspections_requested, [
    { port: 8080, rootPid: undefined },
    { port: 8080, rootPid: 4100 },
    { port: 8080, rootPid: 4100 },
  ])
})

test('a current llama.cpp listener log marks the direct child ready', async () => {
  const { supervisor, spawned } = createHarness()

  await supervisor.start(startPayload())
  const accepted = supervisor.handleLogLine(
    '0.09.896.397 I srv  llama_server: listening on http://0.0.0.0:8080',
  )

  assert.equal(accepted, true)
  assert.equal(spawned.length, 1)
  assert.equal(supervisor.snapshot().state, 'running')
  assert.equal(supervisor.snapshot().pid, 4100)
})

test('a launcher exiting successfully while starting keeps readiness pending', async () => {
  const { supervisor, spawned, statuses } = createHarness()
  const payload = {
    ...startPayload(),
    directMode: false,
    launch: {
      mode: 'launcher',
      command: 'llama-server-launcher.exe',
      args: [],
      cwd: '.',
      preview: 'llama-server-launcher.exe',
    },
  }

  await supervisor.start(payload)
  const launcher = spawned[0]
  launcher.exitCode = 0
  launcher.emit('exit', 0)

  assert.equal(supervisor.snapshot().state, 'starting')
  assert.match(supervisor.snapshot().message, /启动器已退出/)
  assert.equal(statuses.some(status => status.state === 'error'), false)

  supervisor.handleLogLine('srv llama_server: listening on http://0.0.0.0:8080')
  assert.equal(supervisor.snapshot().state, 'running')
})

test('stop terminates the owned listener and leaves the runtime stopped', async () => {
  const { supervisor, terminated } = createHarness()

  await supervisor.start(startPayload())
  supervisor.handleLogLine('srv llama_server: listening on http://0.0.0.0:8080')
  await supervisor.stop()

  assert.deepEqual(terminated, [4100])
  assert.equal(supervisor.snapshot().state, 'stopped')
  assert.equal(supervisor.isActive(), false)
})

test('stop rediscovers the listener after a launcher detaches', async () => {
  let inspections = 0
  const { supervisor, spawned, terminated } = createHarness({
    inspectPort: async (_port, rootPid) => {
      inspections += 1
      if (inspections === 1) {
        return { occupied: false, processes: [] }
      }
      assert.equal(rootPid, 4100)
      return {
        occupied: true,
        processes: [{ pid: 4300, name: 'llama-server.exe', ownedByRoot: true }],
      }
    },
  })
  const payload = {
    ...startPayload(),
    directMode: false,
    launch: {
      mode: 'launcher',
      command: 'llama-server-launcher.exe',
      args: [],
      cwd: '.',
      preview: 'llama-server-launcher.exe',
    },
  }

  await supervisor.start(payload)
  spawned[0].exitCode = 0
  spawned[0].emit('exit', 0)
  supervisor.handleLogLine('srv llama_server: listening on http://0.0.0.0:8080')
  await supervisor.stop()

  assert.deepEqual(terminated, [4300])
  assert.equal(supervisor.snapshot().state, 'stopped')
})

test('stop during port preflight cancels the pending spawn', async () => {
  let finishInspection
  let inspections = 0
  const { supervisor, spawned } = createHarness({
    inspectPort: () => {
      inspections += 1
      return new Promise(resolve => {
        finishInspection = resolve
      })
    },
  })

  const startPromise = supervisor.start(startPayload())
  await waitFor(() => inspections === 1)
  assert.equal(supervisor.snapshot().state, 'starting')
  await supervisor.stop()
  finishInspection({ occupied: false, processes: [] })
  await startPromise

  assert.equal(spawned.length, 0)
  assert.equal(supervisor.snapshot().state, 'stopped')
})
