# Linux

## 识别环境

首次在主机执行时检查一次：

```sh
uname -srm
test -r /etc/os-release && sed -n '1,20p' /etc/os-release
printf 'login_shell=%s\nargv0=%s\n' "$SHELL" "$0"
command -v apt-get || command -v dnf || command -v pacman || command -v apk || command -v zypper || true
```

- 以 `/etc/os-release` 的 `ID`/`ID_LIKE` 和实际包管理器选择命令，不依次试多套。
- `$SHELL` 是登录 Shell，`$0` 是当前调用的 `argv0`，不保证等于解释器路径。
- 不假定 `/bin/sh` 是 Bash；需要 Bash 特性时显式调用 `bash`。
- 二进制资产必须匹配 `uname -m` 返回的架构。

## 路径与 Shell

- 设置明确工作目录，路径和动态值加引号并保持为独立参数。
- 远端复杂逻辑传脚本后用明确解释器执行，不堆叠本地与远端多层转义。
- 遵循仓库编码、换行和文件 mode；结构化配置使用对应解析器。

## `rg`

```sh
command -v rg
rg --version
```

任一命令失败即按 [ripgrep 安装](rg.md#linux) 选择一组发行版命令或用户级 Release，安装后重新运行以上两条命令。

## 进程、端口与服务

```sh
ss -ltnp "sport = :$port"
ps -p "$pid" -o pid=,ppid=,user=,args=
```

- 只停止本任务启动且已核对命令行的 PID。
- 查看 systemd 服务使用 `systemctl status "$unit" --no-pager`；启动、停止或重启使用项目既定入口。
- 长驻任务使用项目已有 systemd、容器或进程管理配置，并验证监听或健康检查。

## 常用工具链

- Git：先运行 `git status --short`，不覆盖用户已有修改。
- Node、Python、Java、Go、Rust：按锁文件、版本文件、包装器和虚拟环境执行。
- Docker：先运行 `docker version` 判断 daemon 是否可用；只操作当前项目资源。

原生命令检查退出码。`rg` 返回 `0` 表示有匹配，`1` 表示无匹配，大于 `1` 表示错误。SSH 连接、密码和传输规则见 [SSH](ssh.md)。
