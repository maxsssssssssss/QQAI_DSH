# SnowLuma 许可与官方部署路径核对

核对日期：2026-10-31（Asia/Shanghai）。这是工程实施前的许可核对记录，不是法律结论。状态：**用户已明确确认取得作者或权利人对本次自动部署的书面授权，因此本次官方镜像部署可继续。工程师未查看授权文本，不能记为已独立核验授权内容。**此确认不等于用户已阅读并接受 EULA／PRIVACY；初次官方 WebUI 接受仍留给用户，与 QQ 扫码同一环节完成。本项目未联系作者，也不提交私人授权往来。

## 版本及原始证据

| 对象 | 本次核实结果 | 原始来源 |
| --- | --- | --- |
| 最新正式发行 | v2.2.1，发布于 2026-10-27；Linux x64／arm64 均有完整及 Lite 包 | [官方 Release](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.1) |
| 发行源码锚点 | `8ffd314260e9e2b6967eeca494d87aa5be046c34` | [标签 API](https://api.github.com/repos/SnowLuma/SnowLuma/git/ref/tags/v2.2.1) |
| EULA | 1.1，生效 2026-07-21；v2.2.1 与本次 main 的文件 blob 均为 `59198c2498a965d1fa19ab684e792f3f4c3f4a04` | [固定版本 EULA](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/EULA.md) |
| 源码许可 | SnowLuma Source-Available Non-Commercial License 1.0；不属于 OSI 开源许可，原生组件不在源码许可内 | [固定版本 LICENSE](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/LICENSE) |
| 隐私声明 | 1.0，生效 2026-06-19；需由运营者阅读并确认 | [固定版本 PRIVACY](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/PRIVACY.md) |
| Docker 框架 | 本次 main：`3f388b17f8baf47b4c2c9606b8a3121eb8599fef` | [官方框架](https://github.com/SnowLuma/SnowLuma.Docker.Framework/tree/3f388b17f8baf47b4c2c9606b8a3121eb8599fef) |

## 原先暂停自动安装的依据

EULA §5.4 明列“通过自动化脚本部署”，并要求“均须事先取得书面授权”。该条适用于专有组件，并未在条文中明确豁免个人自用或执行官方脚本；§2.5 将发行包专有组件及二进制特有事项交由 EULA 约束。[EULA](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/EULA.md)

另一方面，[官方 Docker 指南](https://snowluma.github.io/zh/docs/guide/deploy/docker)推荐官方镜像和 Compose；[框架 README](https://github.com/SnowLuma/SnowLuma.Docker.Framework/blob/3f388b17f8baf47b4c2c9606b8a3121eb8599fef/README.md)提供安装脚本。[v2.2.1 发布说明](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.1)还提供 `SNOWLUMA_ACCEPT_EULA=1` 与 `SNOWLUMA_ACCEPT_PRIVACY=1` 的无人值守确认方式。

这些入口证明上游支持自动化技术路径，但本次所查材料没有明确说明它们如何豁免或满足 §5.4。**不能由官方脚本存在、个人用途或用户同意 EULA，推定已经获得权利人的额外书面授权。**这是实施边界判断；应由权利人澄清具体场景，不能由本项目替其作扩大解释。

## 本次授权状态与后续范围

用户于本轮选择了“已取得作者或权利人对本次自动部署的书面授权”。工程执行依此用户确认继续；授权文本由用户私有保存，当前未提供给工程师。该记录仅适用于本次任务，不推定包含商业使用、公开打包、再分发或范围外的后续部署。

自动部署授权与运营者接受发行包 EULA／PRIVACY 是不同事项。Compose 不设置 `SNOWLUMA_ACCEPT_EULA` 或 `SNOWLUMA_ACCEPT_PRIVACY`，不预写 `consent.json`；由用户经 SSH 隧道登录官方 WebUI 阅读并确认。固定版本 [consent.ts](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/packages/core/src/webui/consent.ts)及 [server.ts](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/packages/core/src/webui/server.ts)显示：未接受时仍启动 WebUI，普通管理 API 被协议门禁限制；登录后可读取协议及提交接受。此处为源码核实，实际固定镜像行为仍由首次运行检查。

## 许可确认后的技术检查项

- 官方镜像 `motricseven7/snowluma:v2.2.1` 已通过 Docker Registry API 核实存在，manifest 与 config 响应的本地 SHA256 计算均吻合。linux/amd64 固定 digest 为 `sha256:74d6874a4240636dca700734f31fbce7d0735cbce6bb43780dd8e3788eddccc9`；详见 [运行记录](snowluma-runtime.md)。镜像层内容、容器内版本与运行状态仍待实际拉取运行核实。[官方指南](https://snowluma.github.io/zh/docs/guide/deploy/docker)
- 文档仍有 Node 22 的旧描述，但固定框架 [Dockerfile](https://github.com/SnowLuma/SnowLuma.Docker.Framework/blob/3f388b17f8baf47b4c2c9606b8a3121eb8599fef/Dockerfile)已用 Node 24；v2.2.1 [package.json](https://github.com/SnowLuma/SnowLuma/blob/8ffd314260e9e2b6967eeca494d87aa5be046c34/package.json)要求 `^24.22.1 || >=26.12.1`。不能只检查主版本号。
- 官方 [Compose](https://github.com/SnowLuma/SnowLuma.Docker.Framework/blob/3f388b17f8baf47b4c2c9606b8a3121eb8599fef/docker-compose.yml)要求 `SYS_PTRACE`、`seccomp=unconfined` 与 1 GB shm，并持久化三个数据卷。后续应向用户具体说明容器权限需求，宿主端口改为 `127.0.0.1`，保留 SSH 隧道；不能照抄其默认全接口端口映射。
- 不公开再分发上游专有组件、整合镜像或登录态；Git 仅保存自己的配置、适配代码与来源记录。本次 Docker Hub 不可达时，在用户已确认授权范围内私有运输官方原始镜像，保留全部原始 digest，不构建修改镜像；运输包不入 Git。恢复也遵守相同授权范围。

本记录不依赖旧 QQAI 代码、人格、记忆或数据库。
