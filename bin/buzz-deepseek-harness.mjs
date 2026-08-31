#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { auditSourceTree } from '../lib/schema-audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifestName = 'deepseek-harness.json'
const backupFolderName = '.buzz-deepseek-harness-backups'

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function defaultBuzzDataDir() {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library/Application Support/xyz.block.buzz.app')
  }
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'xyz.block.buzz.app')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'xyz.block.buzz.app')
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const [rawName, inlineValue] = token.slice(2).split('=', 2)
    if (['help', 'force', 'unauthenticated', 'skip-endpoint', 'skip-acp'].includes(rawName)) {
      options[rawName] = true
      continue
    }
    const value = inlineValue ?? argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`)
    options[rawName] = value
  }
  return options
}

function numericOption(options, name, fallback) {
  const value = Number(options[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`)
  return String(value)
}

function configuration(options) {
  const baseURL = options['base-url'] ?? process.env.DSH_BASE_URL ?? 'http://127.0.0.1:8000/v1'
  const parsedURL = new URL(baseURL)
  if (!['http:', 'https:'].includes(parsedURL.protocol)) throw new Error('--base-url must use http or https')

  const sidecar = resolve(options['mcp-command'] ?? '/Applications/Buzz.app/Contents/MacOS/buzz-dev-mcp')
  const nodeBin = resolve(options.node ?? process.execPath)
  return {
    label: options.label ?? 'DeepSeek Harness (OpenAI-compatible)',
    baseURL: parsedURL.toString().replace(/\/$/, ''),
    modelId: options['model-id'] ?? process.env.DSH_MODEL_ID ?? 'ds-0731',
    modelName: options['model-name'] ?? process.env.DSH_MODEL_NAME ?? 'DeepSeek V4 Flash',
    providerName: options['provider-name'] ?? process.env.DSH_PROVIDER_NAME ?? 'Twin DGX Spark',
    contextWindow: numericOption(options, 'context-window', 1_048_576),
    maxTokens: numericOption(options, 'max-tokens', 16_384),
    apiKeyEnv: options['api-key-env'] ?? 'DSH_LOCAL_API_KEY',
    permissionMode: options['permission-mode'] ?? 'workspace-write',
    sessionsRoot: resolve(options['sessions-root'] ?? join(homedir(), '.dsh/acp-sessions')),
    nodeBin,
    sidecar,
    buzzDataDir: resolve(options['buzz-data-dir'] ?? defaultBuzzDataDir()),
    unauthenticated: options.unauthenticated === true,
  }
}

function buildManifest(config) {
  const env = {
    DSH_BASE_URL: config.baseURL,
    DSH_MODEL_ID: config.modelId,
    DSH_MODEL_NAME: config.modelName,
    DSH_PROVIDER_NAME: config.providerName,
    DSH_CONTEXT_WINDOW: config.contextWindow,
    DSH_MAX_TOKENS: config.maxTokens,
    DSH_API_KEY_ENV: config.apiKeyEnv,
    DSH_PERMISSION_MODE: config.permissionMode,
    DSH_ACP_SESSIONS_ROOT: config.sessionsRoot,
    DSH_NODE_BIN: config.nodeBin,
    DSH_TRUSTED_MCP_COMMAND: config.sidecar,
    DSH_MAX_SCHEMA_STRING_LENGTH: '2000',
  }
  if (config.unauthenticated) env[config.apiKeyEnv] = 'local'
  return {
    id: 'deepseek-harness',
    label: config.label,
    command: realpathSync(join(root, 'codex-acp')),
    args: [],
    env,
    installInstructionsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    installHint: `Buzz DeepSeek Harness bridge ${packageJson.version}`,
  }
}

function writeAtomic(path, contents, mode = 0o600) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, contents, { mode })
  renameSync(temporary, path)
}

function install(options) {
  const config = configuration(options)
  accessSync(config.nodeBin, constants.X_OK)
  accessSync(config.sidecar, constants.X_OK)
  accessSync(join(root, 'codex-acp'), constants.X_OK)
  if (!existsSync(join(root, 'node_modules/@deepseek-ai/dsh-acp-demo'))) {
    throw new Error('Dependencies are missing; run npm ci before installing')
  }

  const harnessDir = join(config.buzzDataDir, 'custom_harnesses')
  const target = join(harnessDir, manifestName)
  const backupDir = join(harnessDir, backupFolderName, timestamp())
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const targetExisted = existsSync(target)
  if (targetExisted) copyFileSync(target, join(backupDir, manifestName))

  const contents = `${JSON.stringify(buildManifest(config), null, 2)}\n`
  const state = {
    version: 1,
    packageVersion: packageJson.version,
    installedAt: new Date().toISOString(),
    target,
    targetExisted,
    installedManifestSha256: sha256(contents),
  }
  writeAtomic(join(backupDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  mkdirSync(harnessDir, { recursive: true })
  writeAtomic(target, contents)

  console.log(`Installed: ${target}`)
  console.log(`Backup: ${backupDir}`)
  console.log('Restart the Buzz managed agent so its ACP worker pool reloads the harness.')
}

function backupStates(buzzDataDir) {
  const rootDir = join(buzzDataDir, 'custom_harnesses', backupFolderName)
  if (!existsSync(rootDir)) return []
  return readdirSync(rootDir)
    .sort()
    .reverse()
    .map((name) => join(rootDir, name, 'state.json'))
    .filter(existsSync)
    .map((path) => ({ path, state: JSON.parse(readFileSync(path, 'utf8')) }))
}

function uninstall(options) {
  const buzzDataDir = resolve(options['buzz-data-dir'] ?? defaultBuzzDataDir())
  const target = join(buzzDataDir, 'custom_harnesses', manifestName)
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null
  const record = backupStates(buzzDataDir).find(({ state }) => (
    state.target === target && current !== null && state.installedManifestSha256 === sha256(current)
  ))
  if (!record && !options.force) {
    throw new Error('The installed manifest was changed or no matching backup exists; use --force only after reviewing it')
  }
  if (!record) {
    if (existsSync(target)) rmSync(target)
    console.log(`Removed without restoration: ${target}`)
    return
  }

  const backupManifest = join(dirname(record.path), manifestName)
  if (record.state.targetExisted && existsSync(backupManifest)) {
    copyFileSync(backupManifest, target)
    console.log(`Restored: ${backupManifest}`)
  } else {
    rmSync(target)
    console.log(`Removed: ${target}`)
  }
}

async function checkAcp(manifest) {
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'buzz-dsh-doctor-'))
  const child = spawn(manifest.command, manifest.args ?? [], {
    cwd: root,
    env: { ...process.env, ...manifest.env, DSH_ACP_SESSIONS_ROOT: sessionsRoot },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  try {
    const acp = await import('@agentclientprotocol/sdk')
    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: async () => {},
      }),
      acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    )
    const result = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'buzz-deepseek-harness-doctor', version: packageJson.version },
      clientCapabilities: {},
    })
    const session = await connection.newSession({ cwd: root, mcpServers: [] })
    if (!session.sessionId || result.agentInfo?.name !== 'deepseek-harness-acp') {
      throw new Error('ACP returned an incomplete handshake')
    }
  } finally {
    child.kill('SIGTERM')
    rmSync(sessionsRoot, { recursive: true, force: true })
  }
}

