# 角色预设与翻译器规范

本目录是跨宿主角色配置的权威来源：预设（preset）以中立 schema 描述一套 agent 角色，安装器在安装时把预设翻译为 ZCode 的 md agent 与 Codex 的 toml role。仓库不直接维护任何宿主角色文件；宿主文件是本目录预设的编译产物。

## 目标与非目标

目标：

- 用户只维护一份角色定义，即可生成 Codex 与 ZCode 两个宿主的角色文件。
- 新增一个模型方案（如 DeepSeek）只需新增一个预设目录，不修改翻译器与安装器。
- 内置预设只是"用公开 schema 写好的普通数据文件"，用户可复制、修改或从零编写，机制完全相同。
- 消除"角色文件绑定了用户环境中不存在的模型导致子代理启动失败"一类问题：模型绑定是用户可显式配置的数据，不是仓库硬编码。

非目标：

- 不提供运行时动态增删角色的能力；角色集合在安装时确定。
- 不在预设层做跨角色、跨宿主的继承或引用；预设是自包含数据，重复表达优于隐式耦合。
- 不校验模型 ID 在用户环境真实存在；安装器对 `model` 只做非空校验（不校验格式与真伪，裸模型名也能通过安装但会被 ZCode 静默忽略并回退父会话模型），模型可用性由宿主在运行时暴露。

## 预设目录结构

一个预设 = 一个目录：

```
shared/roles/presets/<preset-name>/
  preset.toml        # 元数据 + 按宿主分节的角色绑定（不含正文）
  roles/<id>.md      # 每个角色的正文，id 与角色块对应
```

- `roles/<id>.md` 是纯正文（无 frontmatter），可包含 `{{role:<id>}}` 互引用。
- 同一 `id` 在一个预设内唯一；两个宿主小节引用同一 `id` 即共享同一正文。
- 正文文件缺省为 `roles/<id>.md`，可用角色块 `body` 字段指向其他文件。

## preset.toml schema

```toml
description = "GLM 预设：ZCode 5 角色绑定 GLM-5.3 / GLM-5.3-Flash。"

[zcode]
model = "account:bigmodel-individual-coding-plan/GLM-5.3-Flash"   # 该宿主角色默认 model

[[zcode.role]]
id          = "flash_low"                 # 预设内唯一；对应 roles/flash_low.md；互引用它
name        = "glm_5.3_flash_low"         # 完整角色名 = 安装后文件名基底（md）或 toml name
description = "只读常规取证与实施后预审。"  # 单行
effort      = "basic"                     # basic | deep | max
readonly    = true                        # true = 只读角色
# model     = "..."                       # 可选：覆盖宿主默认 model
# body      = "flash_low.md"              # 可选：正文文件，缺省 roles/<id>.md
# color     = "cyan"                      # 可选：仅 ZCode 消费；缺省按翻译规则推导
# tools     = [Read, Bash]                # 可选：仅 ZCode 消费；缺省按 readonly 推导
# sandbox_mode = "read-only"              # 可选：仅 Codex 消费；缺省按 readonly 推导
# skill_desc = "常规跨文件取证与预审，只读。"  # 可选：写入 SKILL.md 角色清单的描述，缺省用 description
```

字段规则：

- 顶层 `description` 必填，安装交互时展示给用户。
- 宿主小节 `[zcode]` / `[codex]` 至少出现一个；安装器只翻译与目标客户端匹配的小节。
- 宿主小节的 `model` 为该宿主角色默认值；角色块 `model` 覆盖之；两者都缺失时安装报错，不做静默回退。
- `id` 必填，预设内唯一，格式 `^[A-Za-z0-9][A-Za-z0-9_-]*$`；`name` 必填，格式 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（首字符必须字母或数字，防止路径歧义），在同一预设内也必须唯一。
- `effort`（取值 `basic` | `deep` | `max`）与宿主原生档位字段（ZCode `thoughtLevel`、Codex `model_reasoning_effort`）必须提供其一；两者同时提供时报错，不允许歧义配置。
- `readonly` 缺省视为 `true`（安全默认：未声明的角色不得写入），必须为标量布尔。
- `tools` 必须是数组形式（如 `[Read, Bash]`）；标量形式报错，`readonly = false` 的角色显式写 `tools` 也报错（写入角色继承宿主全工具）。
- 命名公式 `模型_版本_类型_思考档`（如 `glm_5.3_flash_low`）是推荐约定，不是机制；翻译器不推导名字。

## 翻译规则

### ZCode md agent（安装到 `<ZCODE_HOME>/agents/<name>.md`，顶层平铺）

```markdown
---
name: <name>
description: "<description>"
model: "<model>"
thoughtLevel: <effort 映射>
color: <color>
tools: [Read, Bash, WebFetch, WebSearch, TodoWrite]   # 仅 readonly = true 时生成
---

<正文，互引已解析>
```

- `effort` 映射：`basic → low`，`deep → high`，`max → max`。
- `color` 缺省规则：`readonly = false` → `green`；`readonly = true` 且 `effort = max` → `orange`；`readonly = true` 且 `effort = deep` → `cyan`；其余 → `cyan`。预设与内置现状的对应关系由预设显式写 `color` 保持。
- `readonly = false` 时不生成 `tools` 行（继承宿主默认全工具）。

### Codex toml role（安装到 `<CODEX_HOME>/agents/ai-vibecode-superpower/<name>.toml`）

