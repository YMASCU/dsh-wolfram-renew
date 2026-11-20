# dsh-wolfram-renew

[English](README.md) | **简体中文**

本插件派生自 [dsh-wolfram](https://github.com/hatter123/dsh-wolfram)，并依据当前 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（0.2.2 系列）的插件机制重新实现，提供中英双语的配置页面、可选的沙箱执行、可切换的执行前端，以及完整的错误处理与超时机制。

插件通过 DeepSeek Harness 调用 [Wolfram Mathematica](https://www.wolfram.com/mathematica/) 或免费的 [Wolfram Engine](https://www.wolfram.com/engine/)，注册名为 `wolfram` 的工具（对应 Loader 行 `wolfram-tool`）：该工具以安装目录中的 `math`（或在关闭沙箱时选用 `wolframscript`）执行 Wolfram Language 代码，并返回结果的 `InputForm` 文本。

## 前置要求

需安装 Mathematica 或 Wolfram Engine。插件可自行发现各磁盘 `Program Files\Wolfram Research` 目录下的安装。

## 安装

```sh
dsh plugin --profile <profile> add github:YMASCU/dsh-wolfram-renew
```

## 用法

原始 [dsh-wolfram](https://github.com/hatter123/dsh-wolfram) 将求值时限固定，本插件将其改为可选参数，由 agent 按需指定。

agent 调用 `wolfram` 工具，入参为 `expression`（Wolfram Language 代码）与可选的 `timeout`（秒）。

## 配置界面

配置页面位于 Web 的 **插件（Plugins）** 页面：打开 `dsh-wolfram-renew` 的详情页即可见到。四项设置直接排列，无需展开：

- **安装目录**：包含 `wolframscript.exe` 或 `math.exe` 的 Wolfram 安装目录；留空则由插件自动发现。
- **默认超时（毫秒）**：取值范围 1000–600000。
- **使用沙箱**：默认为开启状态，代码在会话沙箱内执行。在 Android 等沙箱无法启动受控进程的环境中，应手动关闭。
- **执行前端**：可选 `math` 或 `wolframscript`。沙箱开启时该项固定为 `math`（受限令牌下 `wolframscript` 无法与内核建立链接）；仅当沙箱关闭时方可选择 `wolframscript`。

保存后，配置写入当前 profile 的配置层并立即生效，无需手工编辑 YAML。页面文案、插件标题与描述均提供中英双语，并跟随 DSH 的语言设置。

## 安装目录解析

候选对象仅用于定位一次安装，按以下顺序尝试：

1. 配置项 `installDir`（目录；若提供可执行文件路径，则取其所在目录）
2. 环境变量 `DSH_WOLFRAMSCRIPT`（目录或可执行文件路径）
3. `PATH` 中的 `wolframscript` 或 `math`
4. 各磁盘 `Program Files\Wolfram Research\{Wolfram Engine,Mathematica,Wolfram Desktop}\<版本>\` 下的安装，按版本从高到低

定位完成后，默认以同目录的 `math` 执行（`math -noprompt -run ...`）；仅当沙箱关闭且执行前端设为 `wolframscript` 时，方使用 `wolframscript -code`。

## 配置

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

`installDir` 指定 Wolfram 安装目录，其中须包含 `wolframscript.exe` 或 `math.exe`；`timeoutMs` 为单次求值的默认超时（默认 120000，上限 600000），调用参数 `timeout` 可在该上限内调高；`useSandbox` 控制是否施加沙箱约束；`frontend` 取值为 `math` 或 `wolframscript`，沙箱开启时被忽略并固定使用 `math`。

## 错误处理

Mathematica 不通过退出码报告错误：语法错误表现为退出码 0，输出中包含 `Symbol::tag:` 消息与 `$Failed`。插件将此类输出、非零退出码以及无输出的情形一并判定为失败，使工具调用以非零状态结束，而不将错误文本作为结果返回。空表达式立即失败，以避免进入交互式 REPL 等待标准输入而使调用挂起。

## 沙箱与后台任务

- 默认情况下，每次求值均由 DSH 沙箱按当前会话的文件策略包裹：`workspace-write` 会话仅可写入工作区与私有临时目录，`read-only` 会话不可写入，仅 `danger-full-access` 会话不受限制。关闭「使用沙箱」后不再施加包裹。若仍开启沙箱而当前组合未挂载沙箱后端，插件拒绝执行，而非以无约束方式运行。
- 超过 `timeout` 的内核不会被终止，而是转交给后台任务：结果中给出 job id，可通过 `job_output` 读取，通过 `job_kill` 终止。仅在无作业注册表可用时，方回退为超时终止。

## 说明

- 每次调用均启动新的内核：在 Wolfram Engine 15.0 上热启动约 1.5 s，冷启动约 2.5–3 s。
- 默认使用 `math` 的原因：受限令牌下，`wolframscript` 创建的 `*_shm` 链接无法连至内核对端，将报 `LinkConnect::linkc` 并挂起；`math` 采用内部前端路径，不受此限制。
- `math.exe` 为 CONSOLE 子系统程序，spawn 时使用 `windowsHide`，不会弹出控制台窗口。

## 许可证

MIT
