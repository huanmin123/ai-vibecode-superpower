---
name: security-audit
description: 对目标项目及其运行环境做取证式安全审计：先测绘攻击面，再以攻击者视角建立攻击路径，按通用视角做多视角穷举排查，逐条用代码证据证实或证伪，并对外部漏洞事实做可追溯核实，输出含覆盖台账的审计报告。用于安全审计、漏洞排查、上线前体检、PR 安全审查、部署/主机/云配置审查；不用于依赖升级、普通功能开发、单点 bug 修复或未授权渗透测试。
---

# 安全审计

审计交付的是**可核对的结论**，不是漏洞清单。两条主线：

1. **攻击者视角**：从"谁、已经有什么、想得到什么、最便宜的路径是什么"组织排查，而不是从漏洞名出发。
2. **外部核实**：任何版本默认值、已知漏洞、修复版本、在野利用，都必须追溯到审计时打开过的来源。

> 本文所有入口类型、视角、层、画像、漏洞类、工具与来源列表都是**下界，不是全集**。看到任何清单，先问"这个目标还有哪些表外情况"，再按清单展开；不得因为"表里没有"而跳过。

## 定位与边界

| 任务形态 | 走向 |
| --- | --- |
| 源码、配置、供应链、部署、主机、云、CI/CD 安全审查 | 本 skill |
| 质量缺陷、隐藏 bug、回归风险 | `deep-dive-review` |
| 跨文件实现、修复与独立验收 | `orchestrate-model-workflow` |
| 依赖升级、普通功能开发、单点 bug 修复 | 不进本 skill |
| 未授权渗透、主动打靶、红队 | 不在本 skill 范围 |

默认**只读**：不修改目标仓库的源码与配置，不对目标系统发起攻击性请求。报告写到用户指定路径；未指定时用项目外临时目录或聊天正文，不写入目标仓库源码/配置。需要修复时由用户另行发起；需要运行时/主机/云验证时，必须有明确授权并限定范围。

## 不变量

违反任一条，该结论作废。

1. **攻击者目标优先**：每条 finding 要能回答"哪个画像、已有什么、想得到什么、还差哪一步"。只写"这里有个危险调用"不构成 finding。
2. **证据准入**：finding 必须有 `source(file:line) → 传播路径 → sink(file:line)`，每一跳实际读取核对。只有模式匹配的，登记为线索。
3. **控制判定**：区分"控制缺失"与"控制存在但无效"，指出具体位置。框架/库默认行为必须按安装版本核实，不凭记忆。
4. **层与证据等级**：结论要标注属于哪一层（代码/配置/供应链/主机/网络/云/CI/数据）与证据等级（E1 仓库、E2 部署产物、E3 只读运行访问、E4 文档访谈）。不得把 E1/E2 推断写成 E3 事实。
5. **外部事实可追溯**：CVE/GHSA/公告/修复版本/默认行为必须给来源、版本、检索日期；没打开过的来源不引用，不编造编号或引文。
6. **时效性**：安全事实会过期。示例与历史结论只是起点，审计时重新核实；无法核实的写"未验证"。
7. **工具只产线索**：扫描器、grep、依赖 CVE 输出都不是 finding，必须追到代码路径并确认攻击者控制与既有控制。
8. **证伪独立**：每条 confirmed 由未参与取证的实例尝试推翻；单人执行时逐条执行证伪清单并记录结果。
9. **覆盖台账**：结束列出已查、已查清白、未覆盖及原因。禁止输出"项目是安全的"，只能写"在已覆盖范围内未确认漏洞"。
10. **不夸大**：加固建议与漏洞结论分栏；依赖 CVE 不等于代码可利用；理论风险不写成已确认漏洞。
11. **开放世界**：本文任何入口类型、视角、层、画像、漏洞类、工具或来源列表都是**下界，不是全集**。目标出现清单外的组件、协议、身份、数据流或业务机制时，必须新增条目并纳入台账；不得因为"表里没有"而跳过。

## 模式与覆盖层

