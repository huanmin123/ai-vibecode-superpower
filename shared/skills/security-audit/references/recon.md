# 攻击面测绘

测绘的目标不是"看懂项目"，而是产出后续排查可直接使用的边界与清单：哪些输入能进入系统、经过哪些控制、落到哪些敏感操作、由谁授权。

## 1 技术栈与版本

先确定**实际运行版本**，而不是清单里的声明版本：

```bash
rg --files -g 'package.json' -g 'pnpm-lock.yaml' -g 'yarn.lock' -g 'package-lock.json'
rg --files -g 'pyproject.toml' -g 'requirements*.txt' -g 'poetry.lock' -g 'uv.lock' -g 'Pipfile*'
rg --files -g 'go.mod' -g 'go.sum'
rg --files -g 'pom.xml' -g 'build.gradle*' -g 'gradle.lockfile'
rg --files -g 'composer.json' -g 'composer.lock' -g 'Gemfile' -g 'Gemfile.lock'
rg --files -g '*.csproj' -g 'packages.lock.json' -g 'Directory.Packages.props'
rg --files -g 'Cargo.toml' -g 'Cargo.lock'
```

记录：语言与运行时版本、框架与主版本、ORM/模板/HTTP 客户端/序列化库、鉴权库。版本决定默认行为（自动转义、参数化、反序列化策略、安全响应头），是后续判定控制是否有效的依据。

同时确认构建与运行方式：`Dockerfile`、`docker-compose*`、`Procfile`、`*.service`、`serverless.yml`、`fly.toml`、`app.yaml`、K8s 清单。它决定"代码里的入口是否真的对外"。

## 2 入口清单

按实际框架枚举，不靠目录名猜。每类至少记录路由/处理器位置、方法、认证要求、角色要求、输入来源。

| 入口类型 | 查找方式 |
| --- | --- |
| HTTP/JSON | 路由注册（`app.get`、`router.*`、`@GetMapping`、`path()`、`urlpatterns`、`Route::`、`routes.rb`） |
| 文件上传/下载 | multipart、`UploadFile`、`multer`、`$_FILES`、`MultipartFile`、流式响应 |
| GraphQL | schema、resolver、`Query`/`Mutation` 定义、`node(id:)` |
| RPC/消息 | gRPC service、消费者注册、队列订阅、事件处理函数 |
| 定时任务/后台作业 | cron、scheduler、worker、job 注册与重试入口 |
| CLI/运维脚本 | `main()`、`argparse`/`click`/`cobra`/`commander`、管理命令 |
| Webhook/回调 | 回调路由、签名校验逻辑、第三方事件处理 |
| Server Action/边缘函数 | `"use server"`、`route.ts`、edge functions、lambda handler |
| 文件系统/配置 | 扫描目录、监听文件、读取环境变量或挂载配置的路径 |

入口必须能对应到具体函数与文件行。找不到注册点的 handler 记为"未接线"，不当作可达入口。

入口类型不是穷举；专门找表外入口：插件、规则引擎、导入导出、消息订阅、模型/Agent 工具调用、批处理、管理脚本、设备/离线同步。发现表外入口时新增一行，并说明它为什么可达或为什么不可达。

## 3 信任边界

画出数据跨越的边界，每条边都问"谁在另一侧、能提供什么"：

- 互联网/边缘 → 应用（含反代、CDN、WAF、网关；它们不是授权边界）
- 匿名用户 → 登录用户 → 普通角色 → 管理角色
- 租户 A → 租户 B（共享库、共享缓存、共享存储、共享队列）
- 应用 → 数据库/缓存/对象存储/消息队列
- 应用 → 第三方 API、用户可控 URL、内网服务
- 应用 → 构建/部署/CI（供应链边界）
- 前端 → 后端（客户端校验不构成边界）

记录每条边界上**实际执行**的校验位置：中间件、过滤器、拦截器、全局 guard、数据库行级安全、网关规则。只写在文档或前端的不算。

## 4 身份与授权模型

产出授权矩阵，后续 A 域排查直接使用：

