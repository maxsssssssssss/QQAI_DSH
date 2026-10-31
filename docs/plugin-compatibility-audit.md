# 三插件兼容性核查与已实现适配

核查日期：2026-10-31（Asia/Shanghai）。本文件记录固定上游源码、兼容修复、自动化接口测试、真实 DeepSeek 测试及已经完成的部分 QQ 验证。整体验收仍在进行；通过范围与待测事项在文末分别列出。不引用旧项目人格、记忆、Guard、发送或主动聊天实现。

## 固定来源

| 插件 | 已重新核验的版本 / Git 提交 | 安装与许可 |
|---|---|---|
| dsh-aurabot-qq | 1.1.24 / `e9026a99d9db58974363c416eaa9e555499737fa` | MIT；Git 源码直接入口 `src/host.js`；package 没有安装脚本或依赖；提交包含未发布更改，不能仅凭版本号标识源码 |
| dsh-whale-musume-persona | 0.1.0 / `0fbdcf217e3bf94e35fef36f7ac56134b704529b` | MIT；入口 `lib/index.js` 的 apply 为空；人格在 bundle patch / 旧 preset 中 |
| dsh-nekowhale-stickers | 1.1.1 / `b7b58c0ff347d639fabe87d90d6716c4b3cad185` | npm 预编译 lib；代码 Apache-2.0，资源/知识库 CC BY-NC 4.0 等；保留上游 NOTICE 与 LICENSE-ASSETS |

三个仓库当前 HEAD 均与参考方案中的锚点一致，已通过 GitHub 官方 API 重新读取。Nekowhale npm 1.1.1 tarball 已实际下载，并核验 registry 给出的 SHA-512：

```text
sha512-GJN5I3Kdh2GlRkB9qA0Jp9XZybBEI6T0IXGLdfmYO1AoF0sb8zT/yfrTJMQybtLSzqTSJhe7o3Zfh78GNajhMA==
```

Aurabot Node 要求 `>=22.13.0`；Nekowhale `>=20`，可选 `@napi-rs/canvas` 负责文字/GIF 模板渲染。安装后必须实测中文字体与 native canvas，不将可选依赖安装失败视作模板通过。

来源：[Aurabot package](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/package.json)、[人格 package](https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/0fbdcf217e3bf94e35fef36f7ac56134b704529b/package.json)、[Nekowhale package](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/package.json)、[资源许可](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/LICENSE-ASSETS)、[NOTICE](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/NOTICE)。

## 已确认的兼容缺口

### 1. 人格插件安装不会自动改变 QQ 人格

Aurabot 根据权限创建 `aurabot-private`、`aurabot-private-long` 或 `aurabot-social`。这些 preset 用 `{{aurabot_persona}}` 和 `{{aurabot_rules_private}}` 等变量，变量来自它自己的人格库与用户模块。因此旧人格包把 Web 默认设为 `whale`，不会使 QQ 人格生效；直接照搬其旧 standard 派生 preset 也会带入额外工具。

实现：安装并装载指定人格包的空宿主入口，避免应用它的旧 bundle patch。`adapters/qqai-compat/index.mjs` 从该已安装包的 `cordis.patch.yml` 提取人格内容，用 Aurabot 原生 `persona` 事件替换实际 QQ 人格来源。归一化为单个末尾换行后，来源 SHA-256 必须为：

```text
9969097250f89301d23dffabb3b3dd2a1614cf5e5e0500a389c10c11fa383d7b
```

已明确的小幅本地调整：删除年龄标签“萝莉”、删除强制显露思考过程的句子；替换旧模板中的 model/cwd 占位符；添加可配置姓名、知道自己是 AI、不将虚拟角色动作或未执行工具描述为现实事实。主体鲸鱼娘语气、米饭、尾巴、傲娇与认真工作设定仍取自指定插件，不引入旧人格全文。

`rules` 事件补入 Nekowhale 四工具的使用说明和图片 Markdown 例外。这样即使 DSH `persona.complete: true` 抑制其他静态提示段，实际 Aurabot 规则仍能解释图片工具协议。本轮实际 QQ 会话已核对运行时工具目录，并观察到真实模型成功调用 `sticker_search`、`sticker_send`；用户确认了“大肥鱼”身份和动画 GIF 的实际显示。

来源：[Aurabot presets](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/cordis.patch.yml)、[人格 patch](https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/0fbdcf217e3bf94e35fef36f7ac56134b704529b/cordis.patch.yml)、[人格变量装载](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/host.js)、[用户模块 API](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/modules/API.md)。

