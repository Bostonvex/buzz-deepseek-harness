#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpObserverFromEnv } from '@buzz-agent-observability/acp-observer'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const harnessVersion = '0.1.1-rc.2'
const modelId = process.env.DSH_MODEL_ID ?? 'ds-0731'
const modelName = process.env.DSH_MODEL_NAME ?? 'DeepSeek V4 Flash'
const providerName = process.env.DSH_PROVIDER_NAME ?? 'Twin DGX Spark'
const trustedMcpCommand = process.env.DSH_TRUSTED_MCP_COMMAND
  ?? '/Applications/Buzz.app/Contents/MacOS/buzz-dev-mcp'
const allowedMcpEnv = new Set([
  'BUZZ_RELAY_URL',
  'BUZZ_PRIVATE_KEY',
  'BUZZ_AUTH_TAG',
  'BUZZ_ACP_DISPLAY_NAME',
  'BUZZ_GIT_ORIGIN_CHANNEL_ID',
  'BUZZ_GIT_ORIGIN_AGENT_NAME',
])
const mcpConfigureTimeoutMs = Number(process.env.DSH_MCP_STARTUP_TIMEOUT_MS ?? 65_000)
const telemetry = createAcpObserverFromEnv({
  harness: 'deepseek',
  harnessVersion,
  model: modelId,
  producerName: 'buzz-deepseek-harness',
  producerVersion: '0.1.0',
})

function modelConfigOptions() {
  return [{
    id: 'model',
    name: 'Model',
    description: `Model served by ${providerName}`,
    category: 'model',
    type: 'select',
    currentValue: modelId,
    options: [{
      name: `${modelName} (${providerName})`,
      value: modelId,
      description: `${modelName} served as ${modelId}`,
    }],
  }]
}

function requestKey(id) {
  return JSON.stringify(id)
}

