# QQAI 从零重建：DSH + Aurabot + 鲸鱼娘人格 + Nekowhale 表情包

研究日期：2026-10-31。性质：公开文档与源码审查、实施计划和 Codex 交接；本轮未连接 VPS、安装软件、重启或删除数据。

## 1. 决策摘要

建议把此次任务作为真正的新系统安装，而非继续扩展旧 AstrBot 项目：

```text
用户主 QQ ⇄ 机器人 QQ 小号
                 ⇅
       SnowLuma 官方 Linux Docker
                 ⇅ OneBot v11 正向 WebSocket
          DSH Web + Aurabot
             ├─ 鲸鱼娘人格插件：人格内容来源
             ├─ Nekowhale：表情检索、资源、模板
             └─ Aurabot 原生聊天、记忆、心情、主动与发送
```

最终范围必须包含三个指定插件的实际安装、装载与 QQ 侧生效，不以“只安装 Aurabot、另外两个以后再说”交付。顺序安装用于定位兼容问题，不缩减最终范围。

旧 AstrBot、PrivateCompanion、MemoryCompanion、Guard 不再运行，不把旧发送器、记忆表结构、主动决策协议或复杂发布门禁迁进来。只允许必要的版本与插件接口薄适配。

技术可行性有官方 Linux/Web/OneBot 文档支持；完整版本组合尚未在用户 VPS 实机验证，不能写成已经开箱即用。[S1][S2][S3]

## 2. 本次核对的版本锚点

| 组件 | 本次读到的版本／提交 | 使用方式 |
|---|---|---|
| DSH npm | latest/next 为 0.2.1-rc.5；alpha 为 0.2.2-alpha.2 | 0.2.1-rc.5 作为初选，安装前重查 npm 元数据；不要误把主分支 alpha 当已验证发行版 |
| Aurabot | package.json 1.1.24；main e9026a99d9db58974363c416eaa9e555499737fa | 记录 commit、安装包与依赖锁；CHANGELOG 中仍有“未发布”条目 |
| Whale persona | 0.1.0；main 0fbdcf217e3bf94e35fef36f7ac56134b704529b | 旧式 preset/patch 要按所选 DSH 版本适配 |
| Nekowhale | package.json 1.1.1；main b7b58c0ff347d639fabe87d90d6716c4b3cad185 | npm 成品优先；README 图片版本号不能代替 package.json |
| SnowLuma | 最新 release v2.2.1，含 Linux x64/arm64 | 采用实际可取得的官方镜像，并核对镜像内版本与 digest；不能由 release 存在推断同名镜像一定存在 |
| 旧 QQAI | 84f6988564b312a5ea12f0412bc81cf538dd87bd | 仅作为旧工程归档锚点，不作为新系统运行依赖 |

这些版本是调研锚点，不是已经验证通过的组合。执行时先确定一个可运行组合，再固定版本；不要在同一次验收中自动追着 main 升级。[S4][S5][S6][S7][S8]

DSH 当前源码 package.json 的 Node 要求为 >=24.9.0，Aurabot 为 >=22.13.0，Nekowhale 为 >=20。宿主 Node 按最终安装的 DSH npm 包 engines 核实，初选满足要求的 Node 24 LTS。SnowLuma 容器自带运行时，其 Lite 包的 Node 要求不要与宿主混为一谈。优先预构建 DSH 包，不在 4 GB VPS 编译整个 DSH monorepo。[S4][S5][S7]

## 3. 网关选择及许可边界

### 3.1 SnowLuma 作为首选技术路线

作者提供 Linux 官方 Docker 部署，镜像包含 Linux QQ、Xvfb、VNC/noVNC、supervisord。Aurabot 在 Linux 使用“连接已有 OneBot”模式，而不是插件内 Windows SnowLuma 启动／注入管理器。[S1][S2]

建议 DSH 直接以专用普通用户运行于宿主；SnowLuma 在 Docker 内运行。这样 DSH 可连接映射到宿主 loopback 的正向 WS，避免不必要的跨容器媒体访问问题。

SnowLuma 文档所列默认服务：6081/noVNC、5099/WebUI、3000/HTTP、3001/WS。宿主映射应限制为 127.0.0.1，管理通过 SSH 隧道。容器内服务为接收端口映射可监听 0.0.0.0；不要把这与向公网开放混淆。

