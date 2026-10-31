# DSH 运行时核查与安全配置

核查日期：2026-10-31（Asia/Shanghai）。范围为全新 QQAI_DSH，不读取或迁移旧项目人格、记忆、数据库或执行规则。本记录包含上游核查、本地实际 DSH Runtime 与真实 DeepSeek API 测试；不代表腾讯云部署或实际 QQ 验收通过。

## 版本与取得证据

直接读取 npm 官方 registry 元数据，确认 `@deepseek-ai/dsh` 的 `latest`、`next` 均为 `0.2.1-rc.5`，`alpha` 为 `0.2.2-alpha.2`。初选固定 `0.2.1-rc.5`，不使用浮动 `latest` 或主分支构建物。[npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.5)

`@deepseek-ai/dsh@0.2.1-rc.5`：

- 许可：MIT。
- npm bin：`dsh -> lib/bin.js`。
- tarball：[官方 rc.5 包](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.5.tgz)。
- npm integrity：`sha512-WkyJZv4zl9sCAxSzRctGm58m0rilGqwR6pniBiLOz5CPDfHfDuAUicg0AAazXI7oj/Cph6/cjNTncA/rpLTXpw==`。
- npm shasum：`8e1bfd31869414f7a5ec10c34403a852ac9c3dc7`。
- 发布包自身没有 `engines` 字段；不能把主仓 Node 要求标注为该 npm 包的声明。主仓当前要求 Node `>=24.9.0`；部署采用 Node 24，并记录实际小版本、二进制校验和与 npm 安装结果。[源码 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json)

已下载并逐包比对 npm SHA512，未执行包代码：`dsh`、`dsh-web-app`、`dsh-base`、`dsh-llm-deepseek`、`dsh-llm-deepseek-api-key`、`dsh-plugin-manager`、`dsh-home-paths`、`dsh-agent-preset`、`dsh-persona`、`dsh-app-boot`、`dsh-web-deepseek-api`、`dsh-web-search-deepseek`，均为 `0.2.1-rc.5`。本次临时核查副本位于 `/tmp/qqai-dsh-audit/dsh/`；这不是运行目录或备份。

## 确认的安装与启动接口

官方支持的 Node 启动器为 `dsh`。`dsh web` 与 `dsh --profile web` 等价，Web 缺省监听 `127.0.0.1:3080`。[官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)

固定安装采用 `@deepseek-ai/dsh@0.2.1-rc.5`，并保存其实际依赖锁。`deployment/locks/package.json` 与 `package-lock.json` 来自服务器的 DSH 宿主安装；`profile-package.json` 与 `pnpm-lock.yaml` 来自服务器的三插件 profile 安装。插件管理命令将参数转交给同一 profile 内的 pnpm，本项目固定为 11.28.5。以下是已核实的接口形态；完整初始化请用本文后面的安装脚本：

```bash
dsh --profile web --dump-config
dsh --profile web --help
dsh plugin --profile web install --frozen-lockfile --ignore-scripts
dsh --profile web --no-open --host 127.0.0.1 --port 3080
```

启动器参数（`--profile`、`--patch`、`--dump-config`）必须先于 Web 参数（`--no-open`、`--host`、`--port`）。`--dump-config` 不启动服务；它与启动使用相同的 patch 合成逻辑。[CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)

始终以同一专用普通用户、同一 `HOME`、同一 `DSH_HOME`、同一 `web` profile 安装与运行。`DSH_HOME` 缺省为 `~/.dsh`；项目部署必须显式指定受保护的运行数据目录。profile 的依赖和配置在 `$DSH_HOME/profiles/web/`，凭据不在代码工作区。

## 安全 overlay 的实际内容与限制

仓库 `config/safe-profile.patch.yml` 面向上述固定版本。已实现：

