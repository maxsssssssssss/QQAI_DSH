# 运行与后续验收

实际基线为用户最终选择的 Ubuntu 26.04 LTS x86_64、Node 24.22.2。服务器首次主机指纹由用户经腾讯云控制台独立确认；后续始终使用项目专用 known_hosts 严格校验。重装或主机密钥改变时必须重新走控制台核实，不删除检查或盲目接受网络自报密钥。

## 运行路径

| 内容 | 路径或名称 |
|---|---|
| 运行用户 | dsh；无sudo或docker组权限 |
| DSH服务 | qqai-dsh.service |
| Node | /opt/qqai-dsh/node-v24.22.2-linux-x64 |
| DSH安装与npm锁 | /opt/qqai-dsh/app |
| 部署源码 | /opt/qqai-dsh/source |
| DSH_HOME | /srv/qqai-dsh/home/.dsh |
| 独立工作区 | /srv/qqai-dsh/workspace |
| Aurabot私有配置、记忆、模块 | DSH_HOME/plugins-data/aurabot |
| 专用提醒任务与回执 | DSH_HOME/plugins-data/aurabot/modules-data/qqai-reminders/reminders.json |
| Nekowhale资源 | DSH_HOME/nekowhale-stickers |
| API凭据 | /etc/qqai-dsh/deepseek-api-key，root:root、0600 |
| Snow管理初始密码 | /etc/qqai-dsh/snowluma.env，root:root、0600 |
| 网关容器 | qqai-dsh-snowluma |
| 备份 | /var/backups/qqai-dsh，root私有 |

systemd 使用 LoadCredential 把 Key 传入运行进程。配置、启动参数、Git和公开证据不含Key。`bootstrap-host.sh` 安装依赖；`install-dsh-profile.sh` 为新部署初始化profile；两者不是在线更新命令。尤其不要在运行中的陪伴系统上重跑初始化器，因为它会重新关闭发送、重置初始选项。升级应先备份、停服务、审核版本及七个文件的hash补丁，再安装锁定依赖并恢复同项目私有配置。当前文件清单、最终hash和Hub已审核中间版本迁移规则见[兼容性记录](plugin-compatibility-audit.md)；须同时保留安装器及其依赖 `scripts/qq-delivery-patch-spec.mjs`。

## 管理与健康检查

```bash
sudo systemctl is-active qqai-dsh.service
sudo python3 /opt/qqai-dsh/source/deployment/healthcheck.py
sudo systemctl restart qqai-dsh.service
sudo docker compose -p qqai-dsh \
  -f /opt/qqai-dsh/source/deployment/snowluma.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.offline.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.ready.compose.yml ps
```

本部署因腾讯云直连Docker Hub失败，使用原官方镜像的离线传输；第二个Compose文件指定已经核实的本地镜像ID并禁止自动拉取，第三个ready文件保持已启用的自动注入。普通恢复和更新须保留这三份文件的顺序，不能只应用自动注入为0的普通模板。镜像版本、manifest/config digest以及离线传输方法见[Snow运行文档](snowluma-runtime.md)。

DSH健康检查用未鉴权RPC返回401确认认证生效，不把未鉴权GET必须返回200当作条件。该检查不等价于模型、QQ连接或主观自然度验收。

完整DSH启动日志包含管理入口token，Snow首次启动日志可能含VNC密码。日志和启动URL属于私有运行数据，不能贴到GitHub问题、聊天或公开报告。启动token在每次DSH进程启动后变化，运维通过SSH读取到本地内存用于登录；不要固化到README。

## SSH隧道

Windows PowerShell可沿用本机已有 `qq-companion-vps` SSH别名和指定PEM。以下只使用项目已验证的主机记录，不新增公网端口：

```powershell
ssh -F "$env:USERPROFILE/.ssh/config" `
  -o "UserKnownHostsFile=C:/Codex/QQAI_DSH/.private/known_hosts" `
  -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes `
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
  -N -L 127.0.0.1:3080:127.0.0.1:3080 `
  -L 127.0.0.1:5099:127.0.0.1:5099 `
  -L 127.0.0.1:6081:127.0.0.1:6081 qq-companion-vps
