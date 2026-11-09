import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfigPatch } from '../lib/config.js'

describe('config', () => {
  it('loads defaults when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'superbot-config-'))
    try {
      const config = loadConfig(dir)
      assert.equal(config.budgetTokens, DEFAULT_CONFIG.budgetTokens)
      assert.equal(config.stateDir, dir)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('persists a validated patch atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'superbot-config-'))
    try {
      const saved = saveConfig(dir, { dedupeToolResults: false, budgetTokens: 200_000, compactAt: 0.6, handoffAt: 0.85 })
      assert.equal(saved.dedupeToolResults, false)
      assert.equal(saved.budgetTokens, 200_000)
      assert.equal(loadConfig(dir).compactAt, 0.6)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects invalid values', () => {
    assert.throws(() => validateConfigPatch({ budgetTokens: 1 }), /budgetTokens/)
    assert.throws(() => validateConfigPatch({ compactAt: 0.9, handoffAt: 0.8 }), /smaller than handoffAt/)
    assert.throws(() => validateConfigPatch({ dedupeToolResults: 'yes' }), /boolean/)
  })
})
