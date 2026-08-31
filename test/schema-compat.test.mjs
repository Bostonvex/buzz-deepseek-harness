import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { capSchemaMaxLength } from '../lib/schema-cap.mjs'
import { findJsonMaxLengths, findSourceMaxLengths } from '../lib/schema-audit.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fakeMcp = join(root, 'test/fixtures/fake-buzz-mcp.mjs')

test('detects decimal and scientific-notation maxLength values', () => {
  const source = 'a = { maxLength: 4096 }; b = { maxLength: 1e4 }; c = { maxLength: 2000 }'
  assert.deepEqual(findSourceMaxLengths(source).map(({ raw, value }) => ({ raw, value })), [
    { raw: '4096', value: 4096 },
    { raw: '1e4', value: 10000 },
  ])
})

test('caps nested schema values without changing compliant values', () => {
  const schema = {
    maxLength: 65_536,
    properties: { a: { maxLength: 1e4 }, b: { maxLength: 2_000 } },
  }
  capSchemaMaxLength(schema)
  assert.equal(schema.maxLength, 2_000)
  assert.equal(schema.properties.a.maxLength, 2_000)
  assert.equal(schema.properties.b.maxLength, 2_000)
  assert.deepEqual(findJsonMaxLengths(schema), [])
})

test('MCP proxy caps model-facing tool schemas from a trusted server', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'mcp-schema-proxy.mjs')],
    env: {
      ...process.env,
      DSH_SCHEMA_PROXY_TARGET: fakeMcp,
      DSH_MAX_SCHEMA_STRING_LENGTH: '2000',
    },
  })
  const client = new Client({ name: 'schema-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const result = await client.listTools()
    assert.equal(result.tools[0].inputSchema.properties.message.maxLength, 2_000)
  } finally {
    await client.close()
  }
})
