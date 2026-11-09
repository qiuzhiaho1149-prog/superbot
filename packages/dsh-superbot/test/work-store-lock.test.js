import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { WorkStore, acquireInstanceLock } from '../lib/work-store.js'

const WORK_STORE_PATH = fileURLToPath(new URL('../lib/work-store.js', import.meta.url))

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const waitFor = (stream, marker, timeoutMs = 5000) => new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => {
    stream.off('data', onData)
    reject(new Error(`timed out waiting for ${marker}: ${buffer}`))
  }, timeoutMs)
  function onData(chunk) {
    buffer += chunk.toString()
    if (!buffer.includes(marker)) return
    clearTimeout(timer)
    stream.off('data', onData)
    resolve(buffer)
  }
  stream.on('data', onData)
})

describe('single-instance lock (D5)', () => {
  it('refuses a second live process and takes over a stale lock', async () => {
    const holder = join(dir, 'holder.mjs')
    writeFileSync(holder, [
      `import { createWorkStore } from ${JSON.stringify(WORK_STORE_PATH)}`,
      `const store = createWorkStore({ stateDir: ${JSON.stringify(dir)} })`,
      `console.log('ready')`,
      `setInterval(() => {}, 1000)`,
    ].join('\n'))
    const child = spawn(process.execPath, [holder], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await waitFor(child.stdout, 'ready')
      assert.throws(() => new WorkStore({ stateDir: dir }), /already in use by another Superbot process/)

      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      // Stale lock from a dead pid is taken over instead of blocking forever.
      const store = new WorkStore({ stateDir: dir })
      store.dispose()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit').catch(() => {})
      }
    }
  })

  it('lets exactly one of several concurrently started processes hold the lock', async () => {
    const racer = join(dir, 'racer.mjs')
    writeFileSync(racer, [
      `import { acquireInstanceLock } from ${JSON.stringify(WORK_STORE_PATH)}`,
      'try {',
      `  const lock = acquireInstanceLock(${JSON.stringify(dir)})`,
      `  console.log('RESULT:ok')`,
      `  setTimeout(() => { lock.release(); process.exit(0) }, 300)`,
      '} catch (error) {',
      `  console.log('RESULT:fail:' + String(error && error.message ? error.message : error))`,
      '  process.exit(0)',
      '}',
    ].join('\n'))
    const children = Array.from({ length: 3 }, () => spawn(process.execPath, [racer], { stdio: ['ignore', 'pipe', 'pipe'] }))
    const results = await Promise.all(children.map((child) => new Promise((resolve) => {
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk.toString() })
      child.on('exit', () => resolve(out))
    })))
    const winners = results.filter((line) => line.includes('RESULT:ok'))
    assert.equal(winners.length, 1, `exactly one process may hold the lock, got: ${JSON.stringify(results)}`)
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })

  it('replaces its own process lock and releases it explicitly', () => {
    const first = acquireInstanceLock(dir)
    assert.ok(first.file.endsWith('instance.lock'))
    const second = acquireInstanceLock(dir)
    first.release() // stale token: must not delete the newer owner's lock
    const store = new WorkStore({ stateDir: dir })
    store.dispose()
    second.release()
    // A fresh store can lock the directory again after dispose.
    const third = new WorkStore({ stateDir: dir })
    third.dispose()
  })
})
