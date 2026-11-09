/**
 * Restricted acceptance runner: turn ONE declared acceptance command into ONE
 * machine-evidence record.
 *
 * Trust boundary:
 * - the command text comes from the ledger (`task.acceptanceCommands[index]`),
 *   never from the model, so a verifier cannot invent a free-form shell;
 * - execution happens in the task's project root with a hard timeout;
 * - worker sessions have no tool that reaches this module: only a verifier run
 *   can ask the store to persist the resulting evidence.
 *
 * Residual risk (documented, not solved here): the command runs in the real
 * project directory, so a mis-declared command may write files. Commands are
 * declared by the manager in the approved plan and bounded to 500 chars.
 */

import { createHash } from 'node:crypto'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ACCEPTANCE_TIMEOUT_MS = 120_000
const MAX_BUFFER = 8 * 1024 * 1024
const ARTIFACT_MAX_CHARS = 2_000_000
const PREVIEW_HEAD = 1400
const PREVIEW_TAIL = 600

/** Stable content digest for an acceptance output. */
export function digestOf(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex')}`
}

/** Bounded preview: head + tail, with a marker when truncated. */
export function previewOf(text, { head = PREVIEW_HEAD, tail = PREVIEW_TAIL } = {}) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= head + tail) return value
  return `${value.slice(0, head)}\n…[truncated ${value.length - head - tail} chars]…\n${value.slice(-tail)}`
}

/**
 * Run one declared acceptance command. Never throws for a failing command: a
 * non-zero exit IS evidence and must be recorded, not turned into a tool error.
 *
 * @param {{
 *   task: Record<string, unknown>,
 *   index: number,
 *   cwd: string,
 *   artifactsDir: string,
 *   evidenceId: string,
 *   timeoutMs?: number,
 *   shell?: { resolve: Function, execute: Function },
 *   sandboxPolicy?: Record<string, unknown>,
 *   isolationMode?: 'copy'|'in-place',
 * }} input
 */
export async function runAcceptanceCommand({ task, index, cwd, artifactsDir, evidenceId, timeoutMs = ACCEPTANCE_TIMEOUT_MS, shell, sandboxPolicy, isolationMode }) {
  const declared = Array.isArray(task?.acceptanceCommands) ? task.acceptanceCommands[index] : undefined
  if (declared === undefined || typeof declared.command !== 'string' || declared.command.trim() === '') {
    throw new Error(`task ${String(task?.id)} has no declared acceptance command at index ${String(index)}`)
  }
  if (typeof cwd !== 'string' || cwd === '' || !existsSync(cwd)) {
    throw new Error(`acceptance cwd does not exist: ${String(cwd)}`)
  }
  const command = declared.command.trim()
  const startedAt = Date.now()
  // Acceptance commands do not need host credentials or DSH_* routing: strip
  // them so a declared command cannot read tokens/credentials from the env.
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Also drop the parent test-runner context: when Superbot itself runs under
    // `node --test`, an inherited NODE_TEST_CONTEXT makes the child runner skip
    // every file ("called recursively"), which would fake a green result.
    if (key === 'NODE_TEST_CONTEXT' || key === 'NODE_V8_COVERAGE') continue
    if (key.startsWith('DSH_') || key.startsWith('DEEPSEEK') || /TOKEN|SECRET|CREDENTIAL|API_KEY/i.test(key)) continue
    env[key] = value
  }
  env.DSH_SUPERBOT_ACCEPTANCE = '1'
  env.CI = '1'
  let result
  let executionMode = 'direct-exec'
  let sandboxed = false
  let sandboxMode
  if (typeof shell?.resolve === 'function' && typeof shell?.execute === 'function') {
    // Structural path: the host shell applies its sandbox policy (workspace-write
    // at best). Never fall back to a bare child_process on failure: a downgrade
    // would silently turn "sandboxed evidence" into "plugin-process RCE".
    const request = {
      command,
      workdir: cwd,
      timeoutMs,
      onExpiry: 'kill',
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    }
    const spec = shell.resolve(request)
    const execution = await shell.execute(spec)
    const outcome = await execution.result()
    result = {
      stdout: typeof outcome?.stdout?.text === 'string' ? outcome.stdout.text : '',
      stderr: typeof outcome?.stderr?.text === 'string' ? outcome.stderr.text : '',
      exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : (outcome?.timedOut === true ? 124 : 1),
      timedOut: outcome?.timedOut === true,
      signal: outcome?.signal ?? null,
    }
    executionMode = 'host-shell'
    sandboxed = outcome?.sandbox !== undefined
    sandboxMode = outcome?.sandbox?.mode
  } else {
    result = await new Promise((resolve) => {
      exec(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        shell: '/bin/sh',
        env,
      }, (error, stdout, stderr) => {
        const timedOut = error !== null && error.killed === true
        const exitCode = error === null
          ? 0
          : (Number.isInteger(error.code) ? error.code : (timedOut ? 124 : 1))
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode,
          timedOut,
          signal: error?.signal ?? null,
        })
      })
    })
  }
  const durationMs = Date.now() - startedAt
  const combined = `$ ${command}\n${result.stdout}\n${result.stderr}`.trim()
  mkdirSync(artifactsDir, { recursive: true })
  const outputPath = join(artifactsDir, `${evidenceId}.log`)
  writeFileSync(outputPath, combined.length <= ARTIFACT_MAX_CHARS ? combined : `${combined.slice(0, ARTIFACT_MAX_CHARS)}\n…[artifact truncated]…\n`, 'utf8')
  return {
    command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    signal: result.signal,
    durationMs,
    outputDigest: digestOf(combined),
    outputPath,
    preview: previewOf(combined),
    executionMode,
    sandboxed,
    ...(isolationMode === undefined ? {} : { isolationMode }),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
  }
}
