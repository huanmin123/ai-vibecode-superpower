#!/bin/sh
set -eu

readonly TOOLCHAIN_HOME="${AGENT_TOOLCHAIN_HOME:-$HOME/.local/share/agent-toolchain}"
readonly TOOLCHAIN_BIN="${AGENT_TOOLCHAIN_BIN:-$HOME/.local/bin}"

die() { printf '%s\n' "agent-toolchain: $*" >&2; exit 1; }
note() { printf '%s\n' "agent-toolchain: $*"; }

usage() {
  cat <<'EOF'
Usage:
  agent-toolchain.sh configure --project PATH
  agent-toolchain.sh doctor --project PATH [--quick]
  agent-toolchain.sh bootstrap --project PATH --dry-run|--apply
  agent-toolchain.sh init-codegraph --project PATH
  agent-toolchain.sh maintain --project PATH [--sync]
  agent-toolchain.sh rollback rtk VERSION
EOF
}

command_name() {
  case "$1" in
    codegraph|rtk) printf '%s\n' "$1" ;;
    *) die "不支持的工具：$1" ;;
  esac
}

parse_args() {
  ACTION=${1:-}; shift || true
  PROJECT=
  APPLY=0
  DRY_RUN=0
  QUICK=0
  SYNC=0
  ROLLBACK_TOOL=
  ROLLBACK_VERSION=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) [ "$#" -ge 2 ] || die "--project 缺少路径"; PROJECT=$2; shift 2 ;;
      --apply) APPLY=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --quick) QUICK=1; shift ;;
      --sync) SYNC=1; shift ;;
      codegraph|rtk) [ "$ACTION" = rollback ] || die "未知参数：$1"; ROLLBACK_TOOL=$1; shift ;;
      *)
        if [ "$ACTION" = rollback ] && [ -z "$ROLLBACK_VERSION" ]; then
          ROLLBACK_VERSION=$1; shift
        else
          die "未知参数：$1"
        fi
        ;;
    esac
  done
  [ "$QUICK" -eq 0 ] || [ "$ACTION" = doctor ] || die "--quick 仅适用于 doctor"
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM_OS=darwin ;;
    Linux) PLATFORM_OS=linux ;;
    *) die "不支持的操作系统：$(uname -s)；仅支持 macOS、Linux 和 Windows PowerShell 7" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) PLATFORM_ARCH=arm64 ;;
    x86_64|amd64) PLATFORM_ARCH=x64 ;;
    *) die "不支持的 CPU 架构：$(uname -m)；仅支持 arm64 和 x64" ;;
  esac
  PLATFORM="$PLATFORM_OS-$PLATFORM_ARCH"
  case "$PLATFORM" in
    darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
    *) die "不支持的 POSIX 平台：$PLATFORM" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "缺少 curl，无法下载受信任资产"
  command -v file >/dev/null 2>&1 || die "缺少 file，无法验证二进制架构"
  if [ "$PLATFORM_OS" = darwin ]; then
    command -v shasum >/dev/null 2>&1 || die "缺少 shasum，无法验证 SHA-256"
  else
    command -v sha256sum >/dev/null 2>&1 || die "缺少 sha256sum，无法验证 SHA-256"
    command -v cp >/dev/null 2>&1 || die "缺少 cp，无法安装受信任资产"
  fi
}

sha256_file() {
  if [ "$PLATFORM_OS" = darwin ]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

assert_binary_architecture() {
  arch_binary=$1
  arch_description=$2
  arch_file_info=$(file -b "$arch_binary")
  case "$PLATFORM" in
    darwin-arm64) case "$arch_file_info" in Mach-O*arm64*) ;; *) die "$arch_description 不是 Mach-O arm64：$arch_file_info" ;; esac ;;
    darwin-x64) case "$arch_file_info" in Mach-O*x86_64*) ;; *) die "$arch_description 不是 Mach-O x64：$arch_file_info" ;; esac ;;
    linux-arm64) case "$arch_file_info" in ELF*ARM*aarch64*) ;; *) die "$arch_description 不是 ELF arm64：$arch_file_info" ;; esac ;;
    linux-x64) case "$arch_file_info" in ELF*x86-64*) ;; *) die "$arch_description 不是 ELF x64：$arch_file_info" ;; esac ;;
  esac
}

check_project() {
  [ -n "$PROJECT" ] || die "必须指定 --project"
  [ -d "$PROJECT" ] || die "项目目录不存在：$PROJECT"
  PROJECT=$(CDPATH= cd -- "$PROJECT" && pwd)
}

assert_plain_file_or_absent() {
  path=$1
  [ ! -e "$path" ] && [ ! -L "$path" ] && return 0
  [ -f "$path" ] && [ ! -L "$path" ] || die "$path 必须是普通文件"
}

append_project_text() {
  path=$1
  content=$2
  assert_plain_file_or_absent "$path"
  if [ -s "$path" ]; then
    printf '\n' >> "$path"
  fi
  printf '%s\n' "$content" >> "$path"
}

