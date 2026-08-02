# ai-vibecode-superpower

本仓库维护可安装的 Codex 全局配置、agent role 与 skills。项目级约定只在本文件说明；运行时全局行为不在此复制。

## 提示词与文档写作

按 [OpenAI Model Guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) 维护提示词与文档：

1. **先写意图与结果**：给出目标、相关上下文、硬约束、授权边界、成功标准和必要输出格式；让模型自行选择正常步骤，只把会实质改变结果的歧义上升为问题。
2. **保持精简**：每条规则只写一次，role、模板和说明链接到权威来源而不重复；工具描述简短、精确；示例仅用于表达产品要求或修复已验证的问题。
3. **以可观察结果写文档**：结论在前，随后给出证据、重要限制与下一步；区分事实和判断，说明目标、非目标、可见行为与验证方式。
4. **明确长度与语气**：短答复说明必须保留和可省略的信息，不使用泛泛的“简短”；直接回答，用户报告问题时先回应具体问题，省略泛泛表扬、安慰和签名。
5. **用评估迭代**：基于代表性任务，每次只增删一组提示词、示例或工具，再比较任务成功、完整性、证据、token、延迟与成本。

## 权威来源

- 全局行为规范：`codex-global-config/AGENTS.md`；安装后对应 `<CODEX_HOME>/AGENTS.md`。
- 工作流路由、交接与验收：`skills/orchestrate-model-workflow/SKILL.md`。
- role 本地权限与输出边界：`codex-global-config/agents/ai-vibecode-superpower/`。
- 安装与合并逻辑：`install-codex.ps1`、`install-codex.sh`；不要直接编辑已安装的 `<CODEX_HOME>` 副本作为最终修改。

## 修改与验证

1. 修改全局行为、skill 或 role 时，先改本仓库中的权威来源；role 内容变更同时更新其 SHA-256 manifest。
2. 只有用户要求部署时，运行对应平台的 `install-codex` 脚本，并核对已安装文件与源文件一致。
3. 保留实际错误和未验证项；不得用未证明兼容的 fallback 隐藏问题。
