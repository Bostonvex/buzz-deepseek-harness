#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditSourceTree } from './lib/schema-audit.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const cap = Number(process.env.DSH_MAX_SCHEMA_STRING_LENGTH ?? 2_000)
const roots = [
  join(root, 'lib'),
  join(root, 'node_modules/@deepseek-ai/dsh-mcp-client'),
  ...[
    'dsh-tool-fs',
    'dsh-tool-todo',
    'dsh-bash-sandbox',
  ].map((name) => join(root, 'node_modules/@deepseek-ai', name)),
].filter(existsSync)
const findings = roots.flatMap((path) => auditSourceTree(path, cap))

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: maxLength ${finding.raw} exceeds ${cap}`)
  }
  process.exitCode = 1
} else {
  console.log(`Schema audit passed: no model-facing maxLength exceeds ${cap}.`)
}
