/**
 * Workspace fingerprints for acceptance integrity.
 *
 * The ledger alone cannot tell whether the files a verifier tested are still
 * the files the project has NOW. Two digests close the common gaps:
 *
 * - `protectedDigest` — the acceptance harness (tests, package manifests,
 *   lockfiles). Captured BEFORE the worker starts (dispatch baseline) and again
 *   when the verifier runs evidence: a worker that "fixes" a test instead of the
 *   code changes this digest, so policy acceptance must refuse.
 * - `workspaceDigest` — the whole project tree (bounded). Captured when evidence
 *   is recorded and re-checked at acceptance: files changed after verification
 *   (TOCTOU) must not be auto-accepted.
 *
 * Everything here is bounded and best-effort: unreadable files are skipped,
 * the file count is capped, and a truncated scan is marked as such (policy then
 * falls back to human acceptance).
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'target', 'vendor', 'out', '.cache'])
const MAX_FILES = 2000
const MAX_FILE_BYTES = 512 * 1024

/** Paths whose change means "the acceptance harness changed", not "the code was fixed". */
const PROTECTED = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^bun\.lockb$/,
  /(^|\/)(test|tests|spec|__tests__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  // Runner configuration / dependency manifests: changing these changes WHICH
  // tests run (or whether they run at all), so they are harness, not work.
  /^(jest|vitest|playwright|cypress|karma)\.config\.[cm]?[jt]s$/,
  /^\.(mocharc|nycrc)(\.[a-z]+)?$/,
  /^(Makefile|conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/,
  /^(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)(test-?utils|fixtures|__mocks__)\//,
]

const isProtected = (relPath) => PROTECTED.some((pattern) => pattern.test(relPath))

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * @param {string} root project directory
 * @param {{maxFiles?: number, maxFileBytes?: number}} [options]
 */
export function fingerprintWorkspace(root, { maxFiles = MAX_FILES, maxFileBytes = MAX_FILE_BYTES } = {}) {
  const files = new Map()
  let truncated = false
  let scanned = 0
  const walk = (dir) => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const absolute = join(dir, entry.name)
      const relPath = relative(root, absolute).split('\\').join('/')
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(absolute)
        if (truncated) return
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      if (scanned > maxFiles) {
        truncated = true
        return
      }
      let digest
      try {
        const stat = statSync(absolute)
        if (stat.size > maxFileBytes) {
          // Large artifacts do not need content identity for the harness check.
          digest = `size:${stat.size}`
        } else {
          digest = sha256(readFileSync(absolute))
        }
      } catch {
        digest = 'unreadable'
      }
      files.set(relPath, digest)
    }
  }
  walk(root)
  const lines = [...files.entries()].sort(([left], [right]) => left.localeCompare(right))
  const protectedLines = lines.filter(([relPath]) => isProtected(relPath))
  return {
    root,
    files: lines.length,
    protectedFiles: protectedLines.length,
    truncated,
    digest: sha256(lines.map(([relPath, digest]) => `${relPath}\u0000${digest}`).join('\n')),
    protectedDigest: sha256(protectedLines.map(([relPath, digest]) => `${relPath}\u0000${digest}`).join('\n')),
    hasProtected: protectedLines.length > 0,
  }
}

/** Compare a fresh fingerprint against the digests recorded in the ledger. */
export function compareFingerprints(current, expected) {
  if (current === undefined || current === null) return { ok: false, reason: 'fingerprint-unavailable' }
  if (expected === undefined || expected === null) return { ok: false, reason: 'no-baseline' }
  if (current.truncated === true) return { ok: false, reason: 'workspace-too-large' }
  const reasons = []
  if (expected.protectedDigest !== undefined && current.protectedDigest !== expected.protectedDigest) {
    reasons.push('acceptance-harness-changed')
  }
  if (expected.digest !== undefined && current.digest !== expected.digest) {
    reasons.push('workspace-changed-since-evidence')
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('+'), reasons }
}
