/**
 * Minimal fake Cordis context for unit tests. Not a test file (not matched by
 * `test/*.test.js`); imported by tests that exercise plugin `apply()` entry
 * points without booting DSH.
 */

/**
 * @param {{services?: Record<string, unknown>}} [options]
 */
export function createFakeContext({ services = {} } = {}) {
  /** @type {Map<string, unknown>} */
  const provided = new Map(Object.entries(services))
  /** @type {Array<Record<string, unknown>>} */
  const tools = []
  /** @type {Array<{event: string, handler: Function, options?: object}>} */
  const hooks = []
  /** @type {Array<() => void>} */
  const effects = []
  /** @type {Array<{deps: string[], callback: Function}>} */
  const pendingInjects = []
  const logs = { info: [], warn: [] }

  const runInjects = () => {
    for (let index = pendingInjects.length - 1; index >= 0; index -= 1) {
      const pending = pendingInjects[index]
      if (!pending.deps.every((dep) => provided.has(dep))) continue
      pendingInjects.splice(index, 1)
      pending.callback(ctx)
    }
  }

  const ctx = {
    logger: {
      info: (message) => { logs.info.push(String(message)) },
      warn: (message) => { logs.warn.push(String(message)) },
      error: (message) => { logs.warn.push(String(message)) },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    get(name) {
      return provided.get(name)
    },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    on(event, handler, options) {
      hooks.push({ event, handler, options })
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    inject(deps, callback) {
      pendingInjects.push({ deps: [...deps], callback })
      runInjects()
    },
    emit() {},
  }

  return {
    ctx,
    provided,
    tools,
    hooks,
    effects,
    logs,
    /** Register a service after apply() and run any inject callback waiting on it. */
    addService(name, value) {
      provided.set(name, value)
      runInjects()
      return value
    },
    /** Run callbacks whose dependencies are already available (normally automatic). */
    flush() {
      runInjects()
    },
    /** Invoke a captured event hook: `emit('tools/post-execute', ...args, next)`. */
    async dispatch(event, ...args) {
      const matched = hooks.filter((hook) => hook.event === event)
      let index = matched.length - 1
      const next = async () => {
        const hook = matched[index]
        index -= 1
        if (hook === undefined) return undefined
        return hook.handler(...args, next)
      }
      return next()
    },
  }
}

/** Fake HTTP response capturing status/headers/body. */
export function createFakeResponse() {
  const output = { status: 0, headers: {}, body: '' }
  return {
    output,
    writeHead(status, headers) {
      output.status = status
      output.headers = headers ?? {}
    },
    end(body) {
      output.body = typeof body === 'string' ? body : String(body ?? '')
    },
  }
}

/** Parse a captured response body as JSON. */
export function jsonOf(response) {
  return JSON.parse(response.output.body)
}

/** Await pending microtasks (async preset registration etc.). */
export async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}