| 模式 | 适用 | 覆盖 |
| --- | --- | --- |
| `triage` | 快速评估、接管项目第一眼 | 入口与攻击路径、最高价值目标、密钥、依赖 high/critical |
| `full` | 资源/时间受限的完整覆盖 | 声明的全部层 × 全部视角，台账完整；不做多生成者与覆盖审计 |
| `exhaustive` | 默认；高风险系统、上线前高保证、明确要求不计成本穷举 | 覆盖空间全格；多生成者 + 合并 + 独立验证 + 覆盖审计 |
| `diff` | PR/提交/变更集 | 变更集 + 一跳调用方/被调用方；未变更区域只在证据指向时扩查 |
| `class:<名称>` | 单类深挖（如 `class:authz`） | 指定视角的完整覆盖 |

层选择：默认 L1 应用代码、L2 配置、L3 供应链。用户要求"也看服务器/部署/云"时追加 L4 主机、L5 网络、L6 云与编排、L7 身份、L8 数据与备份。没有访问权限的层标为 `not-covered`，不做推断。层定义见 [layers.md](references/layers.md)。

`exhaustive` 不是把同一提示词发给多个实例，而是先把**入口 × 视角 × 层 × 攻击者画像 × 数据资产 × 状态转换**拆成互不重叠的分片，再并行生成假设、按根因合并、独立验证、由独立覆盖审计者检查空格。协议见 [exhaustive-sweep.md](references/exhaustive-sweep.md)。没有多实例能力时顺序执行，并在报告中标注独立验证缺失。

用户未指定时：有明确变更范围用 `diff`；只说"快速看看"用 `triage`；其余默认 `exhaustive`。没有多实例能力时按 `exhaustive` 的顺序流程执行，并在报告中记录独立验证缺失，不声称多角度独立。

## 流程

### 0 建档

记录：目标路径与 ref、模式、覆盖层、可用证据与访问方式、已知部署形态、暴露假设、报告输出位置、时间预算。范围、授权或访问边界含糊且会改变结论时先问清楚；低风险缺省可按"最不利暴露"继续，但必须标注。

### 1 攻击面测绘

按 [recon.md](references/recon.md) 产出 surface map：技术栈与版本、入口清单、信任边界、身份与授权模型、数据分级、暴露证据、依赖与构建清单。

同时收集目标自身的已知问题线索：`SECURITY.md`、CHANGELOG 的安全条目、issue/PR、提交历史、跳过的安全测试、`TODO/FIXME`。方法见 [external-research.md](references/external-research.md) 第 2 节。

除表内类型外，专门找清单外入口，例如插件、规则引擎、导入导出、Webhook、消息订阅、模型/Agent 工具调用、批处理、管理脚本、设备/离线同步。入口表是下界，不是全集。

### 2 攻击者建模

按 [attacker-mindset.md](references/attacker-mindset.md) 建立：

- 攻击者画像：匿名、普通用户、同租户、跨租户、低权管理员、内部人、服务账号、供应链参与者；
- 每个画像"已经能合法做什么"，这是判断越权的基线；
- 资产与目标：机密性、完整性、可用性、身份、信任；
- 攻击路径与攻击树：入口 → 已有能力 → 缺失控制 → 目标；标注前置条件、代价、检测；
- 链式升级：一个低危发现能换来什么，还差哪一步；
- 清单外画像，例如供应商、合作伙伴、匿名 API 调用方、设备身份、外部运营；画像表是下界，不是全集。

输出按攻击者价值排序的候选路径，作为第 3 步的排查顺序。

### 3 视角排查

按 [lenses.md](references/lenses.md) 的视角表（下界，不是全集），对每条入口做 **sink 盘点 → source 假设**；具体栈的入口、控制点、逃逸口用 [stack-playbook.md](references/stack-playbook.md) 的方法定位，不背 API 清单。目标出现新边界、新机制或清单外数据流时，新增视角并记录。

