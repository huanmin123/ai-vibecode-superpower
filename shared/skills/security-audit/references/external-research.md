# 外部检索与事实核实

安全事实会过期：默认值会变、API 会废弃、漏洞会新披露、修复版本会回填。审计中任何"我知道这个版本默认如何""这个组件有 CVE"的说法，都必须能追溯到**审计时打开过的来源**。

模型记忆不是来源。训练截止时间不是"当前"。

## 1 先定义问题

检索前写清要确认什么，不同问题去不同地方：

| 问题 | 一手来源 | 交叉验证 |
| --- | --- | --- |
| 这个版本是否存在已知漏洞 | OSV、GitHub Advisory、厂商 PSIRT、发行版 tracker | NVD/CVE.org、包管理器 audit |
| 这个漏洞是否影响本仓库 | 公告的 affected range + 锁文件版本 + 代码调用 | 发行版 backport 记录、修复提交 |
| 这个框架/库的默认行为 | 对应版本文档、源码 tag、changelog | 依赖源码、release notes |
| 这个 API 是否危险 | 官方文档的安全章节、CWE/Cheat Sheet | 社区/研究文章（仅辅助） |
| 是否存在在野利用 | CISA KEV、厂商通告、可信研究 | EPSS（概率，不是结论） |
| 这个项目以前出过什么问题 | SECURITY.md、CHANGELOG、issue/PR、CVE、bug bounty 披露 | 提交历史、版本 diff |
| 这类问题的通用判定方法 | ASVS、WSTG、CWE、OWASP Cheat Sheets、NIST | 论文与会议研究 |

问题越精确，检索越短。不要用"某框架安全吗"代替"某框架 4.2.1 的 CSRF 默认是否启用"。

## 2 目标自身的已有问题

审计开始前先看项目自己留下了什么线索：

```bash
rg --files -g 'SECURITY.md' -g 'CHANGELOG*' -g 'RELEASE*' -g 'docs/security*'
rg -n 'TODO|FIXME|HACK|XXX|security|vuln|insecure|unsafe|bypass' \
  --glob '!vendor' --glob '!node_modules' --glob '!dist' .
rg -n 'skip|xfail|@Ignore|\.only\(|disabled' tests/ 2>/dev/null
git log --all --oneline -i --grep='security' --grep='CVE-' --grep='vulnerab' --grep='auth bypass' --grep='SSRF' --grep='XSS' --grep='injection'
git log --all -S'unsafe' --oneline -- path/to/area 2>/dev/null
git tag --sort=-creatordate | head -20
```

重点看：

- `SECURITY.md` 的披露流程、支持版本、已知限制。
- `CHANGELOG`/release notes 中的 "security"、"CVE"、"fix" 条目，尤其是**未升级的版本**。
- issue/PR：security 标签、已关闭的修复、误报讨论、被拒绝的补丁、仍开放的披露。
- 提交历史：安全修复是否被回滚、是否只修了主分支而未回填、是否在发布分支缺失。
- 测试：被跳过/禁用/仅标记的安全测试，通常对应已知未修问题。
- 代码注释：`TODO`/`FIXME` 中的"暂时不校验""内部可信""后续补"。

公开 issue 可能包含未修复漏洞。引用时只写必要摘要，不在报告中扩散可直接利用的细节。

### 2.1 目标产品的外部披露

项目自身历史之外，还要查"这个产品/版本在外部被披露过什么"：

- 确认产品名、版本、部署形态（自建/云服务/桌面/库），再搜 `<product> security advisory`、`<product> CVE`、`<product> vulnerability`。
- 开源项目：GitHub Security Advisories、release notes 的 security 段落、issue/PR、项目邮件列表、CVE/GHSA。
- 商业产品：厂商 PSIRT、支持矩阵与 EOL 公告、信任中心、安全公告订阅页。
- 有 bug bounty 的项目：公开披露的 writeup 与致谢列表，通常能指出高风险入口。
- 把外部披露与当前 ref 对照：是否已修复、是否回填到当前分支、是否只在特定配置下成立、是否有未修复的变体。

外部披露是**线索**：同样的产品名不等于同样的代码与配置，必须回到当前仓库核实。

## 3 依赖漏洞的核实流程

1. **确定实际版本**：从锁文件读取，不用清单里的范围号。
2. **查公告**：OSV/GHSA/厂商 PSIRT/发行版 tracker；记录公告 ID、CVE、affected range、fixed version。
3. **核对适用性**：
   - 版本是否落在 affected range；
   - 受影响函数/特性是否被本仓库调用；
   - 是否满足公告要求的配置/前置条件；
   - 发行版是否已 backport（上游未修不代表本环境未修，反之亦然）。
4. **核对可利用性**：入口是否可达、需要什么权限、是否有在野利用（KEV）、EPSS 只作参考。
5. **下结论**：`代码可利用` / `依赖风险（未证明可达）` / `不适用` / `需运行时确认`。
6. **给修复**：升级到哪个版本、是否有 backport、无法升级时的缓解措施。

```bash
osv-scanner scan source -r .
# 只查询包名与版本，不上传代码
curl -s https://api.osv.dev/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"package":{"name":"<pkg>","ecosystem":"npm"},"version":"<version>"}'
```

