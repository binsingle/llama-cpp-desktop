import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isServerReadyLine } from '../desktop/lib/runtime-policy.mjs'
import { probeHttpReady } from '../desktop/lib/runtime-supervisor.mjs'

const mainSource = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8')

test('readiness matches the legacy llama.cpp "server is listening" line', () => {
  assert.equal(isServerReadyLine('main: server is listening on http://127.0.0.1:8080'), true)
  assert.equal(isServerReadyLine('server is listening on http://0.0.0.0:8080'), true)
})

test('readiness matches the llama.cpp b10xxx+ "listening on" line', () => {
  assert.equal(isServerReadyLine('0.09.896.397 I srv  llama_server: listening on http://0.0.0.0:8080'), true)
  assert.equal(isServerReadyLine('llama_server: listening on http://127.0.0.1:8080'), true)
  assert.equal(isServerReadyLine('srv  llama_server: listening on http://[::]:8080'), true)
  assert.equal(isServerReadyLine('listening on: http://0.0.0.0:8080'), true)
})

test('readiness matches other historical llama.cpp startup lines', () => {
  assert.equal(isServerReadyLine('llama server listening at http://127.0.0.1:8080'), true)
  assert.equal(isServerReadyLine('server started'), true)
})

test('readiness ignores model loading, slot bookkeeping and bind errors', () => {
  assert.equal(isServerReadyLine('main: model loaded'), false)
  assert.equal(isServerReadyLine('srv  update_slots: all slots are idle'), false)
  assert.equal(isServerReadyLine('load_tensors: CUDA0 model buffer size = 1234.00 MiB'), false)
  assert.equal(isServerReadyLine("error: couldn't bind HTTP server socket, port 8080 already in use"), false)
  assert.equal(isServerReadyLine(''), false)
  assert.equal(isServerReadyLine(undefined), false)
})

test('main process delegates readiness to the runtime supervisor', () => {
  assert.match(mainSource, /runtimeSupervisor\?\.handleLogLine\(entry\.line\)/)
  assert.doesNotMatch(mainSource, /entry\.line\.includes\('server is listening'\)/)
  assert.match(mainSource, /createRuntimeSupervisor\(/)
})

test('readiness probe falls back across routes and accepts only HTTP 200', async () => {
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    return {
      status: url.endsWith('/health') ? 404 : 200,
      async arrayBuffer() {
        return new ArrayBuffer(0)
      },
    }
  }

  const ready = await probeHttpReady('http://127.0.0.1:8080', { fetchImpl })

  assert.equal(ready, true)
  assert.deepEqual(requested, [
    'http://127.0.0.1:8080/health',
    'http://127.0.0.1:8080/v1/models',
  ])
})

test('a model that is still loading does not fall through as ready', async () => {
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    return {
      status: 503,
      async arrayBuffer() {
        return new ArrayBuffer(0)
      },
    }
  }

  const ready = await probeHttpReady('http://127.0.0.1:8080', { fetchImpl })

  assert.equal(ready, false)
  assert.deepEqual(requested, ['http://127.0.0.1:8080/health'])
})
