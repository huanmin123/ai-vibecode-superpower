# 主机只读基线

用于用户明确要求审查服务器/主机，并提供了只读访问的场景。目标是采集**可核对的事实**，不是拿清单打分，也不是提权或漏洞利用。

## 1 授权门

开工前必须确认：目标主机、账户、时间窗、只读要求、可采集的数据范围、报告输出位置。缺少任一项，不要执行。

禁止：

- 修改配置、重启服务、安装/升级软件包、清理日志；
- 读取或导出业务数据、完整凭据、私钥内容；
- 口令破解、提权尝试、横向移动、端口扫描第三方；
- 把采集结果发送到未授权的外部服务。

敏感值只记录类型、位置、权限与前缀/长度；不打印完整值。

## 2 采集原则

- 每条命令记录：主机、执行身份、命令、时间、退出码。
- 优先非交互命令；需要 `sudo` 时用 `sudo -n`，无权限就记录 `not-covered`，不反复尝试。
- 只读命令也可能有副作用（更新缓存、写临时文件）；避免 `apt update`、`dnf makecache`、`updatedb` 等。
- 输出可能含敏感信息；报告只保留与结论相关的片段。
- 单主机结论不外推到同集群其他主机，除非逐台核实。

## 3 检查项

以下命令以 Linux 为基准；`stat -c`、`ss`、`systemctl` 等在 macOS/Windows 上不通用，替代方式见第 6 节。命令与输出随发行版、版本和权限变化，按目标环境调整。无权限执行的项记录 `not-covered`，不要反复尝试。

### 3.1 身份与权限

```bash
id
getent passwd | awk -F: '$3==0 {print $1}'
sudo -n awk -F: '$2=="" {print $1}' /etc/shadow 2>/dev/null
getent group | grep -E '^(sudo|wheel|docker|adm)\b'
sudo -n -l 2>&1
stat -c '%a %U:%G %n' /etc/sudoers /etc/sudoers.d/* 2>/dev/null
```

看：是否有多个 UID 0、空口令账户、过度 sudo、敏感文件可被非特权用户修改、docker 组等于事实上的 root。

### 3.2 SSH

```bash
sshd -T 2>/dev/null | grep -Ei 'permitrootlogin|passwordauthentication|pubkeyauthentication|permitemptypasswords|x11forwarding|allowtcpforwarding|maxauthtries'
stat -c '%a %U:%G %n' /etc/ssh/sshd_config ~/.ssh ~/.ssh/authorized_keys 2>/dev/null
```

`sshd -T` 输出的是生效配置；无权限时退回读取配置文件并标注"未验证生效值"。

看：root 直登、口令登录、空口令、authorized_keys 权限过宽、允许任意转发。

### 3.3 系统与补丁

```bash
cat /etc/os-release
uname -a
command -v apt >/dev/null && apt list --upgradable 2>/dev/null | head -50
command -v dnf >/dev/null && dnf -q check-update 2>/dev/null | head -50
command -v apk >/dev/null && apk version -l '<' 2>/dev/null | head -50
[ -f /var/run/reboot-required ] && cat /var/run/reboot-required
```

看：版本是否 EOL、是否有安全更新未装、是否需要重启生效。补丁是否可利用要结合具体 CVE 与运行服务，不能只看"有更新"。

### 3.4 服务与端口

```bash
ss -lntup 2>/dev/null || ss -lnt
systemctl list-units --type=service --state=running --no-pager 2>/dev/null
systemctl list-unit-files --state=enabled --no-pager 2>/dev/null
```

看：监听地址是 `0.0.0.0` 还是 `127.0.0.1`、是否有调试/管理端口、是否有不必要的对外服务。本地监听不等于公网可达，需结合防火墙/安全组。

### 3.5 文件权限

```bash
find /etc /opt /srv /var/www -xdev -perm -0002 -type f 2>/dev/null | head -50
find / -xdev -perm -4000 -type f 2>/dev/null | head -50
stat -c '%a %U:%G %n' /etc/passwd /etc/shadow /etc/crontab 2>/dev/null
```

看：全局可写文件（持久化/篡改）、异常 SUID/SGID（提权）、敏感文件权限。`find /` 可能较慢，按需限定路径并记录范围。