查询外部 API 属于只读网络请求，但仍要确认授权与数据边界：不要发送源码、内部 URL、凭据或客户数据。

## 4 版本相关行为的核实

1. 从包元数据/registry 找到官方文档，再切到**对应版本**（版本选择器或 tag），不是最新版。
2. 文档含糊时读安装版本的源码：`node_modules`、`site-packages`、`go mod download` 的模块、jar sources、vendored 目录。
3. 查 changelog/release notes，确认安全默认值是否在版本间变化。
4. 记录：版本、文档 URL、核实日期。
5. 文档与源码冲突时，以安装版本的实际行为为准，并在报告中记录冲突。

不能核实的行为写"未验证"，不写"默认安全"或"默认危险"。

## 5 检索技巧

- 用精确标识：包名 + 版本、`CVE-YYYY-NNNN`、`GHSA-xxxx-xxxx-xxxx`、`RUSTSEC-...`、`GO-YYYY-NNNN`。
- 搜厂商安全公告与 release notes 的 security 段落，不只搜 CVE。
- 对比"当前版本 → 最新版本"的 changelog，找安全修复与行为变更。
- 查发行版 tracker（Debian/Ubuntu/RHEL/Alpine）确认 backport 状态。
- 查项目 issue/PR 的 security 标签与已关闭修复。
- 本地有仓库时优先 `git log`/`git diff`，比外部搜索更接近事实。
- 每次检索设定时间盒（例如 10–15 分钟）；到期未确认就记录"未验证"与"还需要什么"。

### 5.1 研究型检索

用于理解"这类攻击是怎么成立的"，不是用来直接证明目标可利用：

- GitHub：仓库的 Security Advisories、issue/PR、code search（找同类 sink 的真实用法、修复 diff、绕过讨论）、PoC 仓库。
- 论文与会议：USENIX Security、IEEE S&P、NDSS、CCS、arXiv；适合新型攻击类别与利用链，不保证适用于目标版本。
- 厂商研究博客与公开披露：用于理解前置条件与检测方法，必须回到目标代码与版本验证。
- 看到 PoC/exploit 时只判断适用性（版本、配置、入口、权限），不在报告中提供可直接武器化的完整代码。

研究型来源按第 6 节的 C 级处理：可以作为假设来源，不能单独作为 confirmed 依据。

## 6 可信度与防幻觉

| 等级 | 来源 | 用法 |
| --- | --- | --- |
| A | 厂商安全公告、官方文档对应版本、源码 | 可直接作为结论依据 |
| B | OSV/GHSA/NVD/CVE.org、发行版 tracker | 需核对版本与适用性 |
| C | 安全研究博客、会议论文、bug bounty 披露 | 用于理解攻击方式，需复现或交叉验证 |
| D | 聚合站、论坛、AI 生成摘要 | 只能作为线索，不单独引用 |

硬性规则：

- 不编造 CVE/GHSA/公告 ID、日期、版本号、URL 或引文。没有打开过的来源不引用。
- 区分"受影响""可利用""在野利用"；三者不是同义词。
- PoC/ExploitDB 存在不等于目标适用；不把利用代码贴进报告。
- 二手来源与一手来源冲突时，以一手、版本特定、更新的来源为准，并记录冲突。
- 同一事实至少两个独立来源，或一个一手来源 + 本地代码核实。
- 报告写明检索日期；公告会更新。

## 7 记录模板

```yaml
question: <要确认的具体问题>
target: <package@version / framework@version / commit>
source: <URL 或公告 ID>
source_type: vendor | osv | ghsa | nvd | distro | research
retrieved: <YYYY-MM-DD>
claim: <来源原话的准确摘要>
applicability:
  affected_range: <是/否>
  code_reachable: <是/否/未知>
  config_precondition: <满足/不满足/未知>
  backport: <有/无/未知>
conclusion: applicable | not-applicable | unverified
```

## 8 常驻入口

以下是检索起点，不是事实本身，也不是完整清单；具体项目的文档与公告从目标包元数据推导，不要依赖本列表。

- OSV：https://osv.dev/
- GitHub Advisory：https://github.com/advisories
- NVD：https://nvd.nist.gov/
- CVE.org：https://www.cve.org/
- CISA KEV：https://www.cisa.gov/known-exploited-vulnerabilities-catalog
- EPSS：https://www.first.org/epss/
- CWE：https://cwe.mitre.org/
- OWASP ASVS / WSTG / Cheat Sheets：见 [sources.md](sources.md)
- 厂商 PSIRT：按目标栈搜索 `<vendor> security advisory`
- 发行版 tracker：Debian Security Tracker、Ubuntu CVE Tracker、Red Hat Security Advisories、Alpine secdb
- 学术与会议：USENIX Security、IEEE S&P、NDSS、CCS、arXiv（用于理解类别，不直接证明目标可利用）

## 9 停止条件

- 问题已由一手来源回答，且适用性已核对 → 进入结论。
- 时间盒到期仍无法确认 → 记录 `unverified`、已查来源、缺失条件，交由用户或运行时验证。
- 不为"让报告显得充分"继续堆链接；引用数量不是证据强度。
