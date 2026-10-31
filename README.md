# QQAI_DSH

从零构建的独立 QQ AI 陪伴系统：DSH Web、Aurabot、鲸鱼娘人格插件、Nekowhale 表情插件，优先使用许可已确认的 SnowLuma 网关。

**当前状态：实施中，尚未部署完成或通过 QQ 验收。** 不继承旧 QQAI 代码、人格、记忆、数据库、Guard、多气泡或主动实现。工作区调研方案仅供参考，其中旧 V0.4、L1/L2 和旧资料迁移全部不执行。

**最新运行状态（2026-10-31，北京时间）：用户已重新完成普通 QQ 登录，OneBot 连接及机器人身份核对通过；原生主动配置保持生效。** 无人值守自动登录仍未通过，未恢复网关重启排查。[此前维护证据](docs/evidence/20261031-recovery-proactive.json)。

用户后来明确授权重新开展网关恢复和主动配置维护。已完成登录后的完整三卷备份、隔离恢复及离机校验，并应用ready Compose将 `HOOK_AUTOLOAD=1`：Linux QQ自动启动和自动注入已实证；QQ自身自动登录尚未通过。用户手动登录后，Aurabot曾在同一DSH进程内自动重连，观察窗口内历史和记忆保留且无重复回复；后续自动登录调查已按用户新指示停止。

原生 `speakUp` 当前为：开启，普通主动每日最多20次触发、随机间隔30–60分钟、闲置40分钟、北京时间08:00–23:00、`nudge=false`；purpose关闭。未清零当天计数；首次排期在16:23:59自然触发，真实Flash/off回合分享了小黑盒文章，QQ三气泡已收到确认，计数0→1。下一排期17:16:34，间隔52.58分钟；不把这一次通过扩展为长期稳定性保证。

此前实际中文多轮、多气泡、人格、图片与追问、动画GIF、中文表情、Search/Fetch和自然记忆提炼已经验证。[QQ证据](docs/evidence/20261031-qq-chat-media.json)。记忆纠错被用户跳过，新会话召回、无人值守QQ恢复及长期运行等仍未完成完整验收。

新增只读小黑盒模块已启用；真实登录态、文章读取、独立模型判断、原生主动回合与实际QQ分享均通过，用户确认收到。文章作为原生主动回合的可选素材，不另开发信定时器；小黑盒写权限保持全关。[接入说明](docs/heybox-reader.md)

用户最终确认保留 **Ubuntu 26.04 LTS**（替代最初要求的24.04），已通过腾讯云控制台确认主机指纹，SSH 始终严格校验。实机已安装 Node 24.22.2、DSH 0.2.1-rc.5、Docker 29.1.3、Compose 2.40.3 和中文字体。[新仓库](https://github.com/maxsssssssssss/QQAI_DSH)写权限已验证。用户确认已取得 SnowLuma 权利人对本次自动部署的书面授权；本项目尚未查看授权文本，按用户确认继续官方部署。

DSH 已作为专用用户的 systemd 服务运行，仅监听 `127.0.0.1:3080`，三插件已同时装载。服务器真实 DeepSeek 测试通过中文多轮、鲸鱼娘人格、Nekowhale 检索/选图/中文模板、Search/Fetch、真实像素识别与追问；[服务器证据](docs/evidence/20261031-dsh-server-api.json)与[重启后同会话召回](docs/evidence/20261031-dsh-server-restart.json)均使用合成数据。**这些不是实际 QQ 验收，也不是长期记忆验证。** 用户已授权从 2026-11-01 起按官方价格继续启用 Search/Fetch。

## 实施记录

- [2026-10-31 详细现状、全部关键配置与可选功能报告](docs/status-report-20261031.md)
- [部署日志](docs/deployment-log.md)
- [SnowLuma 许可核对](docs/snowluma-license-review.md)
- [DSH 运行核查](docs/dsh-runtime-audit.md)
- [三插件兼容适配](docs/plugin-compatibility-audit.md)
- [备份与恢复](docs/backup-restore.md)
- [运行、隧道与用户醒来后的步骤](docs/operations.md)
- [小黑盒只读文章与 QQ 分享接入](docs/heybox-reader.md)
- [测试证据与验收矩阵](docs/acceptance.md)
- [真实 QQ 验收操作步骤](docs/qq-acceptance-procedure.md)
- [初始版本锁](versions.lock.json)

本项目仅保存源码、配置模板、脚本和脱敏证据。API Key、PEM、QQ 登录态、真实私聊与私有数据库不得提交。管理界面只绑定 loopback，经 SSH 隧道访问。工具能力需从实际 QQ preset 中移除 Shell、宿主文件系统权限；不挂 Docker socket。

