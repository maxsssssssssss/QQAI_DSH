# SnowLuma 官方镜像部署记录

日期：2026-10-31（Asia/Shanghai）。官方镜像已在服务器运行，用户亲自完成协议确认和QQ登录；经官方进程load接口接入后，实际主人QQ聊天与媒体通过。用户随后停止进一步测试；当前自动注入仍为0，重启恢复未验收。本文保留首次准备的源码和镜像核查过程，最新状态以[部署日志](deployment-log.md)和[运维记录](operations.md)为准。

## 固定发行物

使用官方发布的 `motricseven7/snowluma:v2.2.1`，不自行构建或打包。配置为 [snowluma.compose.yml](../deployment/snowluma.compose.yml)，Compose 项目名 `qqai-dsh`，容器名 `qqai-dsh-snowluma`，目标 `linux/amd64`。

| 核实项 | 结果 |
| --- | --- |
| 官方 tag | `v2.2.1`，2026-10-31 Registry API 可取得 |
| 多架构 index | `sha256:29536cd34e9c9c3f8a942be4e5cd6a17d366acd9b2096aa56b5863d024a80d23` |
| 部署所用 amd64 manifest | `sha256:74d6874a4240636dca700734f31fbce7d0735cbce6bb43780dd8e3788eddccc9` |
| amd64 config | `sha256:f819e96808d03205ba2a6a152903de9e3b0aa01787ea6d1da5091b4e4e333fc1` |
| config 声明创建时间 | `2026-10-27T09:36:35.116513154Z` |
| config 声明 Node | `24.22.1`，满足 v2.2.1 要求；运行后仍核实 `node --version` |
| 压缩镜像层合计 | `736507917` 字节，约 702 MiB；不代表解压后占用 |
| arm64 manifest（本次不用） | `sha256:201032279d5d4a1d335f8969e8096d20abc8e7037f1e3b016dbeab883e6f637d` |