官方要求 shm_size 1gb、SYS_PTRACE 与 seccomp=unconfined，用于 QQ/注入。1 GB 共享内存配置不是固定物理内存占用；不再额外开 privileged、挂宿主 Docker socket 或将 DSH 运行用户加入不必要的管理组。[S2]

没有证据证明换 SnowLuma 会改善模型人格，或者比 NapCat 更不容易被封。选择它是为了与 Aurabot 上游路径接近，而非性能或账号风控保证。

### 3.2 Lunabot 名称尚不唯一

公开同名 LunaBot-QQbot 有基于 NapCat 的上层聊天机器人，不应当作 NapCat 的同层替代品。LLBot/LuckyLilliaBot 则是支持 Linux/Docker 和 OneBot 11 的另一种网关。未取得用户所说 Lunabot 的精确链接前，不声称已经比较了同一个项目。[S9][S10]

### 3.3 SnowLuma 的自动安装许可需要核实

SnowLuma v2.2.1 EULA §5.4 对自动化脚本部署、第三方打包等列有额外书面授权要求；另一方面，作者官方 Docker 仓库提供安装脚本与 Compose。当前研究不能替作者解释两者如何覆盖“个人使用 Codex 自动执行官方部署”的情形。[S11][S12]

执行前记录所用官方发行物及其许可。不要制作并公开分发含其专有组件的自定义整合镜像，不把接受 EULA 的布尔开关当成已经取得额外书面授权。需要时由用户核实许可或完成作者支持的安装环节；不得通过改名、隐去条款绕过。这个待确认项只影响网关安装方式，不妨碍 DSH 和三个插件的准备与适配。

## 4. 三插件职责与关键适配

### 4.1 Aurabot：唯一 QQ 会话与发送所有者

原生实现包含 QQ 接入、连续输入合并、多气泡、图片输入、人格、心情、人物档案、记忆检索与整理、主动联系、管理面板和用户扩展模块。

实际多气泡解析采用 `|||`，普通短文本还会按换行拆分，文字气泡最多 5 条，多余并入末条；Markdown 图片能解析为 image 项。先使用这套原生机制，不搬旧 V4 切句器。[S13]

记忆主要为本地索引与 BM25/中文二元切词，结合重要度、人物关联与遗忘权重；已有档案、记忆整理、过时事实处理。它不等同于旧项目的 L1/L2 数据库，也不自动保证所有事实完整列举或跨天纠错准确。先测原生能力，再按具体缺陷调整，不预先再造记忆层。[S1][S14]

原生主动搭话按空闲和随机时间安排，通过同一 QQ 会话让模型生成或沉默。源码的一个话题角度允许编造符合人设的生活片段；这与小鲸原先的 AI 自知要求冲突。第一版建议只替换该明确冲突：允许脑洞、联想、虚拟设想，但不把它们描述成真实发生的生活／工具经历。某些未回复追问不占普通每日次数，不能把原生计数字段机械当成旧版发送尝试账本。[S15]

CHANGELOG 的“未发布”部分有默认关闭的 purpose 目的引擎，作者建议与普通主动搭话互斥。先完成一种模式；不双开，也不再引入旧主动调度器。[S16]

### 4.2 Whale persona：必须接入 Aurabot 实际 QQ preset

插件提供鲸鱼娘口吻及保留编码能力的人格内容，不负责 QQ、记忆或主动调度。其宿主入口 apply 为空，主要作用通过 cordis patch 和旧式 whale preset 实现。[S6][S17]

关键事实：Aurabot 显式创建 `aurabot-private`／`aurabot-private-long`／`aurabot-social` 会话，并使用 `{{aurabot_persona}}`、`{{aurabot_rules_private}}` 等；因此仅把 DSH 新会话默认改为 whale，不保证 QQ 人格变化。[S18][S19]

实施优先顺序：

