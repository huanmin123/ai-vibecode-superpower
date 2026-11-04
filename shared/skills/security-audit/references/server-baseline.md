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
- 下列命令逐条执行并记录原始退出码和错误，不用未核对各进程退出码的管道、截断或丢弃标准错误来判断结果。多路径检查按已授权的具体路径逐项执行；路径不存在、无权限、工具失败和成功但无匹配分别记录，不能把未覆盖记为无异常。输出太大时先缩小授权范围，不以截断后的结果宣称全量覆盖。

## 3 检查项

以下命令以 Linux 为基准；`stat -c`、`ss`、`systemctl` 等在 macOS/Windows 上不通用，替代方式见第 6 节。命令与输出随发行版、版本和权限变化，按目标环境调整。无权限执行的项记录 `not-covered`，不要反复尝试。

### 3.1 身份与权限

```bash
id
awk -F: '$3==0 {print $1}' /etc/passwd
sudo -n awk -F: '$2=="" {print $1}' /etc/shadow
getent group sudo
getent group wheel
getent group docker
getent group adm
sudo -n -l
stat -c '%a %U:%G %n' /etc/sudoers
```

UID 0 检查仅覆盖本地 `/etc/passwd`，不代表已覆盖其他 NSS 身份源；`getent` 按组查询时退出码 2 表示未找到该组，其他非零值记录原错误；`/etc/sudoers.d` 内文件按已授权的具体路径逐项 `stat`。

若已授权枚举 NSS 账户，可在 Bash 中执行以下检查；管道只输出 UID 0 的用户名和 UID，并分别记录两端退出码：

```bash
(
  set -o pipefail
  getent passwd | awk -F: '$3 == 0 {print $1, $3}'
  statuses=("${PIPESTATUS[@]}")
  printf 'getent=%s awk=%s\n' "${statuses[0]}" "${statuses[1]}"
  (( statuses[0] == 0 && statuses[1] == 0 ))
)
```

任一端失败时，已有输出也不能视为完整结果；保留原始错误。确认各授权 NSS provider 支持并参与枚举；不支持枚举或无法确认已完整枚举的 provider 记为未覆盖，不能将空输出当作全体账户无 UID 0。

看：是否有多个 UID 0、空口令账户、过度 sudo、敏感文件可被非特权用户修改、docker 组等于事实上的 root。

### 3.2 SSH

```bash
sshd -T
stat -c '%a %U:%G %n' /etc/ssh/sshd_config
stat -c '%a %U:%G %n' ~/.ssh
stat -c '%a %U:%G %n' ~/.ssh/authorized_keys
```

检查生产生效配置前，须确认命令使用与目标运行实例相同的配置入口和启动选项，例如实际使用的 `-f` 配置文件；无法确认时不将结果归属于该实例。`sshd -T` 不带连接条件时不能代表所有 `Match` 情况。对授权范围内的具体连接，先设置实际的 `ssh_user`、客户端主机名 `ssh_host` 和客户端地址 `ssh_addr`，再执行 `sshd -T -C "user=$ssh_user,host=$ssh_host,addr=$ssh_addr"` 并带上已核实的实例配置选项；按需提供该配置使用的其他匹配条件。只对已测试条件记录有效值。无权限时可读取授权的配置文件并标注“未验证生效值”，保留原错误。

看：root 直登、口令登录、空口令、authorized_keys 权限过宽、允许任意转发。

### 3.3 系统与补丁

```bash
cat /etc/os-release
uname -a
apt list --upgradable
dnf --cacheonly check-update
apk version -l '<'
stat /var/run/reboot-required
```

按发行版只选适用的包管理器，先确认命令的本地缓存读取及日志、锁文件等副作用符合只读授权；否则记录未覆盖。`dnf --cacheonly` 不刷新缓存：退出码 100 表示列出可更新包，0 表示缓存中无可更新包，其他退出码是失败；需独立确认相关仓库缓存存在、可用及其时间，缓存缺失、不可用或过期时不能据此断言没有更新，保留原始错误并记录覆盖限制。其他包管理器的结果也仅反映本地索引，不代表最新仓库状态。重启标记不存在与 `stat` 无权限或失败要分别记录，且标记是否适用由发行版决定。

看：版本是否 EOL、是否有安全更新未装、是否需要重启生效。补丁是否可利用要结合具体 CVE 与运行服务，不能只看"有更新"。

### 3.4 服务与端口

```bash
ss -lntup
systemctl list-units --type=service --state=running --no-pager
systemctl list-unit-files --state=enabled --no-pager
```

看：监听地址是 `0.0.0.0` 还是 `127.0.0.1`、是否有调试/管理端口、是否有不必要的对外服务。本地监听不等于公网可达，需结合防火墙/安全组。

### 3.5 文件权限

