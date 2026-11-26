# 角色预设与翻译器规范

本目录是跨宿主角色配置的权威来源：预设（preset）以中立 schema 描述一套 agent 角色，安装器在安装时把预设翻译为 ZCode 的 md agent、Codex 的 toml role 与 Antigravity 的原生插件子代理（md agent）。仓库不直接维护任何宿主角色文件；宿主文件是本目录预设的编译产物。

## 目标与非目标

目标：

- 用户只维护一份角色定义，即可生成 Codex 与 ZCode 两个宿主的角色文件。
- 新增一个模型方案（如 DeepSeek）只需新增一个预设目录，不修改翻译器与安装器。
- 内置预设只是"用公开 schema 写好的普通数据文件"，用户可复制、修改或从零编写，机制完全相同。
- 消除"角色文件绑定了用户环境中不存在的模型导致子代理启动失败"一类问题：ZCode 的 `model` 必须使用本机 Picker 的 `providerId/modelId`，其中 providerId 随登录账号、套餐或自建 provider 重建而变化；预设通过 `local:<key>` 声明逻辑绑定，安装时从本机绑定文件解析，仓库不硬编码用户 provider。同一逻辑 key 的后缀键 `<key>_<label>` 可在安装时展开为多组 provider 变体，供运行时按当前模型选择。

非目标：

- 不提供运行时动态增删角色的能力；角色集合在安装时确定。
- 不验证模型是否真实存在或可用；但使用 `local:<key>` 时必须显式提供绑定，且 ZCode 绑定解析结果必须通过 `providerId/modelId` 格式校验。后缀变体只从绑定文件的显式键枚举，不推断模型语义。
- 不自动探测本机 provider 集合或模型列表；绑定由用户显式维护。安装器只枚举绑定文件中已写出的后缀键。

## 预设目录结构

每个预设目录都包含安装所需的角色正文，可以单独复制到外部预设目录修改。本机模型绑定由安装环境提供。

```
shared/roles/presets/<preset-name>/
  preset.toml        # 元数据 + 按宿主分节的角色绑定（不含正文）
  roles/<id>.md      # 每个角色的正文，id 与角色块对应
```

- `roles/<id>.md` 是纯正文（无 frontmatter），可包含 `{{role:<id>}}` 互引用。
- 同一 `id` 在一个预设内唯一；两个宿主小节引用同一 `id` 即共享同一正文。
- 正文文件缺省为 `roles/<id>.md`，可用角色块 `body` 字段指向其他文件。

内置预设中需要保持一致的正文只在 [bodies/](bodies/) 编辑。[targets.txt](bodies/targets.txt) 每行列出一个相对 `presets/` 的目标路径，源文件是 `bodies/` 下的同名 Markdown 文件。运行下文的 manifest 更新命令会用源文件覆盖这些目标，再更新校验值。外部预设可以直接编辑自己目录中的正文。

## preset.toml schema

```toml
description = "ZCode 单角色示例，绑定 GLM-5.3-Flash。"

[zcode]
# 宿主角色默认 model；local:<key> 在安装时解析。
model = "local:glm_flash"

[[zcode.role]]
# id 在预设内唯一，对应 roles/flash_low.md，并用于角色互引用。
id = "flash_low"
# 完整角色名会作为安装后的 md 文件名基底或 toml role name。
name = "glm_5.3_flash_low"
# 保持为单行描述。
description = "只读常规取证与实施后预审。"
# basic、deep、max 映射为宿主档位。也可用下方对应宿主的原生字段替代 effort，不能同时设置。
effort = "basic"
# ZCode 原生档位字段示例，使用时注释或删除上面的 effort。
# thoughtLevel = "low"
# true 表示只读角色。
readonly = true
# 可选：覆盖宿主默认 model。
# model = "local:glm_main"
# 可选：正文文件，缺省为 roles/<id>.md。
# body = "flash_low.md"
# 可选：仅 ZCode 消费，缺省按翻译规则推导。
# color = "cyan"
# 可选：仅 ZCode 消费，须保持 readonly = true。
# tools = ["Read", "Bash"]
# 可选：仅 Codex 消费。
# sandbox_mode = "read-only"
# 可选：写入 SKILL.md 角色清单的描述，缺省使用 description。
# skill_desc = "常规跨文件取证与预审，只读。"
```

字段规则：