### 3.6 计划任务与持久化

```bash
crontab -l 2>/dev/null
ls -la /etc/cron.* /etc/cron.d 2>/dev/null
systemctl list-timers --all --no-pager 2>/dev/null
```

看：未知任务、以高权限运行的用户可控脚本、任务脚本所在目录可写。

### 3.7 日志与审计

```bash
systemctl status auditd --no-pager 2>/dev/null | head -20
ls -la /var/log 2>/dev/null | head -40
grep -RIn 'authpriv\|audit' /etc/rsyslog* /etc/systemd/journald.conf 2>/dev/null
```

看：是否有认证/管理操作审计、日志保留与轮转、应用账户能否删改自己的日志。日志缺失属于可观测性缺口，不等于入侵。

### 3.8 TLS 与证书

```bash
openssl s_client -connect 127.0.0.1:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

仅连本机；不要对第三方目标探测。看：过期时间、协议版本、证书链、是否与主机名匹配。

### 3.9 容器

```bash
docker ps --no-trunc 2>/dev/null
docker inspect --format '{{.Name}} privileged={{.HostConfig.Privileged}} user={{.Config.User}} net={{.HostConfig.NetworkMode}} mounts={{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' $(docker ps -q) 2>/dev/null
```

看：privileged、宿主网络、docker socket 挂载、以 root 运行、敏感目录可写挂载。不要 `docker exec` 进入容器修改状态。

### 3.10 密钥与备份

```bash
stat -c '%a %U:%G %n' /etc/app/*.env /opt/*/.env 2>/dev/null
ls -la ~/.aws ~/.ssh ~/.config/gcloud 2>/dev/null
```

只记录存在性与权限，不读取内容。备份检查只记录配置、最近运行时间与是否有恢复演练证据；没有恢复测试就不能断言"备份可用"。

## 4 常见判定

| 观察 | 可能结论 | 必须补的条件 |
| --- | --- | --- |
| 服务以 root 运行 | 漏洞影响放大到整机 | 该服务是否可被外部触达 |
| SSH 允许 root/口令登录 | 暴力破解与直登风险 | 是否有网络隔离/堡垒机/限流 |
| 全局可写文件 | 持久化/篡改 | 是否被高权限进程加载 |
| 异常 SUID | 本地提权 | 文件是否可被低权用户替换/利用 |
| 管理端口监听 0.0.0.0 | 暴露面 | 防火墙/安全组是否真的放行 |
| 有未装补丁 | 已知漏洞适用性 | 具体 CVE、服务版本、可达性 |
| 容器 privileged | 宿主逃逸风险 | 容器内是否可被攻击者控制 |
| 无认证审计 | 检测缺口 | 是否有平台侧日志 |

## 5 不能得出的结论

- 不能因为"没发现异常"断言主机安全。
- 不能仅凭本地监听端口断言公网暴露。
- 不能仅凭包版本断言漏洞可利用。
- 不能在没有恢复演练证据时断言备份可用。
- 不能在没有凭据有效性验证时断言泄露密钥仍有效（验证需另行授权）。

## 6 其他平台

- macOS：`launchctl list`、`dscl . -list /Users`、`system_profiler SPSoftwareDataType`、`socketfilterfw --getglobalstate`、`spctl --status`、`fdesetup status`；权限与 TCC 需单独看。
- Windows：`Get-LocalUser`、`Get-LocalGroupMember Administrators`、`Get-Service`、`Get-NetTCPConnection -State Listen`、`Get-MpComputerStatus`、`auditpol /get /category:*`、`icacls`、更新历史。只用只读 cmdlet。

## 7 输出

```markdown
## L4 主机基线

| 检查 | 观察 | 证据（命令/时间） | 结论 | 未验证项 |
| --- | --- | --- | --- | --- |
| 运行身份 | app 以 root 运行 | `ps -o user,cmd -C app` @ ... | 影响放大 | 外部可达性未知 |
| SSH | PermitRootLogin yes | `sshd -T` @ ... | 直登风险 | 网络隔离未核实 |

覆盖：已查 x 项，未覆盖 y 项（原因）。
声明：主机基线只覆盖采集到的配置与状态，不证明不存在其他问题。
```
