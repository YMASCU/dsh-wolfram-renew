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

const DESCRIPTION = '最严谨精密的数学工具，调用 Mathematica（Wolfram 引擎）计算数学表达式，支持符号积分、解方程、极限、级数展开等。适合科学研究、工程计算、数学建模等场景。'

const GUIDANCE = `You have access to the \`wolfram\` tool, which evaluates Wolfram Language (Mathematica) code through the Wolfram Engine's \`math\` console front-end (\`wolframscript -code\` is only a fallback), confined by the session's sandbox.

Use it for symbolic and exact mathematics — integrals, derivatives, equation systems, limits, series, simplification, matrices, special functions, units, and high-precision numerics. For non-trivial derivations prefer this engine over hand algebra or a CAS in another language: its symbolic algorithms are usually more complete.

The tool returns the textual form of the last expression, e.g. \`Integrate[Cos[x], x]\` -> \`Sin[x]\`. Use \`N[...]\` for a decimal value and \`Simplify\`/\`FullSimplify\` to normalize a result.

A Mathematica error (a message plus \`$Failed\`) fails the call instead of being returned as a result. Long evaluations can raise \`timeout\` (seconds); a kernel that outlives its deadline keeps running as a background job, and the result then names the job id to read with \`job_output\` or stop with \`job_kill\`.`

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

/**
 * Confinement for one call: the session's own policy decides the mode, and a
 * composition without a sandbox backend refuses to run rather than falling back
 * to an unconfined kernel.
 */
function confiner(ctx, exec) {
  const sandbox = ctx.get('sandbox')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandbox === undefined || sandboxPolicy === undefined) {
    return async () => {
      throw new WolframError(
        'no sandbox backend is mounted in this composition, so this tool will not run Mathematica '
          + 'code unconfined; load the harness sandbox packages or run in a session whose policy is '
          + 'danger-full-access (which is reported as unconfined, explicitly)',
        'sandbox-unavailable',
      )
    }
  }
  const resolved = sandboxPolicy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
  const mode = resolved?.mode
  if (mode === 'danger-full-access') {
    return async (argv) => ({ argv, mode })
  }
  return async (argv) => {
    const confined = await sandbox.confine(argv, { ...resolved, mode }, exec?.signal)
    return {
      argv: confined?.argv ?? argv,
      mode,
      enforcement: confined?.enforcement,
      denialSignatures: confined?.denialSignatures ?? [],
      runnerFailureRules: confined?.runnerFailureRules ?? [],
    }
  }
}

export function apply(ctx, config = {}) {
  const executable = typeof config.executable === 'string' && config.executable.trim()
    ? config.executable.trim()
    : undefined
  const defaultTimeoutMs = resolveBudget(config.timeoutMs, DEFAULT_TIMEOUT_MS)

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
        description: `可选，本次计算的最长秒数（默认 ${defaultTimeoutMs / 1000}s，上限 ${MAX_TIMEOUT_MS / 1000}s）`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const outcome = await runWolfram(args.expression, {
        executable,
        timeoutMs: resolveCallTimeout(args.timeout, defaultTimeoutMs),
        jobs: ctx.get('jobs'),
        exec,
        confine: confiner(ctx, exec),
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
}