| 域 | 重点 | 主要参考 |
| --- | --- | --- |
| A 授权与隔离 | 功能级、对象级、租户、管理面、服务间 | [authz.md](references/authz.md) |
| B 解释器边界 | 查询语言、OS 命令、代码/表达式、模板、日志 | [lenses.md](references/lenses.md) |
| C 数据与外部边界 | 文件、归档、上传、URL、XXE、反序列化 | [lenses.md](references/lenses.md) |
| D 身份与密码学 | 认证、会话、token、CSRF/CORS、随机数、密钥 | [lenses.md](references/lenses.md) |
| E 供应链与配置 | 依赖、构建、CI、容器、IaC、主机与网络 | [supply-chain.md](references/supply-chain.md)、[layers.md](references/layers.md) |

域表是下界；出现表外域（插件、规则引擎、模型/Agent 工具调用、数据管道、设备/离线同步）时新增域并纳入台账。

每个候选先回答：谁能影响这个值？中间有哪些控制？这个操作在什么条件下真正执行？回答不了记为 lead。

### 4 取证与证伪

按 [review-loop.md](references/review-loop.md) 对候选逐条：

1. 从 sink 反向追到 source，记录每一跳的文件与行号；
2. 判定控制类型与有效性；
3. 执行证伪清单，尝试证明不可达、不可控、已被防住或影响不成立；
4. 归类 `confirmed` / `needs-runtime` / `lead` / `clean`，给出优先级与 confidence；
5. 对 confirmed 派未参与取证的实例复核。验证者只处理分配的主假设，输出 ID 必须与输入一致；新线索单列，不混入 finding。

### 5 外部核实

按 [external-research.md](references/external-research.md) 对每条涉及外部事实的结论核实：

- 依赖漏洞：实际版本 → 公告 → affected range → 代码可达性 → 配置前置 → backport；
- 框架默认值：对应版本文档或安装源码；
- 目标历史：已修复/回滚/未回填的安全补丁、公开披露、已知限制；
- 在野利用：KEV/厂商通告只作为可利用性参考，不替代本地适用性判断。

核实记录写入 finding 的 `external_sources`；无法核实的标 `unverified`，不写成事实。

### 6 报告

按 [report.md](references/report.md) 输出：攻击路径、确认发现、待运行时验证、线索、已查清白、未覆盖、层覆盖台账、供应链与配置、外部核实记录。每条 finding 带证据锚点、控制失效原因、影响、复核方式与修复建议。

## 证据契约

```yaml
id: SEC-001
title: 一句话说明谁在什么条件下能做什么
status: confirmed | needs-runtime | lead | clean
class: CWE-639
asvs: V8
severity: critical | high | medium | low
priority: P0 | P1 | P2 | P3
confidence: high | medium | low
layers: [L1, L5]
evidence_level: E1
attacker:
  profile: 普通注册用户
  already_has: 合法会话；可枚举自己的发票 ID
  goal: 读取其他租户发票
source:   { file, line, attacker_capability }
path:     [ { file, line, note } ]
sink:     { file, line, operation }
controls: { present, why_ineffective }
impact:   具体资产与攻击者收益
evidence: 代码摘录或可复核命令输出
external_sources:
  - { id: GHSA-..., url: ..., retrieved: 2026-11-04, claim: ... }
refutation:
  - { check: reachable | attacker_control | control_effective | version_reality | impact, result }
remediation: 具体到位置与做法的修复建议
verification: 修复后如何复核
```

- `confirmed`：代码/配置层面可利用性成立，证据链完整。
- `needs-runtime`：路径成立，但结论依赖无法从仓库核实的运行时条件。
- `lead`：缺少关键环节，只作为后续入口，不进入发现统计。
- `clean`：已排查且确认不成立，写入台账并说明理由。

优先级按攻击路径的实际价值：P0 未认证或普通用户可远程直接造成 RCE、认证绕过、全量/跨租户数据泄露；P1 需登录或特定条件造成越权、敏感数据泄露、篡改、内网可达；P2 利用条件受限或影响有限；P3 加固与信息暴露。CVSS 只作补充，默认 CVSS-BE 并写明假设。

## 并行拆分

