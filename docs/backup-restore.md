# 私有备份与恢复

脚本是本项目的一部分：`deployment/backup.sh`、`deployment/restore.sh` 调用同目录 `backup_restore.py`，需要 Ubuntu 自带 Python 3.12+。操作必须以 root 运行，输出目录 0700、归档与校验文件 0600。归档含 API 凭据、QQ 登录态、私聊和记忆，禁止提交 GitHub、贴日志或放入公开下载地址。

备份范围：

- `/srv/qqai-dsh/home/.dsh`：profile、插件锁、会话、附件、三插件私有数据及用户模块。
- `/srv/qqai-dsh/workspace`：这套系统独立工作区。
- `/etc/qqai-dsh`：服务凭据。
- `/opt/qqai-dsh/source`、可选 `/opt/qqai-dsh/deployment`、应用 package.json/package-lock.json/pnpm-lock.yaml。
- `/etc/systemd/system/qqai-dsh.service` 与生产用 `qqai-dsh.service.d` drop-in。临时审计 drop-in 应在最终备份前由主任务移除。
- 本项目 SnowLuma 的三个官方挂载命名卷：`qqai-dsh-snowluma-data`（`/app/data`）、`qqai-dsh-qq-config`（`/app/.config`）、`qqai-dsh-qq-data`（`/app/.local/share`）。Compose 源文件位于项目 `deployment/snowluma.compose.yml`，部署路径 `/opt/qqai-dsh/source/deployment/snowluma.compose.yml`，项目名 `qqai-dsh`、服务名 `snowluma`。

备份不包含 SSH PEM，不收集整个宿主。`node_modules`、`.git`、Python 缓存不归档；依赖按保存的 npm/pnpm 锁重装，再应用固定 hash 补丁。Docker 镜像不打包；恢复使用 Compose 固定的官方 digest，不重新分发专有软件。

