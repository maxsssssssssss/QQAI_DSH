# 部署日志

## 2026-10-31（Asia/Shanghai）：项目启动与预检

- 完整阅读 `QQAI_DSH_Three_Plugins_Rebuild_Plan_20261031.md`，以本次用户启动指令覆盖其中旧项目建议。不读取或迁移旧系统的代码、人格、记忆或数据库。
- 当前工作区仅有调研文档，不是有效 Git checkout。GitHub 连接所列仓库均为旧项目；查询预期的新仓库名称返回 404，已请求新仓库链接。
- 两个指定凭据文件存在并可读，仅检查格式；没有输出内容。Windows 挂载路径的 POSIX mode 不代表真实 NTFS ACL，运行副本将使用受保护目录。
- 从已有 SSH 配置获取目标，使用用户指定 PEM、现有 known_hosts 和 StrictHostKeyChecking=yes 尝试只读预检。Windows OpenSSH 在主机密钥检查阶段拒绝连接；没有执行远程命令、没有改动 known_hosts。
- 已请求用户在腾讯云控制台独立读取 ED25519 指纹，未把网络自报的新指纹当作可信凭据。
- 已并行核查 DSH、三插件与 SnowLuma 许可。许可未确认前不拉取或启动 SnowLuma 发行物，也不代用户勾选许可。
- Node 官方 24 系列当前版本为 24.22.2；DSH npm latest 为 0.2.1-rc.5。先构建隔离本地运行环境，服务器安装尚未开始。

## 2026-10-31：可信 SSH 预检与 API 实测

- 用户独立从腾讯云控制台确认了服务器返回的 ED25519 指纹，说明刚完成重装。采集主机公钥后与该指纹逐字节校验，保存项目专用 known_hosts，继续严格校验；不覆盖全局旧记录。
- 成功执行只读 SSH 预检：x86_64、3718 MiB 内存、2047 MiB Swap、51 GiB 可用磁盘，未安装 Node/npm/Docker。系统实际是 Ubuntu 26.04 LTS；用户决定重装 Ubuntu 24.04，服务器安装等待重装和新指纹。
- 用户确认目标仓库为 maxsssssssssss/QQAI_DSH；GitHub API 已可读取并确认 push 权限。没有向任何旧仓库写入。
- 官方 Node 24.22.2 Linux x64 已下载到隔离临时目录并通过 SHA256 校验；DSH 0.2.1-rc.5 本地依赖安装进行中。
- 使用指定文件中的 Key 真实调用 DeepSeek，合成数据测试通过：中文、多轮代号回忆、实际 SHA256 工具执行往返、PNG 三色像素识别及追问、Search/Fetch。Thinking 显式 disabled，检查响应没有 reasoning_content。证据位于 docs/evidence/deepseek-api-local-20261031.json；尚未声称 QQ 或 DSH 通过。
- 用户已明确同意 2026-11-01 00:00（Asia/Shanghai）后按官方价格持续启用 Search/Fetch。官方目前每千次成功请求各 0.75 美元；来源 https://api-docs.deepseek.com/guides/search/#billing 。
- 上游审查发现 Aurabot 默认 QQ preset 的 Shell/文件工具，以及 Nekowhale loopback 链接被 Aurabot SSRF 检查阻止的兼容问题；正在实现明确工具白名单、受控媒体路径转换及最小发送入口限制。

## 2026-10-31：部署基线与授权更新

- 用户随后明确改为保留当前 Ubuntu 26.04 LTS 并继续部署，撤回重装24.04的选择。这是本项目最终安装基线。
- GitHub 最初写入403，确认连接只覆盖选定仓库。用户更新授权后，创建 .gitignore 成功，初始提交 0713e2f708c69847a2ae6b646b8c93fe46a07094。工作区已初始化独立Git并连接该新仓库。
- 用户明确确认“已取得作者或权利人对本次自动部署的书面授权”。据此解除 SnowLuma 自动部署许可待确认项；此为用户确认，未声称审阅授权书全文或取得再分发权。QQ登录和真实会话验收留待用户醒来。
- 服务器已安装 Node 24.22.2（官方SHA256校验）、DSH 0.2.1-rc.5（616个包）、Docker 29.1.3、Compose 2.40.3及Noto中文字体。运行专用用户dsh无sudo/docker组权限。
- API Key 直接从指定本地文件经严格SSH输入流写入 /etc/qqai-dsh/deepseek-api-key，属主root:root、0600；未放入命令参数、仓库或公开日志。systemd将通过LoadCredential提供给服务。
- 本地DSH实际装载三个固定插件成功；四个实际新建测试Agent的工具目录不含Shell/fs/subagent。未鉴权API返回401，非可信Host返回403。证据后续随本地运行核验报告保存。

## 2026-10-31：DSH 服务器运行阶段

- 三插件按固定提交/版本完成服务器安装。首跑pnpm因继承/home/ubuntu工作目录而失败；安装器改为切换专用工作区后成功，未放宽用户目录权限。
- 四处固定hash适配应用并校验：Aurabot媒体入口、Nekowhale头像文件入口、主动提示的虚构现实经历句子、后台模型硬编码low。服务每次启动前校验补丁hash，未知版本拒绝启动。
- 专用dsh用户systemd服务已启用，LoadCredential传入Key，仅监听loopback3080，配置关闭Shell/fs/插件管理/无关外部写功能，未加入Docker管理组或挂载Docker socket。
- 发现并关闭DSH默认额外session-log上传，同时设置DSH_TELEMETRY_DISABLED=1。关闭前仅本地合成测试；服务器实际运行已关闭该额外上传。
- 服务器真实8项DSH/API场景完成：中文、上下文、鲸鱼娘人格、Neko检索与选图、中文模板、Search/Fetch、图片像素、图片追问。实际工具result均isError:false，请求reasoningEffort均off；证据20261031-dsh-server-api.json。
- 实际重启DSH服务后，同一合成会话经真实模型正确回忆“海盐-741”和蓝色宠物，验证会话持久化；不将其计为长期记忆或QQ重连通过。初始readiness使用未鉴权GET=200假设不正确，已改成未鉴权RPC=401健康判断。
- 锁定了实际runtime npm依赖和三插件pnpm依赖，全新临时profile的frozen安装及原生canvas通过，锁未变化。
- 腾讯云直连Docker Hub超时；独立正确IP的TLS验证也被重置，未改全局DNS或关闭TLS。转为本地从官方registry下载原始镜像，逐一验证manifest/config/压缩层及diff_id，再通过SSH私有传输；不构建或公开分发整合镜像。

