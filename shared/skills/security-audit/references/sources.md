# 权威来源与引用规则

审计结论要能被外部标准复核。本文件只保留与"源码安全审计"直接相关的来源，并标明版本与适用范围。

**核实日期：2026-11-04。** 引用前应重新确认版本；标准与文档会更新，报告中的引用以审计当日核实到的版本为准。

## 1 覆盖标准

### OWASP ASVS 5.0.0

- 发布：2025-05-30；当前稳定版。
- 规模：17 章、345 条需求，L1/L2/L3 三级；L1 约 70 条。
- 编号：`<章>.<节>.<条>`，引用时带版本，如 `ASVS 5.0.0 V8`。
- 用途：覆盖率骨架与需求核对。它包含文档/流程类需求，不是所有条目都能从源码验证。
- 章节：V1 编码与净化、V2 校验与业务逻辑、V3 Web 前端、V4 API/Web 服务、V5 文件处理、V6 认证、V7 会话、V8 授权、V9 自包含 token、V10 OAuth/OIDC、V11 加密、V12 安全通信、V13 配置、V14 数据保护、V15 安全编码与架构、V16 日志与错误处理、V17 WebRTC。
- 注意：ASVS 5.0 不再直接给出 CWE/NIST 映射；不要沿用 4.0 的映射。
- https://asvs.owasp.org/
- https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release

### OWASP WSTG 4.2

- 发布：2020-12-03；5.0 仍在开发。
- 结构：12 类、约 97 个顶层测试用例，编号 `WSTG-<CAT>-NN`。
- 用途：作为"可能出什么问题"的提示清单。它面向黑盒/灰盒测试，不是源码审计标准。
- 源码审查适配度较高：INPV（输入校验）、ATHZ（授权）、CRYP（加密）、ERRH（错误处理）、BUSL（业务逻辑）、CLNT（客户端）、APIT（API）、SESS（会话）、ATHN（认证）。
- 适配度低：INFO（信息收集，属运行时侦察）。
- 注意：WSTG 明确说明静态分析无法发现设计缺陷，发现需要人工验证。
- https://wstg.owasp.org/v4.2/
- https://wstg.owasp.org/v4.2/2-Introduction/#source-code-review

### OWASP Top 10:2025

- 用途：风险叙事与管理层沟通，**不作为审计检查表**。
- 类别：A01 Broken Access Control、A02 Security Misconfiguration、A03 Software Supply Chain Failures、A04 Cryptographic Failures、A05 Injection、A06 Insecure Design、A07 Authentication Failures、A08 Software or Data Integrity Failures、A09 Security Logging and Alerting Failures、A10 Mishandling of Exceptional Conditions。
- 注意：2025 版把 SSRF 并入 A01；站点未显示精确发布日期，引用时写"2025 edition"。
- https://top10.owasp.org/2025/

## 2 弱点与严重度

### CWE Top 25 2025

用于优先级参考与类别编号，不作为完整性清单。2025 版基于 39,080 条 CVE 统计。

| 排名 | CWE | 名称 |
| ---: | --- | --- |
| 1 | 79 | XSS |
| 2 | 89 | SQL 注入 |
| 3 | 352 | CSRF |
| 4 | 862 | Missing Authorization |
| 5 | 787 | Out-of-bounds Write |
| 6 | 22 | Path Traversal |
| 7 | 416 | Use After Free |
| 8 | 125 | Out-of-bounds Read |
| 9 | 78 | OS Command Injection |
| 10 | 94 | Code Injection |
| 11 | 120 | Classic Buffer Overflow |
| 12 | 434 | Unrestricted Upload |
| 13 | 476 | NULL Pointer Dereference |
| 14 | 121 | Stack Buffer Overflow |
| 15 | 502 | Deserialization of Untrusted Data |
| 16 | 122 | Heap Buffer Overflow |
| 17 | 863 | Incorrect Authorization |
| 18 | 20 | Improper Input Validation |
| 19 | 284 | Improper Access Control |
| 20 | 200 | Sensitive Information Exposure |
| 21 | 306 | Missing Authentication for Critical Function |
| 22 | 918 | SSRF |
| 23 | 77 | Command Injection |
| 24 | 639 | Authorization Bypass Through User-Controlled Key |
| 25 | 770 | Resource Allocation Without Limits |

- https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html

### CWE / CVE / CVSS 关系

- CWE 是弱点类型（根因），CVE 是具体产品中的漏洞实例，CVSS 是实例的严重度。
- 一个 CVE 可映射多个 CWE；一个 finding 只选一个主 CWE，关联类别写在正文。
- https://cwe.mitre.org/about/faq.html

### CVSS v4.0

| 等级 | 分数 |
| --- | --- |
| None | 0.0 |
| Low | 0.1–3.9 |
| Medium | 4.0–6.9 |
| High | 7.0–8.9 |
| Critical | 9.0–10.0 |

- 评分变体：CVSS-B（Base）、CVSS-BE（Base+Environmental）、CVSS-BT（Base+Threat）、CVSS-BTE。
- 证据不足以确定环境指标时给 CVSS-B；环境证据可用时给 CVSS-BE。给分须附完整 vector 并写明假设。
- https://www.first.org/cvss/v4-0/specification-document

## 3 修复参考

### OWASP Cheat Sheet Series

按问题类型引用，内容持续更新、无版本号，引用时给标题与 URL：