- 顶层 `description` 必填，安装交互时展示给用户。
- 宿主小节 `[zcode]` / `[codex]` / `[antigravity]` 至少出现一个；安装器只翻译与目标客户端匹配的小节。
- 宿主小节的 `model` 为该宿主角色默认值；角色块 `model` 覆盖之；两者都缺失时安装报错，不做静默回退。
- `model` 可写具体值或 `local:<key>`。`local:` 是保留前缀，任何以它开头的值都按本机绑定键解析，不能表示字面模型 ID；key 必须匹配 `^[A-Za-z][A-Za-z0-9_-]*$`。
- 解析优先级：先按角色块 `model` > 宿主小节 `model` 选中值，再解析其中的 `local:`；具体值原样使用。ZCode 下 `local:` 的解析结果必须是 `providerId/modelId`（至少一个 `/`，两段非空且不含空白），直接写具体值时安装器只做非空校验；Codex 下 `local:` 的解析结果只要求非空。绑定值在两个宿主下都不得以 `local:` 开头，且不得包含控制字符。
- 绑定 key 缺失或绑定值非法时安装失败；缺失 key 一次性汇总列出，不静默回退。精确键 `<key>` 仍是必需项；额外 provider 通过后缀键 `<key>_<label>` 声明。
- 后缀键的 `label` 必须匹配 `^[a-z0-9][a-z0-9_-]*$`，同一预设引用的所有 `local:` key 必须提供同一 label，缺一个就安装失败。预设显式引用的 key 优先，不会被当作更短 key 的变体；同一 key 的各 label 与精确键不得绑定到完全相同的值。
- 仅 ZCode 展开后缀变体；Codex 只使用精确键，`[codex]` 的后缀键不参与展开。
- `id` 必填，预设内唯一，格式 `^[A-Za-z0-9][A-Za-z0-9_-]*$`；`name` 必填，格式 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（首字符必须字母或数字，防止路径歧义），在同一预设内也必须唯一。
- `effort`（取值 `basic` | `deep` | `max`）与宿主原生档位字段（ZCode `thoughtLevel`、Codex `model_reasoning_effort`）必须提供其一；两者同时提供时报错，不允许歧义配置。
- `readonly` 缺省视为 `true`，必须为标量布尔；`true` 表达角色不得写入的职责约束，不证明宿主工具层已禁止写入；`false` 表示继承宿主全工具（Codex 侧并据此推导 `sandbox_mode` 缺省值），是否写入由角色正文的职责决定。
- `tools` 必须是数组形式（如 `[Read, Bash]`）；标量形式报错，`readonly = false` 的角色显式写 `tools` 也报错（这类角色继承宿主全工具，是否写入由正文决定）。
- 命名公式 `模型_版本_类型_思考档`（如 `glm_5.3_flash_low`）是推荐约定，不是机制；翻译器不推导名字。安装器为后缀变体追加 `_<label>`（name 与 id 都追加），这是安装期的唯一名字推导。

## 本地模型绑定

ZCode 的 `model` 是本机 Picker 值 `providerId/modelId`；providerId 随登录账号、套餐或自建 provider 重建变化，modelId 也可能改名。预设因此可写 `local:<key>`，安装时再从仓库外的绑定文件解析为实际值。

文件位置：

- macOS / Linux：`~/.ai-vibecode-superpower/model-bindings.toml`
- Windows：`%USERPROFILE%\.ai-vibecode-superpower\model-bindings.toml`

格式为 TOML 子集：支持 `[zcode]` / `[codex]` 小节、双引号字符串值、整行 `#` 注释与空行；重复的小节或同一小节内重复 key 报错。安装器只在所选预设实际引用 `local:` 时读取并校验该文件；读取时会校验两个小节的结构，但只用当前宿主对应的小节解析绑定。

```toml
[zcode]
ds_flash   = "<provider-a>/<your-deepseek-model>"
# 可选：第二个 provider 的同模型变体
ds_flash_b = "<provider-b>/<your-deepseek-model>"
glm_flash  = "<your-glm-plan>/GLM-5.3-Flash"
glm_main   = "<your-glm-plan>/GLM-5.4"
```