toml_table_body() {
  file=$1
  header=$2
  awk -v header="$header" '
    $0 == header {
      found += 1
      if (found > 1) { conflict = 1; exit }
      active = 1
      next
    }
    active && /^\[/ { active = 0 }
    active { print }
    END {
      if (conflict) exit 2
      if (found != 1) exit 1
    }
  ' "$file"
}

agents_heading_candidate() {
  file=$1
  title=$2
  awk -v title="$title" '
    function normalize_title(value) {
      gsub(/[ \t]+/, " ", value)
      sub(/^ /, "", value)
      sub(/ $/, "", value)
      return tolower(value)
    }
    function is_atx_h2(value) { return value ~ "^[ ]?[ ]?[ ]?##[ \t]+" }
    function atx_title(value) {
      sub(/^[ ]?[ ]?[ ]?##[ \t]+/, "", value)
      sub(/[ \t]+#+[ \t]*$/, "", value)
      return normalize_title(value)
    }
    function is_setext_underline(value) { return value ~ "^[ ]?[ ]?[ ]?-+[ \t]*$" }
    { if (NR == 1) sub(/^\xef\xbb\xbf/, ""); sub(/\r$/, ""); lines[NR] = $0 }
    END {
      candidate = normalize_title(title)
      for (line_no = 1; line_no <= NR; line_no += 1) {
        if (is_atx_h2(lines[line_no]) && atx_title(lines[line_no]) == candidate) { found = 1; break }
        if (line_no < NR && normalize_title(lines[line_no]) == candidate && is_setext_underline(lines[line_no + 1])) { found = 1; break }
      }
      exit (found ? 0 : 1)
    }
  ' "$file"
}

managed_agents_section() {
  file=$1
  heading=$2
  awk -v heading="$heading" '
    function normalize_title(value) {
      gsub(/[ \t]+/, " ", value)
      sub(/^ /, "", value)
      sub(/ $/, "", value)
      return tolower(value)
    }
    function is_atx_h2(value) { return value ~ "^[ ]?[ ]?[ ]?##[ \t]+" }
    function atx_title(value) {
      sub(/^[ ]?[ ]?[ ]?##[ \t]+/, "", value)
      sub(/[ \t]+#+[ \t]*$/, "", value)
      return normalize_title(value)
    }
    function is_setext_underline(value) { return value ~ "^[ ]?[ ]?[ ]?-+[ \t]*$" }
    function is_h2(line_no) {
      return is_atx_h2(lines[line_no]) || (line_no < NR && lines[line_no] ~ "^[ ]?[ ]?[ ]?[^[:space:]].*$" && is_setext_underline(lines[line_no + 1]))
    }
    { if (NR == 1) sub(/^\xef\xbb\xbf/, ""); sub(/\r$/, ""); lines[NR] = $0 }
    END {
      title = normalize_title(substr(heading, 4))
      for (line_no = 1; line_no <= NR; line_no += 1) {
        if (is_atx_h2(lines[line_no]) && atx_title(lines[line_no]) == title) {
          count += 1
          if (lines[line_no] != heading) invalid = 1
          if (count == 1) start = line_no
        }
        if (line_no < NR && normalize_title(lines[line_no]) == title && is_setext_underline(lines[line_no + 1])) {
          count += 1
          invalid = 1
          if (count == 1) start = line_no
        }
      }
      if (count != 1 || invalid) exit 2
      end_line = start
      for (line_no = start + 1; line_no <= NR; line_no += 1) {
        if (is_h2(line_no)) break
        end_line = line_no
      }
      while (end_line > start && lines[end_line] == "") end_line -= 1
      for (line_no = start; line_no <= end_line; line_no += 1) {
        print lines[line_no]
      }
      printf "__agent_toolchain_section_end__"
    }
  ' "$file"
}

configure_project() {
  codex_dir="$PROJECT/.codex"
  config="$codex_dir/config.toml"
  agents="$PROJECT/AGENTS.md"
  ignore="$PROJECT/.gitignore"
  [ ! -L "$codex_dir" ] || die ".codex 不能是 symlink"
  if [ -e "$codex_dir" ]; then
    [ -d "$codex_dir" ] || die ".codex 必须是目录"
  fi
  assert_plain_file_or_absent "$config"
  assert_plain_file_or_absent "$agents"
  assert_plain_file_or_absent "$ignore"

  config_needs_write=0
  agents_needs_write=0
  ignore_needs_write=0
  agents_heading='## CodeGraph 与 RTK'
  agents_block='## CodeGraph 与 RTK

- CodeGraph MCP 可用于查询跨模块依赖、调用链和影响范围；其结果必须以当前源码、`rg`、未跟踪文件和刚修改文件复核。
- 对只读且输出量大的命令，优先使用匹配的 `rtk` 子命令：`git`、`rg`、`log`、`diff`、`test`、`mvn`、`npm`、`pnpm`、`read`、`find`、`ls`、`tree`。未列出的只读命令先用 `rtk rewrite "<command>"` 或 `rtk --help` 核实；写操作和精确排障使用原生命令。
- 只有工具注册表或 `--help` 未列出目标命令时，才能判定该命令不存在；其他工具错误保留原始输出，不得归因于能力缺失。
- 安装、配置修复、初始化或修复索引、健康检查、升级审查和回滚使用全局 `$agent-toolchain`；不得在日常开发中自行安装、升级、重配或维护工具链。'
  if [ -f "$config" ] && rg -q '^\[mcp_servers\.codegraph\][[:space:]]*$' "$config"; then
    main_body=$(toml_table_body "$config" '[mcp_servers.codegraph]') || die ".codex/config.toml 的 CodeGraph 主表重复或无效"
    env_body=$(toml_table_body "$config" '[mcp_servers.codegraph.env]') || die ".codex/config.toml 的 CodeGraph env 表缺失、重复或无效"
    printf '%s\n' "$main_body" | rg -q '^command[[:space:]]*=[[:space:]]*"codegraph"[[:space:]]*$' || die ".codex/config.toml 的 CodeGraph command 冲突"
    printf '%s\n' "$main_body" | rg -q '^[[:space:]]*"serve",[[:space:]]*$' || die ".codex/config.toml 的 CodeGraph args 冲突"
    printf '%s\n' "$main_body" | rg -q '^[[:space:]]*"--mcp",[[:space:]]*$' || die ".codex/config.toml 的 CodeGraph args 冲突"
    printf '%s\n' "$env_body" | rg -q '^CODEGRAPH_TELEMETRY[[:space:]]*=[[:space:]]*"0"[[:space:]]*$' || die ".codex/config.toml 的 CodeGraph telemetry 配置冲突"
    printf '%s\n' "$env_body" | rg -q '^CODEGRAPH_NO_UPDATE_CHECK[[:space:]]*=[[:space:]]*"1"[[:space:]]*$' || die ".codex/config.toml 的 CodeGraph 更新检查配置冲突"
    printf '%s\n' "$env_body" | rg -q '^DO_NOT_TRACK[[:space:]]*=[[:space:]]*"1"[[:space:]]*$' || die ".codex/config.toml 的 CodeGraph 追踪配置冲突"
  elif [ -f "$config" ] && rg -q '^\[mcp_servers\.codegraph\.' "$config"; then
    die ".codex/config.toml 存在不完整的 CodeGraph 表"
  else
    config_needs_write=1
  fi

  if [ -f "$agents" ] && agents_heading_candidate "$agents" 'AI 工具'; then
    die 'AGENTS.md 包含旧版 AI 工具注入标题；请人工迁移为当前 CodeGraph 与 RTK 受管标题'
  fi
  if [ -f "$agents" ] && agents_heading_candidate "$agents" 'CodeGraph 与 RTK'; then
    managed_section=$(managed_agents_section "$agents" "$agents_heading") || die 'AGENTS.md 的 CodeGraph 与 RTK 受管标题冲突或重复'
    case "$managed_section" in
      *__agent_toolchain_section_end__) managed_section=${managed_section%__agent_toolchain_section_end__} ;;
      *) die 'AGENTS.md 的 CodeGraph 与 RTK 受管标题冲突' ;;
    esac
    expected_section=$(printf '%s\n__agent_toolchain_section_end__' "$agents_block")
    expected_section=${expected_section%__agent_toolchain_section_end__}
    [ "$managed_section" = "$expected_section" ] || die 'AGENTS.md 的 CodeGraph 与 RTK 受管标题冲突'
  else
    agents_needs_write=1
  fi
  if [ ! -f "$ignore" ] || ! rg -Fxq '/.codegraph/' "$ignore"; then
    ignore_needs_write=1
  fi

  [ -e "$codex_dir" ] || mkdir "$codex_dir"
  [ "$config_needs_write" -eq 0 ] || append_project_text "$config" '[mcp_servers.codegraph]
command = "codegraph"
args = [
    "serve",
    "--mcp",
]

[mcp_servers.codegraph.env]
CODEGRAPH_TELEMETRY = "0"
CODEGRAPH_NO_UPDATE_CHECK = "1"
DO_NOT_TRACK = "1"'
  [ "$agents_needs_write" -eq 0 ] || append_project_text "$agents" "$agents_block"
  [ "$ignore_needs_write" -eq 0 ] || append_project_text "$ignore" '/.codegraph/'
  note "项目 CodeGraph 与 RTK 受管配置已就绪"
}

load_trusted_manifest() {
  CODEGRAPH_VERSION=1.5.0
  CODEGRAPH_NPM_PACKAGE='@colbymchenry/codegraph'
  RTK_VERSION=0.44.1
  RTK_DARWIN_ARM64_ASSET=rtk-aarch64-apple-darwin.tar.gz
  RTK_DARWIN_ARM64_SHA256=a6a8bb086034a5d4f90ff93f965a631ad4937b5974494dd8a51859e3b04908a8
  RTK_DARWIN_X64_ASSET=rtk-x86_64-apple-darwin.tar.gz
  RTK_DARWIN_X64_SHA256=52475adf4659e95b3560eac117e13bc6ab3320de8b8ce75ba4e7d5f3604613cf
  RTK_LINUX_ARM64_ASSET=rtk-aarch64-unknown-linux-gnu.tar.gz
  RTK_LINUX_ARM64_SHA256=ce97a94dbda556125fdbb22c94f538f93ae7dbc2b3de6f497bd60f206959c11c
  RTK_LINUX_X64_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz
  RTK_LINUX_X64_SHA256=986f29704469b3d1051e2474105c6c75ab8b73651068dcd61612c1fb3938ad95
  select_platform_assets
}

select_platform_assets() {
  case "$PLATFORM" in
    darwin-arm64) RTK_ASSET=$RTK_DARWIN_ARM64_ASSET; RTK_SHA256=$RTK_DARWIN_ARM64_SHA256 ;;
    darwin-x64) RTK_ASSET=$RTK_DARWIN_X64_ASSET; RTK_SHA256=$RTK_DARWIN_X64_SHA256 ;;
    linux-arm64) RTK_ASSET=$RTK_LINUX_ARM64_ASSET; RTK_SHA256=$RTK_LINUX_ARM64_SHA256 ;;
    linux-x64) RTK_ASSET=$RTK_LINUX_X64_ASSET; RTK_SHA256=$RTK_LINUX_X64_SHA256 ;;
    *) die "当前 POSIX 驱动不支持的平台：$PLATFORM" ;;
  esac
}

