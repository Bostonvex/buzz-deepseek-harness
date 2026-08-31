#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { capSchemaMaxLength } from './lib/schema-cap.mjs'

const maxSchemaStringLength = Number(process.env.DSH_MAX_SCHEMA_STRING_LENGTH ?? 2_000)
const target = realpathSync(process.env.DSH_SCHEMA_PROXY_TARGET)
const buzzEnvNames = [
  'BUZZ_RELAY_URL',
  'BUZZ_PRIVATE_KEY',
  'BUZZ_AUTH_TAG',
  'BUZZ_ACP_DISPLAY_NAME',
  'BUZZ_GIT_ORIGIN_CHANNEL_ID',
  'BUZZ_GIT_ORIGIN_AGENT_NAME',
]
const systemEnvNames = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
const childEnv = {}

for (const name of [...systemEnvNames, ...buzzEnvNames]) {
  if (typeof process.env[name] === 'string') childEnv[name] = process.env[name]
}

function requestKey(id) {
  return JSON.stringify(id)
}

const child = spawn(target, [], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'inherit'],
})
const requests = new Map()
const upstream = createInterface({ input: process.stdin, crlfDelay: Infinity })
const downstream = createInterface({ input: child.stdout, crlfDelay: Infinity })

upstream.on('line', (line) => {
  try {
    const message = JSON.parse(line)
    if (Object.hasOwn(message ?? {}, 'id') && typeof message?.method === 'string') {
      requests.set(requestKey(message.id), message.method)
    }
  } catch {}
  child.stdin.write(`${line}\n`)
})

downstream.on('line', (line) => {
  try {
    const message = JSON.parse(line)
    if (Object.hasOwn(message ?? {}, 'id')) {
      const key = requestKey(message.id)
      const method = requests.get(key)
      requests.delete(key)
      if (method === 'tools/list' && message.result) capSchemaMaxLength(message.result)
    }
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    process.stdout.write(`${line}\n`)
  }
})

upstream.on('close', () => child.stdin.end())
child.on('error', (error) => {
  process.stderr.write(`mcp-schema-proxy: failed to start trusted target: ${error.message}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  const signalExitCode = signal === 'SIGINT' ? 130 : 143
  process.exit(code ?? signalExitCode)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
