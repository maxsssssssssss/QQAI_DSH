# QQAI_DSH

从零构建的独立 QQ AI 陪伴系统：DSH Web、Aurabot、鲸鱼娘人格插件、Nekowhale 表情插件，优先使用许可已确认的 SnowLuma 网关。

**当前状态：实施中，尚未部署完成或通过 QQ 验收。** 不继承旧 QQAI 代码、人格、记忆、数据库、Guard、多气泡或主动实现。工作区调研方案仅供参考，其中旧 V0.4、L1/L2 和旧资料迁移全部不执行。

当前 QQ 可用于主人私聊：用户完成官方协议确认与 QQ 登录，身份核验通过。实际中文多轮、三气泡、人格、图片与追问、动画 GIF、中文表情、Search/Fetch 均已验证；真实定时器也完成了自然长期记忆提炼。[QQ证据](docs/evidence/20261031-qq-chat-media.json)。

**用户于 2026-10-31 要求停止后续测试。** 记忆纠错由用户明确跳过；新会话召回、主动与未回复行为、QQ重启恢复和登录后备份恢复未验收。日常主动保持关闭，频率留待用户另行商定。当前网关由官方接口手动注入并已在线，`HOOK_AUTOLOAD=0`；自动注入需要后续应用已准备的 ready override 并重建容器，可能需要QQ本人操作。因此本阶段不作为完整最终验收交付。

此前 DSH 真实 API、合成会话重启持久化、登录前的三网关卷备份与隔离恢复已完成；这些证据不能证明当前 QQ 登录态的自动恢复。

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
- [测试证据与验收矩阵](docs/acceptance.md)
- [真实 QQ 验收操作步骤](docs/qq-acceptance-procedure.md)
- [初始版本锁](versions.lock.json)

本项目仅保存源码、配置模板、脚本和脱敏证据。API Key、PEM、QQ 登录态、真实私聊与私有数据库不得提交。管理界面只绑定 loopback，经 SSH 隧道访问。工具能力需从实际 QQ preset 中移除 Shell、宿主文件系统权限；不挂 Docker socket。

