# macOS

## 识别环境

首次在主机执行且环境未知时检查一次：

```sh
sw_vers
uname -srm
printf 'login_shell=%s\nargv0=%s\n' "$SHELL" "$0"
command -v brew || true
```

`arm64` 为 Apple Silicon，`x86_64` 为 Intel；`$SHELL` 是登录 Shell，`$0` 只是当前调用的 `argv0`。命令不依赖交互插件、alias 或上一条会话状态。

## Shell 与路径

- 静态字符串用单引号，需要展开才用双引号；路径和动态值保持为独立参数。
- 不硬编码 Homebrew 路径，使用 `brew --prefix`；没有适用系统包管理器或明确需要用户级安装时，使用 `$HOME/.local/bin`。
- 远端复杂逻辑传脚本后用明确的 `bash`、`zsh` 或项目入口执行，不堆叠多层引号。
- 遵循仓库编码、换行和文件 mode；使用明确工作目录和加引号的路径。

## `rg`

```sh
command -v rg
rg --version
```

仅当 `command -v rg` 失败，或已有证据表明 `rg` 不可执行时，才按 [ripgrep 安装](rg.md#macos) 选择一个匹配流程，安装后重新验证；命令路径存在但版本检查失败时先保留原始错误并诊断。

## 进程与端口

仅在任务涉及进程、端口或长驻服务时执行下列检查。

```sh
# 先为当前任务设置实际端口和 PID；以下变量名只是占位符。
lsof -nP -iTCP:"$port" -sTCP:LISTEN
ps -p "$pid" -o pid=,ppid=,command=
```

查询无输出只代表当前权限下未发现，不代表全局不存在；权限错误或字段缺失必须保留为未知。只停止本任务启动且已核对命令行的 PID。长驻任务默认使用项目已有 launchd、容器或进程管理入口；用户已明确授权其他入口时记录实际范围，并验证与任务相关的监听或健康结果。

## 常用工具链

- Git：需要检查仓库状态时运行 `git status --short`，不覆盖用户已有修改。
- Node、Python、Ruby、Java：先读锁文件和版本文件，优先项目包装器和虚拟环境。
- Homebrew：只安装当前任务需要的包，不运行无关 `brew upgrade` 或清理。

原生命令检查退出码；验证从目标命令开始，再按风险扩大到测试和构建。SSH 连接、密码和文件传输规则见 [SSH](ssh.md)。
