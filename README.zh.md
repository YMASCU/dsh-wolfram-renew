# dsh-wolfram-renew

[English](README.md) | **简体中文**

本插件 fork 自 [dsh-wolfram](https://github.com/hatter123/dsh-wolfram)，在其基础上放松了版本限制，并完善了错误处理、沙箱执行与超时行为。

插件从 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 调用 [Wolfram Mathematica](https://www.wolfram.com/mathematica/) 或免费的 [Wolfram Engine](https://www.wolfram.com/engine/)。它注册一个 `wolfram` 工具：用 Wolfram 安装目录里的控制台前端 `math` 执行 Wolfram Language 代码，并返回结果的 `InputForm` 文本。

## 前置要求

安装 Mathematica 或 Wolfram Engine 即可，插件会自动发现各盘 `Program Files\Wolfram Research` 下的安装。

## 安装

```sh
dsh plugin --profile <profile> add github:YMASCU/dsh-wolfram-renew
```

## 用法

原 [dsh-wolfram](https://github.com/hatter123/dsh-wolfram) 中计算时间限制固定，这里改为可选参数，由 agent 按需设定。

agent 调用 `wolfram` 工具，入参为 `expression`（Wolfram Language 代码）和可选的 `timeout`（秒）。

## 可执行文件解析

候选只用于**定位一次安装**，依次尝试：

1. 配置的 `executable`
2. 环境变量 `DSH_WOLFRAMSCRIPT`
3. `PATH` 中的 `wolframscript`
4. 各盘 `Program Files\Wolfram Research\{Wolfram Engine,Mathematica,Wolfram Desktop}\<版本>\` 下的安装，版本从高到低

定位到安装后，实际执行使用该目录下的 `math`（`math -noprompt -run ...`）；只有该目录没有 `math` 时，才回退到 `wolframscript -code`。

## 配置

```yaml
- insert:
    - id: wolfram-tool
      name: dsh-wolfram-renew
      config:
        executable: 'D:\Program Files\Wolfram Research\Wolfram Engine\15.0\wolframscript.exe'
        timeoutMs: 180000
```

`executable` 指向安装里的可执行文件（`wolframscript.exe` 或 `math.exe` 均可，用于定位安装目录）；`timeoutMs` 是单次求值的默认超时（默认 120000，上限 600000），调用参数 `timeout` 可在上限内调高。

## 错误处理

Mathematica 不通过退出码报错：语法错误是**退出码 0**，输出里带 `Symbol::tag:` 消息和 `$Failed`。插件把这类输出、非零退出码、以及完全没有输出都判定为**失败**，让工具调用以非零状态结束，而不是把报错文本当成结果返回。空表达式立即失败——否则会进入交互式 REPL 等 stdin，把调用挂死。

## 沙箱与后台任务

- 每次求值都由 DSH 沙箱按当前会话的文件策略包裹：`workspace-write` 会话下只能写工作区与私有 temp，`read-only` 下不可写；只有 `danger-full-access` 会话才不受限。组合里没有沙箱后端时，插件**拒绝执行**而不是裸跑。实测：写工作区内成功，写桌面被拒（`OpenWrite::noopen` → `$Failed` → 调用失败）。
- 超过 `timeout` 的内核不会被杀掉，而是转为后台任务：结果里给出 job id，用 `job_output` 读取、用 `job_kill` 终止。只有在没有作业注册表可用时，才退回"超时即杀"。

## 说明

- 每次调用都会启动一个新内核：Wolfram Engine 15.0 上热启约 1.5 s，冷启 2.5–3 s。
- 为什么不用 `wolframscript`：受限令牌下它建好的 `*_shm` 链接等不到内核对端，报 `LinkConnect::linkc` 后挂住；配置文件的读取告警只是伴随现象（实测只读配置同样被接受，且该告警本身非致命）。`math` 走内部前端路径，不受这个限制。
- `math.exe` 是 CONSOLE 子系统程序，spawn 时使用 `windowsHide`，不会弹控制台窗口。

## 许可证

MIT
