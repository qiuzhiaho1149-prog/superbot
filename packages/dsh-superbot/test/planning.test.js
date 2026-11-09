import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  RUN_TERMINAL_STATUSES, WORK_SCHEMA_VERSION, WorkStore, findPlanCycle, isRunActive, workPaths,
} from '../lib/work-store.js'
import { createSuperbotTools } from '../lib/tools.js'
import { ROLES, ROLE_TOOLS, TOOL_NAMES } from '../lib/roles.js'
import { createFakeContext } from './fake-context.js'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-planning-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const store = () => new WorkStore({ stateDir: dir })

const task = (overrides = {}) => ({
  title: 'Implement the change',
  projectId: 'ws-1',
  priority: 'normal',
  acceptance: ['node --test test/*.test.js'],
  ...overrides,
})

/** Requirement → spec → plan, the normal control-plane path. */
function seedPlan(workStore = store(), planOverrides = {}) {
  const requirement = workStore.submitRequirement({
    projectId: 'ws-1',
    title: 'Ship S4 planning',
    text: '需求原文：把需求/规格/计划接进控制平面。',
    priority: 'high',
  }, { actor: 'manager', reason: 'requirement-submit' })
  const spec = workStore.recordSpec({
    requirementId: requirement.id,
    content: '需求落成可执行规格：新增事件、工具、派工接线。',
    acceptance: ['node --test test/*.test.js'],
  }, { actor: 'manager', reason: 'spec-record' })
  const built = workStore.createPlan({
    requirementId: requirement.id,
    specId: spec.id,
    title: 'S4 plan',
    tasks: [
      { id: 't-a', ...task({ title: 'A' }) },
      { ...task({ title: 'B', acceptance: ['B passes'] }), deps: ['t-a'] },
    ],
    ...planOverrides,
  }, { actor: 'manager', reason: 'plan-create' })
  return { requirement, spec, ...built }
}

