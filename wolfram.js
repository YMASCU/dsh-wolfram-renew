/**
 * dsh-wolfram — executable discovery, confined evaluation, and background hand-off.
 *
 * Three behaviours are deliberate here:
 *
 *   1. Resolution never assumes `wolframscript` is on `PATH`: a Wolfram Engine
 *      installed on a data drive is common, and a half-removed standalone
 *      `WolframScript` folder can leave a stale `PATH` entry with no executable
 *      behind it. Candidates are tried in order and an `ENOENT` start is skipped.
 *   2. Every evaluation is confined by the harness sandbox under the session's
 *      own policy, so model-authored Mathematica code cannot write outside what
 *      the session allows.
 *   3. A Mathematica error (a `Symbol::tag:` message plus `$Failed`, reported
 *      with exit code 0) fails the tool call instead of being returned as an
 *      answer, and an evaluation that outlives its deadline is handed over to
 *      the job registry as a background job instead of being killed.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const SCRIPT_NAME = IS_WINDOWS ? 'wolframscript.exe' : 'wolframscript'

/**
 * The console front-end (`math`) shipped next to `wolframscript` in every
 * install. It is the one that works under a restricted token: `wolframscript`
 * refuses to evaluate anything when its user config file cannot be opened,
 * which is exactly what confinement guarantees.
 */
const FRONT_END_NAME = IS_WINDOWS ? 'math.exe' : 'math'

/** A single `-code` evaluation gets this long unless the call asks for more. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Ceiling for a per-call `timeout`, so one call cannot pin a kernel forever. */
export const MAX_TIMEOUT_MS = 600_000

/** In-memory tail per stream the child backend keeps. */
const STREAM_MAX_BYTES = 8 * 1024 * 1024

/** The job kind, and therefore the id prefix (`wolfram-<id>`). */
const JOB_KIND = 'wolfram'

/** Longest job label (the expression's first line) before truncation. */
const JOB_LABEL_MAX = 80

/** One `job_output` read stays within a shell-sized tail. */
const JOB_OUTPUT_LIMIT_BYTES = 64_000

/** A failed evaluation, phrased for the model. */
export class WolframError extends Error {
  constructor(message, kind = 'wolfram') {
    super(message)
    this.name = 'WolframError'
    this.kind = kind
  }
}

/** Directories whose children hold one installed Wolfram product. */
function candidateRoots() {
  const roots = new Set()
  if (IS_WINDOWS) {
    for (const envName of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
      const base = process.env[envName]
      if (base) roots.add(path.join(base, 'Wolfram Research'))
    }
    // Engine/Mathematica installs routinely live on a data drive while the
    // machine-wide PATH only ever points at the system drive.
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      roots.add(path.join(`${drive}${path.sep}`, 'Program Files', 'Wolfram Research'))
      roots.add(path.join(`${drive}${path.sep}`, 'Program Files (x86)', 'Wolfram Research'))
    }
  } else {
    roots.add('/Applications')
    roots.add('/usr/local/Wolfram')
    roots.add('/opt/Wolfram')
  }
  return [...roots]
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** `15.0.0` -> `[15, 0, 0]`, for newest-first ordering. */
function versionKey(filePath) {
  const match = path.basename(path.dirname(filePath)).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
    ?? filePath.match(/[\\/](\d+)\.(\d+)(?:\.(\d+))?[\\/]/)
  if (!match) return [0, 0, 0]
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersionsDesc(a, b) {
  const left = versionKey(a)
  const right = versionKey(b)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return right[i] - left[i]
  }
  // Same version: prefer the shallower executable (the launcher over the copy
  // under SystemFiles/Kernel/Binaries).
  return a.length - b.length
}

/**
 * Every `wolframscript` executable this machine appears to have installed,
 * newest version first.
 */
export function discoverInstallations() {
  const found = new Set()
  const add = (candidate) => {
    if (existsSync(candidate)) found.add(candidate)
  }
  for (const root of candidateRoots()) {
    if (!existsSync(root)) continue
    for (const product of safeReaddir(root)) {
      if (!product.isDirectory()) continue
      const productDir = path.join(root, product.name)
      add(path.join(productDir, SCRIPT_NAME))
      for (const version of safeReaddir(productDir)) {
        if (!version.isDirectory()) continue
        const versionDir = path.join(productDir, version.name)
        add(path.join(versionDir, SCRIPT_NAME))
        add(path.join(versionDir, 'SystemFiles', 'Kernel', 'Binaries', 'Windows-x86-64', SCRIPT_NAME))
      }
    }
  }
  return [...found].sort(compareVersionsDesc)
}

