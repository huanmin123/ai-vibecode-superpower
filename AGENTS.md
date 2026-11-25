# ai-vibecode-superpower

本仓库维护可安装的 Codex 与 ZCode 全局配置、agent role 与 standalone skills；共享平台文档、skills、角色预设与行为规范放在 `shared/`，全局指令与工作流 skill 以 `shared/` 共享正文为准；只有 docs、config 与 Codex 技能资产等客户端资源由各自目录维护。项目级约定只在本文件说明；运行时全局行为不在此复制。

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
3. 首次安装所需的步骤和示例保留在 README。扩展说明链接到下列权威来源。

## 权威来源

- 两个宿主共用[全局行为规范](shared/global-instructions.md)、`shared/docs/system/` 平台文档和 [skills](shared/skills/)。安装器将全局规范中的 `<GLOBAL_HOME>` 展开为目标 home。
- 工作流路由、交接与验收见[工作流 skill](shared/skills/orchestrate-model-workflow/SKILL.md)。Codex 专属技能资产在 [skill-assets/](codex-global-config/skill-assets/)。
- 角色数据在[预设目录](shared/roles/presets/)中维护。schema、模型绑定（含 `local:<key>_<label>` 多 provider 变体）与宿主翻译见[角色规范](shared/roles/README.md)。宿主角色文件由安装器生成。
- 安装参数与合并行为以 [Windows 安装器](install.ps1)和 [macOS/Linux 安装器](install.sh)为准。

## 文档维护

- `AGENTS.md` 只放跨项目、每次任务都有效的行为与授权边界；`shared/docs/system/` 只放平台语法、命令、工具安装和排障。
- 每条规则只在权威入口完整说明一次。平台文档只补充本平台特有、其他平台不生效的内容，不重复通用约定。
- 新增或修改命令文档时，写清适用条件、预检、可核对的成功证据和失败边界；按风险保留必要的平台差异，不用抽象措辞替代可执行说明。
- 新增平台或工具文档时，同步更新两个客户端 `docs/README.md` 索引的“命中才读”条件；未命中条件的文档不进入常规读取路径。
- 不在公开规范中保存主机地址、账号、密钥、令牌、生产连接信息或其他敏感事实。

## 修改与验证

1. 修改仓库中的权威来源，安装产物由安装器生成。内置预设的 `preset.toml` 或角色正文变更后，运行 `-UpdateRoleManifest` / `--update-role-manifest` 更新 [presets.sha256](shared/roles/presets.sha256)。新增模型方案只需增加预设并更新 manifest；为使用 `local:` 的已有预设增加同一逻辑模型的第二个 ZCode provider，只需在仓库外的绑定文件加后缀键并重跑安装，不修改预设或 manifest。本机模型绑定保存在仓库外。
2. 只有用户要求部署时，运行对应平台的 `install` 脚本并选择目标客户端与预设，核对已安装文件与渲染产物一致。
3. 保留实际错误和未验证项；不得用未证明兼容的 fallback 隐藏问题。