```

本机3080用于DSH，5099用于Snow WebUI，6081用于noVNC。DSH仍需当前进程的管理token，Snow/VNC仍需受保护的随机密码。需要接入时由运维准备本机入口与私有凭据文件，不能为省去登录步骤开放公网或关闭认证。

## QQ接入与后续验收

2026-10-31，用户完成官方协议确认和QQ登录；主人私聊的中文多气泡、上下文与人格、动画GIF顺序、入站PNG识别与追问、中文文字表情、搜索和Fetch均已有真实QQ证据。聊天媒体阶段12次已观察模型请求均为Flash / Thinking Off。[聊天与媒体证据](evidence/20261031-qq-chat-media.json)

随后13:39原生定时器完成真实自然记忆提炼，整理时间恢复04:00/16:00。用户跳过纠错并一度停止后续测试，之后授权登录后备份、恢复检查及主动配置。15:10登录后快照、隔离提取和离机校验已完成；自动注入已配置并验证，但QQ自动在线仍失败。用户要求停止网关重启和自动登录排查。之后在[小黑盒接入](heybox-reader.md)时用户完成普通登录，当前OneBot连接和机器人身份已核对；这一人工登录不改变无人值守恢复未通过的结论。[此前恢复证据](evidence/20261031-recovery-proactive.json)

下面的完整步骤仅作未来参考，不是本轮继续执行或已经通过的清单。新会话长期记忆召回、主动实际行为、长期运行等仍分别记录验收边界。

1. 用户已经确认取得SnowLuma权利人对本次自动部署的书面授权；官方WebUI内EULA与隐私协议的个人阅读/接受状态单独处理，不伪造该记录。
2. 用户在noVNC完成机器人QQ扫码及任何设备验证。不得代替验证或重复绕过平台限制。
3. 用户确认机器人QQ身份和唯一主人QQ号。把号码写进私有Aurabot配置，不进Git。群白名单保持空；只开放机主私聊。
4. 工程师确认OneBot token配置、用户模块已加载、所有hash补丁与实际QQ会话工具清单正确，然后才开启Aurabot真实发送；保持其他平台发帖、文件发送、语音和头像文件输入关闭。
5. 在真实QQ测试多轮/多气泡、人格、合成长期记忆与纠错、跨会话召回、图片及追问、Neko图/GIF/中文模板、搜索和Fetch。模型工具成功不代替QQ收到图片。
6. 原生主动配置现已按用户要求启用，具体值见下节；purpose保持关闭。真实行为应以原生调度验证，不能只手工触发一次代替。
7. 登录后再分别重启DSH和网关，验证QQ重连、无重复发送与登录态恢复；更新备份并做隔离恢复演练。确认观察窗口中的资源与错误情况后，再记录长期运行结果。

独立自动化/真实API测试使用合成数据。运行目录可能保留名为qqai-synthetic的验收会话；这些是本项目新测试记录，不是旧项目迁移数据。真实QQ测试另有接收端确认及筛选后的运行元数据，公开证据不含私人聊天正文或账号标识；上述合成会话仍不替代Aurabot长期记忆验收。

## 网关自动注入与当前登录限制

当前容器已使用 `SNOWLUMA_HOOK_AUTOLOAD=1`。第三份 `deployment/snowluma.ready.compose.yml` 已应用，沿用同一官方镜像和三个命名卷。受控冷启动已证明QQ进程自动启动、Hook自动注入并连接；这些进程状态不等于QQ账号已经在线。

三次冷启动均未完成QQ自动在线，包括用户确认勾选QQ原生“自动登录”并登录之后的再次重启。用户已停止这项排查；之后又为小黑盒接入完成普通登录，目前连接恢复。用户第二次亲自登录后，保持运行的同一个DSH进程曾自动重连；62条近期QQ历史、143条DSH记录保留，记忆和会话哈希一致，限定观察窗口内未出现新消息或重复消息。这证明该窗口的数据保全和登录后的连接恢复，不证明无人操作的QQ自动恢复或长期无重复保证。

未来另行维护需先确认无模型回合或发信在途；若需重建，使用完整三文件命令并保留原三卷，不能运行down -v。下面是后续维护命令，不是在用户停止排查后继续执行的要求：

```bash
sudo docker compose -p qqai-dsh \
  -f /opt/qqai-dsh/source/deployment/snowluma.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.offline.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.ready.compose.yml \
  up -d --no-deps --pull never --no-build --force-recreate snowluma
