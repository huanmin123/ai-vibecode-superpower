# SSH 与跨主机执行

同时读取本地平台文档和远端平台文档。本地 Shell 只构造 SSH 参数；远端命令只使用远端 Shell 语法。用户提供连接凭据只授权该连接，不授权无关的远端写操作。

## 默认认证与最小干预

首次连接先使用用户已经配置且经运行结果验证的默认认证链，例如 SSH 配置、`ssh-agent`、公钥、硬件密钥、跳板机或代理。除端口、可信主机密钥策略和连接超时外，不要预先设置 `PreferredAuthentications`、`PubkeyAuthentication=no`、`PasswordAuthentication=yes` 等选项来关闭或重排认证方式。

```powershell
$ssh = (Get-Command ssh.exe -ErrorAction Stop | Select-Object -First 1).Source
$target = 'user@host.example.com'
& $ssh -o 'StrictHostKeyChecking=accept-new' -o 'ConnectTimeout=10' -- $target
$exit = $LASTEXITCODE
if ($exit -ne 0) { throw "SSH 默认认证失败：$exit" }
```

`ssh -G <host>` 可用于检查客户端最终会采用哪些配置，但不证明网络、代理或认证成功。默认连接已成功时，它就是认证路径正确的证据；不要为了“确认密码”或“统一命令”改成受限认证方式。

只有用户明确要求密码认证，或默认路径的完整错误证据表明确实需要排除/测试密码分支时，才进入下节。强制关闭公钥、代理或其他默认方式后的失败，只能说明该受限认证分支被拒绝，不能单独证明账号、主机或默认认证配置有问题。每次诊断只改变一个认证变量，保留标准错误和实际选项，再决定下一步；不得在没有新证据时反复切换认证组合。

## 账号密码直接连接

用户明确要求密码认证，或已完成上节的证据化诊断后，提供主机、账号、密码并要求连接，即视为授权使用该密码。开发或测试的首次未知主机可使用 `accept-new` 自动记录并继续认证。生产、敏感凭据或高影响操作前，必须通过可信渠道取得并核对主机密钥指纹，再连接；不得把仅由网络侧返回的密钥当作身份验证证据。

Windows PowerShell 7：

```powershell
$ErrorActionPreference = 'Stop'
$ssh = (Get-Command ssh.exe -ErrorAction Stop | Select-Object -First 1).Source
$hostName = 'host.example.com'
$userName = 'deploy'
$port = 22
$target = "$userName@$hostName"
$options = @(
  '-p', "$port",
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=no',
  '-o', 'PreferredAuthentications=password,keyboard-interactive',
  '-o', 'PasswordAuthentication=yes',
  '-o', 'KbdInteractiveAuthentication=yes',
  '-o', 'PubkeyAuthentication=no',
  '-o', 'ConnectTimeout=10'
)
& $ssh @options -- $target
if ($LASTEXITCODE -ne 0) { throw "SSH 密码连接失败：$LASTEXITCODE" }
```

macOS/Linux：

```sh
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=no -o PreferredAuthentications=password,keyboard-interactive -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=yes -o PubkeyAuthentication=no user@host
```

用户提供密码或凭据文件并要求连接后，优先使用终端提示；任务确实需要自动化时，可使用 SSH 客户端库、仅对子进程生效的 `askpass`、辅助脚本或系统临时凭据文件。不要把密码放入命令行、普通日志、最终回复或 Git；临时凭据文件限定为当前任务并在不再需要时删除。生产凭据和生产操作仍须明确授权。缺少主机记录时自动 TOFU/保存，并在同一会话认证和执行远端命令。

已有记录但主机密钥变化时 SSH 会拒绝连接。先从可信渠道取得新指纹并与实际返回值核对；确认主机确实重装、迁移或换密钥后，才清理精确端点：

```powershell
$lookup = if ($port -eq 22) { $hostName } else { "[$hostName]:$port" }
& ssh-keygen.exe -F $lookup
& ssh-keygen.exe -R $lookup
```

## 执行远端命令

Windows PowerShell 连接 POSIX 主机时，远端命令使用单引号保存为一个参数：

```powershell
$remote = 'uname -srm; printf "login_shell=%s\nargv0=%s\n" "$SHELL" "$0"; command -v rg; rg --version'
$sshArgs = @($options + @('--', $target, $remote))
& $ssh @sshArgs
$exit = $LASTEXITCODE
if ($exit -ne 0) { throw "远端命令失败：$exit" }
```

目标为 Windows OpenSSH 时，先确认服务端默认 Shell，再传 PowerShell 命令或项目脚本。复杂、多行或含动态数据的逻辑先传脚本，再用明确的 `bash`、`zsh` 或 `pwsh.exe -File` 执行。

SSH 正常返回远端命令的退出状态；连接或客户端错误通常返回 `255`，但远端程序也可能返回 `255`，需要结合标准错误判断。

## 文件传输

SCP 的端口参数是大写 `-P`：

下列 `PasswordAuthentication` 和 `KbdInteractiveAuthentication` 选项仅适用于已经按上节明确选择的密码认证路径；默认认证成功时，传输命令同样保留默认认证链，不附加这些限制。

```powershell
$localFile = (Resolve-Path -LiteralPath 'D:\build\package.zip').Path
$remoteTarget = "${target}:/tmp/package.zip"
$scpArgs = @(
  '-P', "$port",
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=no',
  '-o', 'PasswordAuthentication=yes',
  '-o', 'KbdInteractiveAuthentication=yes',
  '--', $localFile, $remoteTarget
)
& scp.exe @scpArgs
if ($LASTEXITCODE -ne 0) { throw "SCP 上传失败：$LASTEXITCODE" }
```

SFTP 同样使用大写 `-P`；批处理使用 `-b <file>`。两端都有 `rsync` 时可用：

```sh
rsync -a -e 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=no' ./dist/ user@host:/srv/app/dist/
```

传输前确认精确远端路径和现有状态。覆盖重要文件时，先取得明确的覆盖授权并保留备份或可执行的回滚路径；`rsync` 先使用 `--dry-run` 检查变更范围，再执行实际传输。传输后比较大小、哈希或应用级结果。

## 快速诊断

1. 连接失败先保留完整标准错误和实际 SSH 选项，区分网络、代理、主机密钥、默认认证、密码分支和远端命令。
2. 先运行不限制认证方式的默认连接；`ssh -G host` 只用于解释配置，不证明网络或认证可用。
3. 需要验证特定认证方式时，一次只改变一个变量，并把结果表述为该方式的结论。例如 `PubkeyAuthentication=no` 后密码被拒绝，结论是“密码分支被拒绝”，不是“账号错误”。
4. 密码连接不要使用 `BatchMode=yes`。
5. 只有主机密钥冲突时才处理 `known_hosts`；密码、代理和网络错误不要删除主机记录。
