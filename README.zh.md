# dsh-wolfram-renew

[English](README.md) | **简体中文**

[本插件](https://github.com/YMASCU/dsh-wolfram-renew)派生自 [dsh-wolfram](https://github.com/hatter123/dsh-wolfram)，并依据当前 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（0.2.2 系列）的插件机制重新实现，提供中英双语的配置页面、可选的沙箱执行、可切换的执行前端，以及完整的错误处理与超时机制。

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

## 与官方 Wolfram MCP 的对比

Wolfram Research 亦提供官方 MCP 服务（<https://www.wolfram.com/ai/mcp>），分为本地与云端两种形态；本地形态以 [AgentTools paclet](https://resources.wolframcloud.com/PacletRepository/resources/Wolfram/AgentTools/) 分发，经 `InstallMCPServer` 部署至受支持的 MCP 客户端。该服务与本插件均可为 agent 提供 Wolfram Language 求值能力，但二者的设计目标与技术路径不同，适用场景亦因之而异。两者并不互斥：DSH 亦可经其 MCP 连接接入官方服务，届时两套能力并存，可按任务性质分别选用。

| 维度 | 官方 Wolfram MCP | 本插件 |
| --- | --- | --- |
| 功能范围 | 提供 `WolframContext`、`WolframLanguageEvaluator`、`WolframAlpha` 等一组工具，覆盖自然语言提问、知识库检索与代码求值，兼有本地与云端两种形态。 | 仅注册 `wolfram` 一个工具，职责限于代码求值，结果以 `InputForm` 文本返回。 |
| 调用粒度与上下文开销 | 工具数量较多、描述较长，工具选择与上下文开销相应较大。 | 单一工具、两个参数，形态固定，上下文开销小，行为可预期。 |
| Wolfram 版本要求 | 本地形态要求 Wolfram Engine 或 Mathematica 15.0 及以上；完整功能另需 LLM Kit 订阅。 | 仅要求安装目录内含 `math` 或 `wolframscript` 前端，不涉及 paclet 机制，版本门槛较低。 |
| 部署方式 | 安装 paclet，执行 `InstallMCPServer` 写入客户端配置并重启客户端；云端形态另需账户与服务授权。 | 执行一次 `dsh plugin add`；设置于配置页内完成，保存即生效；卸载后不残留。 |
| 会话状态 | 常驻内核，定义与上下文跨调用保留，利于多步推导，但亦可能引入状态残留。 | 每次调用启动独立内核，求值彼此隔离、结果可复现；表达式须自包含，单次启动开销约为热启动 1.5 s、冷启动 2.5–3 s。 |
| 输出形态 | 遵循 MCP 内容模型，可承载文本以外的内容类型。 | 统一为 `InputForm` 文本；图形、图像与笔记本对象退化为文本，不作直接呈现。 |
| DSH 适配 | 面向通用 MCP 客户端，未针对 DSH 作专门适配。 | 注册为 DSH 原生工具：按会话文件策略施加沙箱，超时移交后台作业，注入系统提示段落，并提供双语配置页。 |
| 沙箱与长任务 | 常驻进程的权限在启动时确定，无法随 DSH 会话的文件策略逐次调整；超过客户端时限的调用亦无移交 DSH 作业的通道。 | 即上文「沙箱与后台任务」：逐次包裹，超时移交 `job_output` 与 `job_kill`。 |
| 网络与数据 | 云端形态将查询与代码提交至 Wolfram Cloud；本地形态亦需与 Wolfram 服务交互，以完成授权与组件更新。 | 除 Wolfram 产品的许可校验外，求值全程在本机完成，表达式不出本机。 |
| 错误语义 | 按 MCP 协议的规定返回结果与错误，诊断粒度由服务端决定。 | 将 `$Failed`、非零退出码与空输出判为失败，并区分沙箱运行器失败与文件访问拒绝。 |
| 许可与维护 | 由 Wolfram Research 维护，功能随 paclet 更新；定制受其接口约束。 | MIT 许可，代码规模小，可审计并按需修改，随 DSH 插件接口演进。 |

选择依据可归纳如下：若任务涉及自然语言提问、知识库检索、富内容输出，或在多步推导中需要保留状态，则官方 MCP 更为适宜；若任务限于以代码表达的计算，且重视安装精简、较低的 Wolfram 版本要求、沙箱约束与长任务管理，则本插件更为适宜。本插件的定位是有意收敛的：它不以取代官方服务为目标，而是在 DSH 的工具模型内，提供一个边界清晰、行为可预期的求值通道。

## 说明

- 每次调用均启动新的内核：在 Wolfram Engine 15.0 上热启动约 1.5 s，冷启动约 2.5–3 s。
- 默认使用 `math` 的原因：受限令牌下，`wolframscript` 创建的 `*_shm` 链接无法连至内核对端，将报 `LinkConnect::linkc` 并挂起；`math` 采用内部前端路径，不受此限制。
- `math.exe` 为 CONSOLE 子系统程序，spawn 时使用 `windowsHide`，不会弹出控制台窗口。

## 许可证

MIT
