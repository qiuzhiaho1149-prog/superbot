import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { PROJECT_FILE_NAME, renderProjectMap, scanProjectProfile, writeProjectMap } from '../lib/project-profile.js'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'superbot-profile-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const seedProject = () => {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', build: 'node build.js' }, dependencies: { x: '1' } }, null, 2))
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  writeFileSync(join(dir, 'src', 'index.js'), 'export {}\n')
  return dir
}

describe('project profile reconnaissance', () => {
  it('maps stack, commands and harness gaps without executing project code', () => {
    const path = seedProject()
    const profile = scanProjectProfile({ projectId: 'ws-1', title: 'demo', path })
    assert.equal(profile.projectId, 'ws-1')
    assert.ok(profile.stack.includes('node'))
    assert.ok(profile.commands.some((entry) => entry.command === 'npm run test'))
    assert.equal(profile.harness.hasAgents, false)
    assert.equal(profile.harness.hasCi, false)
    assert.ok(profile.harness.missing.some((item) => item.includes('AGENTS.md')))
    assert.ok(profile.topLevel.dirs.includes('src'))
    const map = renderProjectMap(profile)
    assert.match(map, /^# Superbot project map/)
    assert.match(map, /npm run test/)
    assert.match(map, /AGENTS\.md/)
  })

  it('writes the map and refuses a foreign file', () => {
    const path = seedProject()
    const profile = scanProjectProfile({ projectId: 'ws-1', path })
    const first = writeProjectMap(path, renderProjectMap(profile))
    assert.equal(first.written, true)
    assert.equal(first.path, join(path, PROJECT_FILE_NAME))
    assert.match(readFileSync(first.path, 'utf8'), /^# Superbot project map/)
    writeFileSync(join(path, PROJECT_FILE_NAME), '# user map\n')
    const second = writeProjectMap(path, renderProjectMap(profile))
    assert.equal(second.written, false)
    assert.equal(second.reason, 'foreign-file')
  })

  it('reports a missing path instead of inventing a map', () => {
    assert.throws(() => scanProjectProfile({ projectId: 'x', path: join(dir, 'missing') }), /does not exist/)
  })
})