| 主题 | Cheat Sheet |
| --- | --- |
| 认证 / 会话 / 授权 | Authentication、Session Management、Authorization |
| 注入 | SQL Injection Prevention、Query Parameterization、OS Command Injection Defense、LDAP Injection Prevention |
| XSS / CSRF | Cross Site Scripting Prevention、DOM based XSS Prevention、CSRF Prevention |
| SSRF / XXE | Server Side Request Forgery Prevention、XML External Entity Prevention |
| 反序列化 / 上传 | Deserialization、File Upload |
| 密钥 / 加密 | Secrets Management、Cryptographic Storage、Password Storage |
| 其他 | Mass Assignment、Input Validation、Error Handling、Logging、Unvalidated Redirects and Forwards |

- https://cheatsheetseries.owasp.org/

## 4 方法与工程实践

- OWASP Code Review Guide v2.0（2017）：代码审查与静态分析分诊的基础实践；明确工具结果需人工判断。https://owasp.org/www-project-code-review-guide/assets/OWASP_Code_Review_Guide_v2.pdf
- NIST IR 8397（2021-10）：开发者最低验证实践，明确静态分析存在误报、需要抑制与优先级管理。https://csrc.nist.gov/pubs/ir/8397/final
- NIST SP 800-218 SSDF v1.1（2022-02）：PW.7 代码审查/分析，要求记录并分诊发现。https://csrc.nist.gov/pubs/sp/800/218/final
- SARIF 2.1.0（OASIS Standard，2020-03-27；Errata 01，2023-08-28）：工具结果交换格式，含 suppression/baselineState/fingerprints。https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

## 5 语言与框架文档：按目标推导，不维护清单

不存在"列全世界文档"的清单。语言、框架、版本和站点结构都在变，任何表都会过期，还会制造"读了我列的就算查过"的假象。正确做法是从目标项目自己的元数据找到文档，再切到锁定版本。

### 5.1 从目标自身拿线索

- 包清单里的 `homepage`、`repository`、`documentation`、`support` 字段（不同生态字段名不同，但都有等价项）。
- registry 项目页的 Project URLs / Homepage / Source。
- 包管理器的 `info`/`show` 输出。
- 仓库 README 的 Documentation、Security、Support 链接。
- 源码中的 `docs/`、`SECURITY.md`、`CHANGELOG`、release notes。

不要从"我记住的某语言文档站点"开始；从目标包的元数据开始，能覆盖任何语言，包括本文档没有提到的语言。

### 5.2 切到锁定版本

- 按适用的锁文件或依赖解析结果核对版本，并区分部署产物；Go 的版本证据见 [供应链审计](supply-chain.md#2-依赖清单)。
- 站点有版本选择器或 git tag，就切到该版本；没有就以安装包源码为准。
- 记录 URL、版本、检索日期。
- 文档与源码冲突时，以安装版本的实际行为为准，并记录冲突。

### 5.3 文档不够时

- 读已存在的安装包源码：`node_modules`、`site-packages`、本地 Go 模块缓存、jar sources、vendored 目录；缺失时登记缺口，另行下载须先确认授权和副作用。
- 读同一版本的 changelog/release notes，确认安全默认值是否变化。
- 读上游修复提交与 advisory，确认补丁是否回填到目标分支。
- 仍无法确认：写 `unverified`，不猜默认值。

### 5.4 安全章节优先

读文档时优先这些主题，而不是从教程首页开始：认证、授权、会话/CSRF、输入校验与输出编码、文件上传、反序列化、加密与密钥、部署/代理/头、错误与日志。

### 5.5 公告与漏洞信息

从包管理器的 audit 命令、OSV、registry 的 advisory、厂商 PSIRT 查；入口和命令随生态与版本变化，在目标环境核对。使用外部服务前确认接收方和发送数据的授权，参见 [工具选择](tooling.md) 与 [供应链审计](supply-chain.md)。不要把任何"数据库清单"当作完整覆盖，也不要把"有公告"当作"本仓库可利用"。

## 6 工具文档

以下是常用工具文档，按类别示例，不是完整清单；工具行为以实际安装版本为准。

- Semgrep：https://docs.semgrep.dev/
- CodeQL CLI：https://docs.github.com/en/code-security/codeql-cli
- Bandit：https://bandit.readthedocs.io/
- gosec：https://github.com/securego/gosec
- Brakeman：https://github.com/presidentbeef/brakeman
- gitleaks：https://github.com/gitleaks/gitleaks
- trufflehog：https://github.com/trufflesecurity/trufflehog
- OSV-Scanner：https://github.com/google/osv-scanner
- Trivy：https://trivy.dev/
- Grype/Syft：https://github.com/anchore/grype 、https://github.com/anchore/syft
- govulncheck：https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck
- Checkov：https://github.com/bridgecrewio/checkov
- ZAP baseline：https://www.zaproxy.org/docs/docker/baseline-scan/
- SARIF：https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

## 7 引用规则

1. 版本相关结论必须给版本与来源；无法核实的写"未验证"，不写成事实。
2. 不编造 ASVS 条目号。只确定章节时写 `V8`，不写猜测的 `8.2.2`。
3. CWE 映射不是一对一；一个 finding 只给主 CWE，其余在正文说明。
4. OWASP Top 10 只用于沟通，不作为覆盖率依据；覆盖率用 ASVS 章节 + 自建台账。
5. WSTG 的测试项默认按运行时测试设计；用于源码审计时只作为提示，不宣称"已按 WSTG 全量验证"。
6. Cheat Sheet 无版本号，报告引用时写标题与 URL，不写"最新版"。
7. 工具文档只用于确认命令与限制；工具的行为以其实际版本为准。
8. 来源之间冲突时，以更具体、更新、与目标版本更接近的来源为准，并在报告中记录冲突。