1. 安装人格插件，保留来源与版本。
2. 从安装包提取其实际人格内容，用 Aurabot 人格库或 `persona` 扩展钩子作为 QQ 的人格来源。
3. 保留 Aurabot 的 QQ 工具、分段与媒体规则，以及 compaction/Web 能力。
4. 按当前 DSH 的 schema 适配旧版 text/prefix/preset 配置。不要把整个旧 standard 派生 preset 覆盖进 Aurabot。
5. 保证一个实际人格来源，不将 Aurabot 原人格、V0.4 和鲸鱼娘三份互相冲突的全文叠加。
6. 在真实 QQ 对应会话、普通回复和主动分支都验证最终人格注入。

Aurabot 默认模板强调“是真人”，鲸鱼娘插件则有米饭、摇尾巴、固定自称等角色元素。保留用户已有“小鲸、畅、知道自己是 AI”的基本身份作为小幅本地覆盖，不偷换成旧版 V0.4 全文，也不追加大段旧行为规章。角色梗可以保留；年龄标签、真实身份与口吻差异应在配置摘要中明示。[S20][S17]

### 4.3 Nekowhale：先尝试原生 Markdown 图片链路

其能力为标注表情库、情绪/场景检索、表情管理、GIF 资源与本地模板。工具包括 sticker_search、sticker_send、meme_render、sticker_manage；Cordis 提供 stickers 服务。[S7][S21]

`sticker_send` 返回 Markdown 图片文本，并不直接调用 OneBot 发 QQ。Aurabot 已原生支持 Markdown 图片，并在自身进程中读取图片、转换 base64 后发送，所以先验证原生组合，而非预先重写媒体发送。[S19][S21]

必须核对：

- 四个工具在 Aurabot 的实际 QQ Agent 中可见，而不只是普通 DSH Web 会话。
- 返回的本地文件／loopback 图片路由能被 Aurabot 进程读取；web cookie/Host 限制是否影响内部抓图。
- SnowLuma 收到的是实际图片数据，不是它容器看不到的宿主路径。
- QQ 显示真实 GIF／表情，必要时仅对该资源添加已验证的 OneBot 表情字段。
- `[sticker:…]`（Nekowhale 可选标记）与 `<sticker:…>`（Aurabot 原生标记）不同。优先使用已通的 Markdown 路线；确需转换时仅做小适配。
- Aurabot 自带的随机配表情与 Nekowhale 工具选择不要重复配图；保留一个选择流程和一个发送出口。
- meme_render 的 native canvas 可选依赖及中文字体真实可用，不能仅文字检索通过就称模板成功。

适配放在 Aurabot 数据目录的用户 modules/，利用 persona、reply/items、send 等既有扩展点；不修改全部上游核心。注意 Aurabot 内部 `api.use('stickers')` 和 DSH 的 Cordis stickers 服务不是同一个注册表。[S22]

Nekowhale 代码 Apache-2.0，知识库/资源另有 CC BY-NC 4.0 等说明；保留署名与 NOTICE，不默认取得收费再分发权。[S7][S23]

## 5. 清空服务器的正确范围

用户已明确选择重建，计划不要求双栈长期并行。建议以腾讯云轻量控制台重装 Ubuntu 24.04 x86_64 系统镜像完成真正清空，不以 SSH 下删除系统目录代替。[S24]

旧仓库当前已确认提交 84f6988；提交说明明确排除了 runtime data、raw evidence 和 private audits。因此 GitHub push 只能证明代码已保存，不能证明聊天、长期记忆、密钥、登录态已备份。

清空前只做一次离机保留清单，不无限扩大旧项目验收：

- 在本地核对代码已拉到指定提交。
- 将用户准备保留的 L1/L2 初始资料、人格文件单独导出到私有位置；是否导入新系统另行列清楚。
- 确认 API Key 仍可从受保护位置取得、本地 PEM 仍可用；不要把密钥写进 Git 或报告。
- 旧聊天、候选、缓存可以选择不迁移；明确放弃的内容无需强制完整迁移。
- 需要快照时，应为云快照或已验证的离机副本，不是在即将清空的系统盘上留一个 backup 目录。
- 重装属于敏感操作：执行时核对实例与删除范围；若 Codex 只有 SSH 而无云控制台/API 授权，控制台重装由用户完成。

腾讯云文档说明系统盘会清空、公网 IP 不变；若另有数据盘，则不会自动清空而需单独核对。重装后通过控制台核对新的 SSH 主机指纹，再更新 known_hosts；不全局关闭主机校验。[S24]