function readEventLines(stateDir = dir) {
  return readFileSync(workPaths(stateDir).events, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

function markDone(workStore, id) {
  workStore.claimTask(id, { owner: 'worker-1' })
  workStore.transitionTask(id, 'in_review', { actor: 'worker-1' })
  workStore.transitionTask(id, 'done', { actor: 'human', reason: 'accepted' })
}

describe('work-store requirements / specs / plans', () => {
  it('persists requirement, spec and plan as append-only events with one envelope', () => {
    const workStore = store()
    const { requirement, spec, plan, tasks } = seedPlan(workStore)

    assert.match(requirement.id, /^rq-/)
    assert.equal(requirement.status, 'submitted')
    assert.equal(requirement.priority, 'high')
    assert.match(spec.id, /^sp-/)
    assert.equal(spec.requirementId, requirement.id)
    assert.deepEqual(spec.acceptance, ['node --test test/*.test.js'])
    assert.match(plan.id, /^pl-/)
    assert.deepEqual(plan.taskIds, ['t-a', tasks[1].id])
    assert.deepEqual(tasks.map((row) => row.status), ['todo', 'todo'], 'a plan is plan-created, so its tasks are dispatchable')
    assert.equal(plan.specId, spec.id)

    assert.equal(workStore.getRequirement(requirement.id).title, 'Ship S4 planning')
    assert.equal(workStore.listSpecs({ requirementId: requirement.id }).length, 1)
    assert.equal(workStore.listPlans({ requirementId: requirement.id }).length, 1)
    assert.equal(workStore.getTask(tasks[1].id).deps[0], 't-a')

    const events = readEventLines()
    assert.deepEqual(events.map((event) => event.kind).slice(0, 7), [
      'requirement/created',
      'spec/recorded',
      'task/created',
      'task/created',
      'task/transition',
      'task/transition',
      'plan/created',
    ])
    for (const event of events) {
      assert.equal(event.schemaVersion, WORK_SCHEMA_VERSION)
      assert.ok(typeof event.at === 'string' && event.at !== '')
      assert.ok(typeof event.actor === 'string' && event.actor !== '')
      assert.ok(typeof event.reason === 'string' && event.reason !== '')
    }
    assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1))

    const projection = JSON.parse(readFileSync(workPaths(dir).projection, 'utf8'))
    assert.equal(projection.schemaVersion, WORK_SCHEMA_VERSION)
    assert.deepEqual(projection.counts, {
      requirements: 1, specs: 1, plans: 1, tasks: 2, runs: 0, reports: 0, reviews: 0, evidence: 0, inventory: 0,
    })
    assert.equal(workStore.stats().plans, 1)

    const audit = workStore.exportAudit()
    const kinds = new Set(audit.events.map((event) => event.kind))
    assert.ok(kinds.has('requirement/created'))
    assert.ok(kinds.has('spec/recorded'))
    assert.ok(kinds.has('plan/created'))
  })

  it('restores requirements/specs/plans after a restart and after projection corruption', () => {
    const first = store()
    const { requirement, spec, plan } = seedPlan(first)

    const reopened = new WorkStore({ stateDir: dir })
    assert.equal(reopened.getRequirement(requirement.id).title, requirement.title)
    assert.equal(reopened.getSpec(spec.id).content, spec.content)
    assert.equal(reopened.getPlan(plan.id).taskIds.length, 2)
    assert.equal(reopened.getTask(plan.taskIds[0]).status, 'todo')

    // events remain the truth when the disposable projection is unreadable
    writeFileSync(workPaths(dir).projection, '{not-json', 'utf8')
    const recovered = new WorkStore({ stateDir: dir })
    assert.equal(recovered.listRequirements().length, 1)
    assert.equal(recovered.listPlans().length, 1)
    assert.equal(recovered.getTask(plan.taskIds[1]).status, 'todo')
    const projection = JSON.parse(readFileSync(workPaths(dir).projection, 'utf8'))
    assert.equal(projection.counts.requirements, 1)
    assert.equal(projection.counts.tasks, 2)
  })

  it('validates requirement/spec input and bounds free text', () => {
    const workStore = store()
    assert.throws(() => workStore.submitRequirement({ projectId: 'ws-1', text: '' }), /raw text/)
    assert.throws(() => workStore.submitRequirement({ projectId: '', text: 'x' }), /projectId/)
    assert.throws(() => workStore.submitRequirement({ projectId: 'ws-1', text: 'x', priority: 'urgent' }), /priority/)
    assert.throws(() => workStore.recordSpec({ requirementId: 'rq-nope', content: 'x' }), /unknown requirement/)

    const long = 'x'.repeat(9000)
    const requirement = workStore.submitRequirement({ projectId: 'ws-1', text: long })
    assert.ok(requirement.text.length <= 8000)
    assert.equal(requirement.title.length, 80, 'title is derived from the first line and bounded')
    assert.ok(requirement.title.endsWith('…'))
  })

  it('lists requirements newest-first-limited without inventing plans', () => {
    const workStore = store()
    workStore.submitRequirement({ projectId: 'ws-1', text: 'one', title: 'one' })
    workStore.submitRequirement({ projectId: 'ws-2', text: 'two', title: 'two' })
    const listed = workStore.listRequirements()
    assert.deepEqual(listed.map((row) => row.title), ['one', 'two'])
    assert.deepEqual(workStore.listRequirements({ projectId: 'ws-2' }).map((row) => row.title), ['two'])
    assert.deepEqual(workStore.listRequirements({ limit: 1 }).map((row) => row.title), ['two'])
    assert.equal(workStore.listPlans().length, 0)
  })

  it('treats every non-terminal run status as active', () => {
    assert.deepEqual([...RUN_TERMINAL_STATUSES], ['succeeded', 'failed', 'canceled'])
    assert.equal(isRunActive({ status: 'running' }), true)
    assert.equal(isRunActive({ status: 'starting' }), true, 'unknown statuses stay conservative')
    for (const status of RUN_TERMINAL_STATUSES) assert.equal(isRunActive({ status }), false)
    assert.equal(isRunActive(undefined), false)
  })
})

