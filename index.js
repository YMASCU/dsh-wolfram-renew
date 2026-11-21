import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WolframError,
  runWolfram,
} from './wolfram.js'

export const name = 'wolfram-tool'
export const inject = ['tools', 'systemPrompt']

const SECTION_NAME = 'tool:wolfram'
const SECTION_ORDER = 600
const CONFIG_ROUTE = '/api/dsh-wolfram/config'

/**
 * The entry's configuration schema. Declaring it is what makes this plugin a
 * describable settings surface, so the client can mount the bundle's config
 * page through `configForms.whileServed`. It is imported at run time because a
 * composition without schemastery should keep the tool and lose only the page.
 */
export const Config = await (async () => {
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    const z = loaded.default ?? loaded
    return z.object({
      installDir: z.string()
        .description('Wolfram install directory (the one holding wolframscript.exe or math.exe); empty auto-discovers an install.')
        .default('')
        .volatile(),
      timeoutMs: z.number()
        .min(1000)
        .max(600000)
        .description('Default deadline per evaluation, in milliseconds.')
        .default(DEFAULT_TIMEOUT_MS)
        .volatile(),
      useSandbox: z.boolean()
        .description('Wrap each evaluation in the session sandbox. Turn it off where the runner cannot start commands, such as Android.')
        .default(true)
        .volatile(),
      frontend: z.union(['math', 'wolframscript'])
        .description('Which front-end runs the code. Only an unsandboxed run may choose wolframscript.')
        .default('math')
        .volatile(),
    })
  } catch {
    // Without the schema the tool still works; only the settings page is lost.
    return undefined
  }
})()

const DESCRIPTION = '最严谨精密的数学工具，调用 Mathematica（Wolfram 引擎）计算数学表达式，支持符号积分、解方程、极限、级数展开等。适合科学研究、工程计算、数学建模等场景。'

const GUIDANCE = `\`wolfram\` evaluates Wolfram Language through the local Wolfram Engine install and returns the result as text; ordinary results come back in \`InputForm\`. Use it for exact symbolic and numeric work — integrals, series, limits, equation systems, special functions, high-precision values — and prefer it over hand derivation for non-trivial algebra.

A \`;\`-separated compound yields only the value of its last expression, and a trailing \`;\` yields \`Null\`; put every value you need into one List.
`
/** Positive millisecond budget from either config spelling, or the default. */
function resolveBudget(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TIMEOUT_MS) : fallback
}

/** Seconds -> milliseconds for one call, clamped to the plugin ceiling. */
function resolveCallTimeout(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs
  return Math.min(Math.round(seconds * 1000), MAX_TIMEOUT_MS)
}

/** A volatile field is a reference; plain values stay usable too. */
function configValue(config, key, fallback) {
  const value = config?.[key]
  if (value !== undefined && value !== null && typeof value.get === 'function') {
    const live = value.get()
    return live === undefined || live === null ? fallback : live
  }
  return value === undefined || value === null ? fallback : value
}

/**
 * Confinement for one call.
 *
 * `useSandbox: false` is the escape hatch for hosts whose sandbox runner cannot
 * start processes at all (Android): the call runs unconfined and says so. With
 * the sandbox on, the session's own policy decides the mode, and a composition
 * without a backend refuses rather than silently running unconfined.
 *
 * `engaged` tells the caller whether a sandbox really wraps this call, which
 * decides the only safe front-end: `wolframscript` cannot link to its kernel
 * under a restricted token.
 */