元数据通过 Docker Registry v2 的 `motricseven7/snowluma` 仓库 manifest/config 接口读取；index、amd64 manifest、config 原始响应体均重新计算 SHA256，与其声明 digest 一致。认证使用仅此公开仓库 pull 范围的临时 token，未打印或保存。镜像出处由 [官方 Docker 指南](https://snowluma.github.io/zh/docs/guide/deploy/docker)与[固定框架 README](https://github.com/SnowLuma/SnowLuma.Docker.Framework/blob/3f388b17f8baf47b4c2c9606b8a3121eb8599fef/README.md)确认。[Docker Hub 镜像页](https://hub.docker.com/r/motricseven7/snowluma)

## 许可和首次操作

用户已确认取得本次自动部署的权利人书面授权；工程师未查看授权文本。详见[许可记录](snowluma-license-review.md)。Compose 未设置 `SNOWLUMA_ACCEPT_EULA`／`SNOWLUMA_ACCEPT_PRIVACY`，未预写接受记录。

固定发行源码 [consent.ts](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/packages/core/src/webui/consent.ts)将未设置变量解析为未接受；[server.ts](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/packages/core/src/webui/server.ts)在该状态继续创建 WebUI，登录后允许协议页面及接受接口，阻止其他管理 API。预期可先启动等待用户；这是源码证据，首次运行还需确认镜像行为。若实际镜像退出，不以自动接受变量绕过。

启动阶段 `SNOWLUMA_HOOK_AUTOLOAD=0`，先不自动注入 QQ。用户经隧道登录 WebUI 阅读并接受协议；若官方面板要求首次改密则按其提示处理，再于 noVNC 完成 QQ 扫码／设备验证。完成后由工程师将该字段改为 `1` 并重建容器，以便重启后恢复注入和连接；该最终配置及 QQ 恢复必须另行验收。

## 网络与容器权限

| 宿主监听 | 用途 | 访问方式 |
| --- | --- | --- |
| `127.0.0.1:6081` | noVNC | SSH 隧道，仅用户扫码时访问 |
| `127.0.0.1:5099` | SnowLuma WebUI | SSH 隧道 |
| `127.0.0.1:3000` | OneBot HTTP | 宿主 Aurabot，配置独立 token |
| `127.0.0.1:3001` | OneBot 正向 WebSocket | 宿主 Aurabot，配置独立 token |

容器内服务监听 `0.0.0.0` 以接收 Docker 映射；宿主映射只监听 loopback。未发布原生 VNC 5900，不新增公网防火墙规则。

官方注入需要 `SYS_PTRACE` 和 `seccomp=unconfined`，用于容器内 QQ 进程；这些能力比 Docker 默认隔离更宽，不能称为完全无特权。配置没有 `privileged`、host network、宿主路径或 Docker socket 挂载；不把 DSH 用户加入 Docker 组。[官方权限说明](https://snowluma.github.io/zh/docs/guide/deploy/docker)

镜像入口以 root 准备用户、数据目录及 VNC，再按官方机制运行服务。不得未经实测强加 `user`／`no-new-privileges` 导致注入失败，也不得因此给容器增加其他权限。`shm_size: 1gb` 是共享内存上限，不是启动即固定占用 1 GB 物理内存。

## 私有凭据及持久卷

| Docker 卷名 | 容器路径 | 私有内容 |
| --- | --- | --- |
| `qqai-dsh-snowluma-data` | `/app/data` | 网关配置、OneBot token、WebUI认证、协议接受记录、VNC密码 |
| `qqai-dsh-qq-config` | `/app/.config` | QQ 客户端配置 |
| `qqai-dsh-qq-data` | `/app/.local/share` | QQ 登录态与用户数据 |

Compose 不含密码。官方入口首次随机生成 VNC 密码，保存到 `/app/data/config/vnc-password`，属主 root、权限 0600；它会在首次启动日志中打印密码，因此容器日志也属于私有运行数据。[固定 start.sh](https://github.com/SnowLuma/SnowLuma.Docker.Framework/blob/3f388b17f8baf47b4c2c9606b8a3121eb8599fef/start.sh)

工程师不得把完整日志、VNC 密码、WebUI 初始密码或 token 输出到聊天或 Git。需要用户查看密码时，提取到受保护的本地运行文件并只提供文件位置。本部署使用受保护的随机 bootstrap 密码；未使用 bootstrap、由官方生成的首次密码应按面板要求修改。不固定或复用公开示例密码。备份及证据收集也不得包含可直接用于登录的公开输出。

## 执行、检查和恢复接口

由主工程师在已核验指纹的服务器上执行。以下命令不含凭据，实际运行结果需记录；本次资产准备没有执行服务器变更。

```bash
docker compose -p qqai-dsh -f deployment/snowluma.compose.yml config --quiet
docker compose -p qqai-dsh -f deployment/snowluma.compose.yml pull
docker compose -p qqai-dsh -f deployment/snowluma.compose.yml up -d
docker compose -p qqai-dsh -f deployment/snowluma.compose.yml ps
docker inspect --format '{{json .NetworkSettings.Ports}}' qqai-dsh-snowluma
docker exec qqai-dsh-snowluma node --version
docker exec qqai-dsh-snowluma supervisorctl status
```

首次检查实际 WebUI 可登录但等待协议接受、四个端口只在 loopback、QQ 身份正确、镜像内版本 2.2.1，并记录实际镜像 ID及 digest。未扫码状态只能算服务准备，不能算 QQ 验收。OneBot 启用后配置 token 并核对 Aurabot owner/bot 身份，真实发图与 GIF 行为另测。

备份必须同时覆盖上表三个卷和最终 Compose；先停止 Aurabot 发信与网关写入，再制作离机私有备份，保存校验和，限制文件 0600／目录 0700。不能只备份 Git 代码，也不能使用 `down -v`。本文件不代替实际备份／恢复演练：主部署备份脚本必须纳入三卷，恢复到相同卷名和属主，使用固定镜像重新启动，并验证登录态、OneBot、未重发历史消息。升级前保留旧 digest 与三卷快照；许可文本变化时重新由运营者确认。

## Docker Hub 不可达时的官方原镜像离线运输

本次服务器访问 Docker Hub 出现超时／TLS reset，指定本地核实的正确 Registry IPv4 仍失败。没有修改服务器全局 DNS、Docker daemon，也没有改用不明镜像站。官方框架虽提供可选 GHCR 发布，但本次 `ghcr.io/snowluma/snowluma` 的匿名授权请求返回 401，未能验证可公开拉取的同 digest 镜像。

[fetch-official-snowluma.py](../deployment/fetch-official-snowluma.py)在可连官方 Registry 的 Linux 机器下载固定官方 index、amd64 manifest、config 与 13 个原始压缩层。它最多使用三个并发下载，验证每个原始对象的 SHA256／大小，并验证各压缩层解压流的原始 `rootfs.diff_ids`。脚本不会提取镜像文件到宿主、执行组件、运行构建或修改 config／层内容；仅添加 OCI／Docker 运输描述文件。匿名 pull token、签名 URL 不输出也不保存。

```bash
python3 deployment/fetch-official-snowluma.py \
  --output-dir /tmp/qqai-dsh-snow-image
```

输出为同目录 `snowluma-v2.2.1-amd64-original.tar`、`SHA256SUMS`、`transfer-evidence.json` 和原始 blob 缓存。目录 0700、运输包 0600。下载中断可重跑；已通过校验的 blob 会复用。`--cached-only` 完全禁止网络；`--verify-only` 只核查已有 blob／diff ID，不重写运输包。

首次实际生成的运输包为 736563200 字节，SHA256 `d4788c192397e41ea11f52ffc7817290a2f1088a293e5d01cc5d215d71249efb`。后续脚本生成的运输描述格式或排序若变化，外层 tar 校验值可能变化；每次以新生成的 `SHA256SUMS` 核实运输，官方 manifest/config/layer digest 仍须与本节固定值完全一致。

通过已严格核实主机指纹的 SCP／SSH 把运输包、校验文件及证据送入服务器 root 0700 私有目录。不要把这些二进制上传 GitHub或公开对象存储；它们只用于同一用户已授权部署的私有运输。

```bash
# 在服务器私有接收目录运行；不输出容器配置或凭据。
sha256sum --check SHA256SUMS
docker load --input snowluma-v2.2.1-amd64-original.tar
docker image inspect --format '{{.Id}}' docker.io/motricseven7/snowluma:v2.2.1
```

目标服务器 Docker 29 使用 containerd image store。2026-10-31 实际导入后，按完整 ID 检查得到 `sha256:74d6874a4240636dca700734f31fbce7d0735cbce6bb43780dd8e3788eddccc9`、平台 `linux/amd64`；该 ID 是原始 manifest digest。`sha256:f819e96808d03205ba2a6a152903de9e3b0aa01787ea6d1da5091b4e4e333fc1` 仍是已经逐字节校验的官方 config digest，并非这台 Docker 的 image ID。经典 Docker image store 的 ID 则使用 config digest，恢复到不同存储后端必须重新核对实际结果。

首次运输包的 OCI descriptor 使用了未完整限定的名称，造成 Docker 29 显示导入成功且 `image ls` 可见，但常规 tag 查询失败。containerd [官方导入实现](https://github.com/containerd/containerd/blob/df9406883d6e0acd28b5f4c3d1e7f2f70efd14d9/core/images/archive/importer.go)优先采用 OCI 元数据，保留其原有名称；只有 Docker archive 分支会规范化名称。无需重新下载或上传镜像，可按已验证 manifest ID 增加完整 tag：

```bash
docker tag sha256:74d6874a4240636dca700734f31fbce7d0735cbce6bb43780dd8e3788eddccc9 \
  docker.io/motricseven7/snowluma:v2.2.1
docker image inspect --format '{{.Id}}' docker.io/motricseven7/snowluma:v2.2.1
```

下载脚本现为后续运输包写入 `io.containerd.image.name=docker.io/motricseven7/snowluma:v2.2.1` 和 tag 形式的 OCI `ref.name`；保留首次实际部署的原运输包与上述 SHA256，不重写。所有官方 config、manifest 和层字节保持原样。Moby [经典加载实现](https://github.com/moby/moby/blob/8c037227b5c4ab012189621bf775f9f64856b56b/daemon/internal/image/tarexport/load.go)也支持读取压缩层并检查解压 diff ID。

`docker load` 可能不恢复 Registry `RepoDigests`，因此提供 [snowluma.offline.compose.yml](../deployment/snowluma.offline.compose.yml)。它用目标 Docker 29 已实证的原始 manifest image ID 固定本地镜像，并设置 `pull_policy: never`，避免 Compose 又去不可达的 Registry。它不会改变网络、卷、权限或镜像内容。恢复到经典 image store 时，应在私有 override 中改用已验证的 config image ID，不能直接假定两种后端的 ID 相同。

```bash
docker compose -p qqai-dsh \
  -f /opt/qqai-dsh/source/deployment/snowluma.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.offline.compose.yml \
  config --quiet
docker compose -p qqai-dsh \
  -f /opt/qqai-dsh/source/deployment/snowluma.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.offline.compose.yml \
  up --pull never -d
```

若还使用 root 私有的 bootstrap env-file override，保持该私有 override 为最后一个 `-f`；不得把其内容输出到日志或 Git。恢复时先导入并核实镜像 ID，再使用相同两份 Compose 和三卷。完整证据链是：固定官方 index → amd64 manifest → 原压缩层 digest 与 config digest → 解压 diff ID → 导入后 image ID。不能用一个来源不明的同名 tag 代替这些检查。

## 可选的官方 WebUI 随机密码预置

固定版本 [auth.ts](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/packages/core/src/webui/auth.ts)支持 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD`。它只在没有有效 `config/webui.json` 的首次初始化使用，随后存储带随机盐的 scrypt hash，且不会打印该口令；此机制独立于 EULA／PRIVACY 接受。

如使用，先生成随机强口令写入 root 0600 私有 env-file，通过私有 Compose override 注入；首次初始化成功后可移除 env-file 注入并重建容器，现存的有效密码 hash 会保留。不要打印完整 `docker inspect`／`docker compose config`，因为环境字段可能含明文口令。已有 `mustChangePassword: true` 配置不会被该环境变量直接覆盖，应走官方首次改密流程，不盲删认证文件。

OneBot token 没有在已核查源码中发现对应预置环境变量；准确字段是 `/app/data/config/onebot.json` 的 `networks.httpServers[].accessToken` 与 `networks.wsServers[].accessToken`。官方 Docker 入口已首次分别生成 32 随机字节的 token。工程师可私有读取并同步 Aurabot 的 HTTP／WS token，不能在报告中输出值。[固定 OneBot 配置实现](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/packages/onebot/src/config.ts)

首次准备私有随机密码可执行 `sudo python3 deployment/prepare-snowluma-secrets.py`；现有有效私有文件不会被覆盖。实际容器已核验 runtime 2.2.1、Node v24.22.1，WebUI/noVNC HTTP200；准备阶段未登录QQ，后续实际登录记录见部署日志。
