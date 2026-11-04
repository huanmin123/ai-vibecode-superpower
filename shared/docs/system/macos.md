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

- 静态字符串用单引号，需要展开才用双引号。
- 不硬编码 Homebrew 路径，使用 `brew --prefix`；只安装当前任务需要的包，不运行无关 `brew upgrade` 或清理。
- 没有适用系统包管理器或明确需要用户级安装时，使用 `$HOME/.local/bin`。

## `rg`

```sh
command -v rg
rg --version
```

仅当 `command -v rg` 失败或已有证据表明 `rg` 不可执行时，按 [ripgrep 安装](rg.md#macos) 安装并复验。

## 进程与端口

仅在任务涉及进程、端口或长驻服务时执行下列检查。

```sh
# 先为当前任务设置实际端口和 PID；以下变量名只是占位符。
lsof -nP -iTCP:"$port" -sTCP:LISTEN
ps -p "$pid" -o pid=,ppid=,command=
```

长驻任务默认使用项目已有 launchd、容器或进程管理入口；用户已明确授权其他入口时记录实际范围，并验证与任务相关的监听或健康结果。

SSH 连接、密码和文件传输规则见 [SSH](ssh.md)。
