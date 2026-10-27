import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortInspector } from '../desktop/lib/port-inspector.mjs'

function rawInspection({ ownerPid = 300, connections = true } = {}) {
  return {
    connections: connections
      ? [{ OwningProcess: ownerPid, State: 'Listen', LocalAddress: '127.0.0.1' }]
      : [],
    processes: [
      { ProcessId: 100, ParentProcessId: 1, Name: 'llama-server-launcher' },
      { ProcessId: 200, ParentProcessId: 100, Name: 'helper' },
      { ProcessId: 300, ParentProcessId: 200, Name: 'llama-server' },
      { ProcessId: 900, ParentProcessId: 1, Name: 'unrelated' },
    ],
  }
}

test('port inspection traces the listener through the launcher process tree', async () => {
  const inspectPort = createPortInspector({
    runPowerShellJson: async () => rawInspection(),
    canBindPort: async () => false,
  })

  const result = await inspectPort(8080, 100)

  assert.equal(result.occupied, true)
  assert.deepEqual(result.processes, [{
    pid: 300,
    parentPid: 200,
    name: 'llama-server',
    state: 'Listen',
    localAddress: '127.0.0.1',
    ownedByRoot: true,
  }])
})

test('port inspection does not claim an unrelated listener', async () => {
  const inspectPort = createPortInspector({
    runPowerShellJson: async () => rawInspection({ ownerPid: 900 }),
    canBindPort: async () => false,
  })

  const result = await inspectPort(8080, 100)

  assert.equal(result.processes[0].pid, 900)
  assert.equal(result.processes[0].ownedByRoot, false)
})

test('a free bindable port is not occupied', async () => {
  const inspectPort = createPortInspector({
    runPowerShellJson: async () => rawInspection({ connections: false }),
    canBindPort: async () => true,
  })

  const result = await inspectPort(8080)

  assert.equal(result.occupied, false)
  assert.deepEqual(result.processes, [])
})

test('direct owner PID is trusted when process metadata is unavailable', async () => {
  const inspectPort = createPortInspector({
    runPowerShellJson: async () => ({
      connections: [{ OwningProcess: 300, State: 'Listen', LocalAddress: '127.0.0.1:8080' }],
      processes: [],
    }),
    canBindPort: async () => false,
  })

  const result = await inspectPort(8080, 300)

  assert.equal(result.processes[0].pid, 300)
  assert.equal(result.processes[0].ownedByRoot, true)
})
