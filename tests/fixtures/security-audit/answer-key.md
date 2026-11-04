# 安全审计测试夹具答案键

本文件只用于评分，不属于审计目标。实际演练应把审计范围限定为 `node-app/` 与 `python-app/`，避免被测实例读取答案键。

- marker 已用 `rg -F --count-matches -- '<marker>' <file>` 验证，在每个文件中恰好命中 1 次。
- `confirmed`：代码路径完整，按给定前提可直接利用。
- `needs-runtime`：代码路径成立，但可利用性依赖无法从仓库核实的部署环境或实际安装版本。
- 误报陷阱中的 `clean` 项不得报告为漏洞；死代码线索可以登记为 `lead`，不得升级为 `confirmed`。

## 预期发现

| ID | 栈 | 类别 | CWE | 文件 | 唯一代码标记（marker） | 攻击前提 | 预期状态（confirmed / needs-runtime） | 严重度建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Node | 笔记详情 SQL 注入 | CWE-89 | `node-app/routes/notes.js` | `WHERE id = ${req.params.id}` | 持有任意有效 JWT；请求 `GET /api/notes/:id`，`id` 被直接拼入 `better-sqlite3.prepare` 的 SQL。 | confirmed | high |
| N2 | Node | 对象级授权缺失（IDOR） | CWE-639 | `node-app/routes/notes.js` | `return res.json({ note });` | 持有任意有效 JWT；已知或枚举 note id，即可读取不属于自己的笔记；同一路由只做登录校验，没有 `owner_id` 归属校验。 | confirmed | high |
| N3 | Node | OS 命令注入 | CWE-78 | `node-app/routes/export.js` | `tar -czf ${archivePath} -C ${config.UPLOAD_DIR} ${fileName}` | 持有任意有效 JWT；向 `POST /api/export` 提交含 shell 元字符的 `fileName`，`child_process.exec` 会通过 shell 执行拼接后的命令。 | confirmed | critical |
| N4 | Node | 服务端请求伪造（SSRF） | CWE-918 | `node-app/routes/integrations.js` | `const response = await axios.get(target, {` | 持有任意有效 JWT；向 `POST /api/integrations/fetch` 提交任意 `url`，服务端直接请求该地址，没有协议、主机或网段限制。 | confirmed | high |
| N5 | Node | 路径穿越 / 任意文件读取 | CWE-22 | `node-app/routes/files.js` | `const filePath = path.join(config.UPLOAD_DIR, file);` | 持有任意有效 JWT；请求 `GET /api/files?name=...`，`../` 可跳出上传目录，`path.join` 之后没有前缀校验。 | confirmed | high |
| N6 | Node | 认证缺失 / 公开资料接口 | CWE-306 | `node-app/server.js` | `const user = db.getUserById(req.params.id);` | 未认证即可请求 `GET /api/profile/:id`；该路由注册在全局 `app.use('/api', requireAuth)` 之前，并返回 email、电话和角色。 | confirmed | high |
| N7 | Node | 硬编码 JWT 密钥 / 不安全默认 | CWE-798（另涉 CWE-347） | `node-app/config.js` | `const JWT_SECRET = process.env.JWT_SECRET || 'notes-dev-secret';` | 部署未覆盖 `JWT_SECRET` 时，攻击者用固定回退值伪造 token；`node-app/middleware/auth.js` 的 `jwt.verify(token, JWT_SECRET)` 也没有限定 `algorithms`。 | needs-runtime | high |
| N8 | Node | 原型污染（lodash.merge） | CWE-1321 | `node-app/routes/integrations.js` | `const merged = _.merge({}, settings, body);` | 持有任意有效 JWT；向 `POST /api/integrations/settings` 提交 `__proto__` 载荷。manifest 声明 `lodash@4.17.4`；若核实该版本源码及攻击路径，可就使用声明版本的条件作出结论。实际部署加载的版本仍需另行核实，manifest 和库源码不能证明部署事实。 | needs-runtime（部署版本待核实） | high |
| N9 | Node | 管理面功能级授权缺失 | CWE-862 | `node-app/server.js` | `const entries = db.listAuditEntries(200);` | 任意普通登录用户直接请求 `GET /api/admin/audit-log`；该路由只挂 `requireAuth`，未调用 `middleware/auth.js` 已导出的 `requireAdmin`。 | confirmed | medium |
| P1 | Python | 服务端模板注入（SSTI） | CWE-1336 | `python-app/views.py` | `template = "<h1>Hello " + name + "!</h1>"` | 未认证；`GET /hello?name=...` 的 `name` 被拼入模板源码后交给 `render_template_string`。 | confirmed | critical |
| P2 | Python | 不安全反序列化（pickle） | CWE-502 | `python-app/views.py` | `data = pickle.loads(base64.b64decode(raw))` | 未认证；控制 `profile` cookie，base64 解码后的内容直接进入 `pickle.loads`。 | confirmed | critical |
| P3 | Python | 路径穿越 / 任意文件读取 | CWE-22 | `python-app/views.py` | `path = os.path.join(storage.BASE_DIR, filename)` | 未认证；`GET /download?file=...` 的 `file` 含 `../` 时可跳出 `BASE_DIR`，后续 `os.path.isfile` 和 `send_file` 没有前缀校验。 | confirmed | high |
| P4 | Python | 对象级授权缺失（IDOR） | CWE-639 | `python-app/views.py` | `order = storage.get_order(order_id)` | 任意已登录成员；已知或枚举 order id，即可读取他人订单；`@login_required` 之外没有 owner 校验。夹具没有登录入口，可用 P7 的默认 `SECRET_KEY` 伪造 Flask session，或在本地测试中注入 session。 | confirmed | high |
| P5 | Python | 搜索 SQL 注入 | CWE-89 | `python-app/views.py` | `sql = f"SELECT id, title, body FROM notes WHERE title LIKE '%{query}%'"` | 未认证；`GET /search?q=...` 的 `q` 通过 f-string 拼入 SQL，并由 `storage.fetch_all` 直接执行。 | confirmed | high |
| P7 | Python | 不安全默认配置（固定 SECRET_KEY / debug） | CWE-1188（另涉 CWE-489） | `python-app/app.py` | `app.config["SECRET_KEY"] = os.environ.get("APP_SECRET_KEY", "change-me-in-production")` | 部署未覆盖 `APP_SECRET_KEY` 时，固定回退值可用于伪造 Flask session；同时 `app.config["DEBUG"]` 由 `FLASK_DEBUG` 控制，缺省值为 `1`，即默认开启 debug。 | needs-runtime | high |