- 只需提供所选预设实际引用的 key；未引用的 key 可省略，也不做 `providerId/modelId` 语义校验，但其 TOML 子集语法仍会被解析。缺失精确 key 一次性汇总报错；被引用 key 的值格式非法，或解析出的 ZCode 绑定值不符合 `providerId/modelId` 格式时同样安装失败。不静默回退，也不自动探测本机 provider。
- 绑定文件位于仓库外，不提交、不进入 `shared/roles/presets.sha256`，安装器不修改它。
- 存在 provider 变体时，绑定值会进入角色 `description` 和 skill 角色清单；不要包含 `{{` 或 home 占位符 token（如 `<ZCODE_HOME>`、`<CODEX_HOME>`、`<GLOBAL_HOME>`、`$(ZCODE_HOME)`），避免安装后的占位符展开拒绝或改写该值。
- 账号、套餐、provider 或 modelId 变化时，只改绑定文件对应值并重跑安装器；无需改预设或重新生成 manifest。外部预设也可直接写具体 `provider/model`，此时不经过绑定层。

### 多 provider 变体

ZCode 的 agent `model` 是精确的 `providerId/modelId`，运行时不会按同名 model 跨 provider 回退。需要在多个 provider 之间切换、同时保留每角色档位时，用后缀键为同一逻辑 `local:<key>` 增加变体组：

- 精确键 `<key>` 是默认组，角色名不变；后缀键 `<key>_<label>` 生成一组变体，角色 name 与 id 都追加 `_<label>`。
- `label` 必须匹配 `^[a-z0-9][a-z0-9_-]*$`；同一预设引用的所有 `local:` key 必须提供同一 label，否则安装报错，避免同组角色跨 provider 混合。预设显式引用的 key 优先，不会被当作更短 key 的变体。
- 同一 key 的精确键与各 label 不得绑定完全相同的值；每个被引用的变体值都通过 `providerId/modelId` 格式校验。
- 多组模式下，参与变体的角色（含默认组）在 `description` 和 `SKILL.md` 角色清单行追加 `（model: <providerId>/<modelId>）`；正文中的 `{{role:<id>}}` 解析为同 label 的变体，只有固定了具体 model 的角色才回落到默认组且保持无标注。
- 仅 ZCode 展开；Codex 只使用精确键。单 provider 不生成变体，角色文件与旧版一致。
- 新增 provider：在绑定文件加一个后缀键，重跑完整安装；已有变体之间切换 provider 不需要安装；删除绑定后重装会备份并清理旧变体。
- 清单行带 `model:` 标注时，运行时由主代理读取自身 `You are powered by the model named <providerId>/<modelId>`，选择标注完全一致的变体；没有匹配变体时按工作流 skill 的“错误与恢复”使用继承当前会话模型的子代理，不改派其他 label 的变体。没有标注的清单行按角色清单正常派发。
- 同一绑定文件同时服务多个预设时，其他预设的 key 若以当前引用的 key 加下划线开头，会被当作当前预设的变体；避免让不同逻辑模型的 key 互为前缀（如 `glm` 与 `glm_flash`），并为这类预设使用单独的绑定文件。

## 翻译规则

安装器在渲染前解析当前宿主选中的 `local:` 绑定并替换为实际 `model`；存在后缀键时，绑定层还会按 label 复制角色并改写同组互引，渲染器只看到一组普通角色。翻译器仍把传入的 `model` 原样写入产物。

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
- `sandbox_mode` 缺省规则：`readonly = true` → `read-only`；`readonly = false` → `danger-full-access`。当前 Codex 的 custom agent 配置不会用该字段覆盖父会话的 `sandbox_mode` 或 `approval_policy`，因此生成此字段本身不能建立角色级只读沙箱；实际权限由宿主支持的权限边界决定。需要强制隔离时，应采用并验证当前宿主实际支持的权限设置，详见 [Codex 子代理权限说明](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agent-file-schema)。
- `tools`、`color` 在 Codex 侧无对应字段，被忽略。角色正文表达职责要求；这些文本要求不构成工具层的写入隔离。

### Antigravity 原生子代理（安装到 `<ANTIGRAVITY_HOME>/agents/<name>.md`，默认 `<ANTIGRAVITY_HOME>` 为 `~/.gemini/config/plugins/ai-vibecode-superpower`）

```markdown
---
name: <name>
description: "<description>"
subagent: true
mainAgent: false
tools: [read_file, run_command, manage_task, search_web]   # readonly = true 缺省；readonly = false 展开为全量工具集
---

<正文，互引已解析>
```

