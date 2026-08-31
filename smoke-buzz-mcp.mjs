#!/usr/bin/env node

import { accessSync, constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const buzzMcp = process.env.DSH_TRUSTED_MCP_COMMAND
  ?? '/Applications/Buzz.app/Contents/MacOS/buzz-dev-mcp'
accessSync(buzzMcp, constants.X_OK)

const child = spawn('./deepseek-harness-acp', [], {
  cwd: new URL('.', import.meta.url).pathname,
  env: {
    ...process.env,
    DSH_TRUSTED_MCP_COMMAND: buzzMcp,
    DSH_ACP_SESSIONS_ROOT: `/private/tmp/dsh-buzz-mcp-smoke-${process.pid}`,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const connection = new acp.ClientSideConnection(
  () => ({
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: async () => {},
  }),
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
)

try {
  const initialized = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'buzz-mcp-smoke', version: '1.0.0' },
    clientCapabilities: {},
  })
  const session = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [{
      name: 'buzz-dev-mcp',
      command: buzzMcp,
      args: [],
      env: [
        { name: 'BUZZ_RELAY_URL', value: 'ws://127.0.0.1:1' },
        { name: 'BUZZ_PRIVATE_KEY', value: 'non-secret-smoke-value' },
        { name: 'BUZZ_ACP_DISPLAY_NAME', value: 'DeepSeek Harness smoke test' },
      ],
    }],
  })
  if (!session.sessionId) throw new Error('ACP did not create a session')
  console.log(JSON.stringify({
    protocolVersion: initialized.protocolVersion,
    agent: initialized.agentInfo,
    buzzMcpMounted: true,
    sessionCreated: true,
  }, null, 2))
} finally {
  child.kill('SIGTERM')
}
