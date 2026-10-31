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

systemd 使用 LoadCredential 把 Key 传入运行进程。配置、启动参数、Git和公开证据不含Key。`bootstrap-host.sh` 安装依赖；`install-dsh-profile.sh` 为新部署初始化profile；两者不是在线更新命令。尤其不要在运行中的陪伴系统上重跑初始化器，因为它会重新关闭发送、重置初始选项。升级应先备份、停服务、审核版本及六个文件的hash补丁，再安装锁定依赖并恢复同项目私有配置。当前文件清单、最终hash和Hub已审核中间版本迁移规则见[兼容性记录](plugin-compatibility-audit.md)；须同时保留安装器及其依赖 `scripts/qq-delivery-patch-spec.mjs`。

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
| maxPerDay | 20，普通主动调度触发次数，不是气泡数或成功送达数 |
| minIntervalMinutes / maxIntervalMinutes | 30 / 60 |
| idleMinutes | 40 |
| awakeFrom / awakeTo | 8 / 23，即北京时间08:00至23:00前 |
| nudge | false，不执行未回复追问 |
| purpose模块 | false，不并行启用第二套主动引擎 |

仅修改以上指定字段，其余业务配置核对未变。服务进程与主机时区均为Asia/Shanghai。原生调度状态新建时count=0，nextAt为2026-10-31 16:23:25.757（北京时间）；没有清零已有当日次数。该时间是当时保存的排期快照，不承诺届时实际发出消息，后续排期以运行状态为准。

原生调度每分钟检查，受活动窗口、闲置时间、静音和模型沉默影响，20次是普通调度上限。QQ现已由用户普通登录，16:24左右完成一次原生主动模型决策与QQ小黑盒分享，用户确认收到；计数0→1，下一次17:16:34，间隔52.58分钟。新增小黑盒阅读只给已有主动回合提供可选素材，不再增加发信器。以后维护应保留当天day/count，检查nextAt而非盲目重置；重启会清空进程内最近私聊时间，因此40分钟闲置条件跨进程重启的连续性仍需单独处理与验证。

## 专用提醒运行与维护

`qqai-reminders` 已部署启用，支持主人私聊中创建、查看和取消一次性、每天或每周提醒。时间统一按北京时间；明确指定的夜间提醒也会执行。调度每5秒检查，到点使用真实QQ纯文字发送，一条提醒对应一条气泡，正文不会当作命令或媒体标记执行，到点不额外调用DeepSeek，也不会因未回复继续催促。该模块不修改原生 `speakUp` 的20次额度、排期或小黑盒分享设置。[完整提醒说明](reminders.md)

38项合成边界回归已通过，其中引擎与模块各19项。真实API、受控DSH重启及QQ出站测试须单独记录；主人从QQ自然语言创建、查询、取消及接收体验因暂不方便而延后。运维在用户授权内使用的受控合成输入，不算真实QQ入站消息，不能据此宣称主人交互已经验收。

每次实际发送前检查总开关、试运行、主人静音、QQ连接和机器人真实身份。离线期间保留任务；恢复后24小时以内的逾期任务最多补发一次，超过24小时的一次性任务过期，重复任务跳过积压。发送前持久化尝试，回执缺失或进程中断时保留“发送结果待核实”并暂停该任务，不自动重发。管理侧通过已有受保护连接读取 `/aurabot/api/ext/qqai-reminders/state` 的聚合状态；只有 `enabled=true`、`ready=true` 且 `storageFailed=false` 才算提醒调度可运行。

首次增量备份在 `/var/lib/qqai-dsh/maintenance/20261031-reminders/reminders-1sf752o0/`，`before/` 与 `isolated-restore/` 的7个文件已验证一致。它覆盖配置、记忆、会话映射和相关状态，未操作QQ登录卷，也不替代既有完整备份。更新代码前关闭该模块的两个开关，使用 `deployment/install-reminders.py` 重新建立私有备份；回滚只处理提醒模块，不能恢复整份旧配置或旧主动状态覆盖后续变化。恢复旧提醒状态还须核对发送回执，避免重新引入已发任务。

## 费用与版本

用户已同意从北京时间2026-11-01 00:00起按官方价格持续启用DeepSeek Search/Fetch；当时公告为每千次成功请求各0.75美元。模型调用仍按官方Token价格计费，未授权自动充值、升级实例或购买额外服务。价格未来变化时应重新核实。[官方说明](https://api-docs.deepseek.com/guides/search/#billing)

完整版本与依赖见 `versions.lock.json`、`deployment/locks/`。恢复脚本与实际演练边界见[备份恢复](backup-restore.md)。不得只升级某一个包后继续沿用旧的通过结论。