tool_value() {
  tool=$(command_name "$1")
  field=$2
  case "$tool:$field" in
    codegraph:version) printf '%s\n' "$CODEGRAPH_VERSION" ;;
    rtk:version) printf '%s\n' "$RTK_VERSION" ;;
    rtk:asset) printf '%s\n' "$RTK_ASSET" ;;
    rtk:sha) printf '%s\n' "$RTK_SHA256" ;;
    rtk:url) printf '%s\n' "https://github.com/rtk-ai/rtk/releases/download/v$RTK_VERSION/$RTK_ASSET" ;;
    *) die "未知工具字段：$tool:$field" ;;
  esac
}

binary_in_dir() {
  tool=$1
  directory=$2
  case "$tool" in
    rtk) printf '%s/rtk\n' "$directory" ;;
    *) die "不支持的工具：$tool" ;;
  esac
}

codegraph_npm_root() {
  command -v npm >/dev/null 2>&1 || return 1
  npm --prefix "$TOOLCHAIN_HOME/npm" root -g 2>/dev/null
}

codegraph_npm_binary() {
  printf '%s/npm/bin/codegraph\n' "$TOOLCHAIN_HOME"
}

codegraph_npm_ready() {
  npm_root=$(codegraph_npm_root) || return 1
  manifest="$npm_root/$CODEGRAPH_NPM_PACKAGE/package.json"
  binary=$(codegraph_npm_binary) || return 1
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  [ -e "$binary" ] && [ -x "$binary" ] || return 1
  package_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' "$manifest" | head -n 1)
  [ "$package_version" = "$CODEGRAPH_VERSION" ] || return 1
  platform_package="$npm_root/$CODEGRAPH_NPM_PACKAGE/node_modules/@colbymchenry/codegraph-$PLATFORM/package.json"
  [ -f "$platform_package" ] && [ ! -L "$platform_package" ] || return 1
  platform_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' "$platform_package" | head -n 1)
  [ "$platform_version" = "$CODEGRAPH_VERSION" ] || return 1
  public_binary="$TOOLCHAIN_BIN/codegraph"
  [ -f "$public_binary" ] && [ ! -L "$public_binary" ] && [ -x "$public_binary" ] || return 1
  codegraph_launcher_matches "$public_binary" || return 1
  version_matches codegraph "$binary" "$CODEGRAPH_VERSION" && version_matches codegraph "$public_binary" "$CODEGRAPH_VERSION"
}

managed_binary() {
  case "$1" in
    codegraph) codegraph_npm_binary || die "CodeGraph npm 全局入口不可用" ;;
    rtk) binary_in_dir rtk "$TOOLCHAIN_HOME/rtk/current" ;;
    *) die "不支持的工具：$1" ;;
  esac
}

codegraph_launcher_matches() {
  path=$1
  cat <<EOF | cmp -s "$path" -
#!/bin/sh
# agent-toolchain CodeGraph npm launcher
export CODEGRAPH_TELEMETRY=0
export CODEGRAPH_NO_UPDATE_CHECK=1
export DO_NOT_TRACK=1
export CODEGRAPH_NO_DOWNLOAD=1
exec "$TOOLCHAIN_HOME/npm/bin/codegraph" "\$@"
EOF
}

write_codegraph_launcher() {
  npm_binary=$(codegraph_npm_binary)
  path="$TOOLCHAIN_BIN/codegraph"
  [ "$path" = "$npm_binary" ] && return 0
  temporary="$TOOLCHAIN_BIN/.agent-toolchain-codegraph-$$"
  mkdir -p "$TOOLCHAIN_BIN"
  if [ -L "$path" ]; then
    [ "$(readlink "$path")" = "$TOOLCHAIN_HOME/codegraph/current/bin/codegraph" ] || die "$path 已被非受管理目标占用"
    rm -f "$path"
  elif [ -e "$path" ]; then
    [ -f "$path" ] && [ -x "$path" ] || die "$path 已被非受管理目标占用"
    if codegraph_launcher_matches "$path"; then
      return 0
    fi
    legacy_npm_binary="$(npm prefix -g 2>/dev/null || true)/bin/codegraph"
    cat <<EOF | cmp -s "$path" - || die "$path 已被非受管理目标占用"
#!/bin/sh
exec "$legacy_npm_binary" "\$@"
EOF
  fi
  cat <<EOF > "$temporary"
#!/bin/sh
# agent-toolchain CodeGraph npm launcher
export CODEGRAPH_TELEMETRY=0
export CODEGRAPH_NO_UPDATE_CHECK=1
export DO_NOT_TRACK=1
export CODEGRAPH_NO_DOWNLOAD=1
exec "$npm_binary" "\$@"
EOF
  chmod 755 "$temporary"
  atomic_replace "$temporary" "$path"
}