- 关闭 shipped `standard`、`minimal`、`cordis`、`ptc` preset。尤其 `minimal` 也带持久 Shell，不能用名称推断它无权限。
- 添加 `qqai-safe` 作为 Web 默认 preset，仅有管理测试人格、时间、压缩和 `web_search`/`web_fetch`。
- 完整替换 Aurabot 的 `aurabot-private`、`aurabot-private-long`、`aurabot-social` 配置；私聊保留 `persona`、`time-context`、原生 compaction 和 Web 工具，删除 bash/pwsh/fs/fs-search；long 同样删除 jobs/schedule。
- 再次禁用宿主层文件、Shell、后台命令、子 Agent、workflow 与插件管理模型工具。
- 关闭 Web terminal、宿主文件树/预览、本地路径引用、目录浏览及宿主应用启动入口。
- DeepSeek API-key 路由固定 Thinking Off，默认模型为 `deepseek-official / deepseek-flash`。
- 关闭上游默认 `session-log-deepseek` 的额外规范化会话日志上传；正常模型推理需要的历史仍发送给模型。服务环境同时应设置 `DSH_TELEMETRY_DISABLED=1`。

Cordis patch 按 entry id 替换整份 `config`，不是深度合并。每个 preset override 必须重述 `config.id` 和完整 `plugins`；不能只写一小段嵌套工具开关。上游 `applyEntryPatches()` 对未命中目标记录警告后跳过，因此 Aurabot 安装前可出现三条未命中警告；最终三插件安装后不得忽略这类警告。[preset 声明参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/README.md)

安全边界不是对插件代码的沙箱。Aurabot、图片附件、表情库与持久化仍需普通运行用户下的内部文件访问；已安装的可信 Host 插件也在进程内执行。必须结合专用用户、目录权限、systemd 限制、无 Docker Socket/管理组与 loopback 绑定，不能声称 overlay 已隔离所有宿主文件。

禁用目录选择后，Web 初次工作区需由运维侧创建并注册指定的空工作目录，不能为使界面按钮恢复而重新开放全宿主文件浏览。图片上传与 QQ 附件应通过附件服务验证，不用重开 `read_image` 或 Shell 来代替。

此 overlay 不管理 Aurabot 自己的配置：上游 `id: aurabot` 的 Host Config 为空，聊天开关从独立 `config.json` 加载。上线前必须在那个文件中关闭 `files.enabled`、`longTasks`、空间/第三方写操作与 profile 权限，并把 `model.reasoningEffort` 设为 `off`。最终开始发送由单独的联调步骤开启，不能凭 DSH 启动自动开放所有 QQ 工具。具体字段及媒体限制见三插件审计文档。

Whale 的旧 `cordis.patch.yml` 不能直接覆盖新 DSH 的默认 preset。保留安装与宿主装载，从指定包提取人格接入 Aurabot，禁止将旧 patch 的默认会话改为 whale 当作 QQ 人格验收。`complete: true` 会只保留渲染后的 persona prefix 作为系统提示；Nekowhale 的工具使用规则需经 Aurabot `rules` 扩展进入该 prefix，不能只依赖被屏蔽的额外系统提示 section。[persona 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/persona/README.md)

新 preset revision 不修改已有 Agent；重建测试会话并检查真实工具目录后再验收。

## DeepSeek Key、模型与真实像素输入

rc.5 的 `llm-deepseek` entry 实际挂载 `@deepseek-ai/dsh-llm-deepseek-api-key`，使用 Messages API，默认根为 `https://api.deepseek.com/anthropic`，实际请求追加 `/v1/messages`。配置字段是 `apiKeyEnv: DEEPSEEK_API_KEY`、`thinking: disabled`、`reasoningEffort: off`。`apiKeyEnv` 是凭据引用，不是把 Key 写入 YAML。