```bash
find /etc -xdev -perm -0002 -type f
find /etc -xdev -perm -4000 -type f
stat -c '%a %U:%G %n' /etc/passwd
stat -c '%a %U:%G %n' /etc/shadow
stat -c '%a %U:%G %n' /etc/crontab
```

上述 `find` 仅覆盖 `/etc`；其他授权目录按路径逐项执行并记录范围。SUID 用 `-perm -4000`，SGID 另用 `-perm -2000` 检查。遍历失败时即使已有输出也不能宣称覆盖完整。看：全局可写文件（持久化/篡改）、异常 SUID/SGID（提权）、敏感文件权限。

### 3.6 计划任务与持久化

```bash
crontab -l
ls -la /etc/cron.d
systemctl list-timers --all --no-pager
```

其他 cron 目录按已授权的具体路径逐项检查。`crontab -l` 仅查询当前账户；结合原始提示区分无 crontab 与权限或工具错误。看：未知任务、以高权限运行的用户可控脚本、任务脚本所在目录可写。

### 3.7 日志与审计

```bash
systemctl show auditd --property=LoadState,ActiveState,SubState,UnitFileState --no-pager
ls -la /var/log
rg -n 'authpriv|audit' /etc/rsyslog.conf
rg -n 'authpriv|audit' /etc/rsyslog.d
rg -n 'authpriv|audit' /etc/systemd/journald.conf
```

`systemctl show` 仅检查服务状态字段，不读取日志片段；`LoadState` 为 `not-found` 时不能当作服务正常。`rg` 退出码 0 为匹配、1 为无匹配、大于 1 为错误；检查授权路径且输出只保留与结论相关的片段。看：是否有认证/管理操作审计、日志保留与轮转、应用账户能否删改自己的日志。日志缺失属于可观测性缺口，不等于入侵。

### 3.8 TLS 与证书

```bash
openssl s_client -connect 127.0.0.1:443 -servername "$tls_hostname" -verify_hostname "$tls_hostname" -verify_return_error -brief </dev/null
```

执行前将 `tls_hostname` 设为本机服务证书对应的实际 DNS 名称，并确认本地 443 端口在授权内；命令只连接 `127.0.0.1`。确认 OpenSSL 支持这些参数和实际使用的信任库；成功握手且验证通过才记录该次连接协商的协议和证书链、主机名验证结果，失败保留原错误。过期时间需另行读取并核对该端点实际呈现的证书；没有证据时记未验证。一次连接的协商协议不代表服务支持的全部协议版本。

### 3.9 容器

```bash
env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host "unix://${docker_socket:?须指定已核实的 Docker socket}" inspect --format '{{.Name}} privileged={{.HostConfig.Privileged}} user={{.Config.User}} net={{.HostConfig.NetworkMode}} mounts={{range .Mounts}}{{.Source}}:{{.Destination}}:{{.RW}} {{end}}' "${container_id:?须指定已授权的容器 ID}"
```

事先确认授权的 daemon 身份和连接范围，设置 `docker_socket` 为该本机 daemon 的绝对 UNIX socket 路径并确认其为 socket；UNIX socket 也可能转发到远端，路径本身不能证明 daemon 在本机。清除环境中的 Docker 目标选择并显式指定该 socket；无法确认目标时不执行。仅对已确认授权的容器逐个设置 `container_id` 并执行 inspect。只有明确授权枚举整个 daemon 时，才先执行 `env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host "unix://${docker_socket:?须指定已核实的 Docker socket}" ps --quiet --no-trunc`；该命令失败或成功但无容器均不执行 inspect，并分别记录失败或空结果。该枚举仅覆盖运行中的容器，停止的容器未覆盖。只输出 ID 与所需配置字段，不打印容器 command、环境变量或完整 inspect。看：privileged、宿主网络、docker socket 挂载、以 root 运行、敏感目录可写挂载；未配置 user 不自动证明实际运行身份。不要 `docker exec` 进入容器修改状态。

### 3.10 密钥与备份

```bash
ls -ld ~/.aws
ls -ld ~/.ssh
ls -ld ~/.config/gcloud
```

其他授权的 `.env` 文件按具体路径逐项用 `stat -c '%a %U:%G %n'` 检查。只记录存在性与权限，不读取内容。备份检查只记录配置、最近运行时间与是否有恢复演练证据；没有恢复测试就不能断言"备份可用"。

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
| 运行身份 | app 以 root 运行 | `ps -o user= -C app` @ ... | 影响放大 | 外部可达性未知 |
| SSH | PermitRootLogin yes | `sshd -T -C ...` @ ... | 指定连接条件下有直登风险 | 其他匹配条件及网络隔离未核实 |

覆盖：已查 x 项，未覆盖 y 项（原因）。
声明：主机基线只覆盖采集到的配置与状态，不证明不存在其他问题。
```