rtk_launcher_matches() {
  path=$1
  cat <<EOF | cmp -s "$path" -
#!/bin/sh
export RTK_TELEMETRY_DISABLED=1
exec "$TOOLCHAIN_HOME/rtk/current/rtk" "\$@"
EOF
}

write_rtk_launcher() {
  path="$TOOLCHAIN_BIN/rtk"
  temporary="$TOOLCHAIN_BIN/.agent-toolchain-rtk-$$"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] && [ -x "$path" ] && rtk_launcher_matches "$path" || die "$path 已被非受管理目标占用"
    return
  fi
  cat <<EOF > "$temporary"
#!/bin/sh
export RTK_TELEMETRY_DISABLED=1
exec "$TOOLCHAIN_HOME/rtk/current/rtk" "\$@"
EOF
  chmod 755 "$temporary"
  atomic_replace "$temporary" "$path"
  INSTALL_PUBLIC_CREATED=1
}

run_tool_version() {
  tool=$1
  binary=$2
  if [ "$tool" = rtk ]; then
    RTK_TELEMETRY_DISABLED=1 "$binary" --version
  else
    CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_UPDATE_CHECK=1 DO_NOT_TRACK=1 CODEGRAPH_NO_DOWNLOAD=1 "$binary" --version
  fi
}

run_codegraph() {
  CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_UPDATE_CHECK=1 DO_NOT_TRACK=1 CODEGRAPH_NO_DOWNLOAD=1 "$@"
}

version_matches() {
  tool=$1
  binary=$2
  expected=$3
  output=$(run_tool_version "$tool" "$binary" 2>/dev/null) || return 1
  case "$tool" in
    codegraph) [ "$output" = "$expected" ] ;;
    rtk) [ "$output" = "rtk $expected" ] ;;
    *) return 1 ;;
  esac
}

version_is_safe() {
  case "$1" in
    ''|*[!0-9.]*|.*|*..*|*.) return 1 ;;
    *) return 0 ;;
  esac
}

verify_failure() {
  note "安装验证失败：$*"
  return 1
}

verify_version_dir() {
  tool=$1
  version=$2
  [ "$tool" = rtk ] || { verify_failure "只有 RTK 使用受管版本目录"; return 1; }
  version_is_safe "$version" || { verify_failure "版本格式"; return 1; }
  tool_dir="$TOOLCHAIN_HOME/$tool"
  version_dir=${3:-"$tool_dir/$version"}
  binary=$(binary_in_dir "$tool" "$version_dir")
  receipt="$version_dir/receipt"
  [ -d "$tool_dir" ] && [ ! -L "$tool_dir" ] || { verify_failure "工具目录"; return 1; }
  [ -d "$version_dir" ] && [ ! -L "$version_dir" ] || { verify_failure "版本目录"; return 1; }
  if find "$version_dir" -type l -print -quit | rg -q .; then
    verify_failure "版本目录包含符号链接"
    return 1
  fi
  [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] || { verify_failure "binary 权限或链接"; return 1; }
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || { verify_failure "receipt"; return 1; }
  receipt_tool=$(awk -F= '$1 == "tool" { print $2 }' "$receipt")
  receipt_version=$(awk -F= '$1 == "version" { print $2 }' "$receipt")
  receipt_archive_sha=$(awk -F= '$1 == "archive_sha256" { print $2 }' "$receipt")
  receipt_binary_sha=$(awk -F= '$1 == "binary_sha256" { print $2 }' "$receipt")
  [ "$receipt_tool" = "$tool" ] && [ "$receipt_version" = "$version" ] || { verify_failure "receipt 工具或版本"; return 1; }
  [ "$receipt_archive_sha" = "$(tool_value "$tool" sha)" ] || { verify_failure "receipt archive SHA-256"; return 1; }
  actual_binary_sha=$(sha256_file "$binary")
  [ "$actual_binary_sha" = "$receipt_binary_sha" ] || { verify_failure "receipt binary SHA-256"; return 1; }
  assert_binary_architecture "$binary" "$tool"
  version_matches "$tool" "$binary" "$version" || { verify_failure "版本输出"; return 1; }
}

is_ready() {
  tool=$1
  if [ "$tool" = codegraph ]; then
    codegraph_npm_ready
    return
  fi
  version=$(tool_value "$tool" version)
  tool_dir="$TOOLCHAIN_HOME/$tool"
  [ -L "$tool_dir/current" ] || return 1
  [ "$(readlink "$tool_dir/current")" = "$tool_dir/$version" ] || return 1
  if [ "$tool" = rtk ]; then
    [ -f "$TOOLCHAIN_BIN/$tool" ] && [ ! -L "$TOOLCHAIN_BIN/$tool" ] && [ -x "$TOOLCHAIN_BIN/$tool" ] && rtk_launcher_matches "$TOOLCHAIN_BIN/$tool" || return 1
  else
    [ -L "$TOOLCHAIN_BIN/$tool" ] || return 1
    [ "$(readlink "$TOOLCHAIN_BIN/$tool")" = "$(managed_binary "$tool")" ] || return 1
  fi
  verify_version_dir "$tool" "$version"
}

quick_verify_version_dir() {
  tool=$1
  version=$2
  [ "$tool" = rtk ] || return 1
  version_is_safe "$version" || return 1
  tool_dir="$TOOLCHAIN_HOME/$tool"
  version_dir="$tool_dir/$version"
  binary=$(binary_in_dir "$tool" "$version_dir")
  receipt="$version_dir/receipt"
  [ -d "$tool_dir" ] && [ ! -L "$tool_dir" ] || return 1
  [ -d "$version_dir" ] && [ ! -L "$version_dir" ] || return 1
  if find "$version_dir" -type l -print -quit | rg -q .; then
    return 1
  fi
  [ -f "$binary" ] && [ ! -L "$binary" ] && [ -x "$binary" ] || return 1
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
  receipt_tool=$(awk -F= '$1 == "tool" { print $2 }' "$receipt")
  receipt_version=$(awk -F= '$1 == "version" { print $2 }' "$receipt")
  [ "$receipt_tool" = "$tool" ] && [ "$receipt_version" = "$version" ] || return 1
}

