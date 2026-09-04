# Windows 与 PowerShell 7

## 默认环境

- 本机命令优先使用可用的 PowerShell 7 (`pwsh.exe`)；只有任务依赖位数时再核对 64 位。`powershell.exe` 表示 Windows PowerShell 5.1，仅在兼容性有明确依据时使用，不把两者静默视为等价替代。
- 依赖仓库或目标文件的命令设置明确工作目录；纯版本查询、工具定位或系统诊断可沿用当前目录。不依赖 Profile、alias、虚拟环境激活或上一条命令的状态。
- 命令的工作目录必须是已存在的绝对目录；仅在需要指定目录或工具返回目录无效时，用 `Test-Path -LiteralPath <目录> -PathType Container` 或 `Resolve-Path -LiteralPath <目录>` 核实。文件路径、文档路径和命令文本都不能作为工作目录。
- 工具调用因目录无效而未开始执行（如退出码异常或报告“目录名称无效”）时，先重新核对调用时传入的工作目录；只有后续证据支持时，才能断言是文档路径、工具解析或远端系统的原因。
- 同名命令可能来自 PowerShell Alias、脚本、Windows 工具或多套第三方工具；`sort`、`where`、`tee`、`cat`、`rm` 等名称尤其容易遮蔽。行为或版本受来源影响时使用 `Get-Command <name> -All`，再调用确认后的完整路径、`.exe` 或 `.cmd`，不只按命令名猜测。

任务确实受版本或工具来源影响时检查一次：

```powershell
$PSVersionTable.PSVersion
[Environment]::Is64BitProcess
Get-Command pwsh.exe, rg.exe, git.exe -All -ErrorAction SilentlyContinue
```

## PowerShell 写法

- 静态文本用单引号，需要变量展开才用双引号。
- `$` 只用于变量；cmdlet 直接写名称，例如 `Get-Content`，不能写成 `$Get-Content`。
- 动态命令使用参数数组：`& $exe @args`；不用 `Invoke-Expression`。
- 文件 cmdlet 使用 `-LiteralPath`，路径组合用 `Join-Path`，关键路径用 `Resolve-Path -LiteralPath`。
- 不把 Bash 的 heredoc、`export`、`source`、`VAR=value command`、`$(pwd)`、`/dev/null` 或反斜杠续行写进 PowerShell。
- PowerShell 管道传对象；JSON、CSV、XML、TOML 使用解析器，不切割格式化表格。
- 调用原生程序后检查 `$LASTEXITCODE`；产生输出不代表成功。
- 需要同时处理原生输出和退出码时，先完整捕获 `$output = @(& $exe @args)` 并立即保存 `$exit = $LASTEXITCODE`，再对 `$output` 使用 `Select-Object` 或解析器；不要直接把原生命令管到 `Select-Object -First`，下游提前关闭可能让原程序返回管道错误。
- `$env:NAME` 只修改当前 PowerShell 进程及其后启动的子进程；写入 User/Machine 的持久环境变量不会反向更新当前会话。命令需要立即读取新值时，同时更新当前进程。
- PowerShell 变量名不区分大小写；不得给只读或常量自动变量赋值，例如 `$Host`、`$PID`、`$HOME`、`$Error`、`$PSVersionTable`、`$PSEdition`、`$PSHOME`、`$true`、`$false`。业务变量使用 `$hostName`、`$processId`、`$homePath`、`$errorList` 等明确名称；不确定时用 `Get-Variable` 检查 `Options` 中的 `ReadOnly` 或 `Constant`。
- 命令对象和可执行路径字符串不得混用。`Get-Command` 结果命名为 `$rgCommand`、`$sshCommand`，从其读取一次 `.Source` 后保存为 `$rgPath`、`$sshPath`；路径字符串用 `& $rgPath` 直接调用，不再访问 `$rgPath.Source`。调用前不确定类型时检查 `$value.GetType().FullName`。

```powershell
# 先为当前任务设置实际仓库路径；$repo 只是占位符。
$git = (Get-Command git.exe -ErrorAction Stop | Select-Object -First 1).Source
$gitArgs = @('-C', $repo, 'status', '--short')
& $git @gitArgs
if ($LASTEXITCODE -ne 0) { throw "git status 失败：$LASTEXITCODE" }
```

## Windows 上的 POSIX Shell

- `bash` 或 `sh` 可能来自 BusyBox、Git Bash、MSYS2、Cygwin 或 WSL；命令名不保证解释器是 GNU Bash。行为受实现影响时先运行 `Get-Command bash, sh -All`，并检查实际路径和版本。
- 面向 POSIX `sh` 的生产脚本和行为测试不得使用 `${BASH_SOURCE[0]}`、`[[ ... ]]`、数组、`source`、进程替换或 `set -o pipefail` 等 Bash 专属语法。直接执行的脚本使用 `$0` 解析自身目录：

