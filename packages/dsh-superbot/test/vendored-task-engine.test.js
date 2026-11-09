import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const here = fileURLToPath(new URL('.', import.meta.url))
const vendored = join(here, '..', 'lib', 'task-engine.js')
const source = join(here, '..', '..', 'task-engine', 'lib', 'index.js')

describe('vendored task-engine (self-contained plugin package)', () => {
  it('matches the source task-engine byte-for-byte', () => {
    assert.equal(readFileSync(vendored, 'utf8'), readFileSync(source, 'utf8'), 'run `cp packages/task-engine/lib/index.js packages/dsh-superbot/lib/task-engine.js` after changing task-engine')
  })
})