describe('plan DAG validation', () => {
  it('rejects an empty task list and tasks without acceptance', () => {
    const workStore = store()
    const requirement = workStore.submitRequirement({ projectId: 'ws-1', text: 'need it' })
    assert.throws(() => workStore.createPlan({ requirementId: requirement.id, tasks: [] }), /at least one task/)
    assert.throws(
      () => workStore.createPlan({ requirementId: requirement.id, tasks: [task({ acceptance: [] })] }),
      /acceptance/,
    )
    assert.equal(workStore.listTasks().length, 0, 'a rejected plan must not write tasks')
  })

  it('rejects unknown deps, cycles and duplicate ids before writing anything', () => {
    const workStore = store()
    const requirement = workStore.submitRequirement({ projectId: 'ws-1', text: 'need it' })
    assert.throws(
      () => workStore.createPlan({
        requirementId: requirement.id,
        tasks: [{ id: 't-1', ...task(), deps: ['t-missing'] }],
      }),
      /depends on unknown task: t-missing/,
    )
    assert.throws(
      () => workStore.createPlan({
        requirementId: requirement.id,
        tasks: [
          { id: 't-1', ...task({ title: 'one' }), deps: ['t-2'] },
          { id: 't-2', ...task({ title: 'two' }), deps: ['t-1'] },
        ],
      }),
      /acyclic/,
    )
    assert.throws(
      () => workStore.createPlan({
        requirementId: requirement.id,
        tasks: [{ id: 't-1', ...task({ title: 'one' }) }, { id: 't-1', ...task({ title: 'dup' }) }],
      }),
      /duplicate task id/,
    )
    assert.equal(workStore.stats().events, 1, 'only requirement/created exists; validation failed before task writes')
    assert.equal(workStore.listTasks().length, 0)
  })

  it('rejects a task id already used by the ledger and a spec from another requirement', () => {
    const workStore = store()
    workStore.submitTask({ id: 't-taken', ...task() })
    const requirement = workStore.submitRequirement({ projectId: 'ws-1', text: 'need it' })
    assert.throws(
      () => workStore.createPlan({ requirementId: requirement.id, tasks: [{ id: 't-taken', ...task() }] }),
      /already exists/,
    )

    const other = workStore.submitRequirement({ projectId: 'ws-1', text: 'other' })
    const spec = workStore.recordSpec({ requirementId: other.id, content: 'other spec' })
    assert.throws(
      () => workStore.createPlan({ requirementId: requirement.id, specId: spec.id, tasks: [task()] }),
      /does not belong/,
    )
  })

  it('accepts a dep on an already completed ledger task and links task states', () => {
    const workStore = store()
    workStore.submitTask({ id: 't-done', ...task({ title: 'prereq' }) })
    workStore.planTask('t-done')
    markDone(workStore, 't-done')
    const requirement = workStore.submitRequirement({ projectId: 'ws-1', text: 'need it' })
    const { tasks } = workStore.createPlan({
      requirementId: requirement.id,
      tasks: [{ id: 't-next', ...task({ title: 'next' }), deps: ['t-done'] }],
    })
    assert.equal(tasks[0].status, 'todo')
    assert.deepEqual(tasks[0].deps, ['t-done'])
  })

  it('detects internal cycles but ignores external dependencies', () => {
    assert.deepEqual(
      findPlanCycle([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]).sort(),
      ['a', 'b'],
    )
    assert.equal(findPlanCycle([{ id: 'a', deps: ['outside'] }, { id: 'b', deps: ['a'] }]), undefined)
  })
})