function makeConfinement(ctx, exec, useSandbox) {
  if (!useSandbox) {
    return { engaged: false, confine: async (argv) => ({ argv, mode: 'sandbox off' }) }
  }
  const sandbox = ctx.get('sandbox')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandbox === undefined || sandboxPolicy === undefined) {
    return {
      engaged: true,
      confine: async () => {
        throw new WolframError(
          'no sandbox backend is mounted in this composition. Turn the sandbox off on this plugin\'s '
            + 'page to run Mathematica code unconfined, or load the harness sandbox packages.',
          'sandbox-unavailable',
        )
      },
    }
  }
  const resolved = sandboxPolicy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
  const mode = resolved?.mode
  if (mode === 'danger-full-access') {
    return { engaged: false, confine: async (argv) => ({ argv, mode }) }
  }
  return {
    engaged: true,
    confine: async (argv) => {
      const confined = await sandbox.confine(argv, { ...resolved, mode }, exec?.signal)
      return {
        argv: confined?.argv ?? argv,
        mode,
        enforcement: confined?.enforcement,
        denialSignatures: confined?.denialSignatures ?? [],
        runnerFailureRules: confined?.runnerFailureRules ?? [],
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const installDirOf = () => {
    const value = configValue(config, 'installDir', '')
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const defaultTimeoutMs = () => resolveBudget(configValue(config, 'timeoutMs', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS)
  const useSandboxOf = () => configValue(config, 'useSandbox', true) !== false
  const frontendOf = () => (configValue(config, 'frontend', 'math') === 'wolframscript' ? 'wolframscript' : 'math')

  ctx.tools.register(defineTool({
    name: 'wolfram',
    description: DESCRIPTION,
    parameters: {
      expression: {
        type: 'string',
        required: true,
        description: 'Mathematica code，例如 "Integrate[Cos[x], x]"、"Solve[x^2 - 1 == 0, x]"',
      },
      timeout: {
        type: 'number',
        description: `可选，本次计算的最长秒数（默认 ${DEFAULT_TIMEOUT_MS / 1000}s，上限 ${MAX_TIMEOUT_MS / 1000}s）`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const confinement = makeConfinement(ctx, exec, useSandboxOf())
      const outcome = await runWolfram(args.expression, {
        directory: installDirOf(),
        timeoutMs: resolveCallTimeout(args.timeout, defaultTimeoutMs()),
        // Only an unconfined run may use wolframscript: under a restricted
        // token it never links to its kernel.
        frontend: confinement.engaged ? 'math' : frontendOf(),
        jobs: ctx.get('jobs'),
        exec,
        confine: confinement.confine,
        cwd: exec?.agent?.session?.header?.cwd,
        env: process.env,
      })
      return outcome.text
    },
  }))

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: GUIDANCE,
    }),
    'dsh-wolfram: system prompt section',
  )

  // The Plugins page edits this entry's own configuration through this route;
  // persistence belongs to the profile's config editor, never to the plugin.
  ctx.inject(['connection', 'configEditor'], (routeCtx) => {
    const register = routeCtx.get('connection')?.fetch?.register
    const editor = routeCtx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (typeof register !== 'function' || editor === undefined || entry === undefined) return

    // The page must read what the entry actually stores: an edit updates the
    // entry and restarts this plugin, so the closure's config can trail it.
    const current = () => {
      const stored = entry.config ?? {}
      const value = {
        useSandbox: stored.useSandbox === undefined ? useSandboxOf() : stored.useSandbox !== false,
        frontend: stored.frontend === 'wolframscript' ? 'wolframscript' : 'math',
      }
      const installDir = typeof stored.installDir === 'string' && stored.installDir.trim()
        ? stored.installDir.trim()
        : installDirOf()
      if (installDir !== undefined) value.installDir = installDir
      const timeout = stored.timeoutMs === undefined
        ? configValue(config, 'timeoutMs', undefined)
        : stored.timeoutMs
      if (timeout !== undefined) value.timeoutMs = Number(timeout)
      return value
    }

    routeCtx.effect(() => register({
      path: CONFIG_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') {
          return Response.json({ ok: true, value: current() })
        }
        let payload
        try {
          payload = await request.json()
        } catch {
          return Response.json({ ok: false, error: 'request body is not JSON' }, { status: 400 })
        }
        const sanitized = sanitizeConfig(payload)
        if (sanitized.error !== undefined) {
          return Response.json({ ok: false, error: sanitized.error }, { status: 400 })
        }
        try {
          await editor.edit(entry, (stored) => ({ ...stored, ...sanitized.value }))
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return Response.json({ ok: false, error: detail }, { status: 400 })
        }
        return Response.json({ ok: true, value: { ...current(), ...sanitized.value } })
      },
    }, 'dsh-wolfram: config route'), 'dsh-wolfram: config route')
  })
}

/** Validate one page write; unknown fields are ignored, never persisted. */
function sanitizeConfig(input) {
  const value = {}
  if (typeof input?.installDir === 'string') value.installDir = input.installDir.trim()
  if (input?.timeoutMs !== undefined) {
    const ms = Number(input.timeoutMs)
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS) {
      return { error: `timeoutMs must be a number between 1000 and ${MAX_TIMEOUT_MS}` }
    }
    value.timeoutMs = Math.round(ms)
  }
  if (input?.useSandbox !== undefined) {
    if (typeof input.useSandbox !== 'boolean') return { error: 'useSandbox must be true or false' }
    value.useSandbox = input.useSandbox
  }
  if (input?.frontend !== undefined) {
    if (input.frontend !== 'math' && input.frontend !== 'wolframscript') {
      return { error: 'frontend must be "math" or "wolframscript"' }
    }
    value.frontend = input.frontend
  }
  return { value }
}
