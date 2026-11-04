# 供应链与配置审计

供应链问题的判定标准与代码漏洞不同：**组件存在漏洞不等于本仓库可利用**。必须把"版本存在、代码可调用、入口可达、部署暴露"分开记录，不能把依赖告警直接写成 finding。

## 1 范围

- 依赖与传递依赖（直接/间接、运行时/开发）
- 锁文件与安装脚本（`postinstall`、`build.rs`、`setup.py`、`prepare`）
- 构建系统与产物来源
- CI/CD 工作流、凭据与权限
- 容器镜像、基础镜像、IaC（Terraform/K8s/Helm）
- 仓库中的密钥与历史提交
- 外部服务与回调的信任配置

## 2 依赖清单

先确定**实际锁定版本**，再看是否存在漏洞。常见对应关系如下（示例，不是完整清单；以目标仓库实际使用的包管理器为准）：

| 生态 | 清单 | 锁文件 |
| --- | --- | --- |
| Node | `package.json` | `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` |
| Python | `pyproject.toml` / `requirements*.txt` | `poetry.lock` / `uv.lock` / `Pipfile.lock` |
| Go | `go.mod` | `go.sum` |
| JVM | `pom.xml` / `build.gradle` | `gradle.lockfile` / 依赖树 |
| PHP | `composer.json` | `composer.lock` |
| Ruby | `Gemfile` | `Gemfile.lock` |
| .NET | `*.csproj` | `packages.lock.json` |
| Rust | `Cargo.toml` | `Cargo.lock` |

只有清单没有锁文件时，解析结果可能与生产不一致，必须在报告中标注"版本未锁定/可能漂移"。

## 3 已知漏洞与可达性

常用工具如下（示例；优先使用项目已有工具，缺工具时先确认是否已有等价能力）：

| 工具 | 适用 | 要点 |
| --- | --- | --- |
| `osv-scanner scan source -r .` | 多生态 + 锁文件 | 优先锁文件；支持 `--call-analysis` 的语言可减少未调用告警 |
| `trivy fs --scanners vuln,secret,misconfig .` | 文件系统/镜像/IaC | 缺省扫描 `vuln,secret`；用 `--severity` 过滤 |
| `govulncheck ./...` | Go | 基于调用图，信噪比最好；无抑制机制 |
| `npm audit` / `pnpm audit` / `yarn npm audit` | Node | 无锁文件不可靠；`--audit-level` 只改退出码，不过滤报告 |
| `pip-audit -r requirements.txt` | Python | 解析环境或锁文件；注意解析漂移 |
| `cargo audit` | Rust | 基于 `Cargo.lock` 与 RustSec |
| `bundle audit` / `composer audit` | Ruby / PHP | 基于锁文件 |
| `dotnet list package --vulnerable` | .NET | 需还原依赖 |

判定顺序：

1. 漏洞是否影响**实际锁定版本**；
2. 受影响函数是否被本仓库调用（有调用图工具时优先）；
3. 调用路径是否可从外部入口到达；
4. 是否有可用修复版本；没有修复时是否有官方缓解措施；
5. 运行时依赖还是仅开发/构建依赖；
6. 是否已通过配置/特性开关规避（仅在能证明时采用）。

以上无法确认的，归入"供应链告警/待验证"，不写成代码漏洞。

## 4 安装脚本与构建

- Node：`preinstall`/`install`/`postinstall`/`prepare` 会在安装时执行；检查直接依赖与传递依赖是否含可疑脚本。
- Python：`setup.py` 的 `cmdclass`、`build` 钩子；`pyproject.toml` 的构建后端。
- Rust：`build.rs` 与过程宏在编译期执行。
- 构建产物：是否从网络下载二进制、是否校验哈希/签名、是否使用 `curl | sh` 式安装。
- 依赖来源：是否使用内部 registry、git 依赖、tarball URL；是否存在 typosquat 近似名。
- 版本固定：是否使用 `latest`、宽范围 `^`/`~`、未固定 commit 的 git 依赖。

## 5 CI/CD 与凭据

- 工作流是否使用 `pull_request_target` 且检出/执行 PR 代码；
- `permissions` 是否最小化（默认可能过宽）；
- Action/镜像是否固定到 commit SHA；
- 是否把密钥写入日志、artifact、缓存；
- 是否允许 fork PR 访问密钥；
- 发布流程是否签名、是否有 provenance/SBOM；
- 自托管 runner 是否可被不可信代码触达。

## 6 容器与 IaC

- 基础镜像是否固定 digest、是否以 root 运行、是否含不必要工具；
- 是否 `privileged`、挂载 docker socket、共享宿主网络；
- K8s：`securityContext`、RBAC、NetworkPolicy、Secret 管理；
- Terraform：公开 bucket、过宽 IAM、未加密存储、开放安全组；
- 反向代理：是否把管理端口、调试端口、内部服务暴露到公网。

工具：`checkov -d .`、`trivy config .`、`hadolint Dockerfile`、`kubesec scan`。它们的输出同样是线索，需结合部署实际判断。

## 7 仓库密钥

1. 扫描当前文件与 git 历史（`gitleaks git`、`trufflehog git file://.`、`detect-secrets`）。
2. 确认凭据是否**有效、权限多大、是否已在生产使用**；不能确认有效性的，标为"疑似泄露"。
3. 处理顺序：先轮换/吊销，再清理历史；只从工作区删除不算修复。
4. 测试夹具、示例值、已吊销凭据记 clean 并注明依据。

注意：部分工具的"验证"会向凭据提供方发起请求。使用前确认授权与网络策略，避免把凭据发送到未授权服务。

## 8 配置审计

配置问题要区分"仓库默认"与"生产实际"：

- 调试开关、详细错误、管理端点、默认账号；
- 认证/会话/CORS/CSRF 配置是否被显式关闭；
- TLS 校验、代理信任、Host 校验；
- 上传大小、超时、连接数、日志级别；
- 密钥是否来自环境/密钥管理，是否有不安全回退值。

只有能证明生产继承该默认值时，才把配置问题升级为 finding；否则记为"配置风险/需部署核实"。

## 9 输出

供应链与配置发现单列一节，不与代码漏洞混排。每条写清：

- 组件/配置、锁定版本、影响条件；
- 可达性判定（调用了哪个函数、从哪个入口）；
- 可利用性前提（配置、暴露、权限）；
- 修复版本或缓解措施；
- 无法验证的部分。

## 10 误报陷阱

| 现象 | 正确处理 |
| --- | --- |
| 依赖有 CVE | 先核对版本、调用、可达性；不可达记告警 |
| 开发依赖漏洞 | 标注 dev-only，按构建链影响评估 |
| `latest` 标签 | 记为可复现性/供应链风险，不直接定为漏洞 |
| 示例密钥 | 确认非真实凭据后记 clean |
| 容器以 root 运行 | 结合是否可被外部触达、是否有其他隔离判断 |
| CI 权限过宽 | 需要证明可被不可信代码触发才升级 |
