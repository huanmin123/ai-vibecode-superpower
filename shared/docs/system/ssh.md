## SSH 连接与认证规则

1. 用户明确给出地址、端口、账号、密码、密钥、代理、跳板机等参数时，组装为**单条可直接执行命令**，尽可能规避交互式密码输入，防止AI终端执行卡在密码等待交互。
   - 指定端口：ssh 用小写 `-p`，plink 用大写 `-P`，二者不可混淆。
   - 指定私钥：ssh 和 plink 均使用 `-i 密钥路径`。
   - **平台策略**：
      - Linux/macOS：优先密钥；需要确认能否免交互时用 `ssh -o BatchMode=yes`（无可用密钥时快速失败，不阻塞）。用户只提供密码且无密钥时，用 `SSHPASS` 环境变量配合 `sshpass -e ssh user@host -p 端口`（`sshpass -p` 会把密码放进 argv，不使用）；首次连接的主机密钥确认需按用户指定策略预先处理，否则仍会阻塞。环境无 sshpass 时备注：环境缺少 sshpass，会进入密码交互，AI 无法继续执行。
      - Windows：密码登录**优先使用 plink**，不使用 sshpass（sshpass 无官方 Windows 版，第三方移植依赖多）。
   - Windows plink 全自动连接流程（关键）：
      1. plink 首次连接新主机会因主机密钥未缓存而报错，**禁止**不加 `-batch` 等待人工输入 y，**禁止**用 `echo y | plink` 管道（plink 读控制台不读 stdin，会卡住）。
      2. 用 Windows 自带工具提前获取主机密钥指纹：
         - `ssh-keyscan -t ed25519 主机IP` 获取公钥
         - `ssh-keygen -lf 公钥文件` 计算指纹，提取 `SHA256:xxxx`
      3. 连接时携带指纹：`plink -batch -pw "密码" -hostkey "SHA256:xxxx" user@host -P 端口 "远程命令"`
      4. `-hostkey` 不会自动缓存密钥，每次连接都需携带；也可使用 `-pwfile 密码文件路径` 替代 `-pw`（密码不进命令行历史，更安全）。
   - Windows 环境约束：
      1. plink 非系统自带，使用前必须先检测 `plink` 命令是否存在。
      2. 未检测到 plink：**先询问用户是否同意安装 plink**（说明：plink 是 PuTTY 官方命令行工具，可通过包管理器安装 PuTTY 或单 exe 下载后全局使用，用于实现一行命令带密码非交互登录）。用户同意后执行安装；用户拒绝则输出原生 ssh 命令并追加备注【Windows原生OpenSSH无命令行传密码能力，当前命令运行后会阻塞等待人工输入密码，AI无法自动完成登录，强烈建议配置密钥登录】。
      3. plink 安装方式（用户同意后执行），按顺序只采用第一个可用分支：
         - 包管理器：检查 `winget`、`choco`、`scoop`，存在则用其安装 PuTTY（winget 包 ID 为 `PuTTY.PuTTY`）；安装后用 `Get-Command plink.exe -All` 确认解析路径，不在 `PATH` 时使用完整路径调用。
         - 直接下载：没有包管理器时下载官方 `plink.exe`，核对官方发布页公布的 SHA-256 后再使用；未获得可核对摘要时记录残余风险。使用 `System.Net.WebClient`（兼容旧版 PowerShell，禁止用 Invoke-WebRequest/iwr），地址 `https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe`，先保存到用户目录，用 `plink -V` 验证版本后复制到 `C:\Windows\System32\` 实现全局调用；复制失败则保留在用户目录并使用完整路径调用。
      4. 用户提供密钥文件：输出 `ssh -i "密钥路径" -p 端口 user@host`，优先密钥免交互。
   - 跳板/代理：ssh 用 `-J user@jumphost:port`（ProxyJump）；plink 不支持 `-J`，需用 `-proxycmd "plink -W %host:%port user@jumphost"`。
   - 所有参数合并一条完整命令输出，禁止输出分步操作。

2. 用户未指定认证相关参数，直接输出 `ssh user@host`，交由本地 ssh 客户端自动读取 `~/.ssh/config`、私钥、ssh-agent、跳板代理配置，不自行追加 `-i`/`-p`/`sshpass`/`plink` 等参数。

3. 禁止输出需要人工手动输入密码或主机密钥确认的分步流程，避免执行流阻塞。所有参数仅来源于用户输入，不脑补额外配置。

4. 禁止使用 VBS SendKeys、模拟键盘输入等不稳定方案，不输出给 Agent 使用。

5. 用户本地无密钥仅有密码时：Windows 环境可同时提供两条路线供用户选择——①安装 plink + ssh-keyscan 获取指纹实现全自动密码登录；②生成密钥对（ssh-keygen + 公钥推送）一次性配置后永久免密。不自动执行密钥生成操作，输出命令由用户手动执行。
