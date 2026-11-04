# 工具选择与结果分诊

工具只负责扩大视野和降低遗漏，**不负责定性**。任何工具输出都须依据相应层的证据确认攻击者控制与既有控制后，才能进入报告；代码层结论须核查代码路径。

## 1 使用原则

- 优先使用已安装且可信的工具；静态审计不执行被审项目或依赖的构建、脚本和配置代码。使用前核实实际版本、模式、规则及其副作用；无法满足边界时登记覆盖缺口，不运行该工具。安装新工具须先获得授权。
- 优先本地/离线执行；会把代码、依赖清单或凭据发送到外部服务的工具，使用前确认授权与数据边界。
- 数据库、缓存、临时文件和报告写入获准的被审仓库外目录；确认工具不会改写被审仓库，无法确认则登记缺口。
- 记录工具名称、版本、命令、规则集/数据库版本与执行时间，保证结果可复核。
- 工具告警默认进入候选池，不直接进入"确认发现"。
- 不把工具报告原文粘贴为审计结论；报告只保留能定位问题的摘要与证据位置。

下表的工具、命令与许可证是示例，不是完整清单；以目标环境实际安装版本为准。缺工具时先确认是否已有等价能力，不要为审计引入不必要的依赖。

## 2 SAST

| 工具 | 适用 | 强项 | 局限 | 使用边界 |
| --- | --- | --- | --- | --- |
| Semgrep CE | 多语言 | 自定义规则、单函数内 taint、本地规则可离线 | 跨文件/跨过程 taint 弱；`--config auto` 会访问 Registry | 使用可信本地规则扫描 |
| CodeQL CLI | 多语言 | 深度数据流、变体分析 | 默认可能自动构建；规则包/数据库需预备，许可证需核对 | 使用当前版本支持的 `--build-mode=none`，数据库与 SARIF 写到获准目录；不支持安全无构建分析时登记缺口 |
| Bandit | Python | AST 规则覆盖常见危险调用 | 无跨文件数据流；测试/示例噪声大 | 扫描源码，报告写到获准目录 |
| gosec | Go | SSA/taint，覆盖注入、路径、TLS、弱随机 | 业务逻辑与部分跨过程场景 | 核实依赖解析及缓存副作用后扫描 |
| Brakeman | Rails | Rails 专用，SQLi/XSS/CSRF/批量赋值覆盖好 | 仅 Rails；许可证需确认商用条款 | 扫描源码，报告写到获准目录 |
| njsscan | Node/Express | 常见 Node 危险模式 | 模式匹配为主 | 扫描源码，报告写到获准目录 |
| ESLint 安全插件 | JS/TS | eval、child_process、正则、对象注入等热点 | 配置和插件可执行代码；误报需人工分诊 | 仅使用可信的已安装工具及独立配置和插件，禁用被审项目配置；不使用可能下载工具的 `npx eslint` |
| SonarQube Community | 多语言 | 质量与安全热点、CI 集成 | 深度 taint/SCA 在商业版；需自建服务 | 扫描分析数据发送到服务端，先确认具体数据与授权 |

使用 SAST 的顺序：核实工具和配置符合上述边界 → 按检测到的栈选本地工具 → 对高置信规则逐条追路径 → 低置信规则只作为线索。CodeQL 的 `none` 支持范围与分析完整性随版本和语言变化，须按实际版本核实；默认静态审计不得退回自动或手工构建。用户已明确授权具体范围的隔离构建时，按该授权执行。

## 3 密钥扫描

| 工具 | 机制 | 注意 |
| --- | --- | --- |
| gitleaks | 正则 + 熵 + 规则，支持历史 | 无实时有效性验证；`--baseline-path` 管理存量 |
| trufflehog | 多服务探测器，可选在线验证 | 本地扫描使用 `--no-verification` 和 `--no-update`，并在禁止网络的环境执行；参数以实际版本为准，不能单凭参数保证 air-gap。在线验证须先确认授权 |
| detect-secrets | 插件 + 熵，基线审计 | 适合存量基线管理；需人工标注 |

分诊：在授权范围内确认是否有效凭据、权限范围、是否在生产使用；无法确认时记录未验证。有效凭据按事件处理（轮换/吊销优先），不能只删文件。

## 4 依赖与 SBOM

