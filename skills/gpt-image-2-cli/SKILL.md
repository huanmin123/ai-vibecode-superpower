---
name: gpt-image-2-cli
description: Generate images through the local imagegen CLI with model gpt-image-2 by bridging Codex Desktop credentials from ~/.codex/auth.json and ~/.codex/config.toml into OPENAI_API_KEY and OPENAI_BASE_URL. Use when the user explicitly asks for gpt-image-2 image generation, says the official/API sample is using a non-image model or wrong endpoint, asks to reproduce the prior Codex auth/config image-generation process, or needs image output through the current Codex provider instead of the built-in image_gen tool.
---

# GPT Image 2 CLI

## Purpose

Use this skill to run the bundled image generation CLI with `--model gpt-image-2` while reusing the current Codex Desktop auth/config files. This avoids hand-copying an API key and avoids accidentally calling a text or Responses model when the user specifically wants GPT Image generation.

The portable helper scripts are:

```text
scripts/invoke_gpt_image2.py      # direct cross-platform entrypoint
scripts/invoke-gpt-image2.ps1     # PowerShell wrapper for Windows/macOS/Linux
```

## Workflow

1. Shape the image prompt using the system `imagegen` skill conventions when available: include use case, asset type, subject, style, composition, exact text, constraints, and avoid list.
2. Choose an output path under the current workspace, usually `output/imagegen/<descriptive-name>.png`.
3. Run the helper script. Do not hardcode a user-specific skill path; resolve it from `CODEX_HOME` or `$HOME/.codex`.

PowerShell 7 on Windows/macOS/Linux:

```powershell
$skill = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$skill = Join-Path (Join-Path $skill "skills") "gpt-image-2-cli"

& (Join-Path (Join-Path $skill "scripts") "invoke-gpt-image2.ps1") `
  -Prompt "<final image prompt>" `
  -Out "output/imagegen/<descriptive-name>.png" `
  -Size "1536x1024" `
  -Quality high
```

macOS/Linux shell:

```bash
skill="${CODEX_HOME:-$HOME/.codex}/skills/gpt-image-2-cli"
python3 "$skill/scripts/invoke_gpt_image2.py" \
  --prompt "<final image prompt>" \
  --out "output/imagegen/<descriptive-name>.png" \
  --size "1536x1024" \
  --quality high
```

4. Inspect the generated file before finishing. For diagrams, verify label legibility, geometry, and that the visual explanation matches the user's intent.
5. Report the saved path and note that the CLI path used `gpt-image-2`.

## What The Helper Does

- Uses `OPENAI_API_KEY` from the current process if already set.
- Otherwise reads `OPENAI_API_KEY` from `CODEX_HOME/auth.json` or `~/.codex/auth.json`.
- Reads `model_provider` and that provider's `base_url` from `CODEX_HOME/config.toml` or `~/.codex/config.toml`, then exports it as `OPENAI_BASE_URL` for the child CLI process.
- Resolves paths with platform-native path joining; no Windows-only separators or machine-specific home directories are required.
- Calls the bundled system script:

```text
<codex-home>/skills/.system/imagegen/scripts/image_gen.py generate --model gpt-image-2
```

- Does not print or log the API key.
- The PowerShell wrapper only finds a Python interpreter and forwards arguments to the portable Python entrypoint.

## Parameters

PowerShell wrapper:

```powershell
-Prompt <string>   # required final prompt
-Out <path>        # optional; defaults to output/imagegen/gpt-image-2-<timestamp>.png
-Size <string>     # default 1536x1024; also supports auto, 1024x1024, 2048x1152, etc.
-Quality <value>   # low, medium, high, auto; default high
-Model <value>     # default gpt-image-2
-CodexHome <path>  # optional override for CODEX_HOME / ~/.codex
-ImageGenCli <path># optional override for image_gen.py
-BaseUrl <url>     # optional override for OPENAI_BASE_URL
-Python <path>     # optional Python interpreter override
-Force             # pass through when intentionally overwriting an existing output
-DryRun            # print the API payload without calling the API
```

Python entrypoint uses the equivalent long options: `--prompt`, `--out`, `--size`, `--quality`, `--model`, `--codex-home`, `--imagegen-cli`, `--base-url`, `--force`, and `--dry-run`.

Use `1024x1024` or `quality low` for quick drafts. Use `1536x1024`, `2048x1152`, or higher with `quality high` for final diagrams or text-heavy images.

## Troubleshooting

- If the helper cannot find `OPENAI_API_KEY`, check `~/.codex/auth.json` or set the environment variable locally. Never ask the user to paste the full key into chat.
- If generation reaches the API but fails, the configured `base_url` may not support GPT Image models. Keep the error visible, then ask whether to switch provider/config.
- If the PowerShell wrapper cannot find Python, install Python 3, set `PYTHON`, or pass `-Python <path>`.
- If Python cannot import `openai`, install the dependency in the active environment before retrying.
- If the output path exists, rerun with `-Force` only when replacement is intended; otherwise choose a versioned filename.

## Example

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
