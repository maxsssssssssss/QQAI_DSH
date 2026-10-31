# 三插件兼容性核查与已实现适配

核查日期：2026-10-31（Asia/Shanghai）。这是当前上游源码、发行包及本地接口验证记录；本文件不声称完成真实 DeepSeek 或真实 QQ 验收。不引用旧项目人格、记忆、Guard、发送或主动聊天实现。

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

`rules` 事件补入 Nekowhale 四工具的使用说明和图片 Markdown 例外。这样即使 DSH `persona.complete: true` 抑制其他静态提示段，实际 Aurabot 规则仍能解释图片工具协议。工具是否真正可见，仍需最终 DSH Agent 与真实模型请求核验。

来源：[Aurabot presets](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/cordis.patch.yml)、[人格 patch](https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/0fbdcf217e3bf94e35fef36f7ac56134b704529b/cordis.patch.yml)、[人格变量装载](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/host.js)、[用户模块 API](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/modules/API.md)。

### 2. Nekowhale 的默认 loopback 图片链接被 Aurabot 拒绝

Nekowhale `sticker_send` / `meme_render` 返回 `http://127.0.0.1:<DSH端口>/x-nekowhale-stickers/...gif` 的 Markdown 图片。Aurabot 已能解析 Markdown 图片，但其 `sendImage` 调用 `fetchImage`；后者 `assertPublicUrl` 拒绝 loopback。因此当前固定版本的原生组合存在确定缺口，不能仅靠安装宣告图片发送成功。

实现沿用 Aurabot 的拆泡与 base64 发送出口：

1. 用户模块的 `reply/items` 仅接受精确实际 DSH 端口、固定路径和合法 hash 的 Nekowhale 链接：`s/<12位小写hex>.gif` 或 `r/<16位小写hex>.gif`；不接受 query、fragment、userinfo、编码路径、其他 loopback 或外部 URL。
2. 通过 **DSH Cordis 服务** `api.dsh.get('stickers')` 调用 `fileByHash` / `renderPath`。它不是 Aurabot 自带 `api.use('stickers')` 的随机表情库。
3. 真实路径必须位于独立 `stickersDataDir` 的 `packs`、`byhash` 或 `renders` 下，且为普通文件、GIF87a/GIF89a、13 字节至 10 MiB。读取采用有界缓冲区并拒绝读取中大小变化。
4. 转成 `base64://` 后仍由原生 `sendImage` 发送；实际 GIF 字节保持不变。没有把宿主路径发给容器，没有全局放宽 SSRF。
5. `send` 钩子只接受已由本模块登记的一次性 GIF payload，接收者限定当前 owner 私聊。其他本地路径、模型自造 base64、其他公网/内网图片路径均拒绝。媒体失败不输出私人路径或图片内容。

暂不默认强加 `sub_type: 1`：实际 SnowLuma GIF 显示需验证；如果网关需要该字段，再以真实结果作针对性调整。

来源：[Nekowhale工具与链接](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/index.ts)、[受控缓存服务](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/core/kit.ts)、[Aurabot发送](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/chat/hub.js)、[Aurabot网络读取](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/core/net.js)。

### 3. 只关闭 Shell/文件工具不足以阻止媒体读取宿主文件

Aurabot `fetchImage` 对本地路径默认允许读取。模型输出 `![x](/任意可读文件)` 就会进入读取路径；Nekowhale `meme_render.image` 也接受任意本地图片路径。禁用 bash/fs 工具不会阻止这些路径。

此外 Aurabot 用户模块是异步装载的，模块钩子异常会被上游吞掉，热重载或被禁用时钩子也会消失。这使单纯的用户模块不足以持续保证文件访问边界。

因此另实现 `scripts/patch-plugin-media.mjs`，只对已核验源文件打固定补丁，不重写消息发送器。另两处单行改动修正主动提示与后台模型配置：