async function doctor(options) {
  const config = configuration(options)
  const target = join(config.buzzDataDir, 'custom_harnesses', manifestName)
  const checks = []
  const check = async (name, operation) => {
    try {
      await operation()
      checks.push({ name, ok: true })
      console.log(`PASS ${name}`)
    } catch (error) {
      checks.push({ name, ok: false })
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }

  let manifest
  await check('Node.js 22+', () => {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`found ${process.version}`)
  })
  await check('DeepSeek Harness dependencies', () => accessSync(join(root, 'node_modules/@deepseek-ai/dsh-acp-demo')))
  await check('Buzz reply MCP executable', () => accessSync(config.sidecar, constants.X_OK))
  await check('Buzz custom harness manifest', () => {
    manifest = JSON.parse(readFileSync(target, 'utf8'))
    if (basename(manifest.command) !== 'codex-acp') throw new Error('command must end in codex-acp for Buzz MCP discovery')
  })
  await check('Model-facing schema limits', () => {
    const roots = [
      join(root, 'lib'),
      join(root, 'node_modules/@deepseek-ai/dsh-mcp-client'),
      join(root, 'node_modules/@deepseek-ai/dsh-tool-fs'),
      join(root, 'node_modules/@deepseek-ai/dsh-tool-todo'),
      join(root, 'node_modules/@deepseek-ai/dsh-bash-sandbox'),
    ]
    const findings = roots.filter(existsSync).flatMap((path) => auditSourceTree(path))
    if (findings.length) throw new Error(`${findings[0].file}:${findings[0].line} has maxLength ${findings[0].raw}`)
  })
  if (!options['skip-endpoint']) {
    await check('OpenAI-compatible /models endpoint', async () => {
      const effectiveEnv = { ...process.env, ...(manifest?.env ?? {}) }
      const headers = {}
      const keyName = effectiveEnv.DSH_API_KEY_ENV ?? 'DSH_LOCAL_API_KEY'
      if (effectiveEnv[keyName]) headers.Authorization = `Bearer ${effectiveEnv[keyName]}`
      const response = await fetch(`${(effectiveEnv.DSH_BASE_URL ?? config.baseURL).replace(/\/$/, '')}/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    })
  }
  if (!options['skip-acp'] && manifest) await check('ACP initialize and session/new', () => checkAcp(manifest))

  const failed = checks.filter(({ ok }) => !ok).length
  console.log(`${checks.length - failed}/${checks.length} checks passed.`)
  if (failed) process.exitCode = 1
}

function printConfig(options) {
  console.log(JSON.stringify(buildManifest(configuration(options)), null, 2))
}

function help() {
  console.log(`buzz-deepseek-harness ${packageJson.version}

Usage:
  buzz-deepseek-harness install [options]
  buzz-deepseek-harness doctor [--skip-endpoint] [--skip-acp]
  buzz-deepseek-harness uninstall [--force]
  buzz-deepseek-harness print-config [options]

Configuration options:
  --base-url URL              OpenAI-compatible API root (including /v1)
  --model-id ID               API model id
  --model-name NAME           Display name
  --provider-name NAME        Provider display name
  --context-window TOKENS     Context size (default 1048576)
  --max-tokens TOKENS         Maximum output (default 16384)
  --api-key-env NAME          Name of inherited API-key variable
  --unauthenticated           Store a non-secret local placeholder key
  --node PATH                 Node.js executable
  --mcp-command PATH          Trusted Buzz reply MCP executable
  --buzz-data-dir PATH        Override Buzz application-data directory
`)
}

try {
  const options = parseArgs(process.argv.slice(2))
  const command = options._[0]
  if (options.help || !command) help()
  else if (command === 'install') install(options)
  else if (command === 'doctor') await doctor(options)
  else if (command === 'uninstall') uninstall(options)
  else if (command === 'print-config') printConfig(options)
  else throw new Error(`Unknown command: ${command}`)
} catch (error) {
  console.error(`buzz-deepseek-harness: ${error.message}`)
  process.exitCode = 1
}
