import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as acp from '@agentclientprotocol/sdk'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fakeMcp = join(root, 'test/fixtures/fake-buzz-mcp.mjs')
const token = 'deepseek-telemetry-test-token-0000000000000000'
const salt = 'deepseek-telemetry-test-salt-00000000'

class TestClient {
  async requestPermission() {
    return { outcome: { outcome: 'cancelled' } }
  }

  async sessionUpdate() {}
}

function privateFile(directory, name, value) {
  const path = join(directory, name)
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function startBridge({ collectorUrl, directory, displayName, suffix }) {
  const child = spawn(join(root, 'deepseek-harness-acp'), [], {
    cwd: root,
    env: {
      ...process.env,
      BUZZ_TELEMETRY_ENABLED: '1',
      BUZZ_TELEMETRY_URL: collectorUrl,
      BUZZ_TELEMETRY_TOKEN_FILE: join(directory, 'token'),
      BUZZ_TELEMETRY_IDENTITY_SALT_FILE: join(directory, 'salt'),
      BUZZ_TELEMETRY_ENDPOINT_ID: 'deepseek-test-endpoint',
      BUZZ_TELEMETRY_FLUSH_INTERVAL_MS: '10',
      BUZZ_TELEMETRY_TIMEOUT_MS: '25',
      DSH_TRUSTED_MCP_COMMAND: fakeMcp,
      DSH_ACP_SESSIONS_ROOT: join(directory, `sessions-${suffix}`),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const connection = new acp.ClientSideConnection(
    () => new TestClient(),
    acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  )
  return { child, connection, displayName, getStderr: () => stderr }
}

async function createSession(bridge, secretValue) {
  await bridge.connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'telemetry-test', version: '1.0.0' },
    clientCapabilities: {},
  })
  return bridge.connection.newSession({
    cwd: root,
    mcpServers: [{
      name: 'buzz-dev-mcp',
      command: fakeMcp,
      args: [],
      env: [
        { name: 'BUZZ_RELAY_URL', value: 'ws://127.0.0.1:1' },
        { name: 'BUZZ_PRIVATE_KEY', value: secretValue },
        { name: 'BUZZ_AUTH_TAG', value: `auth-${secretValue}` },
        { name: 'BUZZ_ACP_DISPLAY_NAME', value: bridge.displayName },
      ],
    }],
  })
}

async function stopBridge(bridge) {
  const exited = once(bridge.child, 'exit')
  bridge.child.kill('SIGTERM')
  await exited
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('two DeepSeek bridge processes emit isolated, content-free agent telemetry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-telemetry-'))
  privateFile(directory, 'token', token)
  privateFile(directory, 'salt', salt)
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      assert.equal(request.url, '/api/v1/events')
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      received.push(...JSON.parse(body))
      response.writeHead(202).end()
    })
  })

  const port = await listen(server)
  const collectorUrl = `http://127.0.0.1:${port}/api/v1/events`
  const first = startBridge({ collectorUrl, directory, displayName: 'DeepSeek Alpha', suffix: 'alpha' })
  const second = startBridge({ collectorUrl, directory, displayName: 'DeepSeek Beta', suffix: 'beta' })
  const secretOne = 'PRIVATE-CONTENT-ALPHA-DO-NOT-EMIT'
  const secretTwo = 'PRIVATE-CONTENT-BETA-DO-NOT-EMIT'

  try {
    const sessions = await Promise.all([
      createSession(first, secretOne),
      createSession(second, secretTwo),
    ])
    await Promise.all([stopBridge(first), stopBridge(second)])

    const processEvents = received.filter((event) => event.event_type === 'process.started')
    const sessionEvents = received.filter((event) => event.event_type === 'session.started')
    assert.equal(processEvents.length, 2)
    assert.equal(sessionEvents.length, 2)
    assert.deepEqual(
      new Set(processEvents.map((event) => event.agent.display_name)),
      new Set(['DeepSeek Alpha', 'DeepSeek Beta']),
    )
    assert.equal(new Set(processEvents.map((event) => event.agent.id)).size, 2)
    assert.equal(new Set(processEvents.map((event) => event.producer.instance_id)).size, 2)
    assert.equal(new Set(sessionEvents.map((event) => event.session_id)).size, 2)

    const serialized = JSON.stringify(received)
    for (const forbidden of [secretOne, secretTwo, `auth-${secretOne}`, `auth-${secretTwo}`, root]) {
      assert.equal(serialized.includes(forbidden), false)
    }
    for (const session of sessions) assert.equal(serialized.includes(session.sessionId), false)
  } finally {
    if (first.child.exitCode === null) first.child.kill('SIGKILL')
    if (second.child.exitCode === null) second.child.kill('SIGKILL')
    server.close()
    await once(server, 'close')
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unavailable collector does not change ACP responses or delay exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-telemetry-offline-'))
  privateFile(directory, 'token', token)
  privateFile(directory, 'salt', salt)
  const unusedServer = createServer()
  const port = await listen(unusedServer)
  unusedServer.close()
  await once(unusedServer, 'close')

  const bridge = startBridge({
    collectorUrl: `http://127.0.0.1:${port}/api/v1/events`,
    directory,
    displayName: 'DeepSeek Offline',
    suffix: 'offline',
  })
  try {
    const session = await createSession(bridge, 'PRIVATE-CONTENT-OFFLINE-DO-NOT-EMIT')
    assert.equal(typeof session.sessionId, 'string')
    assert.equal(session.configOptions[0].currentValue, process.env.DSH_MODEL_ID ?? 'ds-0731')
    const startedAt = Date.now()
    await stopBridge(bridge)
    assert.ok(Date.now() - startedAt < 1_000, bridge.getStderr())
  } finally {
    if (bridge.child.exitCode === null) bridge.child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})