- `subagent: true` 与 `mainAgent: false` 固定生成，确保角色作为 Antigravity 子代理被主代理通过 `invoke_subagent` 派发，而不污染主代理列表。
- Antigravity 的子代理工具白名单在省略 `tools` 时会收缩为极小只读默认集，因此翻译器对 `readonly = false` 显式展开为 `[read_file, edit_file, write_file, run_command, manage_task, search_web]`，对 `readonly = true` 缺省展开为 `[read_file, run_command, manage_task, search_web]`（剥离 `edit_file`/`write_file`，也可在预设里通过 `tools` 数组进一步收窄）。
- Antigravity 的子代理模型档位由主代理在调用 `invoke_subagent` 时通过 `Model` 参数指定；`[antigravity]` 中的 `model` 必须为 `flash_lite`、`flash`、`inherit` 或 `pro`（非法值在安装期报错拒绝）。翻译器不向 agent frontmatter 写入 `model`、`thoughtLevel`、`color` 或 `sandbox_mode`，而是将解析后的 `model` 自动追加为 `（invoke_subagent Model: <model>）` 写入 agent `description` 与 `orchestrate-model-workflow` 的 `SKILL.md` 角色清单，保证单一事实源；预设里的 `effort` 仍按 `basic` / `deep` / `max` 校验。

### 互引解析

- 正文中 `{{role:<id>}}` 替换为**同一宿主小节、同一 provider label 内**该 `id` 角色的 `name`；被引用角色没有同 label 变体时回落到默认组的 `name`（通常只发生在固定了具体 `model` 的角色上）。
- 引用本宿主小节不存在的 `id` 时安装报错；不静默保留占位符。

### 降级与警告

- 字段被目标宿主忽略（如 Codex 忽略 `tools`）时，安装器在报告中列出，不静默丢弃。
- 除上述显式规则外，翻译器不做任何值变换；解析失败、字段缺失、格式非法一律报错终止安装。

### SKILL.md 渲染

`orchestrate-model-workflow` 的 SKILL.md（双宿主共享骨架）是"骨架 + 角色清单占位符"：安装器只把角色选择段中的 `<!-- preset-roles -->` 标记替换为当前宿主小节的角色清单，每行格式 `- \`<name>\`：<skill_desc 或 description>`，随预设变化。存在后缀变体时，参与变体的角色在 `description` 与清单行追加 `（model: <providerId>/<modelId>）`；骨架中的路由规则只在清单行带标注时要求主代理按当前模型选择标注一致的变体，没有标注时按角色清单正常派发。骨架其余文案仍只描述职责措辞与流程约束，不硬编码角色名。仓库中的共享 SKILL.md 保留标记原样，渲染只发生在安装产物中；预设删除某角色后，清单自动不再包含它。

## 安装器集成

- 交互流程先选预设来源（内置 `shared/roles/presets/` 或外部固定目录 `~/.ai-vibecode-superpower/presets/`），再选客户端，然后只列出包含对应宿主小节（`[zcode]` / `[codex]`）的预设及其 `description`；内置来源默认推荐与客户端同源的预设（ZCode → `glm`，Codex → `gpt`）。输入编号或列表中展示的名称会选择该来源中的目录，也可输入自定义目录路径（相对路径可用 `./` 显式指定）。列表按客户端过滤，不能安装到当前客户端的预设不会出现。
- 位置参数：`install.ps1 -Client zcode -Preset glm`；`install.sh zcode glm`。`-Preset` 缺省时走交互选择。
- 外部来源：`install.sh zcode --external zcode-ds`；`install.ps1 -Client zcode -Preset zcode-ds -External`。外部根目录不存在时安装器创建并打印路径；目录为空时输出复制内置预设的模板命令并退出。外部预设不做 `presets.sha256` 校验，但仍做宿主小节、角色名与 model 结构校验；显式目录路径继续支持。
- 绑定解析：内置 `glm` / `ds` 的 ZCode 角色使用 `local:`，安装前必须提供对应绑定；外部预设写具体 `provider/model` 时不需要绑定文件，写 `local:` 时同样走绑定层。解析发生在 manifest 校验（外部预设跳过）与宿主小节校验之后、渲染之前；ZCode 的后缀 label 在解析阶段枚举、校验并展开为角色副本。
- 预设必须包含与目标客户端匹配的宿主小节，否则报错（如用 `glm` 预设装 Codex 会因缺少 `[codex]` 小节被拒绝）。
- `RoleCount` 不再硬编码：按本次实际渲染的角色文件数动态校验，包含参与变体的角色副本。
- 切换预设时的清理：安装器在宿主 home 维护受管角色清单（`agents/.ai-vibecode-superpower.managed`，md 宿主），记录上次安装的角色文件，包含所有 provider 变体。再次安装时，清单内不在本次渲染名单中的文件先备份（`backups/`）再移除；用户自建的其他 agent 不在清单内，不受影响。Codex 宿主 role 装在独立子目录，整体替换天然覆盖。

