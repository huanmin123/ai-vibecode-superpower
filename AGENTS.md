# ai-vibecode-superpower

本仓库维护可安装的 Codex 与 ZCode 全局配置、agent role 与 standalone skills；两宿主的差异通过 `codex-global-config/` 与 `zcode-global-config/` 目录隔离。项目级约定只在本文件说明；运行时全局行为不在此复制。

## 提示词与文档写作

按 [OpenAI Model Guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) 维护提示词与文档：

1. **先写意图与结果**：给出目标、相关上下文、硬约束、授权边界、成功标准和必要输出格式；让模型自行选择正常步骤，只把会实质改变结果的歧义上升为问题。
2. **保持精简**：每条规则只写一次，role、模板和说明链接到权威来源而不重复；工具描述简短、精确；示例仅用于表达产品要求或修复已验证的问题。
3. **以可观察结果写文档**：结论在前，随后给出证据、重要限制与下一步；区分事实和判断，说明目标、非目标、可见行为与验证方式。
4. **明确长度与语气**：短答复说明必须保留和可省略的信息，不使用泛泛的“简短”；直接回答，用户报告问题时先回应具体问题，省略泛泛表扬、安慰和签名。
5. **用评估迭代**：基于代表性任务，每次只增删一组提示词、示例或工具，再比较任务成功、完整性、证据、token、延迟与成本。

## README 定位

1. `README.md` 是使用者手册：只说明用途、适用场景、简明工作流、安装入口和可选能力。
2. 不在 README 重复 role 路由、模型选择、消息字段、权限边界、并发限制、配置合并或安装器实现细节。
3. 技术规则只在其权威来源维护：项目文档边界在本文件，工作流在 `codex-global-config/skills/orchestrate-model-workflow/SKILL.md` 与 `zcode-global-config/skills/orchestrate-model-workflow/SKILL.md`，role schema、翻译规则与预设边界在 `shared/roles/README.md`，安装行为在安装脚本。README 仅在确有必要时链接这些来源。

## 权威来源

- 共享平台文档与工具无关 skills：`shared/`（`docs/system/`、`agent-toolchain`、`project-doc-planner`、`visual-aesthetics`、`roles`），由两个安装器共同安装或消费。
- Codex 全局行为规范：`codex-global-config/AGENTS.md`；安装后对应用户级 Codex home 中的 `AGENTS.md`。ZCode 对应 `zcode-global-config/AGENTS.md` 与用户级 ZCode home（`~/.zcode`）。
- 工作流路由、交接与验收：`codex-global-config/skills/orchestrate-model-workflow/SKILL.md`（Codex 变体）与 `zcode-global-config/skills/orchestrate-model-workflow/SKILL.md`（ZCode 变体）。
- role 唯一事实源：`shared/roles/`——schema 与翻译规则在 `shared/roles/README.md`，预设数据在 `shared/roles/presets/`（`glm` 绑定 ZCode 5 角色，`gpt` 绑定 Codex 11 role：luna / sol / astra 三型，sol 含 gpt-6.1 主力与 gpt-6 同型回退；`ds` 绑定 ZCode 3 角色，单模型 deepseek-v4.1-flash 拆 3 档，2 读 1 写，复审/终审由 `ds_4.1_flash_max` 兼任，其 model 是占位值），源完整性由 `shared/roles/presets.sha256` 静态校验。仓库不维护任何宿主角色文件；`codex-global-config/agents/` 与 `zcode-global-config/agents/` 已删除，安装时由翻译器按预设生成。角色命名推荐 `模型_版本_类型_思考档`（如 `glm_5.3_flash_low`、`gpt_6_astra_max`、`ds_4.1_flash_low`），同模型同档位冲突时追加职责后缀。md agent 的 `model` 必须写 ZCode Picker 值 `providerId/modelId`（如 `"account:bigmodel-individual-coding-plan/GLM-5.3-Flash"`，provider 段随实际登录的 Coding Plan 账号走），`thoughtLevel` 单独成键；裸模型名会被 ZCode 静默忽略并回退到父会话模型。
- 安装与合并逻辑：`install.ps1`、`install.sh`（每平台一个安装器，交互选择客户端与预设，或以 `-Client`/`-Preset`、位置参数指定；`-UpdateRoleManifest` / `--update-role-manifest` 重写预设 manifest）；不要直接编辑已安装的全局副本作为最终修改。ZCode 的 md agent 按预设渲染名单平铺安装到 `~/.zcode/agents/` 顶层（新版宿主只扫描顶层，子目录不参与发现），产物只做结构校验不做 hash 比对；旧版安装的 `agents/ai-vibecode-superpower/` 子目录仅在结构与角色名单和渲染产物完全一致时随安装备份移除。

## 修改与验证

1. 修改全局行为、skill 或预设时，先改本仓库中的权威来源；预设源文件（preset.toml、roles/*.md）变更后必须运行 `-UpdateRoleManifest` / `--update-role-manifest` 更新 `shared/roles/presets.sha256`；新增模型方案只新增预设目录，不改翻译器。
2. 只有用户要求部署时，运行对应平台的 `install` 脚本并选择目标客户端与预设，核对已安装文件与渲染产物一致。
3. 保留实际错误和未验证项；不得用未证明兼容的 fallback 隐藏问题。