function writeProtocolMessage(message) {
  telemetry.observeServerMessage(message)
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function protocolError(id, code, message) {
  writeProtocolMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

function resolvedPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function sanitizeBuzzMcpServers(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return null
  if (servers.length !== 1) {
    throw new TypeError('Only the single Buzz reply MCP server is supported')
  }

  const serverConfig = servers[0]
  if (!serverConfig || (serverConfig.type !== undefined && serverConfig.type !== 'stdio')) {
    throw new TypeError('Only Buzz\'s local stdio MCP transport is supported')
  }
  if (serverConfig.name !== 'buzz-dev-mcp') {
    throw new TypeError('The requested MCP server is not Buzz dev MCP')
  }
  const requestedCommand = resolvedPath(serverConfig.command)
  const trustedCommand = resolvedPath(trustedMcpCommand)
  if (!requestedCommand || !trustedCommand || requestedCommand !== trustedCommand) {
    throw new TypeError('The requested MCP executable is not the trusted Buzz sidecar')
  }
  if (!Array.isArray(serverConfig.args) || serverConfig.args.length > 0) {
    throw new TypeError('Buzz MCP arguments must be an empty array')
  }

  const sourceEnv = serverConfig.env ?? []
  if (!Array.isArray(sourceEnv)) {
    throw new TypeError('The Buzz MCP environment must be an ACP environment array')
  }
  const env = {}
  for (const entry of sourceEnv) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      throw new TypeError('Buzz MCP contains an invalid environment entry')
    }
    if (Object.hasOwn(env, entry.name)) {
      throw new TypeError(`Duplicate Buzz MCP environment variable: ${entry.name}`)
    }
    env[entry.name] = entry.value
  }
  const unexpectedKeys = Object.keys(env).filter((key) => !allowedMcpEnv.has(key))
  if (unexpectedKeys.length > 0) {
    throw new TypeError(`Unexpected Buzz MCP environment variable: ${unexpectedKeys[0]}`)
  }
  if (typeof env.BUZZ_RELAY_URL !== 'string' || typeof env.BUZZ_PRIVATE_KEY !== 'string') {
    throw new TypeError('Buzz MCP is missing its relay URL or private key')
  }

  return {
    transport: 'stdio',
    serverName: 'buzz-dev-mcp',
    command: process.execPath,
    args: [join(scriptDir, 'mcp-schema-proxy.mjs')],
    env: {
      ...env,
      DSH_SCHEMA_PROXY_TARGET: trustedCommand,
      DSH_MAX_SCHEMA_STRING_LENGTH: process.env.DSH_MAX_SCHEMA_STRING_LENGTH ?? '2000',
    },
    cwd: process.cwd(),
    toolCallTimeoutMs: 120_000,
    failOnStartupError: true,
    reconnect: {
      enabled: true,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
  }
}

const server = spawn(
  join(scriptDir, 'node_modules/.bin/dsh-acp-demo'),
  ['--config', join(scriptDir, 'cordis.yml'), ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
  },
)

const pendingMethods = new Map()
const pendingMcpConfiguration = new Map()
let nextControlId = 1

function configureBuzzMcp(config) {
  if (!server.connected) return Promise.reject(new Error('DeepSeek Harness control channel is unavailable'))

  return new Promise((resolve, reject) => {
    const id = nextControlId++
    const timeout = setTimeout(() => {
      pendingMcpConfiguration.delete(id)
      reject(new Error('Timed out while starting the Buzz reply MCP server'))
    }, mcpConfigureTimeoutMs)
    timeout.unref()
    pendingMcpConfiguration.set(id, { resolve, reject, timeout })
    server.send({ kind: 'buzz-mcp-control/configure', id, config }, (error) => {
      if (!error) return
      const pending = pendingMcpConfiguration.get(id)
      if (!pending) return
      clearTimeout(pending.timeout)
      pendingMcpConfiguration.delete(id)
      pending.reject(new Error('Failed to send the Buzz MCP configuration'))
    })
  })
}

server.on('message', (message) => {
  if (message?.kind !== 'buzz-mcp-control/result') return
  const pending = pendingMcpConfiguration.get(message.id)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendingMcpConfiguration.delete(message.id)
  if (message.ok) pending.resolve()
  else pending.reject(new Error(message.error ?? 'Buzz reply MCP failed to start'))
})

const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const serverLines = createInterface({ input: server.stdout, crlfDelay: Infinity })

let clientMessageChain = Promise.resolve()
clientLines.on('line', (line) => {
  clientMessageChain = clientMessageChain.then(async () => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      telemetry.observeProtocolAnomaly({
        kind: 'malformed_client_json',
        lineBytes: Buffer.byteLength(line),
      })
      server.stdin.write(`${line}\n`)
      return
    }
    telemetry.observeClientMessage(message)

    if (message?.method === 'session/set_config_option' && message?.params?.configId === 'model') {
      if (message.params.value !== modelId) {
        protocolError(message.id, -32602, `Unsupported model: ${String(message.params.value)}`)
        return
      }

      writeProtocolMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { configOptions: modelConfigOptions() },
      })
      return
    }

    if (message?.method === 'session/new') {
      let mcpConfig
      try {
        mcpConfig = sanitizeBuzzMcpServers(message?.params?.mcpServers)
        await configureBuzzMcp(mcpConfig)
      } catch (error) {
        protocolError(message.id, -32602, error instanceof Error ? error.message : 'Invalid MCP configuration')
        return
      }
      message = {
        ...message,
        params: { ...message.params, mcpServers: [] },
      }
    }

    if (Object.hasOwn(message ?? {}, 'id') && typeof message?.method === 'string') {
      pendingMethods.set(requestKey(message.id), message.method)
    }
    server.stdin.write(`${JSON.stringify(message)}\n`)
  }).catch((error) => {
    process.stderr.write(`deepseek-harness-acp: client message failed: ${error.message}\n`)
  })
})

serverLines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    telemetry.observeProtocolAnomaly({
      kind: 'malformed_server_json',
      lineBytes: Buffer.byteLength(line),
    })
    process.stdout.write(`${line}\n`)
    return
  }

  if (Object.hasOwn(message ?? {}, 'id')) {
    const key = requestKey(message.id)
    const method = pendingMethods.get(key)
    pendingMethods.delete(key)

    if (method === 'initialize' && message.result) {
      message.result.agentInfo = {
        name: 'deepseek-harness-acp',
        title: 'DeepSeek Harness',
        version: harnessVersion,
      }
    } else if (method === 'session/new' && message.result) {
      message.result.configOptions = modelConfigOptions()
    }
  }

  writeProtocolMessage(message)
})

clientLines.on('close', () => server.stdin.end())

let exiting = false
function exitWithTelemetry(code, signal = null) {
  if (exiting) return
  exiting = true
  telemetry.observeProcessExit({ code, signal })
  void telemetry.flush({ deadlineMs: 50 }).finally(() => process.exit(code))
}

server.on('error', (error) => {
  process.stderr.write(`deepseek-harness-acp: failed to start ACP server: ${error.message}\n`)
  exitWithTelemetry(1)
})

server.on('exit', (code, signal) => {
  for (const pending of pendingMcpConfiguration.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error('DeepSeek Harness exited while starting Buzz MCP'))
  }
  const signalExitCode = signal === 'SIGINT' ? 130 : 143
  exitWithTelemetry(code ?? signalExitCode, signal)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal))
}
