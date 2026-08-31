import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { isAbsolute } from 'node:path'

const SAFE_PROXY_ENV_KEYS = Object.freeze([
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
])

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase())
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}

function directResult(upstreamBaseUrl) {
  return {
    active: false,
    modelBaseUrl: upstreamBaseUrl,
    contextUrl: null,
    child: null,
    async stop() {},
  }
}

function proxyEnvironment(source) {
  const result = {}
  for (const key of SAFE_PROXY_ENV_KEYS) {
    if (typeof source[key] === 'string' && source[key].length > 0) result[key] = source[key]
  }
  return result
}

function validLoopbackListener(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:') return null
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return null
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
    if (parsed.pathname !== '/' || !parsed.port) return null
    return parsed
  } catch {
    return null
  }
}

export function modelChildEnvironment(source, baseUrlKey, modelBaseUrl) {
  const result = { ...source, [baseUrlKey]: modelBaseUrl }
  for (const key of Object.keys(result)) {
    if (key.startsWith('BUZZ_TELEMETRY_') || key.startsWith('BUZZ_MODEL_PROXY_')) {
      delete result[key]
    }
  }
  return result
}

export async function startModelProxySidecar({
  upstreamBaseUrl,
  model,
  harness,
  environment = process.env,
  diagnostic = (message) => process.stderr.write(`${message}\n`),
}) {
  const direct = directResult(upstreamBaseUrl)
  if (!enabled(environment.BUZZ_MODEL_PROXY_ENABLED)) return direct
  if (!enabled(environment.BUZZ_TELEMETRY_ENABLED)) {
    diagnostic('deepseek-harness-acp: model proxy disabled because telemetry is not enabled')
    return direct
  }

  const executable = environment.BUZZ_MODEL_PROXY_BIN
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    diagnostic('deepseek-harness-acp: model proxy unavailable (absolute executable required); using direct upstream')
    return direct
  }

  const required = [
    environment.BUZZ_TELEMETRY_URL,
    environment.BUZZ_TELEMETRY_TOKEN_FILE,
    environment.BUZZ_TELEMETRY_IDENTITY_SALT_FILE,
    environment.BUZZ_TELEMETRY_ENDPOINT_ID,
  ]
  if (required.some((value) => typeof value !== 'string' || value.length === 0)) {
    diagnostic('deepseek-harness-acp: model proxy unavailable (telemetry configuration incomplete); using direct upstream')
    return direct
  }

  const args = [
    '--upstream', upstreamBaseUrl,
    '--host', '127.0.0.1',
    '--port', '0',
    '--collector-url', environment.BUZZ_TELEMETRY_URL,
    '--token-file', environment.BUZZ_TELEMETRY_TOKEN_FILE,
    '--identity-salt-file', environment.BUZZ_TELEMETRY_IDENTITY_SALT_FILE,
    '--harness', harness,
    '--model', model,
    '--endpoint-id', environment.BUZZ_TELEMETRY_ENDPOINT_ID,
  ]
  const child = spawn(executable, args, {
    env: proxyEnvironment(environment),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const timeoutMs = boundedNumber(
    environment.BUZZ_MODEL_PROXY_STARTUP_TIMEOUT_MS,
    3_000,
    100,
    30_000,
  )

  const listeningUrl = await new Promise((resolve) => {
    let settled = false
    let output = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(value)
    }
    const onData = (chunk) => {
      output += String(chunk)
      if (output.length > 4_096) return finish(null)
      const newline = output.indexOf('\n')
      if (newline < 0) return
      const match = /^Buzz OpenAI timing proxy listening on (http:\/\/\S+)$/.exec(
        output.slice(0, newline).trim(),
      )
      finish(match?.[1] ?? null)
    }
    const onError = () => finish(null)
    const onExit = () => finish(null)
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref()
    child.stdout?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })

  const listener = validLoopbackListener(listeningUrl)
  if (!listener) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    diagnostic('deepseek-harness-acp: model proxy unavailable (startup failed); using direct upstream')
    return direct
  }
  child.stdout?.resume()

  let stopping = false
  return {
    active: true,
    modelBaseUrl: new URL('/v1', listener).toString().replace(/\/$/, ''),
    contextUrl: new URL('/__buzz/context', listener).toString(),
    child,
    async stop() {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return
      stopping = true
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const completed = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 250)),
      ])
      if (!completed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  }
}
