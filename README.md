# Codex 全局配置安装包

这是一套给 Codex 使用者的全局配置与统一插件：统一工作约定、可分工的 agent role，以及 `agnets-workflow` 提供的常用 skills 和工作流工具。安装后，新建的 Codex task 可以直接使用它们。

本项目不安装或升级 Codex CLI，也不安装 Codex 桌面应用。   还有就是内置的`superpowser`插件请关闭使用否则可能会冲突和加大成本 。 

## 你会得到

- 统一的全局规则和跨平台命令文档。
- 11 个分工角色，用于调查、判断、实施和复查。
- `agnets-workflow` 插件，包含 `orchestrate-model-workflow`、`agent-toolchain` 和 `workflow-controller`。
- 独立全局 skill：`project-doc-planner` 与 `gpt-image-2-cli`。

## 适合什么时候

适合日常开发、维护多个项目，或希望复杂任务有稳定工作方式的个人和团队。

一般不需要先了解每个角色。直接告诉 Codex 你的目标、范围和限制即可；任务复杂时，它会按需要安排调查、方案、实施和复查。

## 工作流一眼看懂

```mermaid
flowchart TD
    A["提出任务目标"] --> B["协调者判断需要什么"]
    B --> R["按需要并行安排多个调查或评审分支"]
    R --> P["形成结论或方案"]
    P --> D{"需要修改吗"}
    D -->|"否"| Z["交付结果"]
    D -->|"是"| M["按需要并行安排多个管理分支"]
    M --> W["执行互不冲突的工作"]
    W --> V["验证与独立复查"]
    V --> Z
```

多个分支可以按任务需要并行；相互影响的工作会顺序处理。

## 安装

Windows（PowerShell 7）：

```powershell
& .\install-codex.ps1
```

macOS 或 Linux：

```sh
sh ./install-codex.sh
```

安装目录优先使用非空的 `CODEX_HOME`；未设置时使用当前用户的 `~/.codex`。安装器会备份它管理的已有内容，并注册、安装或更新 `agnets-workflow`，同时安装或更新两个独立全局 skill，并移除旧版安装的三个插件同名全局 skill 和旧的独立 `workflow-controller` 插件，避免重复加载。完成后重启 Codex 相关程序，或新建 task 以加载新配置。

`workflow-controller` 使用 Codex 所需的 Node.js 运行时；安装器会在写入前检查 `node` 命令。

## 可选能力

`agent-toolchain` 用于为另一个目标项目接入 CodeGraph 与 RTK，适合复杂重构、跨模块理解和大范围排障。在目标项目中对 Codex 说：

> 使用 `$agent-toolchain` 给我安装工具。

单文件或一次性任务通常不需要接入。

`workflow-controller` 随 `agnets-workflow` 一起安装。它为复杂状态变更任务保存 DAG、并行 ready 节点、总审证据包和关闭校验，适合希望降低协调开销并保留总审闭环的项目。

联系作者：QQ群 1105515344
