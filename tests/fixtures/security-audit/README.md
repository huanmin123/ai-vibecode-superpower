# 安全审计测试夹具

> **警告：本目录故意包含不安全代码，仅用于安全审计演练。禁止部署、运行或暴露到网络。**

本目录不是可运行的产品项目，也不应作为依赖安装、服务启动或端口暴露的源材料。夹具中的每个“业务功能”都可能有意保留缺陷；任何实际执行都可能造成文件写入、命令执行或数据泄露。所有密钥、令牌和账号信息均为公开示例值或明显的 FAKE 值，例如 `notes-dev-secret`、`change-me-in-production`、`*.example.test`，不对应任何真实凭据。

## 用途

用于端到端验证 `security-audit` skill 的检出率、证据链完整性和误报控制：

- 审计范围应限定为 `node-app/` 与 `python-app/`；`answer-key.md` 和 `markers.json` 只供评分器使用，不应提供给被测实例。
- 预期发现与误报陷阱的对照关系见 `answer-key.md`。
- 契约测试将 `markers.json` 与答案键的两张表逐项比对 ID、分类、文件和 marker；每个 marker 在对应文件中应恰好命中一次。

## 安全约束

1. 仅做静态阅读和代码审计，不执行应用代码。
2. 不要运行 `npm install`、`pip install` 或任何包管理器安装命令；`node_modules/`、虚拟环境和锁文件都不在夹具内。
3. 不要运行 `node server.js`、`flask run`、`python app.py`，不要启动容器或反向代理。
4. 不要把任何服务或端口暴露到本机网络之外；不要向夹具中的接口发送真实请求。
5. 如需语法检查，只使用 `node --check <file>` 和 `python3 -m py_compile <file>`；不要用应用入口做启动检查。

## 目录

| 路径 | 说明 |
| --- | --- |
| `README.md` | 本说明。 |
| `answer-key.md` | 评分答案键：预期发现、误报陷阱、marker 与状态建议。 |
| `markers.json` | 机器可读的 marker 清单，覆盖全部预期发现和陷阱，供契约测试逐条校验。 |
| `node-app/` | 小型 Express 笔记服务，模拟 JWT 鉴权、笔记、文件、导出和第三方集成。包含 N1–N9 与 T1–T5。 |
| `python-app/` | 小型 Flask 工作台，模拟问候、个人资料、下载、订单、搜索、备份恢复和配置读取。包含 P1–P7 与 T6–T10。 |
| `python-app/templates/hello.html` | `/safe-render` 使用的固定模板，用于对照安全渲染与 SSTI。 |

## 运行假设

夹具不提供登录签发接口或登录页，避免引入与审计目标无关的账号体系：

- Node 侧需要登录态的接口假定调用方持有由身份服务签发的 JWT；在默认 `JWT_SECRET` 未覆盖时，可按 N7 的默认密钥伪造。
- Python 侧 `@login_required` 接口假定已有 Flask session；本地测试可用 Flask 测试客户端注入 session，或在默认 `SECRET_KEY` 未覆盖时按 P7 伪造。
- P6 是版本相关的误报陷阱：CPython 3.12.0 的 Windows 名称清理会删除尾随空格/点清理后为空的组件，不能据此认定 Zip Slip；其他版本的结论须有具体版本和机制依据（源码见答案键）。
- `package.json` 只声明依赖和版本，不包含锁文件或 `node_modules`；`requirements.txt` 同样未安装。实际运行版本无法从仓库核实，评分时应按 `answer-key.md` 的 `needs-runtime` 口径处理相关条目。

所有文件使用 LF 换行；代码注释使用英文，说明文档使用简体中文。
