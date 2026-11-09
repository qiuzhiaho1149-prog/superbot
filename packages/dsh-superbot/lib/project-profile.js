/**
 * Read-only project reconnaissance for first-run onboarding and new projects.
 *
 * The manager needs a project map / harness assessment BEFORE planning work in
 * a project it has never seen. This module only reads bounded metadata (manifests,
 * docs, top-level structure, test/CI markers); it never executes project code,
 * never runs git commands and never scans file contents beyond small files.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const PROJECT_FILE_NAME = 'SUPERBOT-PROJECT.md'
const MARKER = '# Superbot project map'
const MAX_FILE_BYTES = 64 * 1024
const MAX_ENTRIES = 80
const MAX_DIRS = 40

const readSmall = (file) => {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const listDir = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => !['.git', 'node_modules', '.DS_Store'].includes(entry.name))
      .slice(0, MAX_ENTRIES)
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
  } catch {
    return []
  }
}

const detectPackage = (root) => {
  const raw = readSmall(join(root, 'package.json'))
  if (raw === undefined) return undefined
  try {
    const pkg = JSON.parse(raw)
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    const pick = ['test', 'lint', 'build', 'typecheck', 'check', 'dev'].filter((key) => typeof scripts[key] === 'string')
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : null,
      private: pkg.private === true,
      scripts: Object.fromEntries(pick.map((key) => [key, String(scripts[key]).slice(0, 120)])),
      dependencyCount: Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length,
    }
  } catch {
    return { parseError: true }
  }
}

const detectManifests = (root) => {
  const files = ['pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'requirements.txt', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'uv.lock']
  return files.filter((file) => existsSync(join(root, file)))
}

const detectHarness = (root) => {
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'README.md', '.cursor/rules', '.github/workflows']
  const present = candidates.filter((file) => existsSync(join(root, file)))
  const handoff = existsSync(join(root, 'SUPERBOT-HANDOFF.md'))
  const projectFile = existsSync(join(root, PROJECT_FILE_NAME))
  const workflows = (() => {
    const dir = join(root, '.github', 'workflows')
    if (!existsSync(dir)) return []
    try { return readdirSync(dir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).slice(0, 10) } catch { return [] }
  })()
  return { present, workflows, handoff, projectFile, hasAgents: present.includes('AGENTS.md'), hasCi: workflows.length > 0 }
}

const inferCommands = (root, pkg) => {
  const commands = []
  if (pkg?.scripts) {
    for (const key of ['test', 'lint', 'typecheck', 'build']) {
      if (pkg.scripts[key]) commands.push({ name: key, command: `npm run ${key}`, source: 'package.json' })
    }
  }
  if (existsSync(join(root, 'pnpm-lock.yaml'))) commands.push({ name: 'install', command: 'pnpm install --frozen-lockfile', source: 'lockfile' })
  if (existsSync(join(root, 'Cargo.toml'))) commands.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' })
  if (existsSync(join(root, 'go.mod'))) commands.push({ name: 'test', command: 'go test ./...', source: 'go.mod' })
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) commands.push({ name: 'test', command: 'pytest', source: 'python manifest' })
  if (existsSync(join(root, 'Makefile'))) commands.push({ name: 'make', command: 'make test', source: 'Makefile' })
  return commands.slice(0, 12)
}

/**
 * @param {{projectId: string, title?: string, path: string}} project
 * @returns {object} bounded profile
 */
export function scanProjectProfile(project) {
  const root = project?.path
  if (typeof root !== 'string' || root === '') throw new Error('project path is required')
  if (!existsSync(root)) throw new Error(`project path does not exist: ${root}`)
  const pkg = detectPackage(root)
  const entries = listDir(root)
  const dirs = entries.filter((entry) => entry.dir).map((entry) => entry.name).slice(0, MAX_DIRS)
  const files = entries.filter((entry) => !entry.dir).map((entry) => entry.name).slice(0, MAX_DIRS)
  const harness = detectHarness(root)
  const commands = inferCommands(root, pkg)
  const missing = []
  if (!harness.hasAgents) missing.push('AGENTS.md（项目级 agent 约束）')
  if (!harness.hasCi) missing.push('.github/workflows（可复现的 CI/验收入口）')
  if (!harness.handoff) missing.push('SUPERBOT-HANDOFF.md（项目交接）')
  if (!commands.some((entry) => entry.name === 'test')) missing.push('可执行的 test 命令（验收证据来源）')

  const tech = []
  if (pkg) tech.push('node')
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) tech.push('python')
  if (existsSync(join(root, 'Cargo.toml'))) tech.push('rust')
  if (existsSync(join(root, 'go.mod'))) tech.push('go')
  if (dirs.includes('src') || dirs.includes('app') || dirs.includes('lib')) tech.push('source-dirs')

  return {
    projectId: String(project.projectId ?? ''),
    title: typeof project.title === 'string' && project.title !== '' ? project.title : String(project.projectId ?? ''),
    path: root,
    stack: tech,
    package: pkg ?? null,
    manifests: detectManifests(root),
    topLevel: { dirs, files },
    commands,
    harness: { ...harness, missing },
    profileWritten: false,
    limits: { maxFileBytes: MAX_FILE_BYTES, maxEntries: MAX_ENTRIES },
  }
}

/** Render a compact project map/harness report (for humans and off-state). */
export function renderProjectMap(profile) {
  const lines = [
    `${MARKER} — ${profile.title}`,
    '',
    'Read-only reconnaissance generated by Superbot. It is a map, not a task.',
    '',
    `- Project: ${profile.projectId}`,
    `- Path: ${profile.path}`,
    `- Stack: ${profile.stack.length > 0 ? profile.stack.join(', ') : 'unknown'}`,
    '',
    '## Commands',
    profile.commands.length === 0 ? '- (no recognised test/build command)' : '',
    ...profile.commands.map((entry) => `- ${entry.name}: \`${entry.command}\` (${entry.source})`),
    '',
    '## Structure (top level)',
    `- dirs: ${profile.topLevel.dirs.join(', ') || '(none)'}`,
    `- files: ${profile.topLevel.files.slice(0, 20).join(', ') || '(none)'}`,
    '',
    '## Harness',
    `- present: ${profile.harness.present.join(', ') || '(none)'}`,
    `- CI workflows: ${profile.harness.workflows.join(', ') || '(none)'}`,
    `- handoff: ${profile.harness.handoff ? 'yes' : 'no'}`,
    '',
    '## Gaps to fix before large changes',
    profile.harness.missing.length === 0 ? '- (none detected)' : '',
    ...profile.harness.missing.map((item) => `- ${item}`),
    '',
    '## How to use this map',
    '1. Run the test command before and after changes; treat failures as evidence, not noise.',
    '2. Add AGENTS.md / CI only with the human owner; do not silently rewrite project policy.',
    '3. For multi-step work, create separate ledger tasks per session contract; one writer per project.',
    '4. Superbot regenerates this file; delete it safely if you no longer use Superbot.',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/** Write the map into the project; refuses foreign files. */
export function writeProjectMap(projectPath, markdown, { fileName = PROJECT_FILE_NAME } = {}) {
  const file = join(projectPath, fileName)
  if (existsSync(file)) {
    let existing = ''
    try { existing = readFileSync(file, 'utf8').slice(0, 120) } catch { existing = '' }
    if (!existing.startsWith(MARKER)) return { path: file, written: false, bytes: 0, reason: 'foreign-file' }
  }
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, markdown, { encoding: 'utf8', mode: 0o644 })
  renameSync(temp, file)
  return { path: file, written: true, bytes: Buffer.byteLength(markdown, 'utf8') }
}
