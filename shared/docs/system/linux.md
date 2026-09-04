# Linux

## 识别环境

首次在主机执行且环境未知时检查一次：

```sh
uname -srm
test -r /etc/os-release && sed -n '1,20p' /etc/os-release
printf 'login_shell=%s\nargv0=%s\n' "$SHELL" "$0"
command -v apt-get || command -v dnf || command -v pacman || command -v apk || command -v zypper || true
```

- 以 `/etc/os-release` 的 `ID`/`ID_LIKE` 选择匹配的包管理器；命令存在不等于发行版、权限、仓库或网络都可用。需要安装时先核对这些条件，再选择一组命令，不无证据地轮流尝试多套。
- `$SHELL` 是登录 Shell，`$0` 是当前调用的 `argv0`，不保证等于解释器路径。
- 不假定 `/bin/sh` 是 Bash；需要 Bash 特性时显式调用 `bash`。
- 二进制资产必须匹配 `uname -m` 返回的架构。
- 沿用系统已有工具和项目入口；只有当前命令确实不可用且替代路径有证据时，才安装或切换工具。

## 路径与 Shell

- 设置明确工作目录，路径和动态值加引号并保持为独立参数。
- 远端复杂逻辑传脚本后用明确解释器执行，不堆叠本地与远端多层转义。
- 遵循仓库编码、换行和文件 mode；结构化配置使用对应解析器。

## `rg`

```sh
command -v rg
rg --version
```

仅当 `command -v rg` 失败，或已有证据表明 `rg` 不可执行时，才按 [ripgrep 安装](rg.md#linux) 选择一组发行版命令或用户级 Release。命令路径存在但 `rg --version` 失败时，先保留原始错误并诊断，不直接安装另一个副本；安装后重新运行检查。

## 进程、端口与服务

```sh
# 先为当前任务设置实际端口和 PID；以下变量名只是占位符。
ss -ltnp "sport = :$port"
ps -p "$pid" -o pid=,ppid=,user=,args=
```

- 查询无输出只代表当前权限下未发现，不代表全局不存在；权限错误或字段缺失必须保留为未知。
- 只停止本任务启动且已核对命令行的 PID。
- 查看 systemd 服务使用 `systemctl status "$unit" --no-pager`（先设置实际 `$unit`）；启动、停止或重启默认使用项目既定入口，用户已明确指定系统服务时按其授权执行。
- 长驻任务默认使用项目已有 systemd、容器或进程管理配置；若用户明确授权其他入口，记录实际范围并验证与任务相关的监听或健康结果。

## 常用工具链

- Git：需要检查仓库状态时运行 `git status --short`，不覆盖用户已有修改。
- Node、Python、Java、Go、Rust：按锁文件、版本文件、包装器和虚拟环境执行。
- Docker：需要 Docker 时再运行 `docker version` 判断 daemon 是否可用；默认只操作当前项目资源，用户已明确授权其他资源时核对目标后执行。

原生命令检查退出码。`rg` 返回 `0` 表示有匹配，`1` 表示无匹配，大于 `1` 表示错误。SSH 连接、密码和传输规则见 [SSH](ssh.md)。
