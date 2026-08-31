import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as acp from '@agentclientprotocol/sdk'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fakeMcp = join(root, 'test/fixtures/fake-buzz-mcp.mjs')

class TestClient {
  async requestPermission() {
    return { outcome: { outcome: 'cancelled' } }
  }

  async sessionUpdate() {}
}

function startBridge(trustedCommand) {
  const child = spawn(join(root, 'deepseek-harness-acp'), [], {
    cwd: root,
    env: {
      ...process.env,
      DSH_TRUSTED_MCP_COMMAND: trustedCommand,
      DSH_ACP_SESSIONS_ROOT: `/private/tmp/dsh-mcp-bridge-test-${process.pid}`,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const connection = new acp.ClientSideConnection(
    () => new TestClient(),
    acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  )
  return { child, connection }
}

async function initialize(connection) {
  return connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'mcp-bridge-test', version: '1.0.0' },
    clientCapabilities: {},
  })
}

test('trusted Buzz MCP is mounted before session creation', async () => {
  const { child, connection } = startBridge(fakeMcp)
  try {
    await initialize(connection)
    const session = await connection.newSession({
      cwd: root,
      mcpServers: [{
        name: 'buzz-dev-mcp',
        command: fakeMcp,
        args: [],
        env: [
          { name: 'BUZZ_RELAY_URL', value: 'ws://127.0.0.1:1' },
          { name: 'BUZZ_PRIVATE_KEY', value: 'test-only' },
          { name: 'BUZZ_GIT_ORIGIN_AGENT_NAME', value: 'testDeepseek' },
        ],
      }],
    })
    assert.equal(typeof session.sessionId, 'string')
    assert.equal(session.configOptions[0].currentValue, process.env.DSH_MODEL_ID ?? 'ds-0731')
  } finally {
    child.kill('SIGTERM')
  }
})

test('untrusted MCP executables are rejected', async () => {
  const { child, connection } = startBridge(fakeMcp)
  try {
    await initialize(connection)
    await assert.rejects(
      connection.newSession({
        cwd: root,
        mcpServers: [{
          name: 'buzz-dev-mcp',
          command: '/bin/false',
          args: [],
          env: [
            { name: 'BUZZ_RELAY_URL', value: 'ws://127.0.0.1:1' },
            { name: 'BUZZ_PRIVATE_KEY', value: 'test-only' },
          ],
        }],
      }),
      /not the trusted Buzz sidecar/,
    )
  } finally {
    child.kill('SIGTERM')
  }
})