QQ 卷中仅排除名为 `SingletonLock`、`SingletonCookie`、`SingletonSocket` 的进程符号链接，以及 tarfile 本来不归档的 Unix domain sockets。这些 Chromium POSIX ProcessSingleton 链接引用进程/临时 socket；没有排除 QQ 的 `Cookies` 数据库、登录数据库或其他链接，也没有放宽恢复路径校验。[Chromium 官方实现](https://chromium.googlesource.com/chromium/src/+/8c3eb804c56b7173f00e58e040f47fe867dabda7/chrome/browser/process_singleton_posix.cc)

## 创建一致性备份

```bash
sudo /opt/qqai-dsh/source/deployment/backup.sh
```

默认输出 `/var/backups/qqai-dsh/qqai-dsh-<UTC时间>.tar` 及 `.tar.sha256`。可用 `--output-dir /绝对/私有目录` 改位置；不能放入被备份的数据树。

脚本先记录 DSH 与带本项目 Compose 标签的 SnowLuma 容器运行状态，停止 DSH，再停止原先正在运行的本项目 SnowLuma 容器，从宿主读取其 local volume mountpoint。DSH 处于 activating/reloading 等过渡状态时拒绝；快照前确认 MainPID 已为零。它不停止其他项目、不创建 helper 容器、不拉镜像。复制完成或遇到错误后，先恢复原先运行的网关，再恢复原先运行的 DSH。原本停止的服务保持停止。恢复运行状态失败会明确返回非零。

归档内含 host 快照、每卷快照、manifest 与逐文件 SHA-256。外层另有 SHA-256。`gateway_included: false` 表示当时没有网关卷，这类备份只能证明 DSH 数据备份，不能作为 QQ 登录态恢复验收证据。Docker 已安装但不可访问、运行中网关缺卷、卷被其他运行容器共用时，脚本拒绝宣称完成一致性备份。

manifest 使用 `contains_private_credentials: true` 标示归档敏感性，`qq_login_state: not-assessed` 表示脚本没有判断 QQ 是否已登录。`gateway_included: true` 仅说明网关卷被纳入，不能证明卷内有有效登录态。隔离恢复的 `VERIFIED.json` 同样标记登录态未评估；真实登录状态、重启连接恢复及 QQ 验收证据另记部署日志，不通过读取用户聊天来判断登录。

备份后将归档和校验文件通过已核验主机指纹的 SSH 通道保留到另一台私有设备；服务器系统盘上的副本不能抵御系统盘丢失。脚本不会自行删除旧备份或添加自动清理计划。

## 默认隔离恢复演练

```bash
sudo /opt/qqai-dsh/source/deployment/restore.sh \
  /var/backups/qqai-dsh/qqai-dsh-<UTC时间>.tar \
  --destination /var/lib/qqai-dsh/restore-check/<新的演练名>
```

默认只验证并解压到新的空目录：`host/` 为宿主路径镜像，`volumes/` 为三卷镜像，`payload/` 保留校验过的内部归档，`VERIFIED.json` 只记录校验结果。不会覆盖运行系统、调用模型、连接 QQ、启动容器或服务。已存在且非空的目标直接拒绝；校验失败、目录穿越、特殊文件或跨数据根符号链接也会拒绝。

演练验收应检查：归档/各载荷校验通过；profile 锁、人格来源引用、兼容模块、记忆数据库与 QQ 三卷存在；原服务运行状态已恢复。只记录文件类别、数量/大小、校验结果和测试时间，不把聊天、数据库、凭据内容附到报告。

SHA-256 检测传输损坏，不证明陌生归档可信；恢复仅使用本项目生成并保存在私有位置的备份。

## 在空服务器上实际恢复

必须先确认原实例/其他机器不会同时运行这个 QQ 号。目标上的 DSH 和本项目 SnowLuma 均须停止；所有恢复目标必须不存在或为空，已有应用 package manifest、systemd unit、非空数据目录或非空 QQ 卷都会使脚本拒绝。脚本不会为了恢复而删除现存数据。

在新的 Ubuntu 主机安装 Python 3.12+、Docker（恢复含 QQ 卷的归档时需要），通过安全通道放入备份、校验文件和本项目恢复脚本。脚本可从临时私有目录执行，不要先把部署源码放进 `/opt/qqai-dsh/source`，否则空目标检查会拒绝。运行：

```bash
sudo /私有/恢复脚本目录/restore.sh /私有/备份.tar \
  --destination /var/lib/qqai-dsh/restore-check/recovery-001 \
  --apply --confirm-no-other-bot
```

`--confirm-no-other-bot` 是操作者已核实不会双发的声明，不会由脚本替用户猜测。脚本仍先做隔离校验，全部目标检查通过后才写运行目录；如缺少普通用户 `dsh`，只建立该专用无登录 shell 用户，不加入 docker/sudo。恢复卷时保留其原数字 UID/GID。数据恢复后强制 Aurabot `enabled: false`、`dryRun: true`、`speakUp.enabled: false`，不启动任何服务或容器。

依赖恢复顺序：

1. 使用保存源码中的 `deployment/bootstrap-host.sh` 安装核验过的 Node 24、Docker、字体和 DSH 宿主依赖。此脚本不启动 DSH/SnowLuma，但其 npm install 可能修改应用依赖锁：执行前将恢复出的 app/package.json 和 package-lock.json 保留到 root 0700 临时目录，执行后恢复这两个原始文件，再按下一步 npm ci；不要把 bootstrap 修改后的锁当作备份原锁。
2. 用 Node 24 自带 npm，分别在 `/opt/qqai-dsh/app` 和 `/srv/qqai-dsh/home/.dsh/toolchain` 对已恢复的 package-lock.json 执行 `npm ci`；pnpm 工具链可加 `--ignore-scripts`。所有目录归属专用 dsh 用户或由 root 安装后给予所需读取权限。
3. 使用恢复工具链的 pnpm，在 `/srv/qqai-dsh/home/.dsh/profiles/web` 执行 `install --frozen-lockfile --ignore-scripts`。不要运行 `configure-dsh-profile.mjs` 或完整 `install-dsh-profile.sh`，它们用于初始化，会重置运行偏好。
4. 执行并验证本项目 `scripts/patch-plugin-media.mjs`，参数为该 profile 下 Aurabot 与 Nekowhale 的安装目录；服务 ExecStartPre 会再次校验四处固定 hash 补丁。
5. 核对 `/etc/qqai-dsh/deepseek-api-key` 为 root:root 0600；按保存的 service 安装/daemon-reload。先启动仅 loopback 的 DSH，保持发送关闭。分别验证三插件装载、人格来源、工具白名单、真实 DeepSeek 与记忆召回。
6. 使用保存的官方镜像 digest 与同名三卷启动 SnowLuma，保持 EULA/设备验证流程，不自动跳过 QQ 平台验证。核对机器人身份、OneBot token、loopback 端口、只存在一个响应所有者。
7. 完成实际 QQ 收发和数据召回回归后，才明确开启发送与原生主动功能；恢复不能用“进程起来了”代替验收。

在同一服务器回滚版本时，先备份，再将旧服务/数据留在独立私有位置，不由本脚本删除。固定 hash 补丁不匹配时停止升级，不能为了启动而取消检查。恢复脚本的 `--apply` 故意不提供覆盖现有部署的选项。

## 已有验证与待完成项

本地已运行 4 项合成归档检查：隔离提取且不覆写、外层校验损坏拒绝、目录穿越/跨根链接/特殊文件拒绝、仅跳过明确的 Chromium 临时符号链接。它们不是服务器备份恢复验收。主任务须在实际服务器执行一次备份与默认隔离恢复演练，记录含不含已登录 QQ 卷及服务恢复状态；测试结果追加到部署日志，不把私有快照提交仓库。

## 本次实际演练

2026-10-31 已在腾讯云实际停止本项目两服务，制作包含三个网关卷的私有备份，恢复原运行状态后，在隔离目录通过checksum与提取验证。归档26071040字节，另有NTFS ACL仅允许当前Windows用户与SYSTEM的本机副本，SHA256一致。详见 `docs/evidence/20261031-backup-restore.json`。QQ尚未登录，本次不证明QQ登录态恢复或重连成功。
