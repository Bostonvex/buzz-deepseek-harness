import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  modelChildEnvironment,
  startModelProxySidecar,
} from '../model-proxy-sidecar.mjs'

function fakeProxy(directory, firstLine) {
  const executable = join(directory, 'fake-model-proxy')
  writeFileSync(executable, `#!/usr/bin/env node
const forbidden = ['BUZZ_PRIVATE_KEY', 'OPENAI_API_KEY', 'BUZZ_TELEMETRY_TOKEN_FILE']
if (forbidden.some((key) => process.env[key])) process.exit(41)
process.stdout.write(${JSON.stringify(`${firstLine}\n`)})
setInterval(() => {}, 1000)
process.on('SIGTERM', () => process.exit(0))
`, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return executable
}

function environment(executable) {
  return {
    PATH: process.env.PATH,
    BUZZ_MODEL_PROXY_ENABLED: '1',
    BUZZ_MODEL_PROXY_BIN: executable,
    BUZZ_TELEMETRY_ENABLED: '1',
    BUZZ_TELEMETRY_URL: 'http://127.0.0.1:7900/api/v1/events',
    BUZZ_TELEMETRY_TOKEN_FILE: '/private/test/token',
    BUZZ_TELEMETRY_IDENTITY_SALT_FILE: '/private/test/salt',
    BUZZ_TELEMETRY_ENDPOINT_ID: 'test-endpoint',
    BUZZ_PRIVATE_KEY: 'must-not-reach-proxy',
    OPENAI_API_KEY: 'must-not-reach-proxy',
  }
}

test('starts an isolated loopback proxy and returns model/context URLs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-model-proxy-'))
  const executable = fakeProxy(
    directory,
    'Buzz OpenAI timing proxy listening on http://127.0.0.1:43123',
  )
  try {
    const proxy = await startModelProxySidecar({
      upstreamBaseUrl: 'https://model.example.test/v1',
      model: 'deepseek-test',
      harness: 'deepseek',
      environment: environment(executable),
    })
    assert.equal(proxy.active, true)
    assert.equal(proxy.modelBaseUrl, 'http://127.0.0.1:43123/v1')
    assert.equal(proxy.contextUrl, 'http://127.0.0.1:43123/__buzz/context')
    await proxy.stop()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('fails open to the direct upstream when proxy startup is invalid', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-model-proxy-fail-'))
  const executable = fakeProxy(directory, 'unexpected output')
  const diagnostics = []
  try {
    const proxy = await startModelProxySidecar({
      upstreamBaseUrl: 'https://model.example.test/v1',
      model: 'deepseek-test',
      harness: 'deepseek',
      environment: environment(executable),
      diagnostic: (message) => diagnostics.push(message),
    })
    assert.equal(proxy.active, false)
    assert.equal(proxy.modelBaseUrl, 'https://model.example.test/v1')
    assert.match(diagnostics.join('\n'), /using direct upstream/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps telemetry and proxy configuration out of the DeepSeek child', () => {
  const child = modelChildEnvironment({
    BUZZ_PRIVATE_KEY: 'seat-key',
    BUZZ_TELEMETRY_TOKEN_FILE: '/private/token',
    BUZZ_MODEL_PROXY_BIN: '/private/proxy',
    DSH_BASE_URL: 'https://direct.example.test/v1',
  }, 'DSH_BASE_URL', 'http://127.0.0.1:43123/v1')
  assert.deepEqual(child, {
    BUZZ_PRIVATE_KEY: 'seat-key',
    DSH_BASE_URL: 'http://127.0.0.1:43123/v1',
  })
})

test('DeepSeek requests streaming usage needed for tokens per second', () => {
  const config = readFileSync(new URL('../cordis.yml', import.meta.url), 'utf8')
  assert.match(config, /supportsUsageInStreaming:\s*true/)
})