| 入口 | 认证方式 | 角色/权限判定 | 对象级判定 | 租户谓词 | 判定位置 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/notes/:id` | JWT | 无 | 无 | 无 | — |
| `POST /api/admin/*` | JWT + 角色 | `requireAdmin` | — | — | `middleware/auth.js:31` |

必须核实的点：

- 认证从哪里取身份：session cookie、Bearer token、API key、mTLS、网关注入头。网关注入头只有在应用**不信任客户端同名头**时才成立。
- 授权是集中还是分散：全局中间件、路由组、装饰器、注解、策略对象、数据库 RLS。集中式要检查注册顺序与排除规则；分散式要逐个入口核对。
- 角色与租户来自哪里：服务端查询、token 声明、请求体/请求头。来自请求体或客户端可改的声明，按不可信处理。
- 是否存在"前端隐藏"式的伪授权：菜单隐藏、按钮禁用、客户端路由守卫，都不构成服务端授权。

## 5 数据分级

标记需要重点保护的数据与位置：凭据与密钥、会话与 token、PII、支付与财务、健康与身份证明、租户标识、内部配置、审计日志。

数据分级决定影响的严重度，也决定哪些 sink 值得优先追。找不到数据模型时，从迁移文件、schema、ORM 模型、序列化 DTO 反推。

## 6 暴露证据

对每个外部入口，收集能证明"是否真的可达"的证据：

- 路由是否被注册到对外监听的服务，还是只在内部 router/未挂载模块中；
- 是否有认证中间件、全局前缀、网关规则、feature flag、环境判断；
- 部署形态是单机、容器、Serverless 还是内网服务；
- 生产配置与仓库默认是否不同（`NODE_ENV`、`DEBUG`、`ENV`、profile）。

代码只能证明"存在路径"，不能证明"公网可达"。两者必须分开写：`reachable: code-path` 与 `exposure: assumed internet / internal / unknown`。

## 7 目标自身的已知问题

在开始判断前，先收集项目自己留下的线索；它们既是审计入口，也是"是否已修/是否回填/是否只是已知限制"的证据：

```bash
rg --files -g 'SECURITY.md' -g 'CHANGELOG*' -g 'RELEASE*' -g 'docs/security*'
rg -n 'TODO|FIXME|HACK|XXX|security|vuln|insecure|unsafe|bypass' \
  --glob '!vendor' --glob '!node_modules' --glob '!dist' .
rg -n 'skip|xfail|@Ignore|\.only\(|disabled' tests/ 2>/dev/null
git log --all --oneline -i --grep='security' --grep='CVE-' --grep='vulnerab' --grep='auth bypass' --grep='SSRF' --grep='XSS' --grep='injection'
git log --all -S'unsafe' --oneline -- path/to/area 2>/dev/null
git tag --sort=-creatordate | head -20
```

记录：已知披露与修复版本、被回滚或未回填的修复、跳过的安全测试、注释中的"暂时不校验"、仍开放的 issue/PR。检索与可信度规则见 [external-research.md](external-research.md) 第 2 节。

这些线索只作为入口：issue 里写了不等于代码仍存在，注释写了"内部可信"也不等于控制有效，必须回到当前 ref 核实。

## 8 依赖与构建清单

记录直接依赖与锁定版本、安装脚本（`postinstall`、`build.rs`、`setup.py`）、构建产物来源、CI 工作流与权限、容器基础镜像。具体检查见 [supply-chain.md](supply-chain.md)。

## 9 输出模板

```markdown
# Surface Map

## 栈与版本
- 运行时 / 框架 / ORM / 模板 / 序列化 / 鉴权库（含锁定版本）

## 入口
| ID | 类型 | 位置 | 方法/触发 | 认证 | 角色 | 输入 |
| --- | --- | --- | --- | --- | --- | --- |

## 信任边界
| ID | 从 | 到 | 实际校验位置 | 备注 |
| --- | --- | --- | --- | --- |

## 授权矩阵
| 入口 | 认证 | 功能级 | 对象级 | 租户 | 判定位置 |
| --- | --- | --- | --- | --- | --- |

## 数据分级
| 数据 | 位置 | 级别 | 关联入口 |
| --- | --- | --- | --- |

## 暴露假设
| 入口/服务 | 代码可达 | 部署假设 | 证据 | 置信度 |
| --- | --- | --- | --- | --- |

## 覆盖层与证据
| 层 | 是否覆盖 | 证据等级 | 证据来源 |
| --- | --- | --- | --- |
| L1 应用代码 | | E1 | |
| L2 配置 | | E1/E2 | |
| L3 供应链 | | E1 | |
| L4-L8 | | | 需额外访问 |

## 依赖与构建
- 清单文件 / 锁文件 / 安装脚本 / CI / 容器
```

## 测绘纪律

- 先读路由注册与中间件装配，再读业务实现；顺序反了容易把不可达代码当成入口。
- 以"实际运行版本"为准核实框架默认行为；声明版本与锁定版本不一致时，以锁文件为准并记录差异。
- 入口、边界、授权矩阵都必须能落到 file:line；落不到的写成待确认项，不带入后续定性。
- 测绘阶段不下漏洞结论；发现可疑 sink 只登记位置，留给分域排查。
