# ripgrep 安装

本文件按 Windows、macOS 和 Linux 分节。仅当当前平台的 `rg` 可用性检查失败时读取对应章节：Windows 使用 `Get-Command rg`，macOS/Linux 使用 `command -v rg`；安装完成后必须重新运行 `rg --version` 并确认实际解析到的路径。

优先使用当前系统已有的包管理器。直接下载 Release 时，核对目标架构；上游提供可信摘要或签名时必须验证，未提供时记录 HTTPS 下载的残余完整性风险。不要从第三方镜像或未经核对的转发链接安装。

## Windows

优先使用已存在的包管理器，只执行第一个匹配分支：

```powershell
$ErrorActionPreference = 'Stop'
if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
  & winget.exe install BurntSushi.ripgrep.MSVC --exact --accept-package-agreements --accept-source-agreements --disable-interactivity
} elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
  & scoop install ripgrep
} elseif (Get-Command choco.exe -ErrorAction SilentlyContinue) {
  & choco.exe install ripgrep -y
} else {
  throw '未找到包管理器，使用下方官方 Release 流程'
}
if ($LASTEXITCODE -ne 0) { throw "ripgrep 安装失败：$LASTEXITCODE" }
```

没有包管理器时安装官方 Release 到用户目录：

```powershell
$ErrorActionPreference = 'Stop'
$latest = Invoke-WebRequest -Uri 'https://github.com/BurntSushi/ripgrep/releases/latest' -TimeoutSec 30
$version = Split-Path -Leaf $latest.BaseResponse.RequestMessage.RequestUri.AbsolutePath
$target = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  'X64' { 'x86_64-pc-windows-msvc' }
  'Arm64' { 'aarch64-pc-windows-msvc' }
  default { throw '不支持的 Windows 架构' }
}
$asset = "ripgrep-$version-$target.zip"
$temp = Join-Path $env:TEMP ('ripgrep-' + [System.Guid]::NewGuid().ToString('N'))
$archive = Join-Path $temp $asset
$expanded = Join-Path $temp 'expanded'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  Invoke-WebRequest -Uri "https://github.com/BurntSushi/ripgrep/releases/download/$version/$asset" -OutFile $archive -TimeoutSec 60
  # Verify an upstream checksum or signature here when the selected Release publishes one.
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
  $source = Join-Path $expanded "ripgrep-$version-$target\rg.exe"
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw '发布包中没有预期的 rg.exe' }
  $bin = Join-Path $env:LOCALAPPDATA 'Programs\ripgrep\bin'
  $rgPath = Join-Path $bin 'rg.exe'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $rgPath -Force
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split [IO.Path]::PathSeparator | Where-Object { $_ })
  if ($entries -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join [IO.Path]::PathSeparator), 'User')
  }
  $env:Path = "$bin$([IO.Path]::PathSeparator)$env:Path"
  & $rgPath --version
  Get-Command rg.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
```

## macOS

有 Homebrew 时：

```sh
brew install ripgrep
rg --version
command -v rg
```

没有 Homebrew 时安装官方 Release 到用户目录：

```sh
set -eu
version=$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' 'https://github.com/BurntSushi/ripgrep/releases/latest')")
case "$(uname -m)" in
  arm64) target='aarch64-apple-darwin' ;;
  x86_64) target='x86_64-apple-darwin' ;;
  *) printf '%s\n' '不支持的 macOS 架构' >&2; exit 1 ;;
esac
asset="ripgrep-$version-$target.tar.gz"
temp=$(mktemp -d "${TMPDIR:-/tmp}/ripgrep.XXXXXX")
trap 'rm -rf "$temp"' EXIT
curl -fL -o "$temp/$asset" "https://github.com/BurntSushi/ripgrep/releases/download/$version/$asset"
tar -xzf "$temp/$asset" -C "$temp"
rg_bin=$(find "$temp" -type f -name rg -perm -111 -print -quit)
test -n "$rg_bin"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$rg_bin" "$HOME/.local/bin/rg"
export PATH="$HOME/.local/bin:$PATH"
rg --version
command -v rg
```

## Linux

根据 `/etc/os-release` 只执行一组：

```sh
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ripgrep

# Fedora / RHEL 系
sudo dnf install -y ripgrep

# Arch Linux
sudo pacman -S --needed --noconfirm ripgrep

# Alpine Linux（root shell）
apk add ripgrep

# openSUSE
sudo zypper --non-interactive install ripgrep
```

没有 root/sudo 或没有匹配包管理器时安装官方静态 Release：

```sh
set -eu
version=$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' 'https://github.com/BurntSushi/ripgrep/releases/latest')")
case "$(uname -m)" in
  x86_64) target='x86_64-unknown-linux-musl' ;;
  aarch64|arm64) target='aarch64-unknown-linux-musl' ;;
  *) printf '%s\n' '不支持的 Linux 架构' >&2; exit 1 ;;
esac
asset="ripgrep-$version-$target.tar.gz"
temp=$(mktemp -d "${TMPDIR:-/tmp}/ripgrep.XXXXXX")
trap 'rm -rf "$temp"' EXIT
curl -fL -o "$temp/$asset" "https://github.com/BurntSushi/ripgrep/releases/download/$version/$asset"
tar -xzf "$temp/$asset" -C "$temp"
rg_bin=$(find "$temp" -type f -name rg -perm -111 -print -quit)
test -n "$rg_bin"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$rg_bin" "$HOME/.local/bin/rg"
export PATH="$HOME/.local/bin:$PATH"
rg --version
```

macOS/Linux 的用户级安装后若新会话找不到 `rg`，将 `export PATH="$HOME/.local/bin:$PATH"` 加入实际登录 Shell 的配置文件一次。
