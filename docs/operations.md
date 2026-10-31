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
| Nekowhale资源 | DSH_HOME/nekowhale-stickers |
| API凭据 | /etc/qqai-dsh/deepseek-api-key，root:root、0600 |
| Snow管理初始密码 | /etc/qqai-dsh/snowluma.env，root:root、0600 |
| 网关容器 | qqai-dsh-snowluma |
| 备份 | /var/backups/qqai-dsh，root私有 |

systemd 使用 LoadCredential 把 Key 传入运行进程。配置、启动参数、Git和公开证据不含Key。`bootstrap-host.sh` 安装依赖；`install-dsh-profile.sh` 为新部署初始化profile；两者不是在线更新命令。尤其不要在运行中的陪伴系统上重跑初始化器，因为它会重新关闭发送、重置初始选项。升级应先备份、停服务、审核版本及四处hash补丁，再安装锁定依赖并恢复同项目私有配置。

## 管理与健康检查

```bash
sudo systemctl is-active qqai-dsh.service
sudo python3 /opt/qqai-dsh/source/deployment/healthcheck.py
sudo systemctl restart qqai-dsh.service
sudo docker compose -p qqai-dsh \
  -f /opt/qqai-dsh/source/deployment/snowluma.compose.yml \
  -f /opt/qqai-dsh/source/deployment/snowluma.offline.compose.yml ps
```

本部署因腾讯云直连Docker Hub失败，使用原官方镜像的离线传输；第二个Compose文件指定已经核实的本地镜像ID并禁止自动拉取。普通恢复和更新不要漏掉该文件。镜像版本、manifest/config digest以及离线传输方法见[Snow运行文档](snowluma-runtime.md)。

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

## 用户醒来后的接入步骤

1. 用户已经确认取得SnowLuma权利人对本次自动部署的书面授权；官方WebUI内EULA与隐私协议的个人阅读/接受状态单独处理，不伪造该记录。
2. 用户在noVNC完成机器人QQ扫码及任何设备验证。不得代替验证或重复绕过平台限制。
3. 用户确认机器人QQ身份和唯一主人QQ号。把号码写进私有Aurabot配置，不进Git。群白名单保持空；只开放机主私聊。
4. 工程师确认OneBot token配置、用户模块已加载、所有hash补丁与实际QQ会话工具清单正确，然后才开启Aurabot真实发送；保持其他平台发帖、文件发送、语音和头像文件输入关闭。
5. 在真实QQ测试多轮/多气泡、人格、合成长期记忆与纠错、跨会话召回、图片及追问、Neko图/GIF/中文模板、搜索和Fetch。模型工具成功不代替QQ收到图片。
6. 确认原生主动聊天频率、安静时段及未回复行为后启用speakup；purpose保持关闭。以真实调度验证，不能只手工触发一次代替。
7. 登录后再分别重启DSH和网关，验证QQ重连、无重复发送与登录态恢复；更新备份并做隔离恢复演练。确认观察窗口中的资源与错误情况后，再记录长期运行结果。

当前所有自动化/真实API测试使用合成数据。运行目录可能保留名为qqai-synthetic的验收会话；这些是本项目新测试记录，不是旧项目迁移数据。它们不替代Aurabot长期记忆与真实QQ验收。

## 费用与版本

用户已同意从北京时间2026-11-01 00:00起按官方价格持续启用DeepSeek Search/Fetch；当时公告为每千次成功请求各0.75美元。模型调用仍按官方Token价格计费，未授权自动充值、升级实例或购买额外服务。价格未来变化时应重新核实。[官方说明](https://api-docs.deepseek.com/guides/search/#billing)

完整版本与依赖见 `versions.lock.json`、`deployment/locks/`。恢复脚本与实际演练边界见[备份恢复](backup-restore.md)。不得只升级某一个包后继续沿用旧的通过结论。