## 6. 按顺序实施

| 阶段 | 实施工作 | 完成标准 |
|---|---|---|
| 0 预备 | 确认上游版本/下载可达性、Snow 许可安装边界、旧资料离机清单 | 版本和数据范围明确，不需要先重测旧系统 |
| 1 重装 | 控制台重装 Ubuntu，恢复 SSH、时区、基础工具、普通运行用户 | 新系统可管理，旧机器人不再自动启动 |
| 2 网关 | 按确认的官方方式安装 Snow Docker、登录 QQ、启用正向 WS/HTTP | 明确 bot 身份，真实收发，重启登录态可恢复 |
| 3 DSH | 安装已发布 DSH、同一用户 web profile、配置官方模型 API、systemd 持久服务 | Web、真实模型、工具循环可用；退出 SSH 后仍运行 |
| 4 Aurabot | 安装、外部 OneBot 模式、主号设置、试运行、文本和看图 | 真实 QQ 普通聊天/多气泡/图片可用 |
| 5 人格 | 安装鲸鱼娘插件并适配 Aurabot 人格来源 | QQ 实际请求中生效，不只 Web 默认会话生效 |
| 6 表情 | 安装 Nekowhale，原生 Markdown 发图优先，必要时薄适配 | 来自指定库的真实表情/GIF和模板到达 QQ |
| 7 记忆主动 | 原生记忆/心情/主动搭话，核对模板、开关及日计数语义 | 自动记忆、纠错、新会话/重启召回与真实主动联系有证据 |
| 8 完整交付 | 三插件同时运行回归、断连/重启检查、备份恢复、维护说明 | 完整新系统可使用；保留明确未验证项 |

建议部署形态：DSH 宿主 systemd，Snow Docker Compose，全部持久目录明确归属。4 GB 可作为一个 QQ 账号、远程模型推理、基础图片和表情的起点；这是估算，必须测真实峰值。不要首轮同时上浏览器自动化、本地语音模型和完整源码构建。常用功能若仍内存吃紧再按测量升级，不事先保证所有功能都装在 4 GB 内。

## 7. 初始配置建议

- 机器人名小鲸，主人显示名畅，仅机主私聊；群白名单空。
- 模型沿用已选 DeepSeek Flash / Thinking Off，核对 DSH 模型元数据和最终请求。Aurabot 源码默认 reasoningEffort=low，不能把 Low 当 Off。[S25]
- 普通多气泡、记忆和心情先采用 Aurabot 原生，不迁移旧 160 字/四泡规则。
- 主动时间按用户生活时区 Asia/Shanghai；频率通过原生面板设置，先解释计数语义与 nudge 是否计入，不照抄旧96次评估字段。
- QQ文字、图片、Nekowhale表情是首轮必需。
- 语音、克隆、RVC翻唱不是三插件安装成功的前置条件；RVC上游当前写明Windows-only。[S1]
- 在开启总发送之前关闭不在本次范围的空间日记、空间评论/点赞、B站/抖音/小黑盒外部写动作。部分子开关默认开启，不能因总开关初始关闭就忽略。[S25]
- DSH普通用户运行，工作区与密钥分开；保留技术讨论/工作区编码能力，不默认允许破坏整个宿主或对外发私密文件。
- DSH Web、noVNC、Snow WebUI、OneBot不上裸公网，SSH隧道管理。不要将附带启动token的URL粘进公开报告。[S26]

## 8. 实际验收清单

安装、装载、QQ实际生效三个状态分别记录。必要真实测试充分执行，不为节约Token缩减，不用空的PASS数字代替实际链路。

1. 同一用户的三个插件均已安装，重启后注册成功。
2. QQ会话使用Aurabot preset，但最终人格来自指定鲸鱼娘插件及小范围本地覆盖。
3. 真实普通闲聊、连续输入、多气泡和长技术回答；未残留|||或控制标签。
4. 真实上传图片、截图及追问，实际像素进入所选模型。
5. 模型真实调用Nekowhale搜索和选择，QQ收到对应资源，而非Aurabot原生随机库冒充。
6. GIF实际动起来；至少一个中文模板meme_render成功；媒体与文字顺序正确。
7. 同时加载三个插件后，没有重复工具注册、相同消息双发和人格互相覆盖。
8. 记住合成测试事实、自动整理、纠错、新会话和服务重启后召回；用户资料与角色表达归属不混。
9. 主动搭话无需每次用户先说话；暂停有效，未回复后行为与配置一致。保留真实调度证据，不以手动fire代替全部测试。
10. DSH与网关分别重启、断开后恢复；不会批量重发旧消息。
11. 凭据、端口、资源峰值和备份/恢复验证完成。
12. 输出代表性真实成功/失败内容，用户评价风格；不以HTTP200宣布自然度通过。