| 工具 | 生态 | 说明 |
| --- | --- | --- |
| osv-scanner | 多生态/锁文件 | 支持离线数据库；有调用分析的语言优先开启 |
| Trivy | 文件系统/镜像/IaC | `--scanners vuln,secret,misconfig`；`--skip-db-update` 只跳过主漏洞库更新，离线须按版本和扫描类型预备数据库、检查包并配置其他离线选项，同时落实网络隔离 |
| Syft + Grype | 镜像/文件系统/SBOM | Syft 生成 SBOM，Grype 匹配漏洞；支持 `--only-fixed` |
| 生态原生 | npm/pnpm/yarn、pip-audit、cargo-audit、govulncheck、bundle audit、composer audit、dotnet list | 基于锁文件更准确；`govulncheck` 可达性最好 |

SBOM 只证明"有什么组件"，不证明"可利用"。报告里把 SBOM 与漏洞判定分开。

## 5 IaC、容器与配置

| 工具 | 范围 | 说明 |
| --- | --- | --- |
| Checkov | Terraform/K8s/Helm/Dockerfile/CloudFormation 等 | 支持 baseline 与 inline skip |
| Trivy config | Terraform/K8s/Dockerfile/Helm | 与漏洞扫描同一入口 |
| tfsec | Terraform | 已被 Trivy 整合，新项目优先 Trivy |
| kubesec | K8s 清单 | 只评分 securityContext，不覆盖 RBAC/网络策略 |
| Hadolint | Dockerfile | lint + ShellCheck，风格规则多，需按安全阈值过滤 |

## 6 运行时验证（仅在授权且本地/测试环境）

| 方式 | 用途 | 边界 |
| --- | --- | --- |
| ZAP baseline | 被动检查响应头、cookie、信息暴露 | 不主动攻击；只对本地/测试目标 |
| 单点 HTTP 验证 | 确认某个已定位结论（如越权、开放重定向） | 使用测试账号与无害标记；不碰生产；不构造破坏性载荷 |
| 浏览器验证 | DOM XSS、前端信任边界 | 仅本地复现，不对外部系统执行 |

渗透测试、主动扫描、漏洞利用不属于本 skill 的默认范围。任何对非本地目标的操作都需要用户明确授权，并记录目标、时间窗与范围。

## 7 SARIF 与合并

SARIF 2.1.0 是工具结果的标准交换格式。合并多个工具的 `runs`，不要试图语义合并结果数组；先确认输出路径已获准且不存在，或现有内容可恢复：

```bash
jq -s '{version:"2.1.0",
  "$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
  runs:[.[].runs[]]}' '<获准目录>/a.sarif' '<获准目录>/b.sarif' > '<获准目录>/merged.sarif'
```

每个结果至少保留：`ruleId`、`level`、`message.text`、`locations[].physicalLocation`（URI + 行列，1-based）、`partialFingerprints`。修复/抑制使用 `suppressions`（`kind`、`status`、`justification`），存量用 `baselineState` 区分新增与既有。

如果目标平台支持代码扫描上传，注意：仅接受 SARIF 2.1.0；单文件有大小上限；同一工具 + 同一 category 的新上传会替换旧结果。上传前确认平台与权限，不把内部代码扫描结果发到未授权服务。

## 8 误报治理

- 每条被抑制的告警必须记录原因、责任人、日期；"静默忽略"不可接受。
- 优先用规则级/路径级抑制，不用全局关闭规则。
- 抑制后代码变更时重新评估；指纹变化意味着需要重看。
- 统计抑制率：持续升高说明规则或代码模式需要调整，而不是继续加抑制。
- 不把"工具没报"当作 clean；clean 必须有相应层的判定证据，代码层须核查代码链。

## 9 工具选择速查

| 目标 | 首选 | 补充 |
| --- | --- | --- |
| 快速找注入/路径/SSRF | 对应语言 SAST + 精确 grep | 手工追路径 |
| 授权/越权 | 无可靠工具 | 逐入口人工核查（见 authz.md） |
| 密钥 | gitleaks/detect-secrets | trufflehog（确认授权后） |
| 依赖漏洞 | 锁文件 + osv-scanner/Trivy | 语言原生工具做交叉验证 |
| 容器/IaC | Trivy config/Checkov | Hadolint、kubesec |
| 变更集审查 | 项目 CI 已有 SAST + 手工 diff 追踪 | 自定义 Semgrep 规则 |
