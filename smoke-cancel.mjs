#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const sessionsRoot = mkdtempSync('/private/tmp/dsh-acp-cancel-sessions-')

class SmokeClient {
  async requestPermission() {
    return { outcome: { outcome: 'cancelled' } }
  }

  async sessionUpdate() {}
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
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'twinspark-acp-cancel-smoke', version: '1.0.0' },
    clientCapabilities: {},
  })
  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] })
  const prompt = connection.prompt({
    sessionId: session.sessionId,
    prompt: [{
      type: 'text',
      text: 'Write a detailed, multi-section 4000-word tutorial about distributed systems. Do not use tools.',
    }],
  })

  // Give the request enough time to enter the model stream, then exercise the
  // same ACP notification and five-second drain budget Buzz uses.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const started = Date.now()
  await connection.cancel({ sessionId: session.sessionId })
  const result = await Promise.race([
    prompt,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('cancelled prompt did not settle within Buzz\'s 5s grace')),
      5000,
    )),
  ])
  const elapsedMs = Date.now() - started

  if (result.stopReason !== 'cancelled') {
    throw new Error(`Unexpected stop reason after cancel: ${result.stopReason}`)
  }

  console.log(JSON.stringify({
    stopReason: result.stopReason,
    cancelSettlementMs: elapsedMs,
    withinBuzzGrace: elapsedMs < 5000,
  }, null, 2))
} finally {
  child.kill('SIGTERM')
  rmSync(sessionsRoot, { recursive: true, force: true })
}
