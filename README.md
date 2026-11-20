# dsh-wolfram-renew

**English** | [简体中文](README.zh.md)

This plugin is forked from [dsh-wolfram](https://github.com/hatter123/dsh-wolfram). It relaxes the version constraints and reworks error handling, sandboxed execution and timeouts.

The plugin calls [Wolfram Mathematica](https://www.wolfram.com/mathematica/) or the free [Wolfram Engine](https://www.wolfram.com/engine/) from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers a `wolfram` tool that evaluates Wolfram Language code through the `math` console front-end of the Wolfram install and returns the result as `InputForm` text.

## Prerequisites

Install Mathematica or the Wolfram Engine; the plugin finds installs under `Program Files\Wolfram Research` on every drive by itself.

## Install

```sh
dsh plugin --profile <profile> add github:YMASCU/dsh-wolfram-renew
```

## Usage

The original [dsh-wolfram](https://github.com/hatter123/dsh-wolfram) fixed the evaluation time limit; here it is an optional parameter the agent can set.

The agent calls the `wolfram` tool with `expression` (Wolfram Language source) and an optional `timeout` in seconds.

## Executable resolution

Candidates only **locate one install**, in this order:

1. the plugin's `executable` config
2. the `DSH_WOLFRAMSCRIPT` environment variable
3. `wolframscript` on `PATH`
4. installs under `<drive>:\Program Files\Wolfram Research\{Wolfram Engine,Mathematica,Wolfram Desktop}\<version>\`, newest version first

Once an install is located, execution uses the `math` in that directory (`math -noprompt -run ...`); `wolframscript -code` is only the fallback when that directory has no `math`.

## Configuration

```yaml
- insert:
    - id: wolfram-tool
      name: dsh-wolfram-renew
      config:
        executable: 'D:\Program Files\Wolfram Research\Wolfram Engine\15.0\wolframscript.exe'
        timeoutMs: 180000
```

`executable` points at an executable of the install (`wolframscript.exe` or `math.exe`, either locates the directory). `timeoutMs` is the default deadline per evaluation (default 120000, ceiling 600000); a call's `timeout` argument can raise it up to that ceiling.

## Error handling

Mathematica does not report errors through the exit code: a syntax error is an **exit-0** run whose output carries a `Symbol::tag:` message and `$Failed`. The plugin treats that output, a non-zero exit code, and a completely empty output as a **failure**, so the tool call ends non-zero instead of returning the message as an answer. An empty expression fails immediately — otherwise it would open an interactive REPL and wait on stdin forever.

## Sandbox and background jobs

- Every evaluation is wrapped by the DSH sandbox under the session's file policy: a `workspace-write` session may only write the workspace and its private temp, a `read-only` session may not write at all, and only a `danger-full-access` session runs unconfined. A composition with no sandbox backend makes the plugin **refuse to run** instead of executing unconfined. Verified: writing inside the workspace succeeds, writing to the Desktop is denied (`OpenWrite::noopen` -> `$Failed` -> failed call).
- A kernel that outlives `timeout` is not killed: it is handed over to a background job, and the result names the job id to read with `job_output` or stop with `job_kill`. The deadline kill remains only for a composition with no job registry.

## Notes

- Each call starts a kernel: roughly 1.5 s warm on a Wolfram Engine 15.0 install, 2.5-3 s cold.
- Why not `wolframscript`: under a restricted token the `*_shm` link it creates never reaches the kernel side, and it reports `LinkConnect::linkc` and hangs. The config-file complaint is only a side effect (a read-only config is accepted, so no write access is required, and the complaint is not fatal). `math` uses an internal front-end path and is not affected.
- `math.exe` is a CONSOLE-subsystem program, so the spawn sets `windowsHide` to avoid flashing a console window.

## License

MIT