```toml
name = "<name>"
description = "<description>"
developer_instructions = """
<正文，互引已解析>
"""
model = "<model>"
model_reasoning_effort = "<effort 映射>"
sandbox_mode = "<readonly 推导或显式值>"
```

- `effort` 映射：`basic → low`，`deep → high`，`max → max`；角色块直接写 `thoughtLevel`（ZCode）或 `model_reasoning_effort`（Codex）时使用该原生值，跳过映射，且不得与 `effort` 并存。
- `sandbox_mode` 缺省规则：`readonly = true` → `read-only`；`readonly = false` → `danger-full-access`。
- `tools`、`color` 在 Codex 侧无对应字段，被忽略（Codex 的工具边界由 sandbox_mode 与正文约束表达，属软约束）。

### 互引解析

- 正文中 `{{role:<id>}}` 替换为**同一宿主小节内**该 `id` 角色的 `name`。
- 引用本宿主小节不存在的 `id` 时安装报错；不静默保留占位符。

### 降级与警告

- 字段被目标宿主忽略（如 Codex 忽略 `tools`）时，安装器在报告中列出，不静默丢弃。
- 除上述显式规则外，翻译器不做任何值变换；解析失败、字段缺失、格式非法一律报错终止安装。

### SKILL.md 渲染

`orchestrate-model-workflow` 的 SKILL.md（两宿主变体）是"骨架 + 角色清单占位符"：角色选择段含 `<!-- preset-roles -->` 标记，安装器在装配 stage 时把它替换为当前宿主小节的角色清单，每行格式 `- \`<name>\`：<skill_desc 或 description>`，随预设变化；骨架其余文案（阶段要求、错误与恢复）只描述职责措辞，不硬编码角色名。仓库中的 SKILL.md 保留标记原样，渲染只发生在安装产物中；预设删除某角色后，清单自动不再包含它，无需改 skill 文本。

## 安装器集成

- 交互流程在选完客户端后新增预设选择：列出 `shared/roles/presets/` 下目录及其 `description`，默认推荐与客户端同源的预设（ZCode → `glm`，Codex → `gpt`），可输入其他预设名或自定义预设目录路径。
- 位置参数：`install.ps1 -Client zcode -Preset glm`；`install.sh zcode glm`。`-Preset` 缺省时走交互选择。
- 预设必须包含与目标客户端匹配的宿主小节，否则报错（如用 `glm` 预设装 Codex 会因缺少 `[codex]` 小节被拒绝）。
- `RoleCount` 不再硬编码：按所选预设当前客户端小节的角色数动态校验。
- 切换预设时的清理：安装器在宿主 home 维护受管角色清单（`agents/.ai-vibecode-superpower.managed`，md 宿主），记录上次安装的角色文件。再次安装时，清单内不在本次渲染名单中的文件先备份（`backups/`）再移除；用户自建的其他 agent 不在清单内，不受影响。Codex 宿主 role 装在独立子目录，整体替换天然覆盖。

### Manifest

- `shared/roles/presets.sha256` 记录全部预设**源文件**（preset.toml 与 roles/*.md）的规范化 SHA-256，静态提交进仓库，安装前校验一次；翻译产物不再做 hash 校验（产物是本机生成的编译物），改为结构校验：ZCode 校验 frontmatter 完整性、必填键与 `name == 文件名`；Codex 校验 6 个必填键各恰好出现一次。
- 翻译产物不再做 hash 校验（产物是本机生成的编译物），改为结构校验：ZCode 校验 frontmatter 完整性、必填键与 `name == 文件名`；Codex 校验 6 个必填键各恰好出现一次。
- 维护命令：`install.ps1 -UpdateRoleManifest` / `install.sh --update-role-manifest`，扫描 presets 目录重写 `presets.sha256`，不执行安装。修改任何预设源文件后必须运行它。

## 内置预设

- `presets/glm/`：ZCode 5 角色（与既有 `glm_5.3_*` 行为等价），不含 `[codex]` 小节——在 Codex 使用 GLM 需要用户先在 Codex 配置对应 model provider，属用户环境配置，仓库不代设。
- `presets/gpt/`：Codex 11 角色（与既有 `gpt_6*` 行为等价），不含 `[zcode]` 小节。
- `presets/ds/`：ZCode 3 角色绑定 `deepseek-v4.1-flash`（2 读 1 写；复审/终审由 `ds_4.1_flash_max` 兼任，复审派发必须是全新实例且不信任写入实例的自述）。`model` 是占位值，安装前必须改成用户 Picker 里的实际值。不含 `[codex]` 小节，理由同 glm。
- 新增模型方案：新增 `presets/<name>/` 并运行 `-UpdateRoleManifest`，不改代码。

## 运行时路由约定

`orchestrate-model-workflow` skill 的角色清单由安装器按预设渲染（见上），骨架文案只描述职责措辞与流程约束；主代理派发时以渲染后的清单和 `<ZCODE_HOME>/agents/`（Codex 对应 role 目录）实际存在的文件为准。预设可增删角色，skill 骨架无需修改。

## 迁移

- 旧目录 `zcode-global-config/agents/ai-vibecode-superpower/`、`codex-global-config/agents/ai-vibecode-superpower/` 及其 `.sha256` manifest 删除；预设是唯一事实源。
- 已安装用户重新运行安装器即获得新机制；安装器负责备份与回滚（沿用既有 targets 机制）。