quick_is_ready() {
  tool=$1
  if [ "$tool" = codegraph ]; then
    codegraph_npm_ready
    return
  fi
  version=$(tool_value "$tool" version)
  tool_dir="$TOOLCHAIN_HOME/$tool"
  [ -L "$tool_dir/current" ] || return 1
  [ "$(readlink "$tool_dir/current")" = "$tool_dir/$version" ] || return 1
  if [ "$tool" = rtk ]; then
    [ -f "$TOOLCHAIN_BIN/$tool" ] && [ ! -L "$TOOLCHAIN_BIN/$tool" ] && [ -x "$TOOLCHAIN_BIN/$tool" ] && rtk_launcher_matches "$TOOLCHAIN_BIN/$tool" || return 1
  else
    [ -L "$TOOLCHAIN_BIN/$tool" ] || return 1
    [ "$(readlink "$TOOLCHAIN_BIN/$tool")" = "$(managed_binary "$tool")" ] || return 1
  fi
  quick_verify_version_dir "$tool" "$version"
}

assert_codegraph_index_safe() {
  index="$PROJECT/.codegraph"
  [ ! -L "$index" ] || die ".codegraph 不能是 symlink"
  if [ -e "$index" ] && [ ! -d "$index" ]; then
    die ".codegraph 必须是目录"
  fi
  if [ -d "$index" ]; then
    if find "$index" \( -type l -o -type p -o -type b -o -type c \) -print -quit | rg -q .; then
      die ".codegraph 包含不安全的链接或特殊文件"
    fi
  fi
}

doctor() {
  doctor_failed=0
  if [ "$QUICK" -eq 1 ]; then
    for tool in codegraph rtk; do
      if quick_is_ready "$tool"; then
        note "$tool: ready ($(managed_binary "$tool"))"
      else
        note "$tool: missing"
        doctor_failed=1
      fi
    done
    note "codegraph-index: skipped (--quick)"
    [ "$doctor_failed" -eq 0 ] || return 1
    return 0
  fi
  assert_codegraph_index_safe
  for tool in codegraph rtk; do
    if is_ready "$tool"; then
      note "$tool: ready ($(managed_binary "$tool"))"
    else
      note "$tool: missing"
      doctor_failed=1
    fi
  done
  if is_ready codegraph; then
    if [ -d "$PROJECT/.codegraph" ] && find "$PROJECT/.codegraph" -mindepth 1 ! -name .gitignore -print -quit | rg -q .; then
      (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" status) || die "CodeGraph 索引状态异常"
    else
      note "codegraph-index: needs_init"
      doctor_failed=1
    fi
  fi
  [ "$doctor_failed" -eq 0 ] || return 1
}

safe_tar() {
  archive=$1
  tar -tzf "$archive" | awk '
    /^\// { exit 1 }
    /(^|\/)\.\.($|\/)/ { exit 1 }
    { count += 1 }
    END { if (count == 0) exit 1 }
  ' || die "归档包含危险路径或为空"
  tar -tvzf "$archive" | awk '
    substr($1, 1, 1) == "l" || substr($1, 1, 1) == "h" { exit 1 }
  ' || die "归档包含符号链接或硬链接"
}

positive_timeout() {
  value=$1
  name=$2
  case "$value" in
    ''|*[!0-9]*) die "$name 必须是 1 到 300 的整数" ;;
  esac
  [ "$value" -ge 1 ] && [ "$value" -le 300 ] || die "$name 必须是 1 到 300 的整数"
}

detect_proxy() {
  DOWNLOAD_PROXY=
  DOWNLOAD_PROXY_SOURCE=direct
  if [ -n "${AGENT_TOOLCHAIN_PROXY:-}" ]; then
    DOWNLOAD_PROXY=$AGENT_TOOLCHAIN_PROXY
    DOWNLOAD_PROXY_SOURCE=explicit
  elif [ -n "${HTTPS_PROXY:-}" ]; then
    DOWNLOAD_PROXY=$HTTPS_PROXY
    DOWNLOAD_PROXY_SOURCE=environment
  elif [ -n "${https_proxy:-}" ]; then
    DOWNLOAD_PROXY=$https_proxy
    DOWNLOAD_PROXY_SOURCE=environment
  elif [ -n "${ALL_PROXY:-}" ]; then
    DOWNLOAD_PROXY=$ALL_PROXY
    DOWNLOAD_PROXY_SOURCE=environment
  elif [ -n "${all_proxy:-}" ]; then
    DOWNLOAD_PROXY=$all_proxy
    DOWNLOAD_PROXY_SOURCE=environment
  elif [ "$PLATFORM_OS" = darwin ]; then
    proxy_state=$(scutil --proxy 2>/dev/null || true)
    socks_enabled=$(printf '%s\n' "$proxy_state" | awk '$1 == "SOCKSEnable" && $2 == ":" { print $3 }')
    socks_host=$(printf '%s\n' "$proxy_state" | awk '$1 == "SOCKSProxy" && $2 == ":" { print $3 }')
    socks_port=$(printf '%s\n' "$proxy_state" | awk '$1 == "SOCKSPort" && $2 == ":" { print $3 }')
    https_enabled=$(printf '%s\n' "$proxy_state" | awk '$1 == "HTTPSEnable" && $2 == ":" { print $3 }')
    https_host=$(printf '%s\n' "$proxy_state" | awk '$1 == "HTTPSProxy" && $2 == ":" { print $3 }')
    https_port=$(printf '%s\n' "$proxy_state" | awk '$1 == "HTTPSPort" && $2 == ":" { print $3 }')
    case "$socks_enabled:$socks_host:$socks_port" in
      1:*:[0-9]*) DOWNLOAD_PROXY="socks5h://$socks_host:$socks_port"; DOWNLOAD_PROXY_SOURCE=macOS-system ;;
      *)
        case "$https_enabled:$https_host:$https_port" in
          1:*:[0-9]*) DOWNLOAD_PROXY="http://$https_host:$https_port"; DOWNLOAD_PROXY_SOURCE=macOS-system ;;
        esac
        ;;
    esac
  fi
}

network_preflight() {
  CONNECT_TIMEOUT=${AGENT_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS:-10}
  REQUEST_TIMEOUT=${AGENT_TOOLCHAIN_REQUEST_TIMEOUT_SECONDS:-90}
  positive_timeout "$CONNECT_TIMEOUT" AGENT_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS
  positive_timeout "$REQUEST_TIMEOUT" AGENT_TOOLCHAIN_REQUEST_TIMEOUT_SECONDS
  detect_proxy
  case "$DOWNLOAD_PROXY_SOURCE" in
    direct)
      note "网络预检：直连 GitHub；未检测到代理。连接超时 ${CONNECT_TIMEOUT}s，请求超时 ${REQUEST_TIMEOUT}s。"
      note "网络提示：若连接或下载缓慢，设置 AGENT_TOOLCHAIN_PROXY=<scheme://host:port> 后重试。"
      ;;
    *) note "网络预检：使用 ${DOWNLOAD_PROXY_SOURCE} 代理；连接超时 ${CONNECT_TIMEOUT}s，请求超时 ${REQUEST_TIMEOUT}s。" ;;
  esac
}

