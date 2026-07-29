# SSH 与跨主机执行

同时读取本地平台文档和远端平台文档。本地 Shell 只构造 SSH 参数；远端命令只使用远端 Shell 语法。

## 账号密码直接连接

用户提供主机、账号、密码并要求连接，即视为授权使用该密码。首次未知主机使用 `accept-new` 自动记录并继续认证；不要求预先提供指纹、已有 `known_hosts` 或二次连接。

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

用户提供密码或凭据文件并要求连接后，按当前环境选择最方便的认证方式：终端提示、SSH 客户端库进程内认证、进程级环境变量式 `askpass`、辅助脚本或系统临时目录中的凭据文件都可使用。本地 `dev/test` 允许明文凭据和任务需要的终端输出，不要求把可用的 `askpass` 流程改造成进程内认证；辅助文件按任务便利性保留或清理。不得自动把凭据提交到 Git 或主动发送给无关外部服务；生产凭据和生产操作仍须明确授权。缺少主机记录时自动 TOFU/保存，并在同一会话认证和执行远端命令。

已有记录但主机密钥变化时 SSH 会拒绝连接。确认主机确实重装、迁移或换密钥后，只清理精确端点：

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

覆盖重要文件时，传输后比较大小、哈希或应用级结果。

## 快速诊断

1. 连接失败先看完整标准错误，区分网络、密码、主机密钥和远端命令。
2. `ssh -G host` 只展开配置，不证明网络或认证可用。
3. 密码连接不要使用 `BatchMode=yes`。
4. 只有主机密钥冲突时才处理 `known_hosts`；密码错误和网络错误不要删除主机记录。