```

AUTOLOAD只自动注入，不代替QQ登录；若QQ要求快速登录、扫码或设备验证，应由用户在noVNC操作。不要伪造登录状态、盲试参数或把手工load算成自动恢复。启动脚本和supervisor配置已与固定官方源码核对一致，QQ进程HOME为/app、UID1000，未发现清空QQ配置或禁用自动登录的启动参数。[官方自动注入说明](https://github.com/SnowLuma/SnowLuma.Docker.Framework/blob/3f388b17f8baf47b4c2c9606b8a3121eb8599fef/README.md#自动注入)

## 当前主动聊天频率

| 字段 | 当前值 |
|---|---|
| speakUp.enabled | true |
| maxPerDay | 30，普通主动调度触发次数，不是气泡数或成功送达数 |
| minIntervalMinutes / maxIntervalMinutes | 40 / 80 |
| idleMinutes | 40 |
| awakeFrom / awakeTo | 8 / 23，即北京时间08:00至23:00前 |
| nudge | true，17:45按用户新指示开启；独立于普通30次额度 |
| purpose模块 | false，不并行启用第二套主动引擎 |

仅修改以上指定字段，其余业务配置核对未变。服务进程与主机时区均为Asia/Shanghai。原生调度状态新建时count=0，nextAt为2026-10-31 16:23:25.757（北京时间）；没有清零已有当日次数。该时间是当时保存的排期快照，不承诺届时实际发出消息，后续排期以运行状态为准。

原生调度每分钟检查，受活动窗口、闲置时间、静音和模型沉默影响，30次是普通调度上限。QQ现已由用户普通登录，16:24左右完成一次原生主动模型决策与QQ小黑盒分享，用户确认收到；计数0→1，下一次17:16:34，间隔52.58分钟。新增小黑盒阅读只给已有主动回合提供可选素材，不再增加发信器。以后维护应保留当天day/count，检查nextAt而非盲目重置；重启会清空进程内最近私聊时间，因此40分钟闲置条件跨进程重启的连续性仍需单独处理与验证。

## 专用提醒运行与维护

`qqai-reminders` 已部署启用，支持主人私聊中创建、查看和取消一次性、每天或每周提醒。时间统一按北京时间；明确指定的夜间提醒也会执行。调度每5秒检查，到点保留原提醒文字，并可按当前表情规则附带0–2张图；使用真实 Flash/off 判断、最多两次短调用，配图准备总预算20秒，失败或超时回退文字。文字和图片合并在一次发送中，正文不会当作命令或任意媒体标记执行，也不会因未回复继续催促。该模块不修改原生 `speakUp` 的30次额度、排期或小黑盒分享设置。[完整提醒说明](reminders.md)

38项合成边界回归已通过，其中引擎与模块各19项。真实Flash/off任务操作、受控DSH重启及QQ定时出站测试也已分别通过，用户确认收到唯一的测试提醒；[脱敏证据](evidence/20261031-reminders.json)记录各层结果。主人从QQ自然语言创建、查询、取消的完整交互复测因暂不方便而延后。运维受控合成输入不算真实QQ入站消息，不能据此宣称该项交互已经验收。

每次实际发送前检查总开关、试运行、主人静音、QQ连接和机器人真实身份。离线期间保留任务；恢复后24小时以内的逾期任务最多补发一次，超过24小时的一次性任务过期，重复任务跳过积压。发送前持久化尝试，回执缺失或进程中断时保留“发送结果待核实”并暂停该任务，不自动重发。管理侧通过已有受保护连接读取 `/aurabot/api/ext/qqai-reminders/state` 的聚合状态；只有 `enabled=true`、`ready=true` 且 `storageFailed=false` 才算提醒调度可运行。

首次增量备份在 `/var/lib/qqai-dsh/maintenance/20261031-reminders/reminders-1sf752o0/`，`before/` 与 `isolated-restore/` 的7个文件已验证一致。它覆盖配置、记忆、会话映射和相关状态，未操作QQ登录卷，也不替代既有完整备份。更新代码前关闭该模块的两个开关，使用 `deployment/install-reminders.py` 重新建立私有备份；回滚只处理提醒模块，不能恢复整份旧配置或旧主动状态覆盖后续变化。恢复旧提醒状态还须核对发送回执，避免重新引入已发任务。

## 模型判断心情

2026-10-31 17:11 已启用原生 `mood.judge=true`，`mood.enabled=true` 与 `halfLifeHours=3` 保持不变。每轮正常对话回复发送后，用当前 DeepSeek Flash / Thinking Off 做一次短判断；心情变化会影响后续语气及已有行为权重。判断置信度低于0.6或变化绝对值小于2时不更新心情。此功能增加API用量，不改变日常主动次数和活动窗口。

本次通过真实DSH `askModel` 和已安装心情解析器验证：合成关心话语返回delta=10、confidence=0.95。验证没有发送QQ，也没有把合成结果写进生产心情；配置、心情文件和DSH进程在验证期间保持不变，临时模块已卸载。证据见 [20261031-mood-judge.json](evidence/20261031-mood-judge.json)；不能把此探针算作已观察到真实QQ活动自动触发或主观体验通过。

配置和原心情的私有备份及隔离副本位于 `/var/lib/qqai-dsh/maintenance/20261031-mood/mood-1jx7m1ey/`。恢复为关键词判断只需要热更新该开关，不恢复整份旧配置或心情历史：

```bash
sudo python3 /opt/qqai-dsh/source/deployment/set-mood-judge.py \
  --record-dir /var/lib/qqai-dsh/maintenance/mood-rollback --disable
