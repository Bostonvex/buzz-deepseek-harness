#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const expected = 'DeepSeek Harness ACP reached the cluster.'
let reply = ''

class SmokeClient {
  async requestPermission() {
    return { outcome: { outcome: 'cancelled' } }
  }

  async sessionUpdate({ update }) {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      reply += update.content.text
    }
  }
}

const child = spawn('./deepseek-harness-acp', [], {
  cwd: new URL('.', import.meta.url).pathname,
  env: {
    ...process.env,
    DSH_ACP_SESSIONS_ROOT: `/private/tmp/dsh-acp-smoke-${process.pid}`,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
)
const connection = new acp.ClientSideConnection(() => new SmokeClient(), stream)

try {
  const initialized = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'twinspark-acp-smoke', version: '1.0.0' },
    clientCapabilities: {},
  })
  const session = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  })
  const configured = await connection.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: 'model',
    value: 'ds-0731',
  })
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: `Reply with exactly: ${expected}` }],
  })

  const normalized = reply.trim()
  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(`ACP version mismatch: ${initialized.protocolVersion}`)
  }
  if (result.stopReason !== 'end_turn') {
    throw new Error(`Unexpected stop reason: ${result.stopReason}`)
  }
  if (configured.configOptions[0]?.currentValue !== 'ds-0731') {
    throw new Error('ACP model selection did not remain on ds-0731')
  }
  if (!normalized.endsWith(expected)) {
    throw new Error(`Unexpected reply: ${JSON.stringify(normalized)}`)
  }

  console.log(JSON.stringify({
    protocolVersion: initialized.protocolVersion,
    agent: initialized.agentInfo,
    model: configured.configOptions[0]?.currentValue,
    stopReason: result.stopReason,
    reply: normalized,
  }, null, 2))
} finally {
  child.kill('SIGTERM')
}
