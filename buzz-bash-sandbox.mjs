import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'

export const name = 'buzz-bash-sandbox'

// DeepSeek Harness deliberately removes credential-shaped variables from every
// subprocess. Restore only the credentials that the managed agent is explicitly
// expected to use: its Buzz seat and its configured GitHub identities. Keep
// these lists narrow so model, provider, 1Password, and unrelated user
// credentials remain covered by DeepSeek's scrub.
export const BUZZ_SHELL_ENV_KEYS = Object.freeze([
  'BUZZ_PRIVATE_KEY',
  'BUZZ_RELAY_URL',
  'BUZZ_AUTH_TAG',
  'BUZZ_ACP_DISPLAY_NAME',
])

export const GITHUB_SHELL_ENV_KEYS = Object.freeze([
  'GH_TOKEN',
  'GH_TOKEN_MERGE',
])

export const TRUSTED_SHELL_ENV_KEYS = Object.freeze([
  ...BUZZ_SHELL_ENV_KEYS,
  ...GITHUB_SHELL_ENV_KEYS,
])

export function buildTrustedShellEnv(source = process.env) {
  const env = {}
  for (const key of TRUSTED_SHELL_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return env
}

export function withTrustedShellEnv(request, source = process.env) {
  const trustedEnv = buildTrustedShellEnv(source)
  if (Object.keys(trustedEnv).length === 0) return request

  return {
    ...request,
    env: {
      ...(request.env ?? {}),
      ...trustedEnv,
    },
  }
}

// Preserve the original exported helpers for consumers of the first bridge
// release. Their behavior now includes the explicit GitHub allowlist above.
export const buildBuzzShellEnv = buildTrustedShellEnv
export const withBuzzShellEnv = withTrustedShellEnv

// The upstream executor passes request.env as an explicit subprocess layer,
// after its ambient credential scrub. This preserves DeepSeek's default policy
// while restoring only the authenticated Buzz and GitHub contracts for the
// built-in bash tool. Trusted parent values win over any earlier in-process
// request overlay.
export default class BuzzBashSandboxExecutor extends SandboxBashExecutor {
  resolve(request) {
    return super.resolve(withTrustedShellEnv(request))
  }
}
