# Antigravity 全局参考文档

`<ANTIGRAVITY_HOME>/rules/AGENTS.md` 是全局行为与授权入口。通用命令约定和平台文档见[系统命令索引](system/README.md)。

安装时，`shared/docs/system/` 会装配到 `<ANTIGRAVITY_HOME>/docs/system/`。

## Antigravity 宿主约定

- 插件安装在 `<ANTIGRAVITY_HOME>`（默认 `~/.gemini/config/plugins/ai-vibecode-superpower`），以 Antigravity 原生插件形式自动发现，可在 Customizations 页面整体启停或卸载。
- 角色由所选预设翻译为原生子代理 `<ANTIGRAVITY_HOME>/agents/<name>.md`（`subagent: true`、`mainAgent: false` 并显式声明 `tools` 白名单）；只读角色不包含 `edit_file` 与 `write_file`。
- 主代理按 `orchestrate-model-workflow` 清单通过 `invoke_subagent` 派发对应 `TypeName`，并结合角色建议选择 `Model` 档位（`flash_lite` / `flash` / `inherit` / `pro`）；无额外授权时不擅自使用 `Workspace: "branch"` 或 `"share"` 创建隔离工作区。
- 界面设计复审涉及浏览器走查与截图时，由主代理或设计角色按宿主能力配合内置 `browser` 子代理或项目既有截图脚本执行，并把截图核查留在子代理侧、向主会话返回结构化文本证据。
- Windows 终端默认使用 PowerShell，macOS / Linux 使用 POSIX Shell；宿主已挂载批量搜索/大纲类 MCP 工具时，可与 `rg` 互补使用，均以实际文件与命令退出码为准。
