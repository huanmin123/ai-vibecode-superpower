# Codex 全局配置安装包

本仓库用于把一套通用的 Codex 行为规范、系统命令文档和技能安装到用户级 Codex 配置目录。它不安装 Codex CLI 或桌面应用本身。

## 安装

Windows（PowerShell 7）：

```powershell
& .\install-codex.ps1
```

macOS 或 Linux：

```sh
sh ./install-codex.sh
```

安装目录优先使用非空的 `CODEX_HOME`；未设置时使用当前用户的 `~/.codex`。两个脚本都会：

1. 校验本仓库中的来源文件。
2. 将新配置完整复制到安装暂存目录。
3. 将已有的 `AGENTS.md`、`docs/` 和 `skills/` 备份到 `<CODEX_HOME>/backups/` 下的唯一目录。
4. 覆盖这三个目标。

脚本不会安装或升级 Codex，也不会读取、输出或复制认证信息。Windows 脚本拒绝穿过符号链接或目录联接的 `CODEX_HOME` 路径；两种脚本都会阻止同一目标目录的并发安装。

## 目录树

```text
.
├── install-codex.ps1
├── install-codex.sh
├── sys-agents.md/
│   ├── AGENTS.md
│   └── docs/
│       ├── README.md
│       └── system/
│           ├── README.md
│           ├── windows.md
│           ├── macos.md
│           ├── linux.md
│           ├── ssh.md
│           ├── rg.md
│           └── 跨系统操作示例.md
└── skills/
    ├── gpt-image-2-cli/
    ├── orchestrate-model-workflow/
    └── project-doc-planner/
```

## 文件与模块说明

| 路径 | 作用 | 安装位置 |
| --- | --- | --- |
| `install-codex.ps1` | Windows PowerShell 安装入口 | 不安装，直接运行 |
| `install-codex.sh` | macOS/Linux POSIX shell 安装入口 | 不安装，直接运行 |
| `sys-agents.md/AGENTS.md` | 全局 Codex 工作规范和命令路由规则 | `<CODEX_HOME>/AGENTS.md` |
| `sys-agents.md/docs/` | 系统、Shell、SSH、ripgrep 等通用操作规范 | `<CODEX_HOME>/docs/` |
| `skills/` | 可复用 Codex skills 的根目录 | `<CODEX_HOME>/skills/` |
| `skills/gpt-image-2-cli/` | 使用当前 Codex 配置调用 `gpt-image-2` 的图片生成辅助工具 | `<CODEX_HOME>/skills/gpt-image-2-cli/` |
| `skills/orchestrate-model-workflow/` | 按风险把设计、实现、审查和修复路由到合适模型的工作流 | `<CODEX_HOME>/skills/orchestrate-model-workflow/` |
| `skills/project-doc-planner/` | 规划项目文档架构、开发规范和环境资源边界 | `<CODEX_HOME>/skills/project-doc-planner/` |

`sys-agents.md` 是来源目录名，尽管名字以 `.md` 结尾；安装时它不会原样复制，只有其中的 `AGENTS.md` 和 `docs/` 会分别写入 Codex 全局目录。

## 覆盖与恢复

每次安装都会整体替换目标中的 `AGENTS.md`、`docs/`、`skills/`。安装前版本保存在 `<CODEX_HOME>/backups/<时间戳-唯一标识>/`，需要恢复时可关闭 Codex 后将备份中的对应项目移回全局目录。不要删除备份，直到确认新配置符合预期。