任务可拆且有多实例能力时，按域并行：授权、解释器、数据/文件、身份/密码学、供应链/配置。每个实例只拿 surface map、攻击路径候选、本域范围与相关参考文件，不投喂全仓。域表是下界；目标有表外域时新增分片，不要硬塞进现有五域。

- 取证实例只产出候选与路径，不最终定性。
- 证伪必须由未参与该条取证的实例执行；无法并行时由主代理按域顺序执行，但证伪步骤不得省略，并记录执行者。
- 外部检索可由独立实例执行，返回来源、版本、日期与适用性判断，不直接改 finding 状态。
- `exhaustive` 模式按 [exhaustive-sweep.md](references/exhaustive-sweep.md) 的分片与角色执行；生成者、合并者、验证者、覆盖审计者不得由同一实例兼任，无法满足时记录独立性缺失。合并后先做生成 ID 守恒检查；不守恒不得进入验证。
- 子代理拒绝或不可用时保留原始拒绝与缺口，不用"未发现问题"填补。

## 参考路由

| 何时读取 | 文件 |
| --- | --- |
| 开工测绘攻击面、入口、授权模型、目标历史线索 | [recon.md](references/recon.md) |
| 建立攻击者画像、攻击树、攻击路径与优先级 | [attacker-mindset.md](references/attacker-mindset.md) |
| 通用判断视角与误报陷阱 | [lenses.md](references/lenses.md) |
| 适配任意语言/框架：入口、控制点、逃逸口 | [stack-playbook.md](references/stack-playbook.md) |
| 审计层、证据等级、场景配方、主机/云边界 | [layers.md](references/layers.md) |
| 主机只读基线采集 | [server-baseline.md](references/server-baseline.md) |
| 授权、越权、多租户隔离专章 | [authz.md](references/authz.md) |
| 依赖、构建、CI、容器、仓库密钥 | [supply-chain.md](references/supply-chain.md) |
| 外部检索、公告核实、防幻觉 | [external-research.md](references/external-research.md) |
| 标准版本与权威入口 | [sources.md](references/sources.md) |
| 工具选择、命令、结果分诊 | [tooling.md](references/tooling.md) |
| 排查、取证、证伪、定级、并行拆分 | [review-loop.md](references/review-loop.md) |
| 穷举模式：覆盖空间、分片、合并、覆盖审计 | [exhaustive-sweep.md](references/exhaustive-sweep.md) |
| 报告、台账、SARIF | [report.md](references/report.md) |

## 停止条件

- `full`：声明的每个层都有状态；surface map 中每个入口 × 视角都有结论；所有 confirmed 完成独立证伪与外部核实；审计过程中新增的入口/视角/层已纳入；未覆盖项已列明原因。
- `exhaustive`：覆盖矩阵每格有状态；连续两轮覆盖审计没有新格或不成立的 `n/a`；未知未知轮完成；所有 confirmed 完成独立验证；未裁决冲突为零；未覆盖与硬上限触顶已列明。
- `triage`：声明的检查项完成，未覆盖范围明确；不得表述为完整审计。
- `diff`：变更集与一跳范围覆盖完成；新 sink、受影响授权路径、引入的依赖与配置已核查。
- `class:<名称>`：该视角的入口清单、证据要求与验证步骤执行完成。

达到停止条件只证明审计过程完成了约定覆盖，不证明对象不存在隐藏缺陷。报告中必须保留等价表述。

## 审计纪律

- 不从漏洞名出发；先问攻击者要什么，再找路径。
- 不做纯模式匹配定性；不把"使用了危险 API"当成漏洞。
- 不把依赖 CVE、缺失安全响应头、默认配置建议混入漏洞发现抬高数量。
- 不凭记忆断言版本行为；不引用未打开的来源；不编造公告编号。
- 不构造针对第三方系统的攻击载荷；本地验证只用无害标记与非破坏性请求。
- 不静默扩大范围；不把未核实内容写成已确认；不用"可能"包装后当作结论。
- 发现高危项先报告，不因继续排查而延迟；证据不足时不抢先定性。