凭据服务可从运行环境或受保护的 `$DSH_HOME/.credentials.yaml` 解析引用。Web 密钥字段只写，返回脱敏描述符；配置文件只保留引用。运行文件权限至少落实专用用户目录 `0700`、Key 文件 `0600`，不复制到 Git、日志、测试请求文件或公开 URL。[模型配置指南](https://deepseek-harness.github.io/deepseek-harness/guide/providers)

`thinking: disabled` 是部署策略，只允许 `off`；Aurabot 或其辅助请求显式传 `low` 时仍可能产生配置错误，不能把 `low` 当作 Off。最终应检查真实请求的 Thinking 字段和实际响应，覆盖普通聊天、压缩/记忆、主动分支。直接 Chat Completions 测试须发送 `thinking: {type: disabled}`；官方默认启用思考。[Thinking 文档](https://api-docs.deepseek.com/guides/thinking_mode/)

2026-10-31 官方模型表显示 `deepseek-flash` 对应 DeepSeek-V4.1-Flash-1017，支持图片；`deepseek-v4-pro` 不支持图片。不能沿用早期“DeepSeek 不支持视觉”的判断。[模型表](https://api-docs.deepseek.com/quick_start/pricing/)

真实像素可用 JPEG/PNG/GIF/WebP。Chat Completions 使用 user message 的 `image_url` data URL 或外部地址；DSH Messages 适配器通常先上传 Files 引用，失败后受字节预算约束回退 inline base64。适配器需把模型标记为支持 `inputModalities: [text, image]`；rc.5 默认 Flash 已声明，不要为 Pro 伪造视觉能力。[Vision 文档](https://api-docs.deepseek.com/guides/vision/)

真实测试应包含只凭图像才能回答的合成图及后续追问，检查上传、模型输入和回答证据。文本占位符、OCR 摘要或只识别图片文件名不构成像素输入通过。

## Search / Fetch 路由和即将变化的收费

rc.5 已包含两套上游实现：

| Web provider 选择 | 实际行为 |
| --- | --- |
| `searchProvider: deepseek-official` | 通过独立 Messages 请求调用服务端 web search，产生辅助模型请求 |
| `fetchProvider: http` | DSH 本地 HTTP Fetch，校验目的地址，限公共 HTTP(S) 目标 |
| `searchProvider: deepseek-search-api` | `https://api.deepseek.com/v1/tools/search` |
| `fetchProvider: deepseek-fetch-api` | `https://api.deepseek.com/v1/tools/fetch` |

上游默认使用第一、二项；本 overlay 保留默认，不暗中切换收费路径。独立 API 路由已内置，若后续启用，需记录选择及实际请求。`web-deepseek-api.sendOriginalQuestion` 缺省 true，会发送触发问题前 128 字符作为意图字段；公开仓库不得保存私人问题或完整结果。[独立 Search/Fetch 插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-deepseek-api/README.md)

官方说明 Search 与 Fetch 在 **北京时间 2026-11-01 00:00** 开始按成功请求收费，分别为每千次 **0.75 美元**；通过 DSH 调用的服务端搜索/抓取也涉及这项计费。必须向用户说明并取得其要求的额外收费确认后，才持续开启相关收费调用。必要模型测试额度不因此被缩减；本地 HTTP Fetch 与收费 DeepSeek Fetch 必须区分。[官方费用说明](https://api-docs.deepseek.com/quick_start/pricing/)

## 核查状态与下一步验收

| 层次 | 当前证据 |
| --- | --- |
| 上游资料与包 | 官方网页实时核查；12 个 rc.5 npm tarball SHA512 通过 |
| 配置静态核查 | 使用真实 rc.5 base/web 与锁定 Aurabot YAML 合成检查；最初 37 条 override 全部命中，之后补充 UI/本地应用打开/额外日志限制，并经真实 DSH 合成与启动验证 |
| DSH 实际合成/启动 | 本地 `--dump-config` 通过，最终三插件均 active；认证 RPC 成功，未认证 API=401、不可信 Host=403；本地应用打开=false |
| 真实 API | 本地 DSH 完成中文多轮、鲸鱼娘人格、Nekowhale 检索/选择/中文模板、Search/Fetch、真实图像像素与图片追问；详见下方证据。Key 只从用户指定文件读入进程环境 |
| 实际 QQ | 用户已确认 3 条气泡且不显示原始 `|||`、多轮上下文、“大肥鱼”身份、文字/动画 GIF/文字顺序、PNG识别与追问、中文文字表情清晰、搜索回答附来源；运行元数据确认五个媒体/Web工具真实成功，12次已观察请求均为Flash / Thinking Off。记忆、主动、重启及登录后备份恢复仍在独立验收。[聊天与媒体证据](evidence/20261031-qq-chat-media.json) |

静态检查采用 PyYAML 解析官方 bundle，保留但不执行 `!!js`，只检验 overlay 目标与 preset 工具白名单；它不是 DSH Runtime 测试。最终还需验证：运行进程身份与权限、监听地址、GUI 禁用入口、真实会话工具目录、同一个 profile 的插件装载、无低思考覆盖、无重复注册、Nekowhale 图片鉴权/发送，以及持久化重启与恢复。

启动 URL 含认证 token；只在私有通道提供给机主，不写入 Git/公开日志。[Web 访问与鉴权](https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments)

## 已执行的本地合成验收

执行环境：隔离 Node 24 / DSH rc.5，独立 `/tmp/qqai-dsh-runtime/home`，QQ 总开关关闭、dryRun 开启，不连接 OneBot。三个固定插件完成安装、固定源码补丁及用户 module 装载。四种 preset 的新合成会话由真实 Web RPC 创建，审计 observer 调用运行时 `ctx.tools.schemas(agent)`，没有用假工具目录替代。

| 测试 | 实际结果与边界 |
| --- | --- |
| 工具目录 | private/private-long/qqai-safe：sticker_search、sticker_send、meme_render、sticker_manage、web_search、web_fetch；social 只有四个 Neko 工具。未出现 Shell/宿主文件/子 Agent 工具。实际 QQ hub 按会话动态添加的工具还需单独验收 |
| 人格 | 三个 Aurabot preset 的最终 section 引用 `aurabot_persona`，来源变量哈希一致、包含鲸鱼娘/AI身份/默认大肥鱼；真实回复自称大肥鱼并说明无真实身体。qqai-safe 可访问同名变量但系统 prompt 不引用它，不把变量存在误判为人格生效 |
| 中文与上下文 | 合成编号“海盐-741”、蓝色鲸鱼在下一轮正确召回；这是短上下文测试，不是长期记忆通过 |
| 多气泡 | 模型在 Aurabot preset 产生 `|||` 三段；没有连接 QQ，不能宣称实际多气泡发送通过 |
| 表情工具 | 真实模型调用 sticker_search、sticker_send，返回受控 loopback GIF 链接；工具结果 isError=false。下载的 GIF 为 300×300、86 帧 |
| 中文模板 | 真实 meme_render 生成“验收通过”举牌 GIF，300×300、30 帧；已目视确认中文字形正确。未验证 QQ 播放 |
| 搜索和 Fetch | 真实 web_search 和 web_fetch 均成功；模型如实指出 quickstart 未列默认端口，没有把 HTTP 200 当作问题必然有答案 |
| 图片像素 | 向 DSH 提交程序生成、无标签的 PNG；真实 Flash 回答左红圆、右蓝正方形、共两个，追问正确识别右侧。图片文件名和文字提示不包含答案 |
| Thinking | 全部受测聊天请求元数据为 deepseek-official / deepseek-flash / off；后台 hardcoded low 也已通过固定哈希补丁改为跟随配置，但其记忆/主动实际效果待 QQ 链路测试 |

前六项只用了合成数据，但当时上游默认额外 session-log contribution 尚开启，记录了 delivery-accepted。发现后已经关闭；后两项视觉回归没有该事件，模型能力仍正常。原始私有 session 日志不提交，仅保存筛选后的模型普通回答、工具名称/成功标记及配置元数据：

- [本地六项真实 API 证据](evidence/20261031-dsh-local-api.json)
- [关闭额外日志后的视觉与追问证据](evidence/20261031-dsh-local-vision.json)

## 可复用安装与验收脚本

服务停止后，以专用 DSH 用户、正确 Node PATH 运行：

```bash
DSH_BIN=/opt/qqai-dsh/app/node_modules/.bin/dsh \
  bash /opt/qqai-dsh/source/scripts/install-dsh-profile.sh \
  /srv/qqai-dsh/home/.dsh /srv/qqai-dsh/workspace 3080
```

脚本固定 pnpm 为 11.28.5。仓库存在完整 profile 锁文件对时，先用 DSH 官方入口初始化新 profile 的目录和 pnpm workspace 设置，再复制锁定 manifest/lock，执行 `dsh plugin --profile web install --frozen-lockfile --ignore-scripts`，并检查锁文件未变化；不会重新解析浮动依赖。若两个文件均不存在，则保留首次捕获分支，按三个精确版本/提交执行 `add --save-exact --ignore-scripts`；只缺其中一个文件时直接失败，避免意外退回无锁安装。首次捕获完成后，将 `$DSH_HOME/profiles/web/package.json` 保存为 `deployment/locks/profile-package.json`，同时保存该目录的 `pnpm-lock.yaml`。可用 `DSH_PNPM_STORE_DIR` 指定同一专用用户可写的包缓存目录，默认位于本次 DSH_HOME/toolchain。

安装后应用当前六文件哈希补丁，调用 `configure-dsh-profile.mjs`，生成完整 profile patch，保留 Whale dependency、排除其旧 bundle patch、独立挂载 Whale Host 空入口。配置会强制停止 QQ 发送和主动发送，设置外部 OneBot 模式，并保留同项目已有 QQ 号和网关 token。脚本不处理模型 Key。重跑属于停机重新配置步骤，不应在线覆盖运行设置；恢复已备份的会话和偏好时，应按 [备份恢复说明](backup-restore.md) 对恢复的锁执行 frozen 安装并检查补丁，不重跑初始化配置。

历史记录：首次在独立空临时 DSH_HOME 执行完整安装脚本时，pnpm 明确报告跳过 resolution，三个固定插件安装成功，当时的四文件补丁与完整配置合成通过；安装后的 manifest 与仓库记录一致、lock 逐字节未变，原生 canvas 能加载并输出 PNG。此项没有启动服务或发送 API 请求，保留其当时的四文件结果，不追改为六文件重建证明。[无锁漂移的重建证据](evidence/20261031-dsh-frozen-install.json)

本轮补充：统一补丁现覆盖 Aurabot `hub.js`、`companion.js`、`llm.js`、`memory.js`、`modules/qq-tools/index.js` 与 Nekowhale `lib/core/image-input.js` 六个文件，加入投递结果核实和记忆流水保留修复。安装器支持原版 Hub 与已部署 GIF-only 中间 hash 迁移到同一最终版本，拒绝其余 hash，每个文件只准备一个输出；机制/媒体 6 项、投递 5 项、记忆 11 项回归通过，无跳过。这些自动化结果不替代真实模型和 QQ 功能验收。完整最终 hash 与修复边界见[三插件兼容性记录](plugin-compatibility-audit.md)。

实际 QQ 会话已核对 10 个工具：`sticker_search`、`sticker_send`、`meme_render`、`sticker_manage`、`web_search`、`web_fetch`、`remember`、`recall_memory`、`qq_chat_history`、`qq_send_message`。本轮12次已观察请求均为 Flash / Thinking Off；两个表情工具、`meme_render`、`web_search`、`web_fetch` 实际成功。用户确认了GIF动画及前后文字顺序、入站PNG识别与边数追问、中文文字表情实际接收且可读、搜索回答附来源。公开[聊天与媒体证据](evidence/20261031-qq-chat-media.json)只记录元数据和确认结果，不含账号或私人聊天。长期记忆、主动及未回复行为、重启恢复与持续运行仍需各自验收；上述历史本地单次测试记录保留当时的范围。

完整安全 overlay 已写入 profile，正式服务不再额外 `--patch` 同一文件，否则会重复插入 preset。启动形态：

```bash
dsh --profile web --no-open --host 127.0.0.1 --port 3080
```

`inspect-dsh-runtime.mjs STARTUP_LOG WORKSPACE OUTPUT_JSON [AUDIT_DIR]` 从受保护启动日志读取最后一条启动 URL，只在内存交换认证 cookie。默认创建无消息合成会话并检查插件，不调用模型；`--real-api` 执行八项真实合成测试，`--vision-only` 只执行图像与追问。输出不含启动 token、Key、原始请求、系统 prompt 或推理内容。

如需精确工具目录及请求/工具成功标记，在测试启动时额外挂载 `scripts/audit-tool-catalog.mjs`（普通 Cordis `insert` row），设置受保护的绝对 `DSH_AUDIT_DIR`。observer 只接受 `qqai-synthetic-...` 会话，记录工具名、schema/persona 哈希、请求路由/off、工具成功标志，不增加模型工具。验收后移除此测试 overlay。

RPC 采用认证 POST `/api/session/create` 等 endpoint，body 为 `{type:"client-request", rpcId:UUID, method:ENDPOINT, payload:{args:{request:BODY}}}`。`session/create` 的 BODY 取 cwd、agentPreset、sessionId；`session/prompt` 取 sessionId、requestId、mode:`queue`、content 文本/图片数组、clientTimeZone。脚本通过 `session/projections` 和 `session/page` 等待真实 `turn/end`，工具成功由独立 observer 核实，不把 completed 单独当作功能成功。