### 2. Nekowhale 的默认 loopback 图片链接被 Aurabot 拒绝

Nekowhale `sticker_send` / `meme_render` 返回 `http://127.0.0.1:<DSH端口>/x-nekowhale-stickers/...gif` 的 Markdown 图片。Aurabot 已能解析 Markdown 图片，但其 `sendImage` 调用 `fetchImage`；后者 `assertPublicUrl` 拒绝 loopback。因此当前固定版本的原生组合存在确定缺口，不能仅靠安装宣告图片发送成功。

实现沿用 Aurabot 的拆泡与 base64 发送出口：

1. 用户模块的 `reply/items` 仅接受精确实际 DSH 端口、固定路径和合法 hash 的 Nekowhale 链接：`s/<12位小写hex>.gif` 或 `r/<16位小写hex>.gif`；不接受 query、fragment、userinfo、编码路径、其他 loopback 或外部 URL。
2. 通过 **DSH Cordis 服务** `api.dsh.get('stickers')` 调用 `fileByHash` / `renderPath`。它不是 Aurabot 自带 `api.use('stickers')` 的随机表情库。
3. 真实路径必须位于独立 `stickersDataDir` 的 `packs`、`byhash` 或 `renders` 下，且为普通文件、GIF87a/GIF89a、13 字节至 10 MiB。读取采用有界缓冲区并拒绝读取中大小变化。
4. 转成 `base64://` 后仍由原生 `sendImage` 发送；实际 GIF 字节保持不变。没有把宿主路径发给容器，没有全局放宽 SSRF。
5. `send` 钩子只接受已由本模块登记的一次性 GIF payload，接收者限定当前 owner 私聊。其他本地路径、模型自造 base64、其他公网/内网图片路径均拒绝。媒体失败不输出私人路径或图片内容。

未强加 `sub_type: 1`。本轮用户已确认通过 SnowLuma 实际收到并播放 GIF，且顺序为文字 → 动画 GIF → 文字；当前链路不需要额外修改该字段。随后分别验证了用户入站 PNG 的识别与边数追问，以及中文文字表情的实际接收和可读性；这些通过结论分别来自真实 QQ 测试。[聊天与媒体证据](evidence/20261031-qq-chat-media.json)

来源：[Nekowhale工具与链接](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/index.ts)、[受控缓存服务](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/core/kit.ts)、[Aurabot发送](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/chat/hub.js)、[Aurabot网络读取](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/core/net.js)。

### 3. 只关闭 Shell/文件工具不足以阻止媒体读取宿主文件

Aurabot `fetchImage` 对本地路径默认允许读取。模型输出 `![x](/任意可读文件)` 就会进入读取路径；Nekowhale `meme_render.image` 也接受任意本地图片路径。禁用 bash/fs 工具不会阻止这些路径。

此外 Aurabot 用户模块是异步装载的，模块钩子异常会被上游吞掉，热重载或被禁用时钩子也会消失。这使单纯的用户模块不足以持续保证文件访问边界。

因此实现 `scripts/patch-plugin-media.mjs`，只对已核验源文件打固定补丁，保留原生消息发送流程。本轮另外修复投递结果误报及记忆流水提前消费问题，当前统一校验以下六个文件：

| 固定补丁 | 原始 SHA-256（单个末尾换行归一化） | 修改后 SHA-256 |
|---|---|---|
| Aurabot `src/chat/hub.js`：仅接受 base64 GIF，并按有效回执汇总文字/GIF投递结果 | `63d8df994316a6286428ad53cfc530015c340c57cfb9c556fc08c2576a714caf` | `3c249d4683389f4d6dfafc54ec492d247e7188f573eba6468de02b9ba06750f9` |
| Nekowhale npm `lib/core/image-input.js`：禁用头像文件/URL输入，保留文字模板 | `fccad94722d5e2e10904633a752f7b7418a0184f64d6b1fc22678775d5e235d8` | `ffa783ad1d41c602678d4bfb4468133c4a952dff5cd21a21ae6556c32c4fa25d` |
| Aurabot `src/features/companion.js`：只将编造经历的角度改为明确的联想/虚拟设想 | `6f515141959f0aae8697df8601e35c8fcf32e94be6dece64d487ad526c169400` | `1aa6989025cca29b2050d06dcdfb34057141783c3f7bb946888528d1a952b5ea` |
| Aurabot `src/core/llm.js`：后台 askModel 尊重 cfg.model.reasoningEffort，未配置时为 off | `6f9b89396e08a23d2adfa65e2de50349cbb5ac12f5b67fae1e291e32cbbf66a6` | `5a34b943fc03bf0162fc3c2f795a150d10c2bf2597dea3253c266717bf10724e` |
| Aurabot `src/features/memory.js`：失败或不足的提炼批次保留流水与游标，完整处理分段 | `a024527ee4ac97ef1fbb5b978f421d1e2f4a14f33076347a538b3aa569a515d1` | `cdca6f6956d191426d175254a859142cee5855f60debf4415eea6cc98cddcf52` |
| Aurabot `src/modules/qq-tools/index.js`：未全部确认投递时返回失败，不宣称已发出 | `bfcae29f15c0737cb3be7664fa95fc4132108fbc486bf126302b09a19dd38bf0` | `59a57d510fcb26f3a1a9a70c03c83adf5bf332181c6deaedce29a4441ca79502` |

