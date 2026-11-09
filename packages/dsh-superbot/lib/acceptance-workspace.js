/**
 * One-time acceptance workspace (P0-1 closure).
 *
 * The verifier's declared command must never run against the live project
 * directory with plugin-process privileges: project code is worker-editable and
 * could otherwise write the ledger, read credentials, or mutate unrelated files.
 * Here we copy the working tree (minus dependency/build dirs) into a fresh temp
 * directory, symlink dependency trees read-only where possible, and execute the
 * command there under the host shell's workspace-write sandbox. The temp copy is
 * deleted afterwards.
 *
 * Residual: a copy still shares the OS user's read access (Seatbelt allows reads)
 * and the host sandbox policy limits writes, not network. Full read/network
 * isolation needs a stronger runner; this closes the ledger-write path.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', '.nuxt',
  'target', 'vendor', 'out', '.cache', '.pnpm-store',
])
const MAX_COPY_FILES = 8000

/**
 * @param {string} projectPath
 * @param {{maxFiles?: number}} [options]
 * @returns {{ dir: string, mode: 'copy', cleanup: () => void }}
 */
export function createAcceptanceWorkspace(projectPath, { maxFiles = MAX_COPY_FILES } = {}) {
  if (typeof projectPath !== 'string' || projectPath === '' || !existsSync(projectPath)) {
    throw new Error(`acceptance workspace: project path does not exist: ${String(projectPath)}`)
  }
  const root = mkdtempSync(join(tmpdir(), 'superbot-acceptance-'))
  let copied = 0
  const filter = (source) => {
    const base = source.split(/[\\/]/).pop()
    if (base !== undefined && SKIP_DIRS.has(base)) return false
    copied += 1
    if (copied > maxFiles) throw new Error(`acceptance workspace: project has more than ${maxFiles} entries; refusing an unbounded copy (split the work or run a narrower test command)`)
    return true
  }
  try {
    cpSync(projectPath, root, { recursive: true, filter, preserveTimestamps: true })
    // Dependency trees are read-only inputs for tests; symlinking avoids copying
    // gigabytes while the workspace-write sandbox still denies writes to them.
    for (const dep of ['node_modules', '.venv', 'venv']) {
      const source = join(projectPath, dep)
      const target = join(root, dep)
      if (!existsSync(source) || existsSync(target)) continue
      try {
        const stats = statSync(source)
        if (stats.isDirectory()) symlinkSync(source, target, 'dir')
      } catch {
        // best effort: tests that need no deps still run
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  let cleaned = false
  return {
    dir: root,
    mode: 'copy',
    cleanup() {
      if (cleaned) return
      cleaned = true
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // temp dir cleanup is best effort; it lives under the OS temp root
      }
    },
  }
}
