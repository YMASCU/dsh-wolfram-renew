/**
 * dsh-wolfram — executable discovery, confined evaluation, and background hand-off.
 *
 * Four behaviours are deliberate here:
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
 *   4. Both streams are collected the way the harness shells collect theirs
 *      (see `dsh-subprocess-local/src/output.ts`): a bounded in-memory tail, a
 *      spill file holding the complete stream, and a truncation notice naming
 *      it. Image/graphics results never degrade to `InputForm`: the kernel
 *      writes them into the platform temporary directory and reports the path.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
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

/**
 * Per-stream in-memory tail, the harness shells' `maxOutputBytes` (64,000
 * bytes). Only the tail is model-facing; the complete stream goes to a spill
 * file, so a truncated result never reads as a complete one.
 */
export const DEFAULT_OUTPUT_MAX_BYTES = 64_000

/**
 * Cap for one stream's complete-output spill file, the harness shells'
 * `maxSpillBytes`. Above it the collector stops advertising a file instead of
 * promising a truncated one.
 */
export const DEFAULT_SPILL_MAX_BYTES = 64 * 1024 * 1024

/** The job kind, and therefore the id prefix (`wolfram-<id>`). */
const JOB_KIND = 'wolfram'

/** Longest job label (the expression's first line) before truncation. */
const JOB_LABEL_MAX = 80

/** One `job_output` read stays within a shell-sized tail. */
const JOB_OUTPUT_LIMIT_BYTES = 64_000

/**
 * Result heads the kernel writes as an image file instead of printing. Every
 * one of them is a graphical object whose `InputForm` is unusable to a model:
 * `Animate` evaluates to a `Manipulate` (measured on Wolfram Engine 15.0), so
 * the animated case is covered by both spellings; the container heads
 * (`GraphicsRow` and friends) hold graphics and are exported the same way.
 */
export const GRAPHICS_HEADS = [
  'Image',
  'Image3D',
  'Graphics',
  'Graphics3D',
  'GraphicsComplex',
  'Legended',
  'Manipulate',
  'Animate',
  'ListAnimate',
  'GraphicsRow',
  'GraphicsGrid',
  'GraphicsColumn',
  'GeoGraphics',
]

/** Heads that export as an animation rather than a still image. */
export const ANIMATED_HEADS = ['Manipulate', 'Animate', 'ListAnimate']

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

/** One install directory from either a directory or an executable path. */
function installDirOf(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return undefined
  const resolved = path.resolve(trimmed)
  return /\.(exe|com)$/i.test(resolved) ? path.dirname(resolved) : resolved
}

/**
 * The ordered install directories one evaluation may try.
 *
 * A directory is the unit of configuration: the executable inside it is chosen
 * per call from `frontend`, so an install that ships only `math.exe` still works.
 */