curl_fetch() {
  if [ -n "$DOWNLOAD_PROXY" ]; then
    curl --proxy "$DOWNLOAD_PROXY" "$@"
  else
    curl "$@"
  fi
}

fetch_or_die() {
  if ! curl_fetch "$@"; then
    die "GitHub 下载失败或超时；请检查网络/代理后重试。可设置 AGENT_TOOLCHAIN_PROXY=<scheme://host:port>，不会写入项目配置。"
  fi
}

download_archive() {
  url=$1
  archive=$2
  work=$3
  label=$4
  workers=${AGENT_TOOLCHAIN_DOWNLOAD_WORKERS:-4}
  case "$workers" in
    1|2|3|4|5|6|7|8) ;;
    *) die "AGENT_TOOLCHAIN_DOWNLOAD_WORKERS 必须是 1 到 8 的整数" ;;
  esac
  headers="$work/range-headers"
  note "下载 $label：获取受信任 release asset 信息"
  fetch_or_die --fail --location --silent --show-error --http1.1 --retry 3 --retry-delay 2 --connect-timeout "$CONNECT_TIMEOUT" --max-time "$REQUEST_TIMEOUT" --proto '=https' --proto-redir '=https' --tlsv1.2 --range 0-0 --dump-header "$headers" --output /dev/null "$url"
  total=$(awk -F/ 'tolower($1) ~ /^content-range:/ { gsub(/\r/, "", $2); print $2 }' "$headers" | tail -n 1)
  asset_url=$(awk 'tolower($1) == "location:" { gsub(/\r/, "", $2); print $2 }' "$headers" | tail -n 1)
  case "$total" in
    ''|*[!0-9]*) die "无法从 Range 响应确定下载大小" ;;
  esac
  case "$asset_url" in
    https://release-assets.githubusercontent.com/*) ;;
    *) die "下载重定向不是受信任的 GitHub release asset" ;;
  esac
  [ "$total" -gt 0 ] || die "下载大小无效"
  chunk=$(( (total + workers - 1) / workers ))
  # Keep proxy connections bounded; each verified range is downloaded in order.
  index=0
  while [ "$index" -lt "$workers" ]; do
    start=$(( index * chunk ))
    [ "$start" -lt "$total" ] || break
    end=$(( start + chunk - 1 ))
    [ "$end" -lt "$total" ] || end=$(( total - 1 ))
    note "下载 $label：分段 $((index + 1))/$workers"
    fetch_or_die --fail --location --silent --show-error --http1.1 --retry 3 --retry-delay 2 --connect-timeout "$CONNECT_TIMEOUT" --max-time "$REQUEST_TIMEOUT" --proto '=https' --proto-redir '=https' --tlsv1.2 --range "$start-$end" --output "$work/part-$index" "$asset_url"
    index=$(( index + 1 ))
  done
  : > "$archive"
  index=0
  while [ "$index" -lt "$workers" ]; do
    [ -f "$work/part-$index" ] || break
    cat "$work/part-$index" >> "$archive"
    index=$(( index + 1 ))
  done
  actual_size=$(wc -c < "$archive" | tr -d ' ')
  [ "$actual_size" = "$total" ] || die "分段下载大小不匹配"
}