describe('planning tools (manager-only)', () => {
  const toolsOf = (role, ctx = createFakeContext().ctx, workStore = store()) => {
    const tools = createSuperbotTools({ role, ctx, store: workStore })
    return { tools, byName: (name) => tools.find((tool) => tool.name === name) }
  }

  it('submits a requirement without creating or dispatching tasks', () => {
    const { byName } = toolsOf('manager')
    const submitted = byName(TOOL_NAMES.requirementSubmit).execute({
      text: '需求：实现计划链', projectId: 'ws-1', title: 'S4', priority: 'high',
    })
    assert.match(submitted.requirement.id, /^rq-/)
    assert.equal(submitted.requirement.text, '需求：实现计划链')
    const listed = byName(TOOL_NAMES.requirementList).execute({})
    assert.equal(listed.requirements.length, 1)
    const tasks = byName(TOOL_NAMES.taskList).execute()
    assert.equal(tasks.tasks.length, 0, 'requirement submit must not create tasks')
  })

  it('records a spec and creates a dispatchable plan through the task engine', () => {
    const { byName } = toolsOf('manager')
    const requirement = byName(TOOL_NAMES.requirementSubmit).execute({ text: '需求', projectId: 'ws-1' }).requirement
    const spec = byName(TOOL_NAMES.specRecord).execute({
      requirementId: requirement.id,
      content: '规格',
      acceptance: ['tests pass'],
    }).spec
    const created = byName(TOOL_NAMES.planCreate).execute({
      requirementId: requirement.id,
      specId: spec.id,
      tasks: [{ id: 't-1', title: 'one', projectId: 'ws-1', priority: 'normal', acceptance: ['tests pass'] }],
    })
    assert.equal(created.dispatchable, true)
    assert.deepEqual(created.taskIds, ['t-1'])
    assert.equal(created.tasks[0].status, 'todo')

    const plan = byName(TOOL_NAMES.planGet).execute({ id: created.plan.id })
    assert.equal(plan.plan.specId, spec.id)
    assert.equal(plan.requirement.id, requirement.id)
    assert.equal(plan.tasks[0].status, 'todo')

    // plan_get reflects later state changes, it is not a frozen snapshot
    byName(TOOL_NAMES.taskClaim).execute({ id: 't-1', owner: 'worker-1' })
    assert.equal(byName(TOOL_NAMES.planGet).execute({ id: created.plan.id }).tasks[0].status, 'in_progress')

    const audit = byName(TOOL_NAMES.auditExport).execute({})
    const kinds = new Set(audit.events.map((event) => event.kind))
    for (const kind of ['requirement/created', 'spec/recorded', 'plan/created']) assert.ok(kinds.has(kind))
  })

  it('enforces the toolsEnabled setting on planning tools', () => {
    const workStore = store()
    const ctx = createFakeContext().ctx
    const tools = createSuperbotTools({ role: 'manager', ctx, store: workStore, getConfig: () => ({ toolsEnabled: false }) })
    const submit = tools.find((tool) => tool.name === TOOL_NAMES.requirementSubmit)
    assert.throws(() => submit.execute({ text: 'x', projectId: 'ws-1' }), /disabled in settings/)
  })

  it('keeps every planning tool out of worker and verifier scopes', () => {
    const planning = [TOOL_NAMES.requirementSubmit, TOOL_NAMES.requirementList, TOOL_NAMES.specRecord,
      TOOL_NAMES.planCreate, TOOL_NAMES.planGet, TOOL_NAMES.planDispatch]
    for (const name of planning) {
      assert.equal(ROLE_TOOLS.manager.includes(name), true, `${name} must be manager-only`)
    }
    for (const role of ['worker', 'verifier']) {
      for (const name of planning) assert.equal(ROLE_TOOLS[role].includes(name), false, `${role} must not see ${name}`)
      const tools = createSuperbotTools({ role, ctx: createFakeContext().ctx, store: store() })
      assert.deepEqual(tools.map((tool) => tool.name), [...ROLE_TOOLS[role]])
      assert.equal(tools.some((tool) => planning.includes(tool.name)), false)
    }
    assert.deepEqual([...ROLES], ['manager', 'worker', 'verifier'])
  })
})