脚本先验证两个包名、版本、六个源文件完整 hash 和唯一替换点，再写入；每个目标文件只生成一个最终输出。Hub 的升级链为原版 `63d8…` → 首次 GIF 补丁 `13792168e58b88e2acfa6e94520b06c526037ac42a42d7a95aadba6bc7d8392c` → 当前 `3c249…`，允许原版全新安装及已部署 GIF 版本迁移。最终版本重复执行不变；其余源码或版本一律失败。`--check` 要求六个文件均处于最终 hash，已审核的中间版本也不能通过启动检查。升级必须重新评审并更新固定版本，不能绕过 hash 不匹配。投递补丁规格位于 `scripts/qq-delivery-patch-spec.mjs`，部署和恢复时须与安装器一同保留。

头像模板不是本次文字表情验收的前提；若以后开放，必须以已授权 QQ 附件 ID 解析到受控内容，不能恢复任意宿主路径参数。自动化检查已证明这两条入口在模块缺席时仍不会读取模型指定的文件或 URL。

来源：[Nekowhale image-input](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/core/image-input.ts)、[Aurabot模块异常及装载](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/core/modules.js)。

### 4. 投递失败不能向模型报告“发出去了”

固定上游 `sendSegments` 在响应缺少有效 `message_id` 时仍可能增加发送计数；`deliver` 忽略文字/图片发送返回的 `null`，继续把完整回复记为已发送；`qq_send_message` 又对这些返回值默认报告成功。因此工具成功标记和 bot 流水都不能单独证明实际送达。

修复保持原解析、气泡顺序及等待时间：文字/GIF 必须取得有效消息 ID 才计入已确认条数，汇总 `ok/delivered/failed/unverified`；全部失败不写出站活动，部分失败仅记录已确认的内容。当前未启用的语音、原生表情等发送实现未改，无法核实回执的类型标记为未验证。`qq_send_message` 只在全部确认时说明网关已接受消息，其余情况返回 `ok:false`，并提示不要自动重发，以免产生重复消息。网关接受仍不代表用户已经看到，动画、中文字形和气泡体验继续由接收端确认。

当前 `allow.private/groups` 均为空，工具目标仅允许唯一主人；兼容模块的发送钩子再次检查主人私聊。回归覆盖缺失回执、传输失败、dryRun、部分/全部失败、顺序和延迟、白名单拒绝及完整 hash 锁定。[固定 QQ 工具源码](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/modules/qq-tools/index.js)

### 5. 记忆提炼失败或聊天不足时不能丢弃待处理流水

固定上游在提炼失败或不足三条非 bot 消息时仍推进全局游标，历史日还会删除流水；只处理末尾三个分段也会漏掉超过 240 行的旧内容。修复按聊天跨日期累积未处理行，仅推进成功批次的日期/聊天游标；失败、非法模型结果或不足的批次保留原始流水等待重试。真实合法 `[]` 才算成功的空结果，所有分段都须处理，提炼期间新到达的行不随旧快照删除。关闭记忆或每日整理时，14 天兜底清理也只删除已消费完的日流水。

这是基于 Aurabot 原生提炼器的可重试修复，未引入旧记忆层。多段处理前段成功、后段失败时，重试可能再次提炼前段，继续依赖上游相似度去重；不宣称严格只提炼一次。原生长期记忆遗忘策略保持不变。11 项故障注入回归验证保留、重试、跨日不足累积、并发到达和完整分段处理；真实 DeepSeek 自动提炼、纠错和新会话召回仍在验收。[详细步骤与边界](qq-acceptance-procedure.md)、[固定记忆源码](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/features/memory.js)