/** The ordered candidates one evaluation may try. */
function candidateExecutables(explicit) {
  const candidates = []
  const push = (exe, source, extra = {}) => {
    if (!exe || candidates.some((candidate) => candidate.exe === exe)) return
    candidates.push({ exe, source, ...extra })
  }
  push(explicit?.trim(), 'config executable')
  push(process.env.DSH_WOLFRAMSCRIPT?.trim(), 'DSH_WOLFRAMSCRIPT')
  // Marked `bare`: a confined runner needs an absolute image path, because the
  // restricted token it creates does not search PATH.
  push(SCRIPT_NAME, 'PATH', { bare: true })
  for (const exe of discoverInstallations()) push(exe, 'discovered')
  return candidates
}

/** Resolve a bare executable name against PATH without spawning anything. */
function resolveOnPath(name) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** A Wolfram Language string literal for arbitrary source text. */
function wlString(text) {
  return `"${String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`
}

/**
 * The `math -run` program that reproduces `wolframscript -code <source>`: parse
 * and evaluate the source, then write the result in `InputForm`.
 *
 * `WriteString` rather than `Print`: this console front-end renders a `Print`ed
 * string with quotes (`Print[ToString[...]]` emits `"Sin[x]"`), which would turn
 * every result into a quoted literal. No spaces either, so the whole program
 * stays one argv token through the sandbox runner.
 */
function runProgram(source) {
  return `$dshResult=ToExpression[${wlString(source)}];`
    + 'WriteString[$Output,ToString[$dshResult,InputForm],"\\n"];Exit[]'
}

/**
 * The argv for one install: the console front-end when it is there, else
 * `wolframscript -code` (which needs an unconfined user config).
 */
function invocationFor(image, source) {
  const frontEnd = path.join(path.dirname(image), FRONT_END_NAME)
  if (existsSync(frontEnd)) {
    return { image: frontEnd, argv: [frontEnd, '-noprompt', '-run', runProgram(source)] }
  }
  return { image, argv: [image, '-code', source] }
}

/**
 * Mirror of the harness's runner-failure classifier (`dsh-sandbox`): separates
 * "the sandbox runner never ran the command" from an ordinary failing command,
 * so a run whose confinement never engaged is never reported as a result.
 */
function classifyRunnerFailure(exitCode, stderr, rules) {
  if (exitCode === null || exitCode === undefined || exitCode === 0) return undefined
  const lines = String(stderr ?? '').split(/\r?\n/)
  for (const rule of rules ?? []) {
    if (rule?.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informational = new Set((rule?.informationalLines ?? []).map((line) => String(line).toLowerCase()))
    const fatal = (rule?.fatalSignatures ?? [])
      .map((signature) => String(signature).trim().toLowerCase())
      .filter((signature) => signature.length > 0)
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informational.has(lowered)) continue
      if (fatal.some((signature) => lowered.includes(signature))) return { detail: line.trim() }
    }
  }
  return undefined
}

/**
 * Mirror of the harness's denial classifier: a failed file effect the runner
 * refused. Mathematica prints its own messages on stdout, so both streams are
 * searched rather than stderr alone.
 */
function matchesDenial(exitCode, text, signatures) {
  if (exitCode === 0 || exitCode === undefined || signatures.length === 0) return false
  const lowered = String(text ?? '').toLowerCase()
  return signatures.some((signature) => lowered.includes(String(signature).toLowerCase()))
}

/** Collapse wolframscript's CRLF output into the newlines a transcript wants. */
function normalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim()
}

/**
 * Mathematica does not report errors through the exit code: a syntax error is
 * an exit-0 run whose output carries a message and `$Failed`. Treat that as a
 * failure, but keep ordinary results that merely come with warnings.
 */
function classify(exitCode, stdout, stderr) {
  const out = normalize(stdout)
  const err = normalize(stderr)
  if (/(^|\n)\$Failed\s*$/.test(out)) {
    return { ok: false, text: [err, out].filter(Boolean).join('\n') }
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      text: [`wolframscript exited with code ${exitCode}`, err, out].filter(Boolean).join('\n'),
    }
  }
  if (!out) {
    return { ok: false, text: err || 'wolframscript produced no output (exit 0)' }
  }
  return { ok: true, text: err ? `${out}\n\n[stderr]\n${err}` : out }
}

