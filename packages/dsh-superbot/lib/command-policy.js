/**
 * Acceptance-command trust anchor: a small template allowlist.
 *
 * A verifier may only execute commands the ledger already declares. That still
 * lets a manager declare arbitrary shell — so the ledger further requires every
 * declared command to match a standard test/check invocation. Anything else is
 * rejected at plan/submit time (and again at execution time as defence in
 * depth). Custom checks must be wrapped in the project's own test script
 * (`package.json` → `test`), which the user can review in the repository.
 *
 * This deliberately has no interactive "approve arbitrary command" path yet:
 * the allowlist is the structural guarantee, not a prompt.
 */

import { isSafeAcceptanceCommand } from './task-engine.js'

/**
 * Fixed argv only. No flags, paths, config files or test-name filters: those
 * can change *which* tests run (skip all / dry-run / zero tests) while still
 * exiting 0, which would turn a red build into green evidence. Anything that
 * needs parameters belongs in the project's own `test` script, which the user
 * can review in the repository.
 */
const FIXED_COMMANDS = Object.freeze([
  'node --test',
  'npm test',
  'npm run test',
  'pnpm test',
  'pnpm run test',
  'yarn test',
  'pytest',
  'py.test',
  'cargo test',
  'go test ./...',
  'dotnet test',
  'mvn test',
  'gradle test',
  'make test',
  'make check',
])

/** Human-facing examples for error messages and docs. */
export const SAFE_COMMAND_EXAMPLES = Object.freeze([
  'node --test',
  'npm test',
  'pnpm test',
  'pytest -q',
  'cargo test',
  'go test ./...',
  'make check',
])

/**
 * @param {unknown} command
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkAcceptanceCommand(command) {
  if (!isSafeAcceptanceCommand(command)) {
    return { ok: false, reason: 'must be a single command without shell chaining/substitution/redirection' }
  }
  const normalized = String(command).trim().replace(/\s+/g, ' ')
  if (!FIXED_COMMANDS.includes(normalized)) {
    return {
      ok: false,
      reason: `not a fixed standard test command (flags/paths/args are rejected because they can skip tests); allowed: ${FIXED_COMMANDS.join(' / ')}`,
    }
  }
  return { ok: true }
}

/**
 * Validate every declared command of one task list (plan create / task submit)
 * BEFORE any ledger write. Returns the rejected entries with their owner index.
 *
 * @param {ReadonlyArray<{id?: string, title?: string, acceptanceCommands?: ReadonlyArray<{command?: string}>}>} tasks
 * @returns {{ ok: boolean, rejected: Array<{task: number, index: number, command: string, reason: string}> }}
 */
export function checkDeclaredCommands(tasks) {
  const rejected = []
  ;(Array.isArray(tasks) ? tasks : []).forEach((task, taskIndex) => {
    const commands = Array.isArray(task?.acceptanceCommands) ? task.acceptanceCommands : []
    commands.forEach((entry, index) => {
      if (entry?.expectExitCode !== undefined && entry.expectExitCode !== 0) {
        rejected.push({ task: taskIndex, index, command: String(entry?.command ?? ''), reason: 'expectExitCode must be 0 when present (only clean success counts as evidence)' })
        return
      }
      const result = checkAcceptanceCommand(entry?.command)
      if (!result.ok) rejected.push({ task: taskIndex, index, command: String(entry?.command ?? ''), reason: result.reason })
    })
  })
  return { ok: rejected.length === 0, rejected }
}

/** One-line error for tools; keeps the actionable list short. */
export function commandPolicyError(rejected) {
  const first = rejected[0]
  return `验收命令不符合标准测试命令白名单：task[${first.task}] acceptanceCommands[${first.index}] = "${first.command}"（${first.reason}）。`
    + `请改用 ${SAFE_COMMAND_EXAMPLES.join(' / ')}，或把自定义检查写进项目 package.json 的 test 脚本。`
}
