/**
 * dsh-superbot persisted user configuration.
 * One JSON file under the DSH storage dir; atomic write; validated on save.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CONFIG = Object.freeze({
  dedupeToolResults: true,
  toolsEnabled: true,
  budgetTokens: 150_000,
  compactAt: 0.7,
  handoffAt: 0.9,
  cacheDir: '',
  stateDir: '',
  /** Global WIP cap across projects; a single project is always capped at one active worker. */
  wipLimit: 2,
  /** S5.2: refuse dispatch until the first-run inventory was confirmed by the user. */
  requireOnboarding: true,
  /** D6: policy auto-accept requires evidence executed by the host sandbox shell. */
  requireSandboxedEvidence: true,
  /** P0-7: HTTP human accept/confirm routes default OFF (approval dialog is structural). */
  httpHumanActions: false,
  /** S0: after a task-bound worker finishes, dispatch the verifier automatically. */
  autoAudit: true,
  /** P0-1: run acceptance in a one-time copy ('copy', default) or the live tree ('in-place', unsafe). */
  acceptanceIsolation: 'copy',
})

export function defaultStateDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-superbot')
}

/** Coerce/validate a partial patch. Throws on invalid values rather than silently dropping them. */
export function validateConfigPatch(patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('config must be an object')
  const out = {}
  if ('dedupeToolResults' in patch) {
    if (typeof patch.dedupeToolResults !== 'boolean') throw new Error('dedupeToolResults must be boolean')
    out.dedupeToolResults = patch.dedupeToolResults
  }
  if ('toolsEnabled' in patch) {
    if (typeof patch.toolsEnabled !== 'boolean') throw new Error('toolsEnabled must be boolean')
    out.toolsEnabled = patch.toolsEnabled
  }
  if ('budgetTokens' in patch) {
    const value = patch.budgetTokens
    if (!Number.isInteger(value) || value < 10_000 || value > 1_000_000) throw new Error('budgetTokens must be an integer 10000..1000000')
    out.budgetTokens = value
  }
  if ('compactAt' in patch) {
    const value = patch.compactAt
    if (typeof value !== 'number' || !(value > 0.3 && value < 1)) throw new Error('compactAt must be between 0.3 and 1')
    out.compactAt = value
  }
  if ('handoffAt' in patch) {
    const value = patch.handoffAt
    if (typeof value !== 'number' || !(value > 0.3 && value <= 1)) throw new Error('handoffAt must be between 0.3 and 1')
    out.handoffAt = value
  }
  if ('cacheDir' in patch) {
    if (typeof patch.cacheDir !== 'string') throw new Error('cacheDir must be a string')
    out.cacheDir = patch.cacheDir
  }
  if ('stateDir' in patch) {
    if (typeof patch.stateDir !== 'string') throw new Error('stateDir must be a string')
    out.stateDir = patch.stateDir
  }
  if ('requireOnboarding' in patch) {
    if (typeof patch.requireOnboarding !== 'boolean') throw new Error('requireOnboarding must be boolean')
    out.requireOnboarding = patch.requireOnboarding
  }
  if ('requireSandboxedEvidence' in patch) {
    if (typeof patch.requireSandboxedEvidence !== 'boolean') throw new Error('requireSandboxedEvidence must be boolean')
    out.requireSandboxedEvidence = patch.requireSandboxedEvidence
  }
  if ('autoAudit' in patch) {
    if (typeof patch.autoAudit !== 'boolean') throw new Error('autoAudit must be boolean')
    out.autoAudit = patch.autoAudit
  }
  if ('httpHumanActions' in patch) {
    if (typeof patch.httpHumanActions !== 'boolean') throw new Error('httpHumanActions must be boolean')
    out.httpHumanActions = patch.httpHumanActions
  }
  if ('acceptanceIsolation' in patch) {
    if (patch.acceptanceIsolation !== 'copy' && patch.acceptanceIsolation !== 'in-place') throw new Error("acceptanceIsolation must be 'copy' or 'in-place'")
    out.acceptanceIsolation = patch.acceptanceIsolation
  }
  if ('wipLimit' in patch) {
    const value = patch.wipLimit
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('wipLimit must be an integer 1..8')
    out.wipLimit = value
  }
  if (out.compactAt !== undefined && out.handoffAt !== undefined && out.compactAt >= out.handoffAt) {
    throw new Error('compactAt must be smaller than handoffAt')
  }
  return out
}

export function configPath(stateDir) {
  return join(stateDir, 'config.json')
}

/** Read config, falling back to defaults on missing/corrupt file. */
export function loadConfig(stateDir = defaultStateDir()) {
  const file = configPath(stateDir)
  let stored = {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    }
  } catch {
    stored = {}
  }
  return { ...DEFAULT_CONFIG, ...stored, stateDir }
}

/** Merge + validate + atomically persist. Returns the new complete config. */
export function saveConfig(stateDir, patch) {
  const current = loadConfig(stateDir)
  const merged = { ...current, ...validateConfigPatch(patch), stateDir }
  if (merged.compactAt >= merged.handoffAt) throw new Error('compactAt must be smaller than handoffAt')
  mkdirSync(stateDir, { recursive: true })
  const file = configPath(stateDir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return merged
}
