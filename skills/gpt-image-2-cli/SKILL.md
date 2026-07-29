---
name: gpt-image-2-cli
description: 通过本地 imagegen CLI 和模型 gpt-image-2 生成图像；将 Codex Desktop 的 `~/.codex/auth.json` 与 `~/.codex/config.toml` 中的凭据和提供方配置桥接为 `OPENAI_API_KEY`、`OPENAI_BASE_URL`。用户明确要求 gpt-image-2 图像生成、指出官方/API 示例误用非图像模型或错误端点、要求复现既有 Codex 鉴权/配置图像生成流程，或需要使用当前 Codex 提供方而非内置 `image_gen` 工具输出图像时使用。
---

# GPT Image 2 CLI

## 用途

使用此 skill 以 `--model gpt-image-2` 运行随附的图像生成 CLI，同时复用当前 Codex Desktop 的鉴权和配置文件。这样无需手工复制 API key，也能避免在用户明确需要 GPT Image 生成时误调用文本模型或 Responses 模型。

可移植的辅助脚本：

```text
scripts/invoke_gpt_image2.py      # 直接的跨平台入口
scripts/invoke-gpt-image2.ps1     # 适用于 Windows/macOS/Linux 的 PowerShell 包装器
```

## 工作流

1. 可用时按系统 `imagegen` skill 的约定组织提示词：包含使用场景、资产类型、主体、风格、构图、精确文字、约束和避免项。
2. 在当前工作区内选择输出路径，通常为 `output/imagegen/<descriptive-name>.png`。
3. 运行辅助脚本。不得硬编码特定用户的 skill 路径；从 `CODEX_HOME` 或 `$HOME/.codex` 解析。

Windows/macOS/Linux 上的 PowerShell 7：

```powershell
$skill = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$skill = Join-Path (Join-Path $skill "skills") "gpt-image-2-cli"

& (Join-Path (Join-Path $skill "scripts") "invoke-gpt-image2.ps1") `
  -Prompt "<final image prompt>" `
  -Out "output/imagegen/<descriptive-name>.png" `
  -Size "1536x1024" `
  -Quality high
```

macOS/Linux Shell：

```bash
skill="${CODEX_HOME:-$HOME/.codex}/skills/gpt-image-2-cli"
python3 "$skill/scripts/invoke_gpt_image2.py" \
  --prompt "<final image prompt>" \
  --out "output/imagegen/<descriptive-name>.png" \
  --size "1536x1024" \
  --quality high
```

4. 完成前检查生成文件。图表尤其要验证标签可读性、几何关系，以及视觉解释是否符合用户意图。
5. 报告保存路径，并说明 CLI 使用了 `gpt-image-2`。

## 辅助脚本的行为

- 若当前进程已经设置 `OPENAI_API_KEY`，直接使用它。
- 否则从 `CODEX_HOME/auth.json` 或 `~/.codex/auth.json` 读取 `OPENAI_API_KEY`。
- 从 `CODEX_HOME/config.toml` 或 `~/.codex/config.toml` 读取 `model_provider` 和对应提供方的 `base_url`，将其导出为子 CLI 进程使用的 `OPENAI_BASE_URL`。
- 使用平台原生的路径拼接；无需 Windows 专用分隔符或机器特定的主目录。
- 调用随附的系统脚本：

```text
<codex-home>/skills/.system/imagegen/scripts/image_gen.py generate --model gpt-image-2
```

- 不打印或记录 API key。
- PowerShell 包装器只负责找到 Python 解释器，并把参数转发给可移植的 Python 入口。

## 参数

PowerShell 包装器：

```powershell
-Prompt <string>   # 必填的最终提示词
-Out <path>        # 可选；默认 output/imagegen/gpt-image-2-<timestamp>.png
-Size <string>     # 默认 1536x1024；也支持 auto、1024x1024、2048x1152 等
-Quality <value>   # low、medium、high、auto；默认 high
-Model <value>     # 默认 gpt-image-2
-CodexHome <path>  # 可选，覆盖 CODEX_HOME / ~/.codex
-ImageGenCli <path># 可选，覆盖 image_gen.py
-BaseUrl <url>     # 可选，覆盖 OPENAI_BASE_URL
-Python <path>     # 可选，覆盖 Python 解释器
-Force             # 仅在有意覆盖已有输出时传入
-DryRun            # 打印 API payload，但不调用 API
```

Python 入口使用等价长选项：`--prompt`、`--out`、`--size`、`--quality`、`--model`、`--codex-home`、`--imagegen-cli`、`--base-url`、`--force` 和 `--dry-run`。

快速草稿使用 `1024x1024` 或 `quality low`。最终图表或文字较多的图像使用 `1536x1024`、`2048x1152` 或更高尺寸，并使用 `quality high`。

## 排障

- 辅助脚本找不到 `OPENAI_API_KEY` 时，检查 `~/.codex/auth.json` 或在本地设置环境变量。绝不要求用户把完整 key 粘贴到对话中。
- 已到达 API 但生成失败时，配置的 `base_url` 可能不支持 GPT Image 模型。保留可见错误，然后询问是否切换提供方或配置。
- PowerShell 包装器找不到 Python 时，安装 Python 3、设置 `PYTHON`，或传入 `-Python <path>`。
- Python 无法导入 `openai` 时，在当前环境安装该依赖后重试。
- 输出路径已存在时，只有确定需要替换才以 `-Force` 重跑；否则选择带版本的文件名。

## 示例

```powershell
$prompt = @"
Use case: scientific-educational
Asset type: clean teaching diagram
Primary request: Draw a central projection ray diagram explaining why a building roof appears tilted away from the camera when photographed with camera pitch -50 degrees.
Style/medium: crisp vector-like technical illustration with legible Chinese labels.
Constraints: simple, intuitive, no watermark, no photorealism.
"@

$skill = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$skill = Join-Path (Join-Path $skill "skills") "gpt-image-2-cli"

& (Join-Path (Join-Path $skill "scripts") "invoke-gpt-image2.ps1") `
  -Prompt $prompt `
  -Out "output/imagegen/central-projection-pitch-minus-50.png" `
  -Size "1536x1024" `
  -Quality high
```