function candidateDirectories(explicit) {
  const candidates = []
  const push = (dir, source) => {
    if (dir === undefined || candidates.some((candidate) => candidate.dir === dir)) return
    candidates.push({ dir, source })
  }
  push(installDirOf(explicit), 'config directory')
  push(installDirOf(process.env.DSH_WOLFRAMSCRIPT), 'DSH_WOLFRAMSCRIPT')
  const onPath = resolveOnPath(SCRIPT_NAME) ?? resolveOnPath(FRONT_END_NAME)
  if (onPath !== undefined) push(path.dirname(onPath), 'PATH')
  for (const exe of discoverInstallations()) push(path.dirname(exe), 'discovered')
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
 * The `math -run` program behind one evaluation.
 *
 * It reproduces `wolframscript -code <source>` for ordinary results (parse,
 * evaluate, write the value in `InputForm`), and it replaces that text for a
 * graphical result: the kernel exports the object into the platform temporary
 * directory — `$TemporaryDirectory`, which the runner points at the session's
 * private temporary directory under confinement — and prints the path with a
 * one-line description instead of an `InputForm` dump.
 *
 * `WriteString` rather than `Print`: this console front-end renders a `Print`ed
 * string with quotes, which would turn every result into a quoted literal.
 *
 * Two facts measured on Wolfram Engine 15.0 shape the export branch:
 *   - `Export` of `Image` data works in a kernel-only session; a
 *     `Graphics`-family export works too once Wolfram's graphics components are
 *     installed, which the kernel does on first use by downloading a paclet —
 *     a download a confined session cannot perform, so the first confined
 *     export of a `Graphics` can legitimately write no file;
 *   - an export can emit messages and still write the file, so success is
 *     judged by `FileExistsQ` plus a non-zero byte count, never by `Export`'s
 *     return value.
 *
 * No front end is borrowed: `UsingFrontEnd` was dropped because a measured
 * Mathematica 13.2 install never reached it (`Export` does not return there),
 * an Engine-only install has no front end to borrow, and on a full Mathematica
 * install it would start a front end the console session does not otherwise own.
 *
 * Export output is redirected to a throw-away stream (`$Output`) so
 * format-registration messages cannot be mistaken for a result. (Measured:
 * progress lines a child process writes — a paclet installer's — bypass that
 * redirection; on a first-ever component install they precede the marker block
 * and are returned as-is, because no stream is ever stripped.)
 */
function runProgram(source) {
  const heads = GRAPHICS_HEADS.map((head) => `"${head}"`).join(',')
  const animated = ANIMATED_HEADS.map((head) => `"${head}"`).join(',')
  const note = 'the export produced no file although the output directory was created (Wolfram '
    + 'installs its graphics components on first use, and a session that cannot download them '
    + 'cannot rasterize); the result was not printed as InputForm'
  const noWriteNote = 'the output directory could not be created, so no image file was written '
    + '(a read-only session allows no writes); the result was not printed as InputForm'
  const program = `
Module[{dshExpr,dshHeads,dshHead,dshExt,dshFmt,dshDir,dshFile,dshSink,dshQuiet,dshWritable,dshBytes,dshDims},
 dshExpr=ToExpression[${wlString(source)}];
 dshHeads={${heads}};
 dshHead=ToString[Head[dshExpr]];
 If[!MemberQ[dshHeads,dshHead],
  WriteString[$Output,ToString[dshExpr,InputForm],"\\n"];Exit[]];
 dshExt=If[MemberQ[{${animated}},dshHead],"gif","png"];
 dshFmt=If[dshExt==="gif","GIF","PNG"];
 dshDir=FileNameJoin[{$TemporaryDirectory,"dsh-wolfram","wl-"<>ToString[$ProcessID]<>"-"<>ToString[Round[AbsoluteTime[]*1000.]]}];
 dshFile=FileNameJoin[{dshDir,"result."<>dshExt}];
 dshSink=Quiet@Check[OpenWrite[],$Failed];
 dshQuiet[code_]:=If[OutputStreamQ[dshSink],Block[{$Output=dshSink},Quiet[code]],Quiet[code]];
 dshQuiet[Check[CreateDirectory[dshDir,CreateIntermediateDirectories->True],$Failed]];
 dshWritable=DirectoryQ[dshDir];
 dshQuiet[Check[Export[dshFile,dshExpr,dshFmt],$Failed]];
 dshBytes=If[FileExistsQ[dshFile],FileByteCount[dshFile],0];
 dshDims=If[dshExt==="png"&&ImageQ[dshExpr],ImageDimensions[dshExpr],$Failed];
 If[OutputStreamQ[dshSink],Close[dshSink]];
 If[dshBytes>0,
  WriteString[$Output,"[graphics] head: ",dshHead,"\\n","[graphics] file: ",dshFile,"\\n","[graphics] format: ",dshFmt,Which[ListQ[dshDims]," ("<>ToString[dshDims[[1]]]<>"x"<>ToString[dshDims[[2]]]<>" px)",dshExt==="gif"," (animation)",True,""],", ",ToString[dshBytes]," bytes\\n"],
  WriteString[$Output,"[graphics] head: ",dshHead,"\\n","[graphics] file: (none)","\\n","[graphics] note: ",If[dshWritable,"${note}","${noWriteNote}"],"\\n"]];
 Exit[]]`
  // One argv token: no spaces or newlines survive, so the program reaches the
  // kernel unchanged through the sandbox runner. (`\n` escapes stay escapes.)
  return program.replace(/\s+/g, ' ').trim()
}

/**
 * The argv for one install directory, or undefined when it holds no executable.
 *
 * `frontend` is `math`, `wolframscript`, or unset:
 *   - `wolframscript` runs `-code` and needs an unconfined user config, so the
 *     Host only asks for it when no sandbox wraps the process;
 *   - `math` (and the unset default) uses the console front-end when the
 *     install ships one, which is the only mode that works under a restricted
 *     token, and falls back to `-code` when it does not.
 */
function invocationFor(dir, source, frontend) {
  const scriptPath = path.join(dir, SCRIPT_NAME)
  const mathPath = path.join(dir, FRONT_END_NAME)
  const hasScript = existsSync(scriptPath)
  const hasMath = existsSync(mathPath)
  if (!hasScript && !hasMath) return undefined
  const program = runProgram(source)
  if (frontend === 'wolframscript' && hasScript) {
    return { image: scriptPath, argv: [scriptPath, '-code', program] }
  }
  if (hasMath) {
    return { image: mathPath, argv: [mathPath, '-noprompt', '-run', program] }
  }
  return { image: scriptPath, argv: [scriptPath, '-code', program] }
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

// --- Bounded collection with a spill file ----------------------------------

let spillCounter = 0
let spillDirectory

/**
 * The one spill location: a private (0700) per-process directory under the OS
 * temporary area, created lazily. Predictable world-readable paths would let
 * other local users read evaluation output or pre-create symlinks. When the
 * directory cannot be created the collectors degrade to their in-memory tail,
 * which the truncation notice then reports as `(unavailable)`.
 */
function privateSpillDirectory() {
  if (spillDirectory === undefined) {
    spillDirectory = mkdtempSync(path.join(tmpdir(), 'dsh-wolfram-'))
  }
  return spillDirectory
}

// A directory that never spilled is empty and safe to remove; one holding
// completed spill files keeps them — their content is the recovery artifact.
process.once('exit', () => {
  if (spillDirectory === undefined) return
  try {
    rmdirSync(spillDirectory)
  } catch {
    // ENOENT / ENOTEMPTY / EBUSY: OS temp hygiene owns the residue.
  }
})

/**
 * One stream with a bounded in-memory tail, mirroring the harness shells'
 * `OutputCollector` (`dsh-subprocess-local/src/output.ts`): on first overflow a
 * spill file is opened and receives every chunk (the already collected ones
 * included) while the stream fits the spill cap; the in-memory window then
 * keeps only the last `maxBytes`, because errors and final results cluster at
 * the end of output.
 */
class StreamCollector {
  constructor(label, maxBytes = DEFAULT_OUTPUT_MAX_BYTES) {
    this.label = label
    this.maxBytes = maxBytes
    this.chunks = []
    this.bytes = 0
    this.total = 0
    this.dropped = false
    this.fd = undefined
    this.file = undefined
    this.spillDisabled = false
  }

  /** Ingest one stream chunk, counting it toward the whole-stream total. */
  push(chunk) {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.fd !== undefined)) this.spill(chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // Byte-exact tail: the retained window holds the LAST maxBytes
        // regardless of how the stream was chunked.
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /**
   * Open the spill file lazily and append the chunk (and any prior chunks
   * once). Runs inside the stream's `'data'` listener, so every filesystem
   * failure is contained: the spill is discarded and collection continues with
   * the in-memory tail alone.
   */
  spill(chunk) {
    if (this.total > DEFAULT_SPILL_MAX_BYTES) {
      this.discardSpill()
      return
    }
    try {
      if (this.fd === undefined) {
        // Random suffix + O_EXCL ('wx' fails on any existing path, symlink or
        // not) + owner-only mode: defeats spill-path prediction in a shared
        // temp area. The path is published only after the open succeeded.
        const file = path.join(
          privateSpillDirectory(),
          `wolfram-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
        )
        const fd = openSync(file, 'wx', 0o600)
        this.file = file
        this.fd = fd
        for (const prior of this.chunks) writeSync(fd, prior)
      }
      writeSync(this.fd, chunk)
    } catch {
      this.discardSpill()
    }
  }

  /** Stop spilling and remove the file once it can no longer hold the stream. */
  discardSpill() {
    this.spillDisabled = true
    const fd = this.fd
    const file = this.file
    this.fd = undefined
    this.file = undefined
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Nothing left to recover from a failed close.
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // At most DEFAULT_SPILL_MAX_BYTES left behind.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates: everything pushed since
   * `fromByte`. A cursor that already slid out of the tail window is `lossy` —
   * the read returns the whole retained tail and the gap is only recoverable
   * from the spill file.
   */
  readFrom(fromByte) {
    const windowStart = this.total - this.bytes
    const requested = Number(fromByte)
    const from = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, this.total)
      : 0
    const lossy = from < windowStart
    const buffer = Buffer.concat(this.chunks)
    const slice = lossy ? buffer : buffer.subarray(from - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.file === undefined ? {} : { spillPath: this.file },
    }
  }

  /** Seal the spill file once the stream ended; later reads still work. */
  seal() {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
      this.fd = undefined
    } catch {
      // A delayed writeback failure makes the spill unreliable: stop
      // advertising it rather than pointing the model at a file missing its tail.
      this.fd = undefined
      this.file = undefined
    }
  }
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
      const collectors = {
        stdout: new StreamCollector('stdout'),
        stderr: new StreamCollector('stderr'),
      }
      child.stdout.on('data', (chunk) => collectors.stdout.push(chunk))
      child.stderr.on('data', (chunk) => collectors.stderr.push(chunk))

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
        seal() {
          collectors.stdout.seal()
          collectors.stderr.seal()
        },
        read(channel, from) {
          const collector = collectors[channel]
          if (collector === undefined) return { text: '', nextOffset: 0, lossy: false }
          return collector.readFrom(from)
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
 * One stream as the model reads it plus the facts the notice needs. `lossy`
 * is the collector's verdict that the head slid out of the retained tail;
 * `spillPath` names the file holding the complete stream when one was kept.
 */
function finalStreams(handle) {
  handle.seal()
  const read = (channel) => {
    const piece = handle.read(channel, 0)
    return {
      text: normalize(piece.text),
      truncated: piece.lossy === true,
      ...piece.spillPath === undefined ? {} : { spillPath: piece.spillPath },
    }
  }
  return { stdout: read('stdout'), stderr: read('stderr') }
}

/**
 * One stream rendered with its truncation notice, exactly as the shell tools
 * render theirs: a tail alone would read as the whole output, so the notice
 * names the spill file, and `(unavailable)` says so honestly when the spill
 * itself exceeded its cap.
 */
function streamText(stream) {
  if (!stream.truncated) return stream.text
  return `${stream.text}\n[output truncated; full output: ${stream.spillPath ?? '(unavailable)'}]`
}

/**
 * Mathematica does not report errors through the exit code: a syntax error is
 * an exit-0 run whose output carries a message and `$Failed`. Treat that as a
 * failure, but keep ordinary results that merely come with warnings.
 *
 * Nothing is stripped from any stream: a result is exactly what the kernel
 * wrote, so a Mathematica message or the progress lines of a first-time
 * component installer stay visible ahead of the answer.
 *
 * `streams` are already bounded tails; the truncation notice travels with the
 * text on both the success and the failure path, so a cut-off diagnostic says
 * where the rest is.
 */
function classify(exitCode, streams) {
  // The `$Failed` verdict reads the raw tail: the truncation notice may follow
  // it, so testing the rendered text would miss a cut-off failure.
  if (/(^|\n)\$Failed\s*$/.test(streams.stdout.text)) {
    return {
      ok: false,
      text: [streamText(streams.stderr), streamText(streams.stdout)].filter(Boolean).join('\n'),
    }
  }
  const out = streamText(streams.stdout)
  const err = streamText(streams.stderr)
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
          const verdict = classify(code, finalStreams(handle))
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
  const read = handle.read('stdout', 0)
  const partial = streamText({
    text: normalize(read.text),
    truncated: read.lossy === true,
    ...read.spillPath === undefined ? {} : { spillPath: read.spillPath },
  })
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
 * Output is bounded: each stream keeps a 64,000-byte tail and the complete
 * stream goes to a spill file named by the `[output truncated; ...]` notice,
 * matching the harness shells. A graphical result is written to an image file
 * in the platform temporary directory and reported as a path, never as
 * `InputForm`.
 *
 * @param {string} expression - Wolfram Language source.
 * @param {{ directory?: string, timeoutMs?: number, frontend?: 'math'|'wolframscript',
 *   jobs?: object, exec?: object,
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
  for (const candidate of candidateDirectories(options.directory)) {
    const invocation = invocationFor(candidate.dir, source, options.frontend)
    if (invocation === undefined) {
      missing = true
      continue
    }
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
      `could not start ${invocation.image}: ${started.error?.message ?? String(started.error)}`,
      'spawn',
    )
  }

  if (handle === undefined) {
    throw new WolframError(
      missing
        ? 'no `wolframscript` found on PATH and no Wolfram Engine/Mathematica install under '
          + 'Program Files\\Wolfram Research. Install the Wolfram Engine, or set `installDir` in this '
          + "plugin's config / the DSH_WOLFRAMSCRIPT environment variable."
        : 'no usable `wolframscript` candidate was found',
      'missing',
    )
  }

  const settled = await raceRun(handle.done, timeoutMs, options.exec?.signal)

  if (settled === 'exit') {
    const { code } = await handle.done
    const streams = finalStreams(handle)
    const stderrText = streams.stderr.text
    const runnerFailure = classifyRunnerFailure(code, stderrText, runnerRules)
    if (runnerFailure !== undefined) {
      throw new WolframError(
        `the sandbox runner could not start the confined command (${runnerFailure.detail}). `
          + 'Confinement is mandatory here, so this is a runner/runtime problem rather than a '
          + 'Mathematica failure.',
        'sandbox-runner',
      )
    }
    const verdict = classify(code, streams)
    if (!verdict.ok) {
      const denied = matchesDenial(code, `${streams.stdout.text}\n${stderrText}`, denialSignatures)
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