| 固定补丁 | 原始 SHA-256（单个末尾换行归一化） | 修改后 SHA-256 |
|---|---|---|
| Aurabot `src/chat/hub.js`：sendImage 只接受 base64 GIF，不解析任何路径/URL | `63d8df994316a6286428ad53cfc530015c340c57cfb9c556fc08c2576a714caf` | `13792168e58b88e2acfa6e94520b06c526037ac42a42d7a95aadba6bc7d8392c` |
| Nekowhale npm `lib/core/image-input.js`：禁用头像文件/URL输入，保留文字模板 | `fccad94722d5e2e10904633a752f7b7418a0184f64d6b1fc22678775d5e235d8` | `ffa783ad1d41c602678d4bfb4468133c4a952dff5cd21a21ae6556c32c4fa25d` |
| Aurabot `src/features/companion.js`：只将编造经历的角度改为明确的联想/虚拟设想 | `6f515141959f0aae8697df8601e35c8fcf32e94be6dece64d487ad526c169400` | `1aa6989025cca29b2050d06dcdfb34057141783c3f7bb946888528d1a952b5ea` |
| Aurabot `src/core/llm.js`：后台 askModel 尊重 cfg.model.reasoningEffort，未配置时为 off | `6f9b89396e08a23d2adfa65e2de50349cbb5ac12f5b67fae1e291e32cbbf66a6` | `5a34b943fc03bf0162fc3c2f795a150d10c2bf2597dea3253c266717bf10724e` |

脚本先验证两个包名、版本、源文件完整 hash 和唯一替换点，再写入。已打补丁时可重复执行；未知源码/版本一律失败。`--check` 只校验补丁存在，缺失即失败，应作为服务启动前置检查。升级必须重新评审并更新固定版本，不能自动绕过 hash 不匹配。

头像模板不是本次文字表情验收的前提；若以后开放，必须以已授权 QQ 附件 ID 解析到受控内容，不能恢复任意宿主路径参数。自动化检查已证明这两条入口在模块缺席时仍不会读取模型指定的文件或 URL。

来源：[Nekowhale image-input](https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/core/image-input.ts)、[Aurabot模块异常及装载](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/core/modules.js)。

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

后台检查发现 `askModel` 原先在调用方不传 reasoningEffort 时硬编码 low，未读取 cfg；其模型能力归一化在某些元数据下可能再降为 off，不能依赖这一间接行为。已在统一入口改为读取 cfg 的 off。当前固定 memory/companion 源码无额外显式 low 调用。per-chat 设置不接受 off 时会清空并由 hub 回退全局 off；真实 DeepSeek 测试仍须核对最终请求。

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
| 自动化接口验证 | Node 24.22.2 下两文件共 11 项通过，独立审查者复跑无跳过；包含固定 Aurabot parseReply、真实 npm image-input 编译模块、GIF 字节不变、错误闭合、路径/符号链接拒绝、固定 hash 补丁幂等性；后台 off 的提供者捕获检查是接口测试桩，不是真实 API |
| 本地 DSH 三插件运行 | dsh-runtime-audit 子任务已实际装载三插件与用户模块，四种 preset 的 Nekowhale 四工具可见；这一层仍不是通过实际 QQ hub 创建的会话，不替代真实 QQ 验收 |
| 真实 DeepSeek | 此子任务未执行；需验证普通聊天、真实工具调用、Thinking Off、图像像素输入 |
| 真实 QQ | 此子任务未执行；需验证多气泡、人格、PNG输入与追问、Nekowhale GIF/中文模板真发、记忆/纠错/新会话召回、定时主动、未回复、重启恢复 |
| 主观体验 | 需由用户在真实会话中评估语气与自然度；无自动化 PASS 可替代 |

复现本地接口验证（路径参数指向受审计的固定上游包）：

```bash
AURABOT_SOURCE_ROOT=/ABSOLUTE/AURABOT WHALE_PERSONA_SOURCE=/ABSOLUTE/PERSONA/cordis.patch.yml node tests/qqai-compat.test.mjs
AURABOT_SOURCE_ROOT=/ABSOLUTE/AURABOT NEKOWHALE_PACKAGE_ROOT=/ABSOLUTE/NEKOWHALE node tests/plugin-media-patches.test.mjs
```

未设置来源变量的用例会明确 skip；不能把 skip 当作通过。此次记录使用实际受审计源码路径运行，未跳过任何项。