atomic_link() {
  target=$1
  link=$2
  parent=$(dirname "$link")
  temporary="$parent/.agent-toolchain-link-$$"
  [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || die "临时 link 已存在：$temporary"
  ln -s "$target" "$temporary"
  if [ "$PLATFORM_OS" = darwin ]; then
    mv -f -h "$temporary" "$link"
  else
    mv -f -T "$temporary" "$link"
  fi
}

atomic_replace() {
  source_path=$1
  destination_path=$2
  if [ "$PLATFORM_OS" = darwin ]; then
    mv -f -h "$source_path" "$destination_path"
  else
    mv -f -T "$source_path" "$destination_path"
  fi
}

cleanup_install() {
  result=$?
  trap - EXIT HUP INT TERM
  can_remove_destination=1
  if [ -n "${INSTALL_DESTINATION:-}" ]; then
    current="$TOOLCHAIN_HOME/$INSTALL_TOOL/current"
    if [ -L "$current" ] && [ "$(readlink "$current")" = "$INSTALL_DESTINATION" ]; then
      if [ -n "${INSTALL_PREVIOUS_CURRENT:-}" ]; then
        restore_link="$(dirname "$current")/.agent-toolchain-restore-$$"
        if ! ln -s "$INSTALL_PREVIOUS_CURRENT" "$restore_link"; then
          note "无法恢复 $INSTALL_TOOL 的 previous current；保留 $INSTALL_DESTINATION"
          can_remove_destination=0
        elif [ "$PLATFORM_OS" = darwin ] && ! mv -f -h "$restore_link" "$current"; then
          note "无法恢复 $INSTALL_TOOL 的 previous current；保留 $INSTALL_DESTINATION"
          can_remove_destination=0
        elif [ "$PLATFORM_OS" = linux ] && ! mv -f -T "$restore_link" "$current"; then
          note "无法恢复 $INSTALL_TOOL 的 previous current；保留 $INSTALL_DESTINATION"
          can_remove_destination=0
        fi
      else
        if ! rm -f "$current"; then
          note "无法移除 $INSTALL_TOOL 的 current；保留 $INSTALL_DESTINATION"
          can_remove_destination=0
        fi
      fi
    fi
    if [ "${INSTALL_PUBLIC_CREATED:-0}" -eq 1 ] && [ "$can_remove_destination" -eq 1 ]; then
      rm -f "$TOOLCHAIN_BIN/$INSTALL_TOOL"
    fi
    [ "$can_remove_destination" -eq 0 ] || rm -rf "$INSTALL_DESTINATION"
  elif [ -n "${INSTALL_STAGE:-}" ]; then
    rm -rf "$INSTALL_STAGE"
  fi
  [ -z "${INSTALL_WORK:-}" ] || rm -rf "$INSTALL_WORK"
  exit "$result"
}

restore_publication() {
  tool=$1
  previous_current=$2
  public_existed=$3
  tool_dir="$TOOLCHAIN_HOME/$tool"
  current="$tool_dir/current"
  if [ -n "$previous_current" ]; then
    atomic_link "$previous_current" "$current"
  else
    rm -f "$current"
  fi
  if [ "$public_existed" -eq 0 ]; then
    rm -f "$TOOLCHAIN_BIN/$tool"
  fi
}

switch_current() {
  tool=$1
  version=$2
  [ "$tool" = rtk ] || die "仅 RTK 支持受管版本回滚；CodeGraph 固定为 npm 审查版本"
  version_is_safe "$version" || die "不安全的版本号：$version"
  tool_dir="$TOOLCHAIN_HOME/$tool"
  version_dir="$tool_dir/$version"
  verify_version_dir "$tool" "$version" || die "未安装或未验证的版本：$tool $version"
  mkdir -p "$tool_dir" "$TOOLCHAIN_BIN"
  [ ! -L "$tool_dir" ] || die "受管理工具目录不能是 symlink"
  if [ -e "$tool_dir/current" ] && [ ! -L "$tool_dir/current" ]; then
    die "受管理目录中的 current 不是 symlink"
  fi
  write_rtk_launcher
  atomic_link "$version_dir" "$tool_dir/current"
}

install_tool() {
  tool=$1
  [ "$tool" = rtk ] || die "CodeGraph 必须通过官方 npm 包安装"
  version=$(tool_value "$tool" version)
  url=$(tool_value "$tool" url)
  expected_sha=$(tool_value "$tool" sha)
  destination="$TOOLCHAIN_HOME/$tool/$version"
  if is_ready "$tool"; then
    note "$tool $version 已就绪"
    return 0
  fi
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || die "$destination 已存在但不健康，拒绝覆盖"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry-run: 下载 $url"
    note "dry-run: 验证 SHA-256 $expected_sha"
    note "dry-run: 安装到 $destination 并创建 $TOOLCHAIN_BIN/$tool"
    return 0
  fi
  INSTALL_TOOL=$tool
  INSTALL_WORK=$(mktemp -d "${TMPDIR:-/tmp}/agent-toolchain.XXXXXX")
  INSTALL_STAGE=
  INSTALL_DESTINATION=
  INSTALL_PUBLIC_CREATED=0
  INSTALL_PREVIOUS_CURRENT=
  if [ -L "$TOOLCHAIN_HOME/$tool/current" ]; then
    INSTALL_PREVIOUS_CURRENT=$(readlink "$TOOLCHAIN_HOME/$tool/current")
  fi
  trap 'cleanup_install' EXIT HUP INT TERM
  archive="$INSTALL_WORK/$(tool_value "$tool" asset)"
  note "下载 $tool $version"
  download_archive "$url" "$archive" "$INSTALL_WORK" "$tool $version"
  actual_sha=$(sha256_file "$archive")
  [ "$actual_sha" = "$expected_sha" ] || die "$tool 下载摘要不匹配"
  safe_tar "$archive"
  extract="$INSTALL_WORK/extract"
  mkdir "$extract"
  tar -xzf "$archive" -C "$extract"
  if find "$extract" \( -type l -o -type p -o -type b -o -type c \) -print -quit | rg -q .; then
    die "归档解压后包含不允许的文件类型"
  fi
  candidate=$(find "$extract" -type f -name "$tool" -perm -u+x -print | head -n 1)
  [ -n "$candidate" ] || die "归档中未找到可执行 $tool"
  [ "$(find "$extract" -type f -name "$tool" -perm -u+x -print | wc -l | tr -d ' ')" = 1 ] || die "归档中存在多个 $tool 可执行文件"
  assert_binary_architecture "$candidate" "$tool"
  mkdir -p "$TOOLCHAIN_HOME/$tool"
  [ ! -L "$TOOLCHAIN_HOME/$tool" ] || die "受管理工具目录不能是 symlink"
  INSTALL_STAGE="$TOOLCHAIN_HOME/$tool/.install-$version-$$"
  [ ! -e "$INSTALL_STAGE" ] && [ ! -L "$INSTALL_STAGE" ] || die "安装暂存目录已存在：$INSTALL_STAGE"
  mkdir "$INSTALL_STAGE"
  install -m 755 "$candidate" "$INSTALL_STAGE/$tool"
  stage_binary=$(binary_in_dir "$tool" "$INSTALL_STAGE")
  binary_sha=$(sha256_file "$stage_binary")
  printf 'tool=%s\nversion=%s\narchive_sha256=%s\nbinary_sha256=%s\nurl=%s\n' "$tool" "$version" "$actual_sha" "$binary_sha" "$url" > "$INSTALL_STAGE/receipt"
  if ! verify_version_dir "$tool" "$version" "$INSTALL_STAGE"; then
    note "$tool 暂存 launcher：$(file -b "$stage_binary" 2>/dev/null || true)"
    run_tool_version "$tool" "$stage_binary" 2>&1 || true
    die "$tool 暂存安装验证失败"
  fi
  version_matches "$tool" "$stage_binary" "$version" || die "$tool 版本验证失败"
  mv "$INSTALL_STAGE" "$destination"
  # Keep destination in the cleanup trap until both managed links are verified.
  INSTALL_STAGE=
  INSTALL_DESTINATION=$destination
  switch_current "$tool" "$version"
  is_ready "$tool" || die "$tool 发布后验证失败"
  INSTALL_DESTINATION=
  note "$tool $version 已安装"
  trap - EXIT HUP INT TERM
  rm -rf "$INSTALL_WORK" || note "无法清理临时目录：$INSTALL_WORK"
}

ensure_posix_command_path() {
  node_bin=$(dirname "$(command -v node)")
  write_codegraph_launcher
  export PATH="$TOOLCHAIN_BIN:$PATH"
  case "${SHELL:-}" in
    */zsh) shell_profiles="$HOME/.zprofile $HOME/.zshrc" ;;
    */bash) shell_profiles="$HOME/.bash_profile $HOME/.bashrc" ;;
    *) shell_profiles="$HOME/.profile" ;;
  esac
  for profile in $shell_profiles; do
    assert_plain_file_or_absent "$profile"
    temporary="${profile}.agent-toolchain-$$"
    if [ -f "$profile" ]; then
      awk '
        $0 == "# >>> agent-toolchain command path >>>" { in_block = 1; next }
        $0 == "# <<< agent-toolchain command path <<<" { in_block = 0; next }
        $0 == "# agent-toolchain command path" { getline; next }
        !in_block { print }
      ' "$profile" > "$temporary"
    else
      : > "$temporary"
    fi
    printf '%s\n' '# >>> agent-toolchain command path >>>' >> "$temporary"
    printf 'export PATH="%s:$PATH"\n' "$TOOLCHAIN_BIN" >> "$temporary"
    printf '%s\n' '# <<< agent-toolchain command path <<<' >> "$temporary"
    atomic_replace "$temporary" "$profile"
    note "已将 CodeGraph/RTK 命令路径写入 ${profile}；新开的终端会自动生效。"
  done
  if [ "$PLATFORM_OS" = darwin ] && command -v launchctl >/dev/null 2>&1; then
    gui_path=$(launchctl getenv PATH 2>/dev/null || true)
    [ -n "$gui_path" ] || gui_path='/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    launchctl setenv PATH "$TOOLCHAIN_BIN:$node_bin:$gui_path" || note "无法更新 macOS 图形会话 PATH；新开的终端仍会生效。"
  elif [ "$PLATFORM_OS" = linux ]; then
    environment_dir="$HOME/.config/environment.d"
    environment_file="$environment_dir/90-agent-toolchain.conf"
    if [ ! -e "$environment_dir" ]; then
      mkdir -p "$environment_dir"
    fi
    [ -d "$environment_dir" ] && [ ! -L "$environment_dir" ] || die "$environment_dir 必须是非链接目录"
    assert_plain_file_or_absent "$environment_file"
    temporary="${environment_file}.agent-toolchain-$$"
    if [ -f "$environment_file" ]; then
      awk '
        $0 == "# >>> agent-toolchain command path >>>" { in_block = 1; next }
        $0 == "# <<< agent-toolchain command path <<<" { in_block = 0; next }
        $0 == "# agent-toolchain command path" { getline; next }
        !in_block { print }
      ' "$environment_file" > "$temporary"
    else
      : > "$temporary"
    fi
    printf '%s\n' '# >>> agent-toolchain command path >>>' >> "$temporary"
    printf 'PATH=%s:${PATH}\n' "$TOOLCHAIN_BIN" >> "$temporary"
    printf '%s\n' '# <<< agent-toolchain command path <<<' >> "$temporary"
    atomic_replace "$temporary" "$environment_file"
    note "已写入 Linux 用户环境路径；新会话会自动加载。"
  fi
}

