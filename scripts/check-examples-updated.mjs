#!/usr/bin/env node
// Every library change ships an example (CLAUDE.md "Examples rule", .github/copilot-instructions.md DoD 10).
//
// For each changeset ADDED on this branch (compared with the base, default origin/main), every `@weaveintel/*`
// package it names must be imported by at least one file under `examples/` that this branch added or changed.
// A changeset may opt a package out with a line in its body:
//
//   examples: none — <reason>            (all packages in that changeset)
//   examples: none @weaveintel/x — <reason>
//
// A patch-only fix with no API change is the usual reason. Exit 1 with a sentence per missing example.
//
// Usage: node scripts/check-examples-updated.mjs [--base origin/main]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const base = baseIdx >= 0 ? args[baseIdx + 1] : process.env.EXAMPLES_BASE ?? 'origin/main'

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

let mergeBase
try {
  mergeBase = git('merge-base', base, 'HEAD')
} catch {
  console.log(`check-examples-updated: base ${base} not found; nothing to compare (shallow clone?). Skipping.`)
  process.exit(0)
}

const changed = git('diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}...HEAD`).split('\n').filter(Boolean)
const changesets = changed.filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && !f.endsWith('README.md'))
if (changesets.length === 0) {
  console.log('check-examples-updated: no new changesets on this branch. OK.')
  process.exit(0)
}

const exampleFiles = changed.filter((f) => f.startsWith('examples/') && /\.(ts|mts|js|mjs)$/.test(f) && existsSync(f))
const importedByExamples = new Set()
for (const f of exampleFiles) {
  for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"](@weaveintel\/[a-z0-9-]+)/g)) importedByExamples.add(m[1])
}

const problems = []
for (const cs of changesets) {
  const text = readFileSync(cs, 'utf8')
  const front = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!front) continue
  const pkgs = [...front[1].matchAll(/['"]?(@weaveintel\/[a-z0-9-]+)['"]?\s*:/g)].map((m) => m[1])
  const body = text.slice(front[0].length)
  const optOutAll = /^examples:\s*none(?!\s+@)\s*[—-]\s*\S/m.test(body)
  for (const pkg of pkgs) {
    if (optOutAll) continue
    const optOut = new RegExp(`^examples:\\s*none\\s+${pkg.replace('/', '\\/')}\\s*[—-]\\s*\\S`, 'm').test(body)
    if (optOut || importedByExamples.has(pkg)) continue
    problems.push(`${cs} changes ${pkg}, but no example under examples/ added or changed on this branch imports it. ` +
      `Add or update one (see examples/README.md), or write "examples: none ${pkg} — <reason>" in the changeset.`)
  }
}

if (problems.length > 0) {
  console.error('Every @weaveintel library change ships an example (CLAUDE.md, Examples rule):')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`check-examples-updated: ${changesets.length} changeset(s), every package has an example. OK.`)