### Manifest

- `shared/roles/presets.sha256` 记录全部预设**源文件**（preset.toml 与 roles/*.md）的规范化 SHA-256，静态提交进仓库，安装前校验一次；翻译产物不再做 hash 校验（产物是本机生成的编译物），改为结构校验：ZCode 校验 frontmatter 完整性、必填键与 `name == 文件名`；Codex 校验 6 个必填键各恰好出现一次。provider 变体是翻译产物，不进入 manifest。
- 绑定文件 `~/.ai-vibecode-superpower/model-bindings.toml` 位于仓库外，不属于预设源文件，不参与 manifest 校验和；也不是安装器的受管 target。
- 维护命令：`install.ps1 -UpdateRoleManifest` / `install.sh --update-role-manifest`。修改共享正文、同步目标或预设文件后运行一次，将更新后的预设正文和 `presets.sha256` 一起提交。

## 内置预设

- `presets/glm/`：ZCode 6 个逻辑角色（与既有 `glm_5.3_flash_*` / `glm_5.4_*` 行为等价，另含界面设计角色），`model = local:glm_flash`，`review_high` / `review_max` / `design_high` 使用 `local:glm_main`；需在绑定文件 `[zcode]` 提供 `glm_flash` 与 `glm_main`。提供后缀 label 时按 label 倍增为多组变体。不含 `[codex]` 小节——在 Codex 使用 GLM 需要用户先在 Codex 配置对应 model provider，属用户环境配置，仓库不代设。
- `presets/gpt/`：Codex 13 角色（luna / terra / sol / astra 四档分工），不含 `[zcode]` 小节。
- `presets/ds/`：ZCode 4 个逻辑角色，`model = local:ds_flash`（2 读 1 写，另含界面设计角色；复审/终审由 `ds_4.1_flash_max` 兼任，复审派发必须是全新实例且不信任写入实例的自述）；需在绑定文件 `[zcode]` 提供 `ds_flash`。提供后缀 label 时按 label 倍增为多组变体。不含 `[codex]` 小节，理由同 glm。
- `presets/antigravity/`：Antigravity 6 个原生子代理（2 只读取证 `agy_scout_flash` / `agy_scout_deep`、1 写码主力 `agy_worker`、2 只读复审/终审 `agy_reviewer` / `agy_auditor`、1 界面设计 `agy_designer`），映射到 Antigravity 的 `flash` / `inherit` / `pro` 档位，开箱即用无需本地模型绑定文件。
- 新增模型方案：新增 `presets/<name>/` 并运行 `-UpdateRoleManifest`，不改代码；使用 `local:` 时在预设描述中注明所需 key。为使用 `local:` 的已有预设增加同逻辑模型的第二个 provider 只需在绑定文件加后缀键并重跑安装，不需要新增预设或更新 manifest。

### 界面设计角色

三个内置预设共用[界面设计角色正文](bodies/design_high.md)。角色设为 `readonly = false`，以便使用宿主工具走查界面和截图。具体模型由各预设的 `design_high` 角色块指定。

## 运行时路由约定

`orchestrate-model-workflow` skill 的角色清单由安装器按预设渲染（见上），骨架文案描述职责措辞、流程约束和 provider 标注的路由规则；主代理派发时以渲染后的清单和 `<ZCODE_HOME>/agents/`（Codex 对应 role 目录）实际存在的文件为准。清单行带 `model:` 标注时，主代理读取自身 `You are powered by the model named <providerId>/<modelId>`，只选择标注完全一致的变体；没有匹配变体时按错误与恢复使用继承当前会话模型的子代理，不改派其他 provider 的变体。没有标注的清单行按角色清单正常派发。预设可增删角色，清单自动更新。

## 迁移

- 旧目录 `zcode-global-config/agents/ai-vibecode-superpower/`、`codex-global-config/agents/ai-vibecode-superpower/` 及其 `.sha256` manifest 删除；预设是唯一事实源。
- 已安装用户重新运行安装器即获得新机制；安装器负责备份与回滚（沿用既有 targets 机制）。