## 安装接线

DSH 同一普通用户、同一 DSH_HOME/web profile 安装三个指定包。Aurabot 用户模块目录为其私有数据根下 `modules/qqai-compat/`，复制本项目 `adapters/qqai-compat/index.mjs` 到该目录。Aurabot 独立 `config.json` 中增加：

```json
{
  "ext": {
    "qqai-compat": {
      "personaSourcePath": "/ABSOLUTE/INSTALLED/dsh-whale-musume-persona/cordis.patch.yml",
      "stickersDataDir": "/ABSOLUTE/PRIVATE/nekowhale-stickers",
      "botName": "大肥鱼",
      "ownerName": "主人"
    }
  }
}
```

这些是路径占位符，不是已部署目录。`stickersDataDir` 必须与 Nekowhale `config.dataDir` 完全一致，且不能填整个 DSH_HOME。密钥不放入该目录。人格 source hash 不符时模块会关闭 Aurabot 发送总开关并进入 dryRun。

实际固定补丁命令接口：

```bash
node scripts/patch-plugin-media.mjs AURABOT_PACKAGE_DIR NEKOWHALE_PACKAGE_DIR
node scripts/patch-plugin-media.mjs --check AURABOT_PACKAGE_DIR NEKOWHALE_PACKAGE_DIR
```

这些脚本现已实现；只在服务停止的已安装固定包上应用。恢复方式为重新安装相同锁定包，再应用相同补丁；不要把补丁删除后直接恢复 QQ 发送。

新环境初始化已实现为 `scripts/configure-dsh-profile.mjs DSH_HOME WORKSPACE PORT`。可选 QQ 号由 `OWNER_QQ` / `BOT_QQ` 环境变量提供；脚本不读取 API Key。它从已安装 Aurabot 的完整 DEFAULTS 创建受限配置，复制兼容模块，保留同项目已有 QQ 号/OneBot token，重设总发送与主动开关为关闭。它是部署/维护时的初始化操作，会重置配置偏好；不要把它作为每次服务启动命令。

后台检查发现 `askModel` 原先在调用方不传 reasoningEffort 时硬编码 low，未读取 cfg；其模型能力归一化在某些元数据下可能再降为 off，不能依赖这一间接行为。已在统一入口改为读取 cfg 的 off。当前固定 memory/companion 源码无额外显式 low 调用。per-chat 设置不接受 off 时会清空并由 hub 回退全局 off。本轮真实 QQ 聊天请求元数据已确认 Thinking Off；记忆和主动调用仍随各自真实测试核对。

## 启用前配置要求

Aurabot `apply(ctx)` 自己加载独立 config.json，不接受把业务配置塞到 Cordis `id: aurabot.config` 来替代它。

- `gateway: onebot`；SnowLuma 内置 Windows 管理器 `autoStart/autoAttach: false`。
- 保留 owner 私聊，`allow.private/groups: []`；明确 `files.enabled: false`、`longTasks: false`。
- 私聊 preset 原生含 bash/pwsh/fs/fs-search，必须由 profile 完整覆盖 `config.plugins` 白名单；long 额外移除 jobs/schedule。DSH rc.5 patch 是 config 整体替换，不能把嵌套片段当成深度合并。
- `voice.enabled: false`；Aurabot 原生 stickers `enabled/collect: false`，`autoChance: 0`，避免与 Nekowhale 重复选图。
- `diary/qzoneSocial/bili/douyin/heybox/imageGen/song` 关闭；`profilePerms` 各项 `off`。不以默认总开关关闭替代逐项配置。
- 关闭无关内置模块 group-admin、contacts、profile、diary、qzone-social、bili、douyin、heybox、voice、song、imagegen、purpose、pet、stickers；保留 memory、mood、speakup、qq-tools 和本项目兼容模块。
- DeepSeek provider、Aurabot `model.reasoningEffort` 和后台提炼模型均需对应 Thinking Off；不能用默认 low 冒充 off。
- `enabled: false, dryRun: true` 贯穿准备阶段；真实 QQ 身份核对、模块装载和启动前 hash 检查通过后再启用。

来源：[Aurabot默认配置](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/core/config.js)、[权限模型](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/chat/access.js)。

## 原生行为与待验收事项

不迁移旧多气泡规则。Aurabot 原生 `|||`、短文本换行、最多五条文字气泡继续使用；图片顺序由原生 parseReply 保留。记忆继续使用其自身流水、提炼、召回和纠错，不建立旧 L1/L2 兼容层。

