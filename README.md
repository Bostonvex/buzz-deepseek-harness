# Buzz DeepSeek Harness

A small, auditable bridge that runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
as a custom ACP harness in Buzz while using any OpenAI-compatible model server.
It was built for a two-node DGX Spark model cluster with the harness running on
a Mac, but the endpoint and model are configurable.

## Why this bridge exists

DeepSeek Harness 0.1.1-rc.2 rejects ACP `session/new` requests containing
client-supplied `mcpServers`. Buzz needs its local `buzz-dev-mcp` sidecar so an
agent can post its final answer into the chat. Dropping the sidecar prevents the
error but also makes successful model output invisible in Buzz.

This bridge validates Buzz's sidecar, mounts it through DeepSeek's own MCP
client, waits for its tools to be ready, and then sends an empty `mcpServers`
array to the upstream ACP implementation. It also caps model-facing MCP
`maxLength` values at 2000 to avoid llama.cpp grammar failures.

DeepSeek Harness normally removes every credential-shaped environment variable
from commands run by its built-in bash tool. That includes
`BUZZ_PRIVATE_KEY`, even though Buzz's managed-agent contract expects the
authenticated `buzz` CLI to work from the harness shell. The bridge therefore
adds only Buzz's seat key, relay URL, owner attestation, and display name back
as an explicit bash environment overlay after DeepSeek's general scrub. Other
API keys and tokens remain scrubbed.

## Requirements

- macOS with Buzz installed (Linux paths can be overridden)
- Node.js 22 or newer
- an OpenAI-compatible `/v1` endpoint
- DeepSeek Harness dependencies installed by `npm ci`

## Install

```sh
git clone https://github.com/Bostonvex/buzz-deepseek-harness.git
cd buzz-deepseek-harness
npm ci --ignore-scripts
npm run install:buzz -- \
  --base-url http://spark-head.local:8000/v1 \
  --model-id ds-0731 \
  --model-name "DeepSeek V4 Flash" \
  --provider-name "Twin DGX Spark" \
  --context-window 1048576 \
  --max-tokens 16384 \
  --unauthenticated
npm run doctor
```

The installer creates a timestamped backup before replacing Buzz's
`deepseek-harness.json`. Restart the managed agent in Buzz after installation.
The installed command intentionally ends in `codex-acp`; Buzz uses that basename
to enable its reply MCP. The process still identifies itself as DeepSeek Harness
over ACP.

For an authenticated endpoint, omit `--unauthenticated` and set
`--api-key-env NAME`. The secret must be inherited by the Buzz process under
that name; the installer never accepts or writes API-key values.

## Commands

```sh
npx buzz-deepseek-harness --help
npm run doctor
npm run schema:audit
npm test
npm run smoke:buzz-mcp
npm run smoke:cancel
npm run uninstall:buzz
```

`doctor` checks Node, dependencies, the trusted Buzz MCP executable, the custom
harness definition, model-facing schema limits, the `/models` endpoint, and an
ACP initialize/session handshake. Use `--skip-endpoint` only for offline
diagnostics.

Uninstall restores the exact manifest saved by the latest matching install. It
refuses to overwrite a manifest changed since installation unless `--force` is
explicitly supplied.

## Configuration

The installer writes non-secret settings into Buzz's custom-harness definition:

| Option | Environment variable | Default |
|---|---|---|
| API root | `DSH_BASE_URL` | `http://127.0.0.1:8000/v1` |
| Model id | `DSH_MODEL_ID` | `ds-0731` |
| Model name | `DSH_MODEL_NAME` | `DeepSeek V4 Flash` |
| Provider name | `DSH_PROVIDER_NAME` | `Twin DGX Spark` |
| Context | `DSH_CONTEXT_WINDOW` | `1048576` |
| Max output | `DSH_MAX_TOKENS` | `16384` |
| Permission mode | `DSH_PERMISSION_MODE` | `workspace-write` |
| Schema string cap | `DSH_MAX_SCHEMA_STRING_LENGTH` | `2000` |

An example two-node Spark profile remains in
[`examples/twinspark.env`](examples/twinspark.env). Replace its example host
with the DNS name or address of your own model endpoint.

## Security model

Only one MCP server is accepted. Its executable must resolve to the configured
Buzz sidecar, arguments must be empty, and only Buzz relay, identity, display,
and git-origin environment keys are passed. Arbitrary HTTP MCP servers and
additional child-process environment variables are rejected. The schema proxy
passes only a minimal operating-system environment plus those allowlisted Buzz
values to the sidecar.

The built-in bash executor retains DeepSeek Harness's credential scrub and then
restores exactly `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL`, `BUZZ_AUTH_TAG`, and
`BUZZ_ACP_DISPLAY_NAME` when they are present. This makes the built-in `buzz`
CLI behave like it does under the other Buzz harnesses without exposing model
provider keys, GitHub tokens, or unrelated user credentials to shell commands.

See [SECURITY.md](SECURITY.md) for reporting guidance.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run schema:audit
npm run smoke:buzz-mcp # real Buzz sidecar, no relay post
npm run smoke:cancel   # live model cancellation, bounded to Buzz's 5s grace
npm run smoke       # live model response
npm run smoke:tools # live model plus coding tools
```

The unit/integration suite uses a fake local MCP server and does not need Buzz
credentials or a model endpoint. Live smoke tests use the configured endpoint.

## Contributing

Bug reports and pull requests are welcome. Repository write access remains
limited to the maintainer; proposed changes are reviewed through GitHub pull
requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and
validation checklist.
