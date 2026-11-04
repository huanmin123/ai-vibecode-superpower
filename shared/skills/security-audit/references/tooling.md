# 工具选择与结果分诊

工具只负责扩大视野和降低遗漏，**不负责定性**。任何工具输出都必须回到代码路径，确认攻击者控制与既有控制后，才能进入报告。

## 1 使用原则

- 优先使用仓库已配置的工具与项目自带命令；需要安装新工具时先获得授权。
- 优先本地/离线执行；会把代码、依赖清单或凭据发送到外部服务的工具，使用前确认授权与数据边界。
- 记录工具名称、版本、命令、规则集/数据库版本与执行时间，保证结果可复核。
- 工具告警默认进入候选池，不直接进入"确认发现"。
- 不把工具报告原文粘贴为审计结论；报告只保留能定位问题的摘要与证据位置。

下表的工具、命令与许可证是示例，不是完整清单；以目标环境实际安装版本为准。缺工具时先确认是否已有等价能力，不要为审计引入不必要的依赖。

## 2 SAST

| 工具 | 适用 | 强项 | 局限 | 典型命令 |
| --- | --- | --- | --- | --- |
| Semgrep CE | 多语言 | 自定义规则、单函数内 taint、本地规则可离线 | 跨文件/跨过程 taint 弱；`--config auto` 会访问 Registry | `semgrep scan --config ./rules .` |
| CodeQL CLI | 多语言 | 深度数据流、变体分析 | 规则包/数据库需下载；许可证对私有仓库与非开源用途有限制 | `codeql database create db --language=<lang> --source-root .` 后 `codeql database analyze db <packs> --format=sarif-latest --output=out.sarif` |
| Bandit | Python | AST 规则覆盖常见危险调用 | 无跨文件数据流；测试/示例噪声大 | `bandit -r . -lll -f sarif -o bandit.sarif` |
| gosec | Go | SSA/taint，覆盖注入、路径、TLS、弱随机 | 业务逻辑与部分跨过程场景 | `gosec -fmt=sarif -out=gosec.sarif ./...` |
| Brakeman | Rails | Rails 专用，SQLi/XSS/CSRF/批量赋值覆盖好 | 仅 Rails；许可证需确认商用条款 | `brakeman -f sarif -o brakeman.sarif` |
| njsscan | Node/Express | 常见 Node 危险模式 | 模式匹配为主 | `njsscan . --sarif -o njsscan.sarif` |
| ESLint 安全插件 | JS/TS | eval、child_process、正则、对象注入等热点 | 官方说明存在大量需人工分诊的误报；不是完整 SAST | `npx eslint .` |
| SonarQube Community | 多语言 | 质量与安全热点、CI 集成 | 深度 taint/SCA 在商业版；需自建服务 | `sonar-scanner` |

使用 SAST 的顺序：先跑项目已有配置 → 再按检测到的栈选一个本地工具 → 对高置信规则逐条追路径 → 低置信规则只作为线索。

## 3 密钥扫描

| 工具 | 机制 | 注意 |
| --- | --- | --- |
| gitleaks | 正则 + 熵 + 规则，支持历史 | 无实时有效性验证；`--baseline-path` 管理存量 |
| trufflehog | 多服务探测器，可选在线验证 | 验证会向凭据提供方发请求；先确认授权与网络策略 |
| detect-secrets | 插件 + 熵，基线审计 | 适合存量基线管理；需人工标注 |

分诊：先确认是否有效凭据、权限范围、是否在生产使用。有效凭据按事件处理（轮换/吊销优先），不能只删文件。

## 4 依赖与 SBOM

| 工具 | 生态 | 说明 |
| --- | --- | --- |
| osv-scanner | 多生态/锁文件 | 支持离线数据库；有调用分析的语言优先开启 |
| Trivy | 文件系统/镜像/IaC | `--scanners vuln,secret,misconfig`；可用 `--skip-db-update` 离线 |
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

SARIF 2.1.0 是工具结果的标准交换格式。合并多个工具的 `runs`，不要试图语义合并结果数组：

```bash
jq -s '{version:"2.1.0",
  "$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
  runs:[.[].runs[]]}' a.sarif b.sarif > merged.sarif
```

每个结果至少保留：`ruleId`、`level`、`message.text`、`locations[].physicalLocation`（URI + 行列，1-based）、`partialFingerprints`。修复/抑制使用 `suppressions`（`kind`、`status`、`justification`），存量用 `baselineState` 区分新增与既有。

如果目标平台支持代码扫描上传，注意：仅接受 SARIF 2.1.0；单文件有大小上限；同一工具 + 同一 category 的新上传会替换旧结果。上传前确认平台与权限，不把内部代码扫描结果发到未授权服务。

## 8 误报治理

- 每条被抑制的告警必须记录原因、责任人、日期；"静默忽略"不可接受。
- 优先用规则级/路径级抑制，不用全局关闭规则。
- 抑制后代码变更时重新评估；指纹变化意味着需要重看。
- 统计抑制率：持续升高说明规则或代码模式需要调整，而不是继续加抑制。
- 不把"工具没报"当作 clean；clean 必须有代码层面的判定依据。

## 9 工具选择速查

| 目标 | 首选 | 补充 |
| --- | --- | --- |
| 快速找注入/路径/SSRF | 对应语言 SAST + 精确 grep | 手工追路径 |
| 授权/越权 | 无可靠工具 | 逐入口人工核查（见 authz.md） |
| 密钥 | gitleaks/detect-secrets | trufflehog（确认授权后） |
| 依赖漏洞 | 锁文件 + osv-scanner/Trivy | 语言原生工具做交叉验证 |
| 容器/IaC | Trivy config/Checkov | Hadolint、kubesec |
| 变更集审查 | 项目 CI 已有 SAST + 手工 diff 追踪 | 自定义 Semgrep 规则 |
