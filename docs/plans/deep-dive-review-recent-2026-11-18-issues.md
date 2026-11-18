# 近期提交与工作区审查问题记录

以下是初审时确认的触发条件、影响和建议。后续修复、独立复审和平台验证范围见[审查台账的修复记录](deep-dive-review-recent-2026-11-18.md#修复和复审)。

### 01 · P2 · 在外部菜单选中一个预设，实际装入另一个

`ba19f6c` 把菜单扩展到固定外部来源，沿用了只保存目录名的选择逻辑。编号本来唯一对应菜单中列出的目录。Shell 随后优先查找当前工作目录，如果存在同名子目录，就会改从那里读取。PowerShell 同样把所选目录转成 `.Name`，再优先检查当前目录。[Shell 选择与解析](../../install.sh#L1185) · [PowerShell 选择与解析](../../install.ps1#L793)

在隔离的外部根和启动目录各放一个名为 `demo` 的普通预设，两者声明不同模型。用伪终端运行 POSIX 安装器，菜单显示 `1) demo - model-from-external`，输入 `1` 后安装成功，生成的角色文件却声明 `model-from-cwd`。同名子目录缺少预设文件时，这条路径会报找不到预设。PowerShell 此项仅静态核对。建议编号选择一直传选中目录的完整路径，保留用户主动输入自定义路径的入口。

### 02 · P2 · macOS 桌面进程可能运行另一份 CodeGraph 或 RTK

`ba19f6c` 更新图形会话 PATH 的去重逻辑。若 Homebrew 的 bin 已排在受管 bin 前面，并且两处安装了同名工具，新逻辑保留原顺序。旧逻辑会将受管目录置首。用同一 PATH 输入对照两段代码，确认新旧顺序不同。生成的 MCP 配置通过裸命令 `codegraph` 查找程序，而 `doctor` 检查受管绝对路径，所以它可以报告 ready，桌面进程仍使用另一份安装。建议把受管 bin 和选定 Node 目录放在首位，再全局去重。[PATH 更新](../../shared/skills/agent-toolchain/scripts/agent-toolchain.sh#L1128) · [MCP 配置](../../shared/skills/agent-toolchain/scripts/agent-toolchain.sh#L406) · [健康检查](../../shared/skills/agent-toolchain/scripts/agent-toolchain.sh#L769)

### 03 · P2 · POSIX 安装器静默接受末尾含换行的绑定值

当前工作区新增的绑定读取逻辑先解码字符串，然后用 shell 命令替换取回值。命令替换在控制字符校验前去掉了末尾 LF。隔离安装中，绑定文件里的 `"CodexExample\n"` 被接受，生成角色写入 `CodexExample`。独立的函数级检查在 sh、bash、zsh 都得到相同结果。已有测试输入是字符串中间的换行。建议原样传递解码值至校验处，加上末尾换行拒绝用例。PowerShell 静态路径直接传递字符串。[取值位置](../../install.sh#L569) · [校验位置](../../install.sh#L717) · [绑定契约](../../shared/roles/README.md#L63)

### 04 · P3 · PowerShell 会从下一节误读受管段落的版本标记

`ba19f6c` 开始只检查受管段内有没有 v4 标记。若该段缺标记，而后面的 Markdown 二级标题使用下划线式写法且该节包含 v4 示例，PowerShell 只认 `##` 边界，因而把示例归入前一段并跳过迁移提示。POSIX 在相同的下划线式标题处会停止。建议 PowerShell 提取段落时使用脚本已有的 `Test-AgentsH2At`，并增加跨节示例。此项为静态确认，影响提示与旧规则迁移，无文件覆写证据。[段落边界](../../shared/skills/agent-toolchain/scripts/agent-toolchain.ps1#L181) · [标记判断](../../shared/skills/agent-toolchain/scripts/agent-toolchain.ps1#L297)

### 05 · P3 · 夹具的 Python 语法检查示例会在被审目录生成缓存

`2977611` 提供的默认 `py_compile` 示例，与审计工具规则要求缓存写到获准仓库外目录不一致。在临时目录对只含常量的独立文件执行同一命令，观察到 `__pycache__/example.cpython-313.pyc`。建议示例改用内存语法编译，或明确指定仓库外缓存位置。审查期间没有运行夹具应用。[夹具说明](../../tests/fixtures/security-audit/README.md#L21) · [缓存边界](../../shared/skills/security-audit/references/tooling.md#L9)

### 06 · P2 · 新凭据自动保存前缺少本机访问权限检查

`e081559` 新增了收到密码、令牌、私钥就自动写入 `.local/` 的要求。现有检查能确保文件被 Git 忽略且没有被跟踪，却没有要求在写入前确认其他本机账号能否访问文件。在可被其他账号遍历的共享工作目录中，普通文件创建方式配合常见的 `umask 022` 可产生 `0644` 文件，其他账号有读取权限。上级目录已隔离或安全存储工具已限制访问时，该条件不成立。本次结论来自规则与文件系统权限语义，未读取真实凭据，亦未观察到实际泄露。

建议保留私有资料归档设计。对秘密值，先确认目标的有效访问权限，在创建文件时就限制访问；已有密钥管理器的项目可以登记引用。[自动保存规则及相邻检查](../../shared/skills/project-doc-planner/references/local-project-resources.md#L169) · [Git 忽略规则](https://git-scm.com/docs/gitignore)

### 关联旧问题 · 深挖复审对同一类修复给出两种分级

当缺少书面契约、但能证明修复对合法输入没有可见影响时，验证协议明确归为 A；主流程第 3 步又笼统要求找不到契约时按 B。后者会令修复多一次审批，在只审查模式下也会改变建议等级。该矛盾在审查起点 `e8b21c8` 已存在；本轮的 `d6f23e3` 编辑同一段并保留了它。建议只对存在可见变化或影响尚未判明的情况保守分级。[流程第 3 步](../../shared/skills/deep-dive-review/SKILL.md#L53) · [验证协议](../../shared/skills/deep-dive-review/references/verifier-protocol.md#L55)
