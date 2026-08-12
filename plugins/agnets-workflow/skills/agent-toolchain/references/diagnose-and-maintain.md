# 诊断、修复与维护

仅在工具不可用、索引异常、用户要求健康检查或明确要求维护时读取本文件。日常跨模块查询和只读命令压缩遵守目标项目 `AGENTS.md` 的 `## CodeGraph 与 RTK` 标题，不需要读取本文件或触发 `$agent-toolchain`。

## 诊断顺序

1. 对工具可用性不确定的大任务，最多运行一次 `doctor --quick`。
2. `doctor --quick` 失败、CodeGraph MCP 查询异常，或索引状态可疑时，运行完整 `doctor`。
3. 完整检查显示工具缺失时，只有接入或修复安装已获授权，才读取 `references/install.md` 并执行该流程。
4. 完整检查显示索引未初始化或异常时，运行 `init-codegraph`；已有索引会执行一次增量同步。
5. 保留命令输出、退出码和受影响范围。检查失败不表示工具能力不存在，更不允许无证据改用不兼容工具。

使用当前加载的 skill 目录中的平台驱动：Windows 用 `agent-toolchain.ps1`，macOS/Linux 用 `agent-toolchain.sh`。所有需要项目上下文的命令都带 `--project <目标绝对目录>`。

## 命令语义

| 命令 | 用途 | 使用边界 |
| --- | --- | --- |
| `doctor --quick` | 检查受管 CodeGraph、RTK 与公共命令入口 | 每个大任务最多一次；不检查索引 |
| `doctor` | 检查工具、入口和 CodeGraph 索引 | 用于接入完成验证与故障诊断 |
| `init-codegraph` | 建立索引，或同步现有索引 | 仅在未初始化或完整诊断明确需要时使用 |
| `maintain` | 检查 CodeGraph 状态 | 不做周期性维护 |
| `maintain --sync` | 显式同步索引 | 仅当 `doctor`、MCP 结果或 `codegraph status` 明确异常时使用一次 |
| `rollback rtk <版本>` | 切换到已下载且已校验的 RTK 版本 | 仅在明确的 RTK 回滚任务中使用；CodeGraph 不支持此命令 |

## 日常维护原则

- CodeGraph MCP 会监听文件变化并在重连后补齐离线修改；不要按固定周期运行 `maintain --sync`。
- 不自动升级。版本变化必须走安装资料中的受控审查路径。
- 不把 RTK 当安全边界，也不使用它执行写操作、安装、升级、提交、发布、部署、迁移、权限或密钥操作。
- 工具返回与当前源文件冲突时，以当前源文件和 `rg` 为准，并报告差异；不要把陈旧索引当作事实。
