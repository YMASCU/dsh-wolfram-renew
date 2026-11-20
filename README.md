# dsh-wolfram-renew

**English** | [简体中文](README.zh.md)

[This plugin](https://github.com/YMASCU/dsh-wolfram-renew) is derived from [dsh-wolfram](https://github.com/hatter123/dsh-wolfram) and reimplemented against the plugin machinery of the current [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (0.2.2 line). It provides a bilingual configuration page, optional sandboxed execution, a selectable execution front-end, and complete error and timeout handling.

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

## Comparison with the official Wolfram MCP

Wolfram Research publishes an official MCP service (<https://www.wolfram.com/ai/mcp>) in two forms, local and cloud. The local form is distributed as the [AgentTools paclet](https://resources.wolframcloud.com/PacletRepository/resources/Wolfram/AgentTools/) and is deployed into a supported MCP client by `InstallMCPServer`. Both that service and this plugin give an agent access to Wolfram Language evaluation, but they differ in design goal and technical route, and therefore in the situations to which they are suited. The two are not mutually exclusive: DSH can also reach the official service through its MCP connection, in which case both capabilities are available and may be selected according to the nature of the task.

| Dimension | Official Wolfram MCP | This plugin |
| --- | --- | --- |
| Scope | A set of tools — `WolframContext`, `WolframLanguageEvaluator` and `WolframAlpha` — covering natural-language questioning, knowledge retrieval and code evaluation, in local and cloud form. | A single `wolfram` tool whose only responsibility is code evaluation; the result is returned as `InputForm` text. |
| Granularity and context cost | Several tools with longer descriptions, so tool selection and context cost are greater. | One tool with two parameters; a fixed shape, low context cost and predictable behavior. |
| Wolfram version requirement | The local form requires Wolfram Engine or Mathematica 15.0 or later, and full functionality additionally requires an LLM Kit subscription. | Only a `math` or `wolframscript` front-end in the installation directory is required; no paclet is involved, so the version threshold is lower. |
| Deployment | The paclet is installed, `InstallMCPServer` writes the client configuration, and the client is restarted; the cloud form additionally requires an account and service authorization. | One `dsh plugin add`; settings are made on the configuration page and take effect on save; removal leaves nothing behind. |
| Session state | A resident kernel retains definitions and context across calls, which favors multi-step derivations but may also carry state over. | A fresh kernel per call; evaluations are isolated and reproducible, but expressions must be self-contained and each call pays a start-up cost of about 1.5 s warm and 2.5–3 s cold. |
| Output form | Follows the MCP content model and can carry content types other than text. | Uniformly `InputForm` text; graphics, images and notebook objects degrade to text and are not rendered directly. |
| DSH integration | Addressed to generic MCP clients and not adapted to DSH specifically. | Registered as a native DSH tool: sandboxed under the session's file policy, handed over to a background job on timeout, described in a system-prompt section, and configured through a bilingual page. |
| Sandbox and long-running work | A resident process fixes its privileges at start-up, so they cannot follow the DSH session's file policy call by call; a call that exceeds the client's deadline has no channel to a DSH job. | See "Sandbox and background jobs" above: confinement per call, and hand-off to `job_output` and `job_kill` on timeout. |
| Network and data | The cloud form submits queries and code to Wolfram Cloud; the local form also exchanges data with Wolfram services for authorization and component updates. | Apart from Wolfram product license checks, evaluation is entirely local; expressions do not leave the machine. |
| Error semantics | Reports results and errors as the MCP protocol prescribes; diagnostic granularity is determined by the server. | Treats `$Failed`, a non-zero exit and empty output as failures, and distinguishes a sandbox runner failure from a refused file access. |
| License and maintenance | Maintained by Wolfram Research; features arrive with paclet updates, and customization is bounded by its interfaces. | MIT; a small code base that can be audited and modified as needed, tracking the DSH plugin interface. |

The choice may be summarized as follows. Where a task involves natural-language questioning, knowledge retrieval, rich output or the retention of state across a multi-step derivation, the official MCP is the more suitable instrument. Where the task is confined to computation expressed as code, and installation economy, a lower Wolfram version requirement, sandbox confinement and long-task management are valued, this plugin is the more suitable. The scope of this plugin is deliberately narrow: it does not seek to replace the official service, but to provide, within the DSH tool model, an evaluation channel with clear boundaries and predictable behavior.

## Notes

- Each call starts a new kernel: approximately 1.5 s warm and 2.5–3 s cold on a Wolfram Engine 15.0 installation.
- `math` is the default because, under a restricted token, the `*_shm` link created by `wolframscript` never reaches the kernel side; it reports `LinkConnect::linkc` and hangs. `math` uses an internal front-end path and is not affected.
- `math.exe` is a CONSOLE-subsystem program, and the spawn sets `windowsHide` so that no console window appears.

## License

MIT