不预设几百项新自研测试，也不为一条偶发不自然回复重写底层。优先跑上游测试与少量有针对性的接口回归，真实链路有失败就定位修复后复验。

---

# 附录 A：给 Codex 的重建主任务

你负责把这套QQ陪伴系统从旧AstrBot工程切换为全新DSH方案。最终必须安装并实际适配这三个指定插件：

- accomplish07zrh-eng/dsh-aurabot-qq
- Kaalia0912/dsh-whale-musume-persona
- Loping151/dsh-nekowhale-stickers

首选网关为SnowLuma官方Linux Docker。不能继续沿用旧AstrBot/PrivateCompanion/MemoryCompanion/Guard，也不能只安装Aurabot就宣称三插件任务结束。

## 工作方法

先读本文件和最新上游文档。以上游原生安装、配置和扩展点为主，原生能通就不写代码；确有兼容缺口再写薄适配。不要重建旧项目的复杂发布门禁、语义分段系统、记忆层或第二套主动调度。

先做安装前准备，整理唯一版本清单、离机资料清单和主机重装步骤。在清空节点核对目标实例及已保留/放弃的数据；没有明确该节点授权时不自行删除。用户完成控制台重装或提供相应授权后，自动继续所有普通安装和联调，不每完成一个包就询问下一步。首次QQ扫码、验证码、密钥录入和未解决许可确认交给用户，其他技术故障自行定位。

用户允许必要的真实模型和工具测试，不得为了省钱减小原定测试额度；先确保测试对象与输出范围正确，不向其他联系人或公共平台批量发送测试内容。不需要额外购买资源时不要反复审批普通安装动作。

## 必须处理的集成点

1. 选用一个实际可安装的DSH发行版，记录npm版本与engines、三个插件commit/package版本、Snow镜像digest及内置版本。不要把master alpha和npm latest混用；不要静默豁免不兼容插件版本。
2. 同一普通运行用户、同一HOME/DSH_HOME/web profile管理全部插件；服务进程不能指向另一份空配置。
3. Snow使用作者支持的Linux安装方式。EULA自动部署条款和官方Docker文档的适用范围需记录、必要时澄清，不将专有组件重新打包公开发布，不自动代用户接受许可。许可节点未解决时先完成其余安装准备。
4. Aurabot使用外部OneBot正向WS模式；正确区分宿主loopback与容器内部监听地址。只运行一个网关/机器人响应所有者。
5. 安装并保持鲸鱼娘插件为人格来源，使用Aurabot人格库或persona钩子接入实际QQ preset，保留其工具和消息协议。不要把whale设成Web默认就算完成；不叠三份人格全文。
6. 先测试Nekowhale工具→Markdown图片→Aurabot现有image发送链路；能直接通不加适配。确认QQ Agent工具可见性、图片鉴权/地址、GIF样式与模板中文字体。确需补充时放用户module，不改写发送核心。
7. 保留小鲸知道自己是AI、称呼畅等已确认身份。上游主动模板中允许编造现实经历的句子是明确差异，应做小范围修正；不为此添加庞大过滤系统。
8. Aurabot原生记忆/心情/主动先用起来，purpose与普通主动互斥。不得未经确认照搬旧96次机会/144次请求等非对应字段。
9. 上线前核对子开关：空间发帖评论、第三方平台写操作、语音克隆等不因安装三插件自动获准。模型Thinking实际保持用户已选Off，不把默认low当作已符合。
10. 完成同一最终版本的真实收发、表情、图片、记忆、主动、重启与恢复验证。报告区分源码推断、Mock、真实API、实际QQ和用户自然度。

## 交付