```

重新开启使用同一脚本的 `--enable`；也可在Aurabot心情设置打开“用模型判断心情”并保存。`scripts/mood-model-probe.mjs` 是运维临时模块源码，正常运行无需安装；已有结果标记时不会重复请求模型。

## 费用与版本

用户已同意从北京时间2026-11-01 00:00起按官方价格持续启用DeepSeek Search/Fetch；当时公告为每千次成功请求各0.75美元。模型调用仍按官方Token价格计费，未授权自动充值、升级实例或购买额外服务。价格未来变化时应重新核实。[官方说明](https://api-docs.deepseek.com/guides/search/#billing)

完整版本与依赖见 `versions.lock.json`、`deployment/locks/`。恢复脚本与实际演练边界见[备份恢复](backup-restore.md)。不得只升级某一个包后继续沿用旧的通过结论。

## 记忆扩容、小黄脸与未回复追问（2026-10-31 17:45）

当前 `memory.recallCount=10`；实际 `recallHint` 最多附带8条完整事实、正文总计1600字符。跳过放不下的事实后继续考虑后续候选，避免在否定词或纠错内容中间截断。人物档案/相处经验等其他记忆提示保持原有规则。双方 `logChat` 流水现在每条最多2000字符，先脱敏再截断；只影响今后写入，旧流水缺失的尾部无法自动补回。这里是JS字符长度预算，不是模型token数。

事实提炼仍由原生04:00/16:00定时器完成，保留80行上限并增加约40000字符分批预算；所有批次都会处理，单条超预算的旧记录单独完整处理。单事实200字符、遗忘规则、提炼模型输出预算和人物档案上限未变。实际调用更多相关记忆、处理较长流水会增加部分token用量。

`stickers.faces=false`：2026-11-02按用户要求关闭QQ系统小黄脸。原生动态提示词不再加入face标签说明，普通发送路径移除 `<face:…>` 标签。Nekowhale原有GIF/图片功能继续保留。此前开启期间已从真实SnowLuma读取到330个数字编号表情，该历史验证不代表当前仍开启。

`speakUp.nudge=true` 开启原生未回复追问。每分钟在08:00–23:00活动窗口检查；机器人最近一次私聊是问句且晚于主人最后回复，经过15至40分钟时，该问题最多尝试一次，50%概率进入模型决策，模型仍可沉默。追问不消耗普通主动的30次计数，也不改其nextAt；追问产生的新问句仍可能再次成为目标，因此不能承诺主人持续不回时总共只追问一次。DSH重启会清空进程内最近问句，重启前的问题不会继续等待追问。purpose仍关闭。

部署使用 `deployment/set-memory-and-chat-options.py`，固定版本与分阶段hash校验；只重启DSH，不重启QQ。14文件增量备份位于 `/var/lib/qqai-dsh/maintenance/20261031-memory-options/limits-k79uigg2/`，`before`与`isolated-restore`逐字节一致。覆盖配置、原生记忆、会话映射、聊天流水、主动/提醒/小黑盒/心情状态、profile和变更代码；不替代完整三卷备份。失败时安装器自动恢复被修改的代码与配置、重新启动DSH，不把旧记忆和任务状态覆盖回生产。

未来回滚代码时需同时恢复manifest中旧的 `src/chat/hub.js`、`src/features/memory.js` 和旧启动补丁定义，否则systemd启动前hash检查会拒绝启动；先停DSH，再按manifest恢复这些代码的内容/属主/权限。配置只恢复 `memory.recallCount`、`stickers.faces`、`speakUp.nudge` 三个字段，保留后来其他设置；不要整库恢复旧memories/chatlog/speakup/reminders。若只关闭小黄脸或追问，可在原生面板分别关闭faces/nudge，无需恢复代码。

验证分层：40项合成回归通过；5次真实DSH Flash/off请求（合计2598输入/输出tokens）在隔离合成库中完成长消息尾部提炼和第7条记忆回答，临时模块已卸载，生产记忆逐字节未变。QQ连接和身份、真实表情目录已核对；没有额外发送QQ测试消息，没有把单元测试视为实际小黄脸收件或真实未回复窗口验收。[脱敏证据](evidence/20261031-memory-options.json)


## 自定义人格首次接入（2026-10-31 18:33）

初版小鲸的人格文件为 `personas/xiaojing.md`，运行副本保存在私有 `ext.qqai-compat.personaText`，名字字段 `ext.qqai-compat.botName=小鲸`。兼容模块会完整覆盖原生人格卡正文，因此仅在原生面板编辑旧dafeiyu卡不会改变当前生效文本。修改应同步原文与这个运行字段，然后重载 `qqai-compat`；DSH/QQ无需重启，历史与记忆保留。上游鲸鱼娘包仍锁定原版本并校验源hash。

生效检查可读取受保护的本机 `/aurabot/api/ext/qqai-compat/persona-state`，只返回文本hash与长度等元数据；真实模型验证见 `docs/evidence/20261031-persona-xiaojing.json`。当前源文件含末尾换行，其文件hash与去首尾空白后的运行文本hash不同，这是预期格式差异。

本次备份目录 `/var/lib/qqai-dsh/maintenance/20261031-persona/persona-bn_xbes5/`。恢复只从备份配置提取旧 `ext.qqai-compat.botName` 与 `personaText`（不存在则空字符串），通过原生保存接口写回，并按原属主权限恢复 `adapter.before.mjs`、重载该模块。不能将整份旧配置、记忆、sessions或speakup覆盖回生产。部署脚本失败时执行同样的定向回滚。角色里提到编码能力不授予Shell/宿主文件权限，现有工具边界保持。


## 2026-11-01：普通主动30次、随机40–80分钟

用户授权仅调整 `maxPerDay=30`、`minIntervalMinutes=40`、`maxIntervalMinutes=80`；闲置40、活动时间08:00–23:00、nudge=true、purpose=false保持。闲置从双方最近一条私聊起算，包括机器人回复和主动消息；聊天不重新抽取nextAt。追问仍使用独立15–40分钟窗口，不计入普通30次。

固定Aurabot的后端原把maxPerDay限制为20；新增 `scripts/proactive-limits-patch-spec.mjs` 将该唯一校验改为30。原界面数字输入无20上限，不改前端。中央补丁安装器及ExecStartPre现校验7个文件；部署/恢复须保留所有四个脚本：`patch-plugin-media.mjs`、`qq-delivery-patch-spec.mjs`、`memory-limits-patch-spec.mjs`、`proactive-limits-patch-spec.mjs`。其他6个文件最终hash未变。

维护命令由本次暂存仓库运行 `deployment/update-native-proactive.py --record-dir /var/lib/qqai-dsh/maintenance/20261031-proactive-30`。脚本先确认当前QQ回合空闲，停DSH但不重启网关，备份14文件并在独立目录验证，再更新固定源码和三个配置字段。pnpm公开源码可为硬链接，备份只读，原子替换会解除本安装文件与共享inode的关联；私有状态仍要求普通单链接文件。

唯一主动状态写入为停机期间 `nextAt=0`，day/count/last/nudgedFor保持，重启后由原生分钟tick按新间隔重排。此次恰跨北京时间午夜：旧日6次由原生日切变为新日0次，不是脚本重置。观察到新排期2026-11-01 00:47:30，处于新40–80分钟范围；夜间门槛仍阻止发信，08:00后才按条件考虑普通主动。

备份 `/var/lib/qqai-dsh/maintenance/20261031-proactive-30/proactive-noqon_79/`，清单 `manifest.private.json` 和 `before/`、`isolated-restore/` 逐字节验证。回滚只恢复清单中变更的配置源码、启动校验脚本、原生三个字段；主动状态只让nextAt失效，保留当前day/count等字段；不恢复旧聊天、记忆、reader或reminders状态。失败由脚本执行上述回滚后恢复DSH。14项Node合成测试、6项原状态保留回归及硬链接隔离替换验证通过；已验证实际运行配置/原生排期/QQ重连，未强制模型或QQ消息测试。[分层证据](evidence/20261101-proactive-30.json)


## QQ系统小黄脸开关（2026-11-02）

当前为关闭。使用 `deployment/set-qq-faces.py --record-dir /var/lib/qqai-dsh/maintenance/20261102-qq-faces --disable`，只通过原生保存接口热更新 `stickers.faces`；反向恢复使用 `--enable`，无需重启或恢复整份旧配置。每次保存前在root私有目录备份配置并验证隔离副本，保存后比较磁盘/内存配置，确认其他字段与服务进程不变。

本次备份 `/var/lib/qqai-dsh/maintenance/20261102-qq-faces/faces-55sbfgea/`。实际磁盘与运行值均false，QQ connected、兼容模块正常，其他配置未变；未发送QQ测试消息或调用模型。旧回归已覆盖关闭时剥离标签和移除提示说明，本次不把它计作新的真实QQ收件验证。[记录](evidence/20261102-qq-faces-disabled.json)


## 2026-11-02：Nekowhale 正常表情策略

当前 `ext.qqai-compat.stickerUsage=often`，只允许大肥鱼单人286款与五种文字模板，整轮最多2张。频率调节使用Aurabot兼容模块的设置；Neko `promptMode`保持off，因为QQ完整人格模式不采用其独立hint section。程序限制与提示一同生效；off仅关闭主动配图提示/提醒配图，不卸载用户指定表情工具。

[表情运行说明](neko-stickers.md)记录实际请求验证、下载测速、QQ回执、自然闲聊未出图观察及回滚。统一patcher现检查8个文件，并需保留新增 `neko-network-patch-spec.mjs` 与 `sticker-turn-patch-spec.mjs`。提醒安装器必须同时安装`engine.mjs`、`stickers.mjs`和最后写入的`index.mjs`。

本轮备份位置为`/var/lib/qqai-dsh/maintenance/20261102-stickers/enable-qyzmwcdm/`，22文件隔离恢复验证通过；提示热更新副本为同级`prompt-vc8k7t4j/`。回滚只恢复本轮代码、stickerUsage和profile套组字段，不能覆盖后来聊天、记忆、提醒或计数。SnowLuma及QQ自动登录排查未重启；临时验收模块已关闭并归档。


当前启用的病娇版同样通过兼容模块热加载。安装器从 `versions.lock.json` 的 `runtime_state.active_persona.source` 读取 Markdown，同时验证文件原始字节和去除首尾空白后的运行文本摘要。[当前人格](../personas/xiaojing-yandere.md)

在服务器项目源码目录执行 `python3 deployment/set-whale-persona.py --text-only --record-dir /var/lib/qqai-dsh/maintenance/20261109-persona-yandere-revision`，可应用锁文件选定的人格。安装器先确认会话空闲、备份并验证还原副本，再保存 `ext.qqai-compat.personaText` 并重载兼容模块。回退本次 23:39 的更新时，从 `/var/lib/qqai-dsh/maintenance/20261109-persona-yandere-revision/persona-qsdbcizc/config.before.json` 提取旧人格字段，经原生配置接口仅写回此项并热重载。回退目标是 18:03 初版病娇，运行文本 SHA-256 为 `1a48475677339fa46b019a10944d9ccc5e1efa7af9e218102e35894542c673ce`。同步恢复该版 Markdown 和锁文件记录，并按下节处理原会话。18:03 部署使用的 `persona-z7zwgv9l` 备份对应更早的日常版。[23:39 部署记录](evidence/20261109-persona-yandere-revision.json) · [18:03 部署记录](evidence/20261109-persona-yandere.json)

### 既有 QQ 会话的人格切换

核查原私聊时，先通过 `agent.session.deriveMessages()` 检查模型实际接收的所有有效 system 消息。DeepSeek 连续会话可把变更后的人格追加在末尾，面板回读和新建会话都无法单独验证旧会话的首条提示。

在已核对映射的私聊 agent 上取得 `agent.runMaintenance` 空闲窗口，按其作用域重新渲染完整系统提示，先备份系统节点。将前后两份完整人格与渲染结果传给 `scripts/refresh-qq-session-persona.mjs` 的 `normalizePersonaSurface`，先用 `dryRun: true` 检查计划。旧首部是唯一系统提示时，工具要求除人格正文外与新渲染结果完全一致。如果已有新版末尾，则须与新渲染结果一致。按计划执行，调用 `await sessions.flush(agent.session)` 后独立读回有效系统节点及所有非系统消息的顺序和内容摘要。本次旧系统节点备份在 `/var/lib/qqai-dsh/maintenance/20261109-yandere-revision-session/apply-dxwii1rz/data/system-nodes.before.private.json`。[23:40 原会话验证](evidence/20261109-persona-yandere-revision.json) · [18:20 首次修复](evidence/20261109-persona-session.json)

### 2026-11-02 表情积极档与漏图修复回滚

当前线上维护备份为 `/var/lib/qqai-dsh/maintenance/20261102-gif-often/enable-fkdm8szf/`。只需调回频率时，在 Aurabot 兼容模块保存“表情使用积极程度”为“正常”，用本机受保护的 `/aurabot/api/ext/qqai-compat/sticker-state` 核对 `usage`。

若需同时回退漏图修复，先确认主人私聊和提醒空闲并停止 `qqai-dsh.service`。按该目录 `manifest.private.json` 的路径、SHA-256、属主与权限，从 `before/` 原子恢复五个受影响的代码文件：Hub 的 `src/chat/hub.js`、兼容模块的 `index.mjs` 和 `sticker-policy.mjs`、线上源码的 `scripts/patch-plugin-media.mjs` 和 `scripts/sticker-turn-patch-spec.mjs`。仅把当前 config 的 `ext.qqai-compat.stickerUsage` 改回 `normal`。用回退后的 patcher 对两个已装包执行 `--check`，启动 DSH，核对 OneBot 在线、机器人身份和策略回读，将发布记录指向上一版本 `55cbeec`。恢复范围仅含上述代码和配置字段，备份中的记忆、聊天及调度文件只用于核对。
