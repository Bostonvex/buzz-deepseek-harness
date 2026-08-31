import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'

import BuzzBashSandboxExecutor, {
  BUZZ_SHELL_ENV_KEYS,
  buildBuzzShellEnv,
  withBuzzShellEnv,
} from '../buzz-bash-sandbox.mjs'

const buzzEnv = {
  BUZZ_PRIVATE_KEY: 'test-seat-key',
  BUZZ_RELAY_URL: 'wss://relay.example.test',
  BUZZ_AUTH_TAG: 'test-owner-attestation',
  BUZZ_ACP_DISPLAY_NAME: 'Test Implementer',
}

test('only the allowlisted Buzz environment reaches bash', () => {
  assert.deepEqual(buildBuzzShellEnv({
    ...buzzEnv,
    OPENAI_API_KEY: 'must-not-pass',
    GH_TOKEN: 'must-not-pass',
    DSH_LOCAL_API_KEY: 'must-not-pass',
    PATH: '/bin',
  }), buzzEnv)
  assert.deepEqual(Object.keys(buzzEnv), [...BUZZ_SHELL_ENV_KEYS])
})

test('empty and missing Buzz values are not synthesized', () => {
  assert.deepEqual(buildBuzzShellEnv({
    BUZZ_PRIVATE_KEY: '',
    BUZZ_RELAY_URL: 'wss://relay.example.test',
  }), {
    BUZZ_RELAY_URL: 'wss://relay.example.test',
  })
})

test('trusted seat values override an earlier request overlay', () => {
  const request = {
    command: 'buzz messages send --help',
    env: {
      KEEP_ME: 'yes',
      BUZZ_PRIVATE_KEY: 'spoofed',
    },
  }

  const overlaid = withBuzzShellEnv(request, buzzEnv)
  assert.deepEqual(overlaid.env, {
    KEEP_ME: 'yes',
    ...buzzEnv,
  })
  assert.deepEqual(request.env, {
    KEEP_ME: 'yes',
    BUZZ_PRIVATE_KEY: 'spoofed',
  })
})

test('executor resolves the Buzz overlay into the explicit child environment', () => {
  const executor = Object.create(BuzzBashSandboxExecutor.prototype)
  executor.source = () => ({
    timeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 64_000,
    maxSpillBytes: 1_000_000,
    graceMs: 1_000,
  })
  executor.ctx = {
    sandboxPolicy: {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/tmp' }),
    },
  }

  const previous = Object.fromEntries(
    BUZZ_SHELL_ENV_KEYS.map((key) => [key, process.env[key]]),
  )
  try {
    Object.assign(process.env, buzzEnv)
    const resolved = executor.resolve({
      command: 'buzz --version',
      env: { KEEP_ME: 'yes' },
      sandboxPolicy: null,
    })
    assert.deepEqual(resolved.env, {
      KEEP_ME: 'yes',
      ...buzzEnv,
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('real bash subprocess receives Buzz values while unrelated credentials stay scrubbed', async () => {
  const root = new Context()
  const changedKeys = [
    ...BUZZ_SHELL_ENV_KEYS,
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'DSH_LOCAL_API_KEY',
  ]
  const previous = Object.fromEntries(
    changedKeys.map((key) => [key, process.env[key]]),
  )

  try {
    Object.assign(process.env, buzzEnv)
    process.env.OPENAI_API_KEY = 'must-not-pass'
    process.env.GH_TOKEN = 'must-not-pass'
    process.env.DSH_LOCAL_API_KEY = 'must-not-pass'

    await root.plugin(Subprocess)
    await root.plugin(Sandbox)
    await root.plugin(SandboxPolicy, {
      mode: 'danger-full-access',
      workspaceRoot: process.cwd(),
    })
    await root.plugin(BuzzBashSandboxExecutor, { timeoutMs: 120_000 })

    const result = await root.shell.run(root.shell.resolve({
      command: [
        'test "$BUZZ_PRIVATE_KEY" = test-seat-key',
        'test "$BUZZ_RELAY_URL" = wss://relay.example.test',
        'test "$BUZZ_AUTH_TAG" = test-owner-attestation',
        'test "$BUZZ_ACP_DISPLAY_NAME" = "Test Implementer"',
        'test -z "$OPENAI_API_KEY"',
        'test -z "$GH_TOKEN"',
        'test -z "$DSH_LOCAL_API_KEY"',
      ].join(' && '),
      sandboxPolicy: null,
    }))

    assert.equal(result.exitCode, 0, result.stderr.text)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await root.fiber.dispose()
  }
})