/** A one-line job label: what `job_list` and every status line show. */
export function jobLabel(expression) {
  const first = String(expression ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (first === undefined) return 'wolfram'
  return first.length > JOB_LABEL_MAX ? `${first.slice(0, JOB_LABEL_MAX - 1)}…` : first
}

/** The registry is usable only if it answers the documented `start()`. */
export function usableJobs(jobs) {
  return jobs !== undefined && jobs !== null && typeof jobs.start === 'function'
}

/** Append to an in-memory stream, keeping only its bounded tail. */
function appendChunk(stream, chunk) {
  const next = stream.text + chunk
  stream.text = next.length > STREAM_MAX_BYTES ? next.slice(-STREAM_MAX_BYTES) : next
  stream.lossy = next.length > STREAM_MAX_BYTES
}

/**
 * The one backend: `child_process` with `windowsHide`, so the console-subsystem
 * front-end never flashes a window when it is launched from the GUI host. The
 * sandbox runner arrives through `argv` (see `confine`), not through a second
 * process layer.
 */
function childBackend() {
  return {
    spawn(argv, { signal }) {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const streams = { stdout: { text: '', lossy: false }, stderr: { text: '', lossy: false } }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => appendChunk(streams.stdout, chunk))
      child.stderr.on('data', (chunk) => appendChunk(streams.stderr, chunk))

      const started = new Promise((resolve) => {
        child.once('spawn', () => resolve({ ok: true }))
        child.once('error', (error) => resolve({ ok: false, error }))
      })
      const done = new Promise((resolve) => {
        child.once('close', (code, signalName) => resolve({ code, signal: signalName }))
      })
      const terminate = () => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
      signal?.addEventListener?.('abort', terminate, { once: true })
      return {
        started,
        done,
        terminate,
        read(channel, from) {
          const stream = streams[channel] ?? { text: '', lossy: false }
          const offset = Number(from)
          const start = Number.isFinite(offset) ? Math.max(0, Math.min(offset, stream.text.length)) : 0
          return { text: stream.text.slice(start), nextOffset: stream.text.length, lossy: stream.lossy }
        },
      }
    },
  }
}

/** Resolve when the run exits, the deadline passes, or the call is aborted. */
function raceRun(done, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => settle('deadline'), timeoutMs)
    const onAbort = () => settle('aborted')
    if (signal?.aborted) {
      settle('aborted')
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    done.then(() => settle('exit'), () => settle('exit'))
  })
}

/**
 * Register an already-running child as a background job.
 *
 * `run()` hands the registry the settlement promise the call already owns, so
 * the job outlives the call; cancelling it terminates the kernel. Returns the
 * job handle, or undefined when the registry refused it — in which case the
 * caller falls back to the deadline kill.
 */
function registerJob(jobs, { handle, expression, exec }) {
  const owner = exec?.agent?.id
  const callId = exec?.callId
  const rootCallId = exec?.rootCallId
  const toolCall = typeof callId === 'string'
    ? { callId, ...(typeof rootCallId === 'string' ? { rootCallId } : {}) }
    : undefined
  try {
    const created = jobs.start({
      kind: JOB_KIND,
      label: jobLabel(expression),
      ...(owner === undefined ? {} : { owner }),
      ...(toolCall === undefined ? {} : { toolCall }),
      outputLimitBytes: JOB_OUTPUT_LIMIT_BYTES,
      output: [
        { channel: 'stdout', read: (from) => handle.read('stdout', from) },
        { channel: 'stderr', read: (from) => handle.read('stderr', from) },
      ],
      run: () => ({
        done: handle.done.then(({ code }) => {
          const verdict = classify(code, handle.read('stdout', 0).text, handle.read('stderr', 0).text)
          return { status: verdict.ok ? 'completed' : 'failed', detail: `exit code: ${code}` }
        }),
        cancel: () => handle.terminate(),
      }),
    })
    const id = typeof created === 'string' ? created : created?.id
    return typeof id === 'string' ? { id, owner } : undefined
  } catch {
    return undefined
  }
}

/** The text handed back when a run is promoted to a background job. */
function promotedText(jobId, timeoutMs, handle) {
  const partial = normalize(handle.read('stdout', 0).text)
  const sections = [
    `Still running after ${timeoutMs / 1000}s, so the kernel was handed over to background job \`${jobId}\` `
      + 'instead of being killed.',
    `Read more with \`job_output {"job_id": "${jobId}"}\`, list it with \`job_list\`, or stop it with `
      + `\`job_kill {"job_id": "${jobId}"}\`.`,
  ]
  if (partial) sections.push(`--- output so far ---\n${partial}`)
  return sections.join('\n\n')
}

