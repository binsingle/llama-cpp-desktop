import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isServerReadyLine } from '../desktop/lib/runtime-policy.mjs'

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

test('main process readiness detection is version tolerant and has an HTTP probe fallback', () => {
  assert.match(mainSource, /isServerReadyLine\(entry\.line\)/)
  assert.doesNotMatch(mainSource, /entry\.line\.includes\('server is listening'\)/)
  assert.match(mainSource, /async function probeHttpReady\(/)
  assert.match(mainSource, /async function watchServerReady\(/)
  assert.match(mainSource, /void watchServerReady\(config\)/)
  assert.match(mainSource, /readyProbeRunId \+= 1/)
})

test('readiness probe accepts only HTTP 200 and falls back across server routes', () => {
  const probe = mainSource.match(/async function probeHttpReady\([\s\S]*?\n\}/)?.[0] || ''
  assert.match(probe, /'\/health'/)
  assert.match(probe, /'\/v1\/models'/)
  assert.match(probe, /status === 200/)
  assert.match(probe, /status !== 404/)
  assert.match(probe, /AbortSignal\.timeout\(READY_PROBE_TIMEOUT_MS\)/)
})
