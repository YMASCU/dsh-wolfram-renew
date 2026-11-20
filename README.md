# dsh-wolfram-renew

**English** | [简体中文](README.zh.md)

This plugin is derived from [dsh-wolfram](https://github.com/hatter123/dsh-wolfram) and reimplemented against the plugin machinery of the current [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (0.2.2 line). It provides a bilingual configuration page, optional sandboxed execution, a selectable execution front-end, and complete error and timeout handling.

The plugin calls [Wolfram Mathematica](https://www.wolfram.com/mathematica/) or the free [Wolfram Engine](https://www.wolfram.com/engine/) from DeepSeek Harness and registers a tool named `wolfram` (Loader row `wolfram-tool`) that evaluates Wolfram Language code through the `math` binary of the installation (or `wolframscript` when the sandbox is disabled) and returns the result as `InputForm` text.

## Prerequisites

Mathematica or the Wolfram Engine must be installed. The plugin discovers installations under `Program Files\Wolfram Research` on every drive by itself.

## Installation

```sh
dsh plugin --profile <profile> add github:YMASCU/dsh-wolfram-renew
```

## Usage

The original [dsh-wolfram](https://github.com/hatter123/dsh-wolfram) fixed the evaluation time limit; this plugin makes it an optional parameter that the agent may set.

The agent calls the `wolfram` tool with `expression` (Wolfram Language source) and an optional `timeout` in seconds.

## Configuration page

The page is located on the Web **Plugins** page: open the details of `dsh-wolfram-renew`. The four settings are laid out directly and require no disclosure:

- **Install directory** — the Wolfram installation directory containing `wolframscript.exe` or `math.exe`; leave it empty to let the plugin discover an installation.
- **Default timeout (ms)** — the range is 1000–600000.
- **Use the sandbox** — enabled by default, so code runs inside the session sandbox. Where the sandbox runner cannot start controlled processes, such as on Android, it must be disabled manually.
- **Front-end** — `math` or `wolframscript`. While the sandbox is enabled this setting is fixed to `math`, because `wolframscript` cannot establish a link to its kernel under a restricted token; `wolframscript` becomes selectable only after the sandbox is disabled.

A save writes the active profile's configuration layer and takes effect immediately; no manual YAML editing is required. The page copy, the plugin title and its description are provided in English and Chinese and follow the DSH language setting.

## Install-directory resolution

Candidates only locate one installation, in the following order:

1. the `installDir` configuration value (a directory; if an executable path is supplied, its directory is used)
2. the `DSH_WOLFRAMSCRIPT` environment variable (directory or executable path)
3. `wolframscript` or `math` on `PATH`
4. installations under `<drive>:\Program Files\Wolfram Research\{Wolfram Engine,Mathematica,Wolfram Desktop}\<version>\`, newest version first

After an installation is located, the `math` binary in that directory is used by default (`math -noprompt -run ...`). `wolframscript -code` is used only when the sandbox is disabled and the front-end is set to `wolframscript`.

## Configuration

```yaml
- insert:
    - id: wolfram-tool
      name: dsh-wolfram-renew
      config:
        installDir: 'D:\Program Files\Wolfram Research\Wolfram Engine\15.0'
        timeoutMs: 180000
        useSandbox: true
        frontend: math
```

`installDir` names the Wolfram installation directory, which must contain `wolframscript.exe` or `math.exe`. `timeoutMs` is the default deadline per evaluation (120000 by default, with a ceiling of 600000); a call's `timeout` argument may raise it up to that ceiling. `useSandbox` controls whether the sandbox constrains each evaluation. `frontend` is either `math` or `wolframscript`; it is ignored and fixed to `math` while the sandbox is enabled.

## Error handling

Mathematica does not report errors through its exit code: a syntax error exits with code 0 while the output carries a `Symbol::tag:` message and `$Failed`. The plugin classifies such output, a non-zero exit code and a completely empty output as failures, so the tool call ends with a non-zero status instead of returning the error text as a result. An empty expression fails immediately, since it would otherwise open an interactive REPL that waits on standard input and leaves the call pending.

## Sandbox and background jobs

- By default every evaluation is wrapped by the DSH sandbox under the file policy of the current session: a `workspace-write` session may write only the workspace and its private temporary directory, a `read-only` session may not write at all, and only a `danger-full-access` session is unrestricted. Disabling **Use the sandbox** removes the wrapping. When the sandbox remains enabled but no sandbox backend is mounted, the plugin refuses to execute rather than running unconstrained.
- A kernel that exceeds `timeout` is not terminated; it is handed over to a background job. The result reports the job id, which can be read with `job_output` and stopped with `job_kill`. Only when no job registry is available does the plugin fall back to terminating on timeout.

## Notes

- Each call starts a new kernel: approximately 1.5 s warm and 2.5–3 s cold on a Wolfram Engine 15.0 installation.
- `math` is the default because, under a restricted token, the `*_shm` link created by `wolframscript` never reaches the kernel side; it reports `LinkConnect::linkc` and hangs. `math` uses an internal front-end path and is not affected.
- `math.exe` is a CONSOLE-subsystem program, and the spawn sets `windowsHide` so that no console window appears.

## License

MIT