/**
 * Evaluate one Mathematica expression under the session's sandbox policy.
 *
 * Resolves with `{ text, executable, mode }` for a settled evaluation, or
 * `{ text, promoted: true, jobId }` when it outlived its deadline and now runs
 * as a background job. Every failure — syntax error, non-zero exit, missing
 * executable, refused confinement, aborted call — rejects with a
 * {@link WolframError}.
 *
 * @param {string} expression - Wolfram Language source.
 * @param {{ executable?: string, timeoutMs?: number, jobs?: object, exec?: object,
 *   confine?: (argv: string[]) => Promise<{ argv: string[], mode?: string }>,
 *   cwd?: string, env?: object }} [options]
 */
export async function runWolfram(expression, options = {}) {
  const source = typeof expression === 'string' ? expression : ''
  if (!source.trim()) {
    throw new WolframError(
      'expression is empty: pass Mathematica code, e.g. "Integrate[Cos[x], x]"',
      'empty',
    )
  }

  const requested = Number(options.timeoutMs)
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.round(requested), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS

  const backend = childBackend()
  const env = options.env ?? process.env
  const cwd = options.cwd

  let handle
  let executable
  let mode
  let missing = false
  let runnerRules = []
  let denialSignatures = []
  for (const candidate of candidateExecutables(options.executable)) {
    // A confined runner needs an absolute image path; a bare name would reach it
    // as `wolframscript.exe` and fail CreateProcessAsUserW with Win32 2.
    const image = candidate.bare ? resolveOnPath(SCRIPT_NAME) : candidate.exe
    if (image === undefined) {
      missing = true
      continue
    }
    const invocation = invocationFor(image, source)
    let argv = invocation.argv
    if (options.confine !== undefined) {
      const confined = await options.confine(argv)
      argv = confined.argv ?? argv
      mode = confined.mode
      runnerRules = confined.runnerFailureRules ?? []
      denialSignatures = confined.denialSignatures ?? []
    }
    const attempt = backend.spawn(argv, { signal: options.exec?.signal, cwd, env })
    const started = await attempt.started
    if (started.ok) {
      handle = attempt
      executable = invocation.image
      break
    }
    if (started.error?.code === 'ENOENT') {
      missing = true
      continue
    }
    throw new WolframError(
      `could not start ${image}: ${started.error?.message ?? String(started.error)}`,
      'spawn',
    )
  }

  if (handle === undefined) {
    throw new WolframError(
      missing
        ? 'no `wolframscript` found on PATH and no Wolfram Engine/Mathematica install under '
          + 'Program Files\\Wolfram Research. Install the Wolfram Engine, or set `executable` in this '
          + "plugin's config / the DSH_WOLFRAMSCRIPT environment variable."
        : 'no usable `wolframscript` candidate was found',
      'missing',
    )
  }

  const settled = await raceRun(handle.done, timeoutMs, options.exec?.signal)

  if (settled === 'exit') {
    const { code } = await handle.done
    const stdoutText = handle.read('stdout', 0).text
    const stderrText = handle.read('stderr', 0).text
    const runnerFailure = classifyRunnerFailure(code, stderrText, runnerRules)
    if (runnerFailure !== undefined) {
      throw new WolframError(
        `the sandbox runner could not start the confined command (${runnerFailure.detail}). `
          + 'Confinement is mandatory here, so this is a runner/runtime problem rather than a '
          + 'Mathematica failure.',
        'sandbox-runner',
      )
    }
    const verdict = classify(code, stdoutText, stderrText)
    if (!verdict.ok) {
      const denied = matchesDenial(code, `${stdoutText}\n${stderrText}`, denialSignatures)
      const text = denied
        ? `${verdict.text}\n\n[sandbox: file access denied under ${mode ?? 'confined'} mode]`
        : verdict.text
      throw new WolframError(text, 'failed')
    }
    return { text: verdict.text, executable, mode }
  }

  if (settled === 'aborted') {
    handle.terminate()
    throw new WolframError('the call was aborted before the kernel finished', 'aborted')
  }

  // Deadline: keep the kernel alive as a background job rather than killing it.
  if (usableJobs(options.jobs)) {
    const job = registerJob(options.jobs, { handle, expression: source, exec: options.exec })
    if (job !== undefined) {
      return { text: promotedText(job.id, timeoutMs, handle), promoted: true, jobId: job.id, executable, mode }
    }
  }

  handle.terminate()
  throw new WolframError(
    `evaluation exceeded ${timeoutMs} ms and was killed (no background job registry to hand it to); `
      + `pass a larger \`timeout\` (up to ${MAX_TIMEOUT_MS / 1000}s) or simplify the expression`,
    'timeout',
  )
}