交付新项目目录/仓库、可复现安装配置、服务与端口说明、版本锁、少量适配模块、真实测试结果、私有数据路径、恢复方式、升级操作及已知限制。密钥、QQ登录态、用户档案、私聊和完整模型请求不得进入Git。

不要停在“插件下载完成”。最终目标是：腾讯云上的新系统离开本地电脑仍可运行，三个指定插件在同一QQ私聊链路真正生效，用户可以直接开始使用。

---

# 附录 B：官方命令入口（不是已验证的一键脚本）

安装前核查：

```bash
npm view @deepseek-ai/dsh dist-tags --json
npm view @deepseek-ai/dsh@0.2.1-rc.5 engines --json
npm view dsh-nekowhale-stickers@1.1.1 engines dist.integrity --json
```

上游插件安装命令形态：

```bash
dsh plugin --profile web add github:accomplish07zrh-eng/dsh-aurabot-qq
dsh plugin --profile web add github:Kaalia0912/dsh-whale-musume-persona
dsh plugin --profile web add dsh-nekowhale-stickers
```

正式安装按验证后的版本或提交固定，并保存profile依赖锁。安装源码包是否需要构建、旧preset注册如何适配，由所选DSH实际CLI和schema确认。不盲目套用未经核实的Git ref参数，也不因插件管理器退出0就认为QQ功能已接通。

DSH Web的实际启动与服务参数以该版 `dsh --profile web --help` 为准。使用持久systemd服务，不依赖SSH终端保持打开。

# 原始来源

以下为本次读取的上游文档、源码与官方说明；动态URL内容可能继续变化。

[S1] Aurabot README：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/main/README.md
[S2] SnowLuma官方Docker指南：https://snowluma.github.io/zh/docs/guide/deploy/docker
[S3] DSH Web指南：https://deepseek-harness.github.io/deepseek-harness/guide/quickstart
[S4] DSH包与版本：https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions ；源码环境：https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json
[S5] Aurabot版本：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/package.json
[S6] Whale persona README/版本：https://github.com/Kaalia0912/dsh-whale-musume-persona/tree/0fbdcf217e3bf94e35fef36f7ac56134b704529b
[S7] Nekowhale版本：https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/package.json
[S8] SnowLuma发行版：https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.1
[S9] 同名LunaBot：https://github.com/junhao3353/LunaBot-QQbot
[S10] LLBot官方：https://luckylillia.com/
[S11] SnowLuma EULA：https://github.com/SnowLuma/SnowLuma/blob/v2.2.1/EULA.md
[S12] SnowLuma Docker框架：https://github.com/SnowLuma/SnowLuma.Docker.Framework
[S13] Aurabot分段与媒体解析：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/chat/reply.js
[S14] Aurabot记忆：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/features/memory.js
[S15] Aurabot心情/主动：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/features/companion.js
[S16] Aurabot变更记录：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/CHANGELOG.md
[S17] Whale persona patch/入口：https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/0fbdcf217e3bf94e35fef36f7ac56134b704529b/cordis.patch.yml ；https://github.com/Kaalia0912/dsh-whale-musume-persona/blob/0fbdcf217e3bf94e35fef36f7ac56134b704529b/lib/index.js
[S18] Aurabot presets：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/cordis.patch.yml
[S19] Aurabot实际QQ会话及发送：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/chat/hub.js
[S20] Aurabot默认人格：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/personas/dafeiyu.md
[S21] Nekowhale工具与图片链接：https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/src/index.ts
[S22] Aurabot扩展接口：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/modules/API.md
[S23] Nekowhale README与许可：https://github.com/Loping151/dsh-nekowhale-stickers/blob/b7b58c0ff347d639fabe87d90d6716c4b3cad185/README.md
[S24] 腾讯云轻量重装系统：https://cloud.tencent.com/document/product/1207/44576
[S25] Aurabot配置默认值：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/e9026a99d9db58974363c416eaa9e555499737fa/src/core/config.js
[S26] DSH Web远程访问与鉴权：https://deepseek-harness.github.io/deepseek-harness/guide/public-deployments
[S27] 旧QQAI最新提交：https://github.com/maxsssssssssss/QQ_AI_Companion/commit/84f6988564b312a5ea12f0412bc81cf538dd87bd