主动调度仍由原生 speakup 执行。源码普通主动每天次数与 nudge 不同，nudge 不计普通日次数；默认每分钟 tick、15–40 分钟未答时可能追问。当前人格/规则明确 AI 身份；允许编造现实经历的一个角度已作固定单句替换，调度与计数逻辑没有变化。真实模型效果仍待回归。purpose 不同时启用。

来源：[原生拆泡](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/chat/reply.js)、[主动调度](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/features/companion.js)。

截至本记录：

| 证据层 | 已完成 / 尚待完成 |
|---|---|
| 自动化接口验证 | 首次媒体适配验证覆盖 GIF 字节不变、路径/符号链接拒绝及人格来源。本轮独立复跑机制/媒体 6 项、投递 5 项、记忆 11 项，全部通过且无跳过；故障注入与提供者捕获属于自动化测试，不代表真实模型或 QQ 通过 |
| DSH 与实际 QQ 工具装载 | 三插件与用户模块均已装载；本轮真实 QQ 会话的 10 个工具为 Neko 四工具、web_search/web_fetch、remember/recall_memory、qq_chat_history/qq_send_message。未开放 Shell、宿主文件或 qq_send_file |
| 真实 DeepSeek | 已完成 DSH 中文多轮、人格、Neko 检索/选择/中文模板、Search/Fetch、像素识别与追问；[本地证据](evidence/20261031-dsh-local-api.json)、[视觉证据](evidence/20261031-dsh-local-vision.json)、[服务器证据](evidence/20261031-dsh-server-api.json)。本轮 QQ 观察到的 12 次模型请求均为 Flash / Thinking Off；sticker_search、sticker_send、meme_render、web_search、web_fetch 均实际成功 |
| 真实 QQ 已确认 | 用户确认首轮收到 3 条气泡、没有原始 `|||`，随后多轮上下文及“大肥鱼”身份正确；实际收到文字 → 动画 GIF → 文字，GIF 可播放。另已确认入站 PNG 识别与边数追问、中文文字表情收到且清晰、搜索回答附带来源。工具元数据与接收端确认分别记录于[聊天与媒体证据](evidence/20261031-qq-chat-media.json) |
| 真实 QQ 待验收 | 长期记忆自然提炼/纠错/新会话召回、主动聊天及未回复行为、网关重启恢复、登录后备份恢复和持续运行仍在测试；聊天与媒体通过不等于这些项目通过 |
| 主观体验 | 用户已确认上述气泡和动画表现；长期口吻、自然度及主动频率仍需实际使用评价，无自动化 PASS 可替代 |

复现本地接口验证（路径参数指向受审计的固定上游包）：

```bash
AURABOT_SOURCE_ROOT=/ABSOLUTE/AURABOT WHALE_PERSONA_SOURCE=/ABSOLUTE/PERSONA/cordis.patch.yml node tests/qqai-compat.test.mjs
AURABOT_SOURCE_ROOT=/ABSOLUTE/AURABOT NEKOWHALE_PACKAGE_ROOT=/ABSOLUTE/NEKOWHALE node tests/plugin-media-patches.test.mjs
AURABOT_SOURCE_ROOT=/ABSOLUTE/AURABOT node tests/qq-delivery-results.test.mjs
AURABOT_SOURCE_ROOT=/ABSOLUTE/AURABOT node tests/memory-consolidation.test.mjs
```

未设置来源变量的用例会明确 skip；不能把 skip 当作通过。此次记录使用实际受审计源码路径运行，未跳过任何项。


## 2026-11-01 原生普通主动上限适配

新增第7个固定hash目标 `src/core/config.js`：仅将 `c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, 3, 0, 20)` 的上限改为30；默认值和其他校验不变。原hash `1f6125e7be6f718d3c705d27479487b435b0dcdb36ec2eb74f40b30d784e8deb`，最终hash `0309e40efa56a99a4a381f8055be08af564ce0895b3d845f192f3dce11b23873`。前端 `f.num('speakUp.maxPerDay', { min: 0 })` 已支持30，无需前端改动。

该补丁已纳入 `scripts/patch-plugin-media.mjs` 的安装/幂等/拒绝漂移/启动校验；其余6目标hash保持此前版本锁。实际normalize、面板merge及JSON往返验证保存30不再压回20；原生调度29→30后封顶、40–80排期、双方闲置40、夜间与追问独立规则均回归通过。实际部署和原生排期观察见 `docs/evidence/20261101-proactive-30.json`，不升级插件或替换原生主动引擎。
