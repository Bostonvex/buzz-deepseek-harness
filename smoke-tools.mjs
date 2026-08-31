#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const workspace = mkdtempSync('/private/tmp/dsh-acp-tool-smoke-')
const sessionsRoot = mkdtempSync('/private/tmp/dsh-acp-tool-sessions-')
const expectedSource = 'print("DeepSeek Harness ACP tools work")'
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
    DSH_ACP_SESSIONS_ROOT: sessionsRoot,
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
    clientInfo: { name: 'twinspark-acp-tool-smoke', version: '1.0.0' },
    clientCapabilities: {},
  })
  const session = await connection.newSession({ cwd: workspace, mcpServers: [] })
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{
      type: 'text',
      text: 'Create hello.py containing exactly print("DeepSeek Harness ACP tools work"), run it with Python, verify its output, then reply with exactly: ACP coding tools passed.',
    }],
  })

  const source = readFileSync(`${workspace}/hello.py`, 'utf8')
  const execution = execFileSync('python3', [`${workspace}/hello.py`], { encoding: 'utf8' }).trim()
  const normalized = reply.trim()

  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(`ACP version mismatch: ${initialized.protocolVersion}`)
  }
  if (result.stopReason !== 'end_turn') {
    throw new Error(`Unexpected stop reason: ${result.stopReason}`)
  }
  if (source.trimEnd() !== expectedSource) {
    throw new Error(`Unexpected hello.py contents: ${JSON.stringify(source)}`)
  }
  if (execution !== 'DeepSeek Harness ACP tools work') {
    throw new Error(`Unexpected Python output: ${JSON.stringify(execution)}`)
  }
  if (!normalized.endsWith('ACP coding tools passed.')) {
    throw new Error(`Unexpected reply: ${JSON.stringify(normalized)}`)
  }

  console.log(JSON.stringify({
    protocolVersion: initialized.protocolVersion,
    stopReason: result.stopReason,
    reply: normalized,
    file: source.trim(),
    execution,
  }, null, 2))
} finally {
  child.kill('SIGTERM')
  rmSync(workspace, { recursive: true, force: true })
  rmSync(sessionsRoot, { recursive: true, force: true })
}