install_codegraph_npm() {
  command -v node >/dev/null 2>&1 || die "缺少 node，无法运行 CodeGraph npm 包"
  command -v npm >/dev/null 2>&1 || die "缺少 npm，无法全局安装 CodeGraph"
  if codegraph_npm_ready; then
    [ "$DRY_RUN" -eq 1 ] || ensure_posix_command_path
    note "CodeGraph npm $CODEGRAPH_VERSION 已就绪"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry-run: npm install --global --prefix $TOOLCHAIN_HOME/npm --ignore-scripts $CODEGRAPH_NPM_PACKAGE@$CODEGRAPH_VERSION"
    note "dry-run: 使用当前 npm registry 和代理设置；RTK 仍使用下方已校验的 GitHub release"
    return 0
  fi
  note "通过 npm 全局安装 CodeGraph $CODEGRAPH_VERSION"
  mkdir -p "$TOOLCHAIN_HOME/npm"
  NPM_CONFIG_FETCH_TIMEOUT="${NPM_CONFIG_FETCH_TIMEOUT:-$((REQUEST_TIMEOUT * 1000))}" \
  NPM_CONFIG_FETCH_RETRIES="${NPM_CONFIG_FETCH_RETRIES:-1}" \
  NPM_CONFIG_FETCH_RETRY_MINTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:-1000}" \
  NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:-10000}" \
    npm install --global --prefix "$TOOLCHAIN_HOME/npm" --ignore-scripts --no-audit --no-fund "$CODEGRAPH_NPM_PACKAGE@$CODEGRAPH_VERSION" || die "CodeGraph npm 安装失败或超时；请检查 npm registry、代理和 Node 环境"
  ensure_posix_command_path
  codegraph_npm_ready || die "CodeGraph npm 安装后验证失败"
  note "CodeGraph $CODEGRAPH_VERSION 已通过 npm 全局安装"
}

bootstrap() {
  [ "$APPLY" -ne "$DRY_RUN" ] || die "bootstrap 必须且只能指定 --dry-run 或 --apply"
  network_preflight
  set +e
  (set -e; install_codegraph_npm)
  codegraph_result=$?
  set -e
  [ "$codegraph_result" -eq 0 ] || die "CodeGraph 安装失败"
  set +e
  (set -e; install_tool rtk)
  rtk_result=$?
  set -e
  if [ "$rtk_result" -ne 0 ]; then
    die "RTK 安装失败；CodeGraph npm 安装保留，以便修复网络后重试。"
  fi
  if [ "$APPLY" -eq 1 ] && is_ready codegraph; then
    run_codegraph "$(managed_binary codegraph)" telemetry off >/dev/null 2>&1 || note "CodeGraph 当前版本不支持 telemetry off；MCP 环境变量仍会禁用遥测"
  fi
  if [ "$APPLY" -eq 1 ] && is_ready rtk; then
    RTK_TELEMETRY_DISABLED=1 "$(managed_binary rtk)" telemetry disable >/dev/null 2>&1 || note "RTK 当前版本不支持 telemetry disable；调用 RTK 时必须显式传入 RTK_TELEMETRY_DISABLED=1"
  fi
}

init_codegraph() {
  is_ready codegraph || die "CodeGraph 尚未安装"
  assert_codegraph_index_safe
  if [ -d "$PROJECT/.codegraph" ] && find "$PROJECT/.codegraph" -mindepth 1 ! -name .gitignore -print -quit | rg -q .; then
    note ".codegraph 已有索引；执行增量同步"
    (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" sync)
    (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" status)
    return
  fi
  (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" init --help >/dev/null)
  (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" init)
  (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" status)
}

maintain() {
  is_ready codegraph || die "CodeGraph 尚未安装"
  assert_codegraph_index_safe
  (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" status)
  if [ "$SYNC" -eq 1 ]; then
    (cd "$PROJECT" && run_codegraph "$(managed_binary codegraph)" sync)
  fi
}

rollback() {
  [ -n "$ROLLBACK_TOOL" ] && [ -n "$ROLLBACK_VERSION" ] || die "rollback 需要工具和版本"
  [ "$ROLLBACK_TOOL" = rtk ] || die "CodeGraph 使用 npm 固定版本安装，不支持此回滚命令"
  version_is_safe "$ROLLBACK_VERSION" || die "不安全的回滚版本"
  switch_current "$ROLLBACK_TOOL" "$ROLLBACK_VERSION"
  note "$ROLLBACK_TOOL 已切换到 $ROLLBACK_VERSION"
}

main() {
  parse_args "$@"
  case "$ACTION" in
    doctor|bootstrap|init-codegraph|maintain)
      detect_platform
      check_project
      load_trusted_manifest
      ;;
    configure)
      detect_platform
      check_project
      command -v rg >/dev/null 2>&1 || die '缺少 rg；configure 未写入任何文件'
      ;;
    rollback)
      detect_platform
      load_trusted_manifest
      ;;
    -h|--help|help|'') usage; exit 0 ;;
    *) usage >&2; die "未知操作：$ACTION" ;;
  esac
  case "$ACTION" in
    configure) configure_project ;;
    doctor) doctor ;;
    bootstrap) bootstrap ;;
    init-codegraph) init_codegraph ;;
    maintain) maintain ;;
    rollback) rollback ;;
  esac
}

main "$@"
