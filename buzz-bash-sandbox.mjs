import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'

export const name = 'buzz-bash-sandbox'

// DeepSeek Harness deliberately removes credential-shaped variables from every
// subprocess. Buzz is the exception we opt into explicitly: its base prompt
// tells managed agents to use the `buzz` CLI, which requires these seat-scoped
// values in the command environment. Keep this list narrow so unrelated model,
// provider, GitHub, and user credentials remain covered by DeepSeek's scrub.
export const BUZZ_SHELL_ENV_KEYS = Object.freeze([
  'BUZZ_PRIVATE_KEY',
  'BUZZ_RELAY_URL',
  'BUZZ_AUTH_TAG',
  'BUZZ_ACP_DISPLAY_NAME',
])

export function buildBuzzShellEnv(source = process.env) {
  const env = {}
  for (const key of BUZZ_SHELL_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return env
}

export function withBuzzShellEnv(request, source = process.env) {
  const buzzEnv = buildBuzzShellEnv(source)
  if (Object.keys(buzzEnv).length === 0) return request

  return {
    ...request,
    env: {
      ...(request.env ?? {}),
      ...buzzEnv,
    },
  }
}

// The upstream executor passes request.env as an explicit subprocess layer,
// after its ambient credential scrub. This preserves DeepSeek's default policy
// while restoring only Buzz's authenticated CLI contract for the built-in bash
// tool. Trusted seat values win over any earlier in-process request overlay.
export default class BuzzBashSandboxExecutor extends SandboxBashExecutor {
  resolve(request) {
    return super.resolve(withBuzzShellEnv(request))
  }
}