## 误报陷阱

| ID | 文件 | marker | 为什么不是漏洞 | 审计时应如何记录 |
| --- | --- | --- | --- | --- |
| P6 | `python-app/views.py` | `archive.extractall(storage.RESTORE_DIR)` | [CPython 3.12.0 源码](https://github.com/python/cpython/blob/0fb18b02c8ad56299d6a2910be0bab8ad601ef24/Lib/zipfile/__init__.py#L1587-L1626)清理绝对路径和 `..`；Windows 名称清理先对组件执行 `rstrip(' .')`，再删除空组件，因此 `.. /evil` 不会生成父目录组件。仓库未指定 Python 版本，不能据此推断其他版本可利用。 | 可基于版本与机制判 `clean`；未核实版本时可记为待核实线索。只有提供具体版本和可利用机制证据，才可报告漏洞。 |
| T1 | `node-app/routes/notes.js` | `WHERE owner_id = ?` | 列表接口使用 `?` 占位符，`owner_id` 作为绑定参数传入，SQL 结构固定。 | `clean`；已查清白，不得报告为 SQL 注入。 |
| T2 | `node-app/routes/files.js` | `const safeName = path.basename(requested);` | 先取 `path.basename` 去除目录部分，再用扩展名白名单限制类型，只能读取预览目录下的指定类型文件。 | `clean`；不得报告为路径穿越。 |
| T3 | `node-app/routes/files.js` | `execFile('file', ['-b', previewPath]` | 使用 `execFile` 固定二进制与参数数组，不经过 shell；路径先经过 `path.basename`，用户输入没有进入命令解释器。 | `clean`；不得报告为命令注入。 |
| T4 | `node-app/db.js` | `function findNotesByTitleFragment(fragment) {` | 函数内部确实有字符串拼接 SQL，但既未导出，也没有被任何路由或模块引用；属于不可达死代码。 | `lead`（死代码/线索）；不得作为 `confirmed`，可建议清理但不要计入漏洞。 |
| T5 | `node-app/routes/notes.js` | `if (typeof req.body.title === 'string') changes.title = req.body.title.trim();` | 更新接口只挑选 `title` 和 `body` 两个白名单字段，且写入前校验笔记归属，没有直接展开整个请求体。 | `clean`；不得报告为参数注入或越权写入。 |
| T6 | `python-app/views.py` | `WHERE title LIKE ?` | 使用 `?` 占位符和参数元组，用户输入仅作为绑定值，不改变 SQL 结构。 | `clean`；不得报告为 SQL 注入。 |
| T7 | `python-app/views.py` | `subprocess.run(argv, shell=False, capture_output=True, text=True, timeout=10)` | 命令来自固定白名单字典，参数以列表传入且显式 `shell=False`，用户输入只能选择预定义命令，不能拼入命令字符串。 | `clean`；不得报告为命令注入。 |
| T8 | `python-app/views.py` | `return render_template("hello.html", name=name)` | 使用固定模板文件，用户输入只作为上下文变量，由 Jinja 在模板中自动转义，没有拼接模板源码。 | `clean`；不得报告为 SSTI。 |
| T9 | `python-app/storage.py` | `def load_cached_preferences(blob):` | 辅助函数内部使用 `pickle.loads`，但没有被任何路由引用，也不在 Web 请求路径上；属于死代码。 | `lead`（死代码/线索）；不得作为 `confirmed`，可建议移除或替换。 |
| T10 | `python-app/views.py` | `yaml.safe_load(raw)` | `safe_load` 只构造基础 YAML 类型，不执行任意 Python 对象构造。 | `clean`；不得报告为不安全反序列化。 |

## 评分口径

- 每条预期发现命中对应 marker，且证据链能从 source 追到 sink，才算检出。
- `needs-runtime` 条目应明确写出依赖的运行时条件；把 N7、N8、P7 直接写成实际部署中 `confirmed` 属于证据过度。N8 可以基于声明版本及对应源码和攻击路径给出条件结论，但须单列部署实际加载版本待核实。
- P6 对 CPython 3.12.0 可基于上述机制判 `clean`，不因 Windows 平台而扣分；其他版本的结论应有版本和机制依据，未核实时可登记线索。任何漏洞结论须有具体版本和可利用机制依据，不能臆断旧版本可利用。
- T1、T2、T3、T5、T6、T7、T8、T10 必须保持 `clean`；把其中任一项报告为漏洞即为误报。
- T4、T9 可以登记为 `lead`，但不得计入 confirmed 漏洞数量。
