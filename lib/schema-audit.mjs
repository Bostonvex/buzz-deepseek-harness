import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const sourcePattern = /\bmaxLength\s*:\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi

export function findSourceMaxLengths(source, file = '<source>', cap = 2_000) {
  const findings = []
  for (const match of source.matchAll(sourcePattern)) {
    const value = Number(match[1])
    if (value <= cap) continue
    findings.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      raw: match[1],
      value,
    })
  }
  return findings
}

export function findJsonMaxLengths(value, path = '$', cap = 2_000, findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findJsonMaxLengths(item, `${path}[${index}]`, cap, findings))
    return findings
  }
  if (!value || typeof value !== 'object') return findings
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (key === 'maxLength' && typeof child === 'number' && child > cap) {
      findings.push({ path: childPath, value: child })
    } else {
      findJsonMaxLengths(child, childPath, cap, findings)
    }
  }
  return findings
}

export function auditSourceTree(root, cap = 2_000) {
  const findings = []
  const visit = (path) => {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name))
      return
    }
    if (!['.js', '.mjs', '.cjs', '.ts'].includes(extname(path))) return
    findings.push(...findSourceMaxLengths(readFileSync(path, 'utf8'), path, cap))
  }
  visit(root)
  return findings
}