```sh
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit
```

- `$0` 只适用于直接执行入口；脚本被点命令或 `source` 加载时，`$0` 属于调用方。需要 Bash 特性时显式调用已确认的 GNU Bash 路径，并验证 `BASH_VERSION`，不依赖 PATH 中的第一个 `bash`。
- 测试运行器的解析错误与生产脚本语法检查分开判断；先确认失败来自运行器兼容性，再决定是否修改生产脚本。
- Windows 不按 shebang 或 Unix 可执行位自动选择 `.sh` 解释器，`.SH` 通常也不在 `PATHEXT`；运行脚本时显式调用已确认的 `bash.exe`、`sh.exe` 或 `pwsh.exe -File`。
- PowerShell 和原生 Windows 工具使用盘符路径，BusyBox、Git Bash/MSYS 与 WSL 的路径规则不同。只在 Shell 边界做一次明确转换，不把 `C:\...`、`C:/...`、`/c/...`、`/mnt/c/...` 混入同一条命令后依赖隐式转换。

## 文件与编辑

- 遵循 `.editorconfig`、`.gitattributes` 和现有编码、BOM、LF/CRLF；小改动出现整文件差异时先检查编码和换行。
- Git pathspec 使用加引号的仓库相对路径和正斜杠，例如 `git diff -- 'src/a b.ts'`。
- 临时文件放在 `$env:TEMP` 的任务目录；递归删除或移动前核对解析后的绝对路径。
- 文件锁或 Access denied 先定位占用进程、只读属性和权限，不重复碰运气。
- 默认 Windows 文件系统保留大小写但通常不区分大小写；检查 import、路由和打包路径的真实大小写。仅修改文件名大小写时使用中间文件名分两步移动，并用 `git status` 或目录结果确认。
- 不创建 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9` 等保留名；生成文件名时避开 `< > : " / \ | ? *`、尾随空格和尾随句点。
- 符号链接是否可创建和检出取决于权限、Developer Mode 与 Git `core.symlinks`；先检查实际文件类型。Unix 可执行位在 Windows 工作区不能作为运行验证，交付到 Linux/macOS 时在目标环境验证 mode 和 shebang。

## `rg`

```powershell
$rgCommand = Get-Command rg.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $rgCommand) { throw '未找到 rg；仅在获准安装时读取下方流程' }
$rgPath = $rgCommand.Source
if (-not (Test-Path -LiteralPath $rgPath -PathType Leaf)) { throw "rg 路径不可执行：$rgPath" }
& $rgPath --version
if ($LASTEXITCODE -ne 0) { throw "rg 验证失败：$LASTEXITCODE" }
```

确认缺失后按 [ripgrep 安装](rg.md#windows) 选择一个匹配流程，安装后重新验证；不要因为版本输出异常就静默覆盖现有安装。

## 进程与端口

端口占用先查 PID 和命令行；以下 `$port` 是当前任务的占位符。只停止本任务启动且已核对命令行的进程：

```powershell
$listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
$processes = foreach ($processId in @($listeners.OwningProcess | Sort-Object -Unique)) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
}
$processes | Select-Object ProcessId, ExecutablePath, CommandLine
```

查询无输出只代表当前权限下未发现，不代表全局不存在；权限错误或字段缺失必须保留为未知。后台服务保存 PID、完整启动命令和日志，并验证监听端口或健康检查。端口被其他任务占用时先报告占用者及证据；只有项目明确支持动态端口或用户明确允许时才更换端口，不批量结束同名进程。

## 常用工具链

- Git：需要检查仓库状态时运行 `git status --short`；用户已有修改不覆盖，不自动 reset/clean/restore/stash。
- Node.js：按锁文件选择 npm/pnpm/Yarn/Bun；调用 Windows shim 时使用 `npm.cmd`、`npx.cmd`、`pnpm.cmd`、`yarn.cmd`。
- Python：优先 `.venv\Scripts\python.exe`，否则使用项目指定入口或 `py.exe -3`；始终通过同一解释器运行 `-m pip`、`-m pytest`。
- Java：优先 `gradlew.bat`、`mvnw.cmd`；需要 Docker 时再用 `docker version` 判断 daemon 是否可用。

验证从最贴近的项目命令开始，再按风险扩大到格式、类型、测试和构建。其他 Shell 或 WSL 的成功不能替代 Windows 本地结果。
