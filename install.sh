#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

die() {
    printf '%s\n' "$1" >&2
    exit 1
}
path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

assert_path_chain() {
    chain_path=$1
    while [ "$chain_path" != "/" ] && [ "$chain_path" != "." ]; do
        if [ -L "$chain_path" ]; then
            printf '%s\n' "Refusing symlink path: $chain_path" >&2
            return 1
        fi
        next_path=$(dirname -- "$chain_path")
        [ "$next_path" = "$chain_path" ] && break
        chain_path=$next_path
    done
}

assert_no_symlink_tree() {
    tree_path=$1
    path_exists "$tree_path" || return 0
    if [ -L "$tree_path" ]; then
        printf '%s\n' "Refusing symlink path: $tree_path" >&2
        return 1
    fi
    if [ -d "$tree_path" ]; then
        for child_path in "$tree_path"/* "$tree_path"/.[!.]* "$tree_path"/..?*; do
            path_exists "$child_path" || continue
            assert_no_symlink_tree "$child_path" || return 1
        done
    fi
}

assert_target() {
    target_path=$1
    target_kind=$2
    assert_path_chain "$target_path" || return 1
    path_exists "$target_path" || return 0
    if [ -L "$target_path" ]; then
        printf '%s\n' "Refusing to replace a symbolic link: $target_path" >&2
        return 1
    fi
    case "$target_kind" in
        file) [ -f "$target_path" ] || { printf '%s\n' "Expected a regular file target: $target_path" >&2; return 1; } ;;
        directory) [ -d "$target_path" ] || { printf '%s\n' "Expected a directory target: $target_path" >&2; return 1; }; assert_no_symlink_tree "$target_path" || return 1 ;;
        *) printf '%s\n' "Unknown target kind: $target_kind" >&2; return 1 ;;
    esac
}

assert_directory_container() {
    container_path=$1
    assert_path_chain "$container_path" || return 1
    path_exists "$container_path" || return 0
    if [ -L "$container_path" ] || [ ! -d "$container_path" ]; then
        printf '%s\n' "Expected a non-symbolic-link directory: $container_path" >&2
        return 1
    fi
}

normalize_absolute_path() {
    printf '%s\n' "$1" | awk -F/ '
        $0 !~ /^\// { exit 1 }
        {
            depth = 0
            for (i = 1; i <= NF; i++) {
                part = $i
                if (part == "" || part == ".") continue
                if (part == "..") {
                    if (depth > 0) depth--
                    continue
                }
                components[++depth] = part
            }
            if (depth == 0) {
                print "/"
                next
            }
            normalized = ""
            for (i = 1; i <= depth; i++) normalized = normalized "/" components[i]
            print normalized
        }
    '
}

presets_root=$script_dir/shared/roles/presets
preset_manifest=$script_dir/shared/roles/presets.sha256

normalized_lf_sha256() {
    # LF 折叠：逐行去行尾 \r；GNU sed 对无尾换行输入不补 \n，与 ps1 字节折叠算法一致。
    if command -v sha256sum >/dev/null 2>&1; then
        sed 's/\r$//' "$1" | sha256sum | awk '{print $1}'
    else
        sed 's/\r$//' "$1" | shasum -a 256 | awk '{print $1}'
    fi
}

trim_ws() {
    printf '%s' "$1" | LC_ALL=C sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# 解析结果的动态变量存取：变量名只由白名单键与整数索引拼出，值经赋值语句写入不做二次求值。
pset() {
    pset_value=$2
    eval "$1=\$pset_value"
}
pget() {
    eval "printf '%s' \"\${$1:-}\""
}

preset_fail() {
    if [ "${PRESET_QUIET:-0}" = 1 ]; then
        exit 1
    fi
    die "$1"
}

# ---- --update-role-manifest 维护模式：重写预设源 manifest，不执行安装 ----

if [ "${1:-}" = "--update-role-manifest" ]; then
    [ -d "$presets_root" ] || die "Missing presets root: $presets_root"
    um_tmp_manifest=$preset_manifest.tmp
    um_tmp_list=$(mktemp) || die 'Could not create temporary file.'
    um_tmp_files=$(mktemp) || { rm -f -- "$um_tmp_list"; die 'Could not create temporary file.'; }
    trap 'rm -f -- "$um_tmp_list" "$um_tmp_files" "$um_tmp_manifest"' EXIT HUP INT TERM
    : > "$um_tmp_manifest"
    find "$presets_root" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort > "$um_tmp_list"
    um_sources=0
    while IFS= read -r um_preset_path || [ -n "$um_preset_path" ]; do
        [ -n "$um_preset_path" ] || continue
        um_preset_name=$(basename -- "$um_preset_path")
        [ -f "$um_preset_path/preset.toml" ] || die "Preset missing preset.toml: $um_preset_path"
        find "$um_preset_path" -type f | LC_ALL=C sort > "$um_tmp_files"
        while IFS= read -r um_source_path || [ -n "$um_source_path" ]; do
            [ -n "$um_source_path" ] || continue
            um_rel=${um_source_path#"$um_preset_path/"}
            um_hash=$(normalized_lf_sha256 "$um_source_path")
            printf '%s  %s/%s\n' "$um_hash" "$um_preset_name" "$um_rel" >> "$um_tmp_manifest"
            um_sources=$((um_sources+1))
        done < "$um_tmp_files"
    done < "$um_tmp_list"
    [ "$um_sources" -gt 0 ] || die "No preset sources found under $presets_root"
    mv -- "$um_tmp_manifest" "$preset_manifest"
    printf '%s\n' "Preset manifest updated: $preset_manifest"
    exit 0
fi

# ---- 客户端选择：位置参数优先；无参数且为交互终端时进入菜单；否则报用法并退出 ----

client=${1:-}
if [ -z "$client" ]; then
    if [ -t 0 ]; then
        printf '%s\n' 'Select the client to install:' '  1) Codex' '  2) ZCode'
        printf 'Enter number or name (q to quit): '
        read -r client_choice
        case "$client_choice" in
            1|[cC]odex) client=codex ;;
            2|[zZ][cC]ode) client=zcode ;;
            [qQ]) exit 0 ;;
            *) die "Invalid selection: $client_choice" ;;
        esac
    else
        die 'No client specified. Usage: sh install.sh <codex|zcode>'
    fi
fi
case "$client" in
    [cC]odex) client=codex ;;
    [zZ][cC]ode) client=zcode ;;
    *) die "Unknown client: $client (supported: codex|zcode)" ;;
esac

# ---- 按客户端装配来源 ----

source_system_docs=$script_dir/shared/docs/system
shared_skills=$script_dir/shared/skills
has_config=0
case "$client" in
    codex)
        client_label=Codex
        home_env=CODEX_HOME
        default_home=.codex
        role_kind=toml
        host_section=codex
        default_preset=gpt
        placeholder=CODEX_HOME
        source_instructions=$script_dir/codex-global-config/AGENTS.md
        source_docs=$script_dir/codex-global-config/docs
        source_config=$script_dir/codex-global-config/config.toml
        source_model_provider_settings=$script_dir/codex-global-config/model-provider-settings.toml
        client_skills=$script_dir/codex-global-config/skills
        skill_specs='agent-toolchain:shared project-doc-planner:shared visual-aesthetics:shared deep-dive-review:shared orchestrate-model-workflow:codex'
        has_config=1
        ;;
    zcode)
        client_label=ZCode
        home_env=ZCODE_HOME
        default_home=.zcode
        role_kind=md
        host_section=zcode
        default_preset=glm
        placeholder=ZCODE_HOME
        source_instructions=$script_dir/zcode-global-config/AGENTS.md
        source_docs=$script_dir/zcode-global-config/docs
        client_skills=$script_dir/zcode-global-config/skills
        skill_specs='agent-toolchain:shared project-doc-planner:shared visual-aesthetics:shared deep-dive-review:shared orchestrate-model-workflow:zcode'
        ;;
esac

skill_source_dir() {
    case "${1##*:}" in
        shared) printf '%s\n' "$shared_skills/${1%%:*}" ;;
        codex) printf '%s\n' "$client_skills/${1%%:*}" ;;
        zcode) printf '%s\n' "$client_skills/${1%%:*}" ;;
        *) return 1 ;;
    esac
}

# ---- 预设（preset）解析与渲染 ----

# 受限 TOML 表头解析：仅允许 [zcode]、[codex]、[[<host>.role]]；引号表头与未知表统一报错。
parse_preset_header() {
    ph_line=$1
    if ! ph_result=$(printf '%s\n' "$ph_line" | LC_ALL=C awk '
        {
            line = $0
            n = length(line)
            if (substr(line, 1, 2) == "[[") { arr = 1; start = 3 } else { arr = 0; start = 2 }
            basic = 0; literal = 0
            for (pos = start; pos <= n; pos++) {
                c = substr(line, pos, 1)
                if (basic) { if (c == "\\") pos++; else if (c == "\"") basic = 0; continue }
                if (literal) { if (c == "\047") literal = 0; continue }
                if (c == "\"") { basic = 1; continue }
                if (c == "\047") { literal = 1; continue }
                if (c == "[") exit 1
                if (c == "]") {
                    closing = arr ? 2 : 1
                    rest = substr(line, pos + closing)
                    if (rest !~ /^[[:space:]]*(#.*)?$/) exit 1
                    header = substr(line, start, pos - start)
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", header)
                    if (header == "") exit 1
                    if (arr) {
                        # [[<host>.role]]：必须数组形式且 host 为合法标识（ps1:106 数组正则）
                        if (header !~ /^[A-Za-z][A-Za-z0-9_-]*\.role$/) exit 1
                        sub(/\.role$/, "", header)
                        print header; print 1; exit 0
                    }
                    # [<host>]：必须单括号形式且 host ∈ {zcode, codex}（ps1:111 白名单）
                    if (header != "zcode" && header != "codex") exit 1
                    print header; print 0; exit 0
                }
            }
            exit 1
        }
    '); then
        preset_fail "Unsupported preset table: $ph_line"
    fi
    PH_HOST=$(printf '%s\n' "$ph_result" | LC_ALL=C sed -n '1p')
    PH_ISROLE=$(printf '%s\n' "$ph_result" | LC_ALL=C sed -n '2p')
}

# 基本标量解析：true/false（含类型标记）、裸词、带 \" \\ \n \t 转义的双引号字符串。
parse_preset_scalar() {
    ps_ctx=$2
    ps_v=$(trim_ws "$1")
    case "$ps_v" in
        true) PSV=true; PSB=1; return 0 ;;
        false) PSV=false; PSB=1; return 0 ;;
    esac
    if printf '%s' "$ps_v" | LC_ALL=C grep -Eq '^[A-Za-z][A-Za-z0-9_-]*$'; then
        PSV=$ps_v
        PSB=0
        return 0
    fi
    case "$ps_v" in
        '"'*'"')
            ps_inner=${ps_v#\"}
            ps_inner=${ps_inner%\"}
            if ! ps_decoded=$(printf '%sX' "$ps_inner" | LC_ALL=C awk -v ctx="$ps_ctx" '
                {
                    line = $0
                    out = ""
                    n = length(line)
                    i = 1
                    while (i <= n) {
                        c = substr(line, i, 1)
                        if (c == "\\") {
                            i++
                            if (i > n) { printf "Unterminated escape in %s\n", ctx > "/dev/stderr"; exit 1 }
                            e = substr(line, i, 1)
                            if (e == "\"") out = out "\""
                            else if (e == "\\") out = out "\\"
                            else if (e == "n") out = out "\n"
                            else if (e == "t") out = out "\t"
                            else { printf "Unsupported escape in %s: \\%s\n", ctx, e > "/dev/stderr"; exit 1 }
                        } else if (c == "\"") {
                            printf "Unescaped double quote in %s\n", ctx > "/dev/stderr"; exit 1
                        } else {
                            out = out c
                        }
                        i++
                    }
                    printf "%s", out
                }'); then
                preset_fail "Invalid preset string in $ps_ctx"
            fi
            PSV=${ps_decoded%X}
            PSB=0
            ;;
        *) preset_fail "Unsupported preset value in $ps_ctx: $ps_v" ;;
    esac
}

# 值解析：数组 [a, b] 逐元素走标量解析；结果经 PSV/PSB/PSC/PSE_<n> 返回。
parse_preset_value() {
    pv_ctx=$2
    pv_v=$(trim_ws "$1")
    PS_IS_ARRAY=0
    PSB=0
    PSC=0
    PSV=
    case "$pv_v" in
        '['*']')
            PS_IS_ARRAY=1
            pv_inner=${pv_v#\[}
            pv_inner=${pv_inner%]}
            pv_inner=$(trim_ws "$pv_inner")
            if [ -z "$pv_inner" ]; then
                return 0
            fi
            pv_joined=
            pv_rest=$pv_inner
            while [ -n "$pv_rest" ]; do
                pv_item=${pv_rest%%,*}
                case "$pv_rest" in
                    *,*) pv_rest=${pv_rest#*,} ;;
                    *) pv_rest= ;;
                esac
                PSC=$((PSC+1))
                parse_preset_scalar "$pv_item" "$pv_ctx item"
                pset "PSE_${PSC}" "$PSV"
                if [ "$PSC" -eq 1 ]; then pv_joined=$PSV; else pv_joined="$pv_joined, $PSV"; fi
            done
            PSV=$pv_joined
            PSB=0
            ;;
        *)
            parse_preset_scalar "$pv_v" "$pv_ctx"
            ;;
    esac
}

# 解析 preset.toml 到 P_* 全局变量：SET 标志区分"键不存在"与"空值"。
read_preset() {
    rp_file=$1
    PRESET_QUIET=${PRESET_QUIET:-0}
    rp_bom=$(printf '\357\273\277')
    rp_first=1
    P_DESC_SET=0
    P_DESC=
    P_SECTION_COUNT=0
    P_ROLES=0
    P_HOST_zcode_SET=0
    P_HOST_codex_SET=0
    P_HOST_zcode_MODEL_SET=0
    P_HOST_codex_MODEL_SET=0
    rp_host=
    rp_role=

    while IFS= read -r rp_line || [ -n "$rp_line" ]; do
        if [ "$rp_first" = 1 ]; then
            rp_first=0
            rp_line=${rp_line#"$rp_bom"}
        fi
        rp_trim=$(trim_ws "$rp_line")
        if [ -z "$rp_trim" ]; then continue; fi
        case "$rp_trim" in '#'*) continue ;; esac
        case "$rp_trim" in
            '['*)
                parse_preset_header "$rp_trim"
                rp_host=$PH_HOST
                if [ "$(pget "P_HOST_${rp_host}_SET")" = 0 ]; then
                    pset "P_HOST_${rp_host}_SET" 1
                    P_SECTION_COUNT=$((P_SECTION_COUNT+1))
                fi
                if [ "$PH_ISROLE" = 1 ]; then
                    P_ROLES=$((P_ROLES+1))
                    rp_role=$P_ROLES
                    pset "P_R${rp_role}_HOST" "$rp_host"
                    for rp_init_key in id name description effort readonly model body color tools thoughtLevel model_reasoning_effort sandbox_mode skill_desc; do
                        pset "P_R${rp_role}_SET_${rp_init_key}" 0
                        pset "P_R${rp_role}_ARR_${rp_init_key}" 0
                    done
                    pset "P_R${rp_role}_BOOL_readonly" 0
                    pset "P_R${rp_role}_ARRN_tools" 0
                else
                    rp_role=
                fi
                continue
                ;;
        esac
        case "$rp_trim" in
            *=*) rp_key=$(trim_ws "${rp_trim%%=*}"); rp_value_raw=${rp_trim#*=} ;;
            *) preset_fail "Unsupported preset line in $rp_file: $rp_line" ;;
        esac
        if ! printf '%s' "$rp_key" | LC_ALL=C grep -Eq '^[A-Za-z][A-Za-z0-9_-]*$'; then
            preset_fail "Unsupported preset key in $rp_file: $rp_key"
        fi
        if [ -z "$rp_host" ]; then
            if [ "$rp_key" != description ]; then preset_fail "Unsupported preset root key: $rp_key"; fi
            if [ "$P_DESC_SET" = 1 ]; then preset_fail 'Repeated preset key: description'; fi
            parse_preset_scalar "$rp_value_raw" description
            P_DESC=$PSV
            P_DESC_SET=1
        elif [ -z "$rp_role" ]; then
            if [ "$rp_key" != model ]; then preset_fail "Unsupported preset key in [$rp_host]: $rp_key"; fi
            if [ "$(pget "P_HOST_${rp_host}_MODEL_SET")" = 1 ]; then preset_fail "Repeated preset key: $rp_host/$rp_key"; fi
            parse_preset_value "$rp_value_raw" "$rp_host/$rp_key"
            pset "P_HOST_${rp_host}_MODEL_SET" 1
            pset "P_HOST_${rp_host}_MODEL" "$PSV"
        else
            case "$rp_key" in
                id|name|description|effort|readonly|model|body|color|tools|thoughtLevel|model_reasoning_effort|sandbox_mode|skill_desc) ;;
                *) preset_fail "Unsupported preset role key in [$rp_host]: $rp_key" ;;
            esac
            if [ "$(pget "P_R${rp_role}_SET_${rp_key}")" = 1 ]; then preset_fail "Repeated preset key: $rp_host/$rp_key"; fi
            parse_preset_value "$rp_value_raw" "$rp_host/$rp_key"
            pset "P_R${rp_role}_SET_${rp_key}" 1
            pset "P_R${rp_role}_${rp_key}" "$PSV"
            if [ "$rp_key" = readonly ] && [ "$PS_IS_ARRAY" = 0 ] && [ "$PSB" = 1 ]; then pset "P_R${rp_role}_BOOL_readonly" 1; fi
            if [ "$PS_IS_ARRAY" = 1 ]; then
                pset "P_R${rp_role}_ARR_${rp_key}" 1
                pset "P_R${rp_role}_ARRN_${rp_key}" "$PSC"
                pv_j=1
                while [ "$pv_j" -le "$PSC" ]; do
                    pset "P_R${rp_role}_ELEM_${rp_key}_${pv_j}" "$(pget "PSE_${pv_j}")"
                    pv_j=$((pv_j+1))
                done
            fi
        fi
    done < "$rp_file"

    if [ "$P_DESC_SET" = 0 ]; then preset_fail "Preset description missing: $rp_file"; fi
    if [ "$P_SECTION_COUNT" = 0 ]; then preset_fail "Preset has no host section: $rp_file"; fi
}

# YAML/双引号安全转义：\ → \\、" → \"；结尾哨兵 X 由调用方剥掉，防止命令替换吞掉结尾换行。
escape_quoted_apply() {
    printf '%sX' "$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# 内置预设源校验：按 <name>/ 前缀过滤 manifest 行并逐文件核对规范化 hash。
verify_preset_sources() {
    vp_name=$1
    if [ ! -f "$preset_manifest" ]; then
        die "Missing preset manifest: $preset_manifest"
    fi
    vp_matched=$render_dir/manifest.matched
    if ! LC_ALL=C awk -v manifest_path="$preset_manifest" -v prefix="$vp_name/" '
        $0 !~ /^[0-9a-f]{64}  [^[:space:]]+$/ { print "Invalid preset manifest: " manifest_path > "/dev/stderr"; exit 1 }
        {
            total++
            rel = substr($0, 67)
            if (index(rel, prefix) == 1) print $0
        }
        END { if (total == 0) { print "Empty preset manifest: " manifest_path > "/dev/stderr"; exit 1 } }
    ' "$preset_manifest" > "$vp_matched"; then
        die "Invalid preset manifest: $preset_manifest"
    fi
    vp_count=$(awk 'END { print NR }' "$vp_matched")
    if [ "$vp_count" -eq 0 ]; then
        die "Preset not covered by manifest: $vp_name"
    fi
    while IFS= read -r vp_line || [ -n "$vp_line" ]; do
        [ -n "$vp_line" ] || continue
        vp_expected_hash=${vp_line%%  *}
        vp_rel=${vp_line#*  }
        vp_path=$presets_root/$vp_rel
        [ -f "$vp_path" ] || die "Managed preset source missing: $vp_path"
        vp_actual=$(normalized_lf_sha256 "$vp_path")
        [ "$vp_expected_hash" = "$vp_actual" ] || die "Preset source hash mismatch: $vp_rel"
    done < "$vp_matched"
}

# 渲染当前宿主小节为角色文件：校验 + 互引解析 + md/toml 产物 + SKILL 角色清单 + 被忽略字段清单。
render_preset() {
    rd_files=$render_dir/files
    mkdir -p -- "$rd_files"
    : > "$render_dir/names.txt"
    : > "$render_dir/names.tsv"
    : > "$render_dir/ignored.txt"
    : > "$render_dir/route.txt"
    : > "$render_dir/ids.seen"
    : > "$render_dir/names.seen"
    : > "$render_dir/section-roles.txt"

    if [ "$(pget "P_HOST_${host_section}_SET")" != 1 ]; then
        die "Preset has no [$host_section] section"
    fi
    ri=1
    while [ "$ri" -le "$P_ROLES" ]; do
        if [ "$(pget "P_R${ri}_HOST")" = "$host_section" ]; then
            printf '%s\n' "$ri" >> "$render_dir/section-roles.txt"
        fi
        ri=$((ri+1))
    done
    section_role_count=$(awk 'END { print NR }' "$render_dir/section-roles.txt")
    if [ "$section_role_count" -eq 0 ]; then
        die "Preset [$host_section] section declares no roles"
    fi

    while IFS= read -r vridx || [ -n "$vridx" ]; do
        [ -n "$vridx" ] || continue
        for vreq in id name description; do
            if [ "$(pget "P_R${vridx}_SET_${vreq}")" != 1 ]; then
                die "Preset role in [$host_section] missing $vreq"
            fi
        done
        vrid=$(pget "P_R${vridx}_id")
        vrname=$(pget "P_R${vridx}_name")
        if ! printf '%s' "$vrid" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$'; then
            die "Invalid preset role id: $vrid"
        fi
        if ! printf '%s' "$vrname" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
            die "Invalid preset role name: $vrname"
        fi
        if LC_ALL=C grep -Fqx -- "$vrid" "$render_dir/ids.seen"; then
            die "Duplicate role id in [$host_section]: $vrid"
        fi
        if LC_ALL=C grep -Fqx -- "$vrname" "$render_dir/names.seen"; then
            die "Duplicate role name in [$host_section]: $vrname"
        fi
        printf '%s\n' "$vrid" >> "$render_dir/ids.seen"
        printf '%s\n' "$vrname" >> "$render_dir/names.seen"
        printf '%s\t%s\n' "$vrid" "$vrname" >> "$render_dir/names.tsv"
    done < "$render_dir/section-roles.txt"

    while IFS= read -r rridx || [ -n "$rridx" ]; do
        [ -n "$rridx" ] || continue
        r_id=$(pget "P_R${rridx}_id")
        r_name=$(pget "P_R${rridx}_name")
        r_desc=$(pget "P_R${rridx}_description")
        if [ "$(pget "P_R${rridx}_SET_readonly")" = 1 ]; then
            if [ "$(pget "P_R${rridx}_BOOL_readonly")" != 1 ]; then
                die "Role [$host_section]/${r_id}: readonly must be true or false"
            fi
            r_readonly=$(pget "P_R${rridx}_readonly")
        else
            r_readonly=true
        fi
        r_model=
        if [ "$(pget "P_R${rridx}_SET_model")" = 1 ]; then
            r_model=$(pget "P_R${rridx}_model")
        elif [ "$(pget "P_HOST_${host_section}_MODEL_SET")" = 1 ]; then
            r_model=$(pget "P_HOST_${host_section}_MODEL")
        fi
        if [ -z "$(trim_ws "$r_model")" ]; then
            die "Role [$host_section]/$r_id has no model (neither role model nor [$host_section] model)"
        fi
        if [ "$role_kind" = md ]; then
            r_effort_key=thoughtLevel
            r_foreign_key=model_reasoning_effort
        else
            r_effort_key=model_reasoning_effort
            r_foreign_key=thoughtLevel
        fi
        if [ "$(pget "P_R${rridx}_SET_${r_effort_key}")" = 1 ]; then
            if [ "$(pget "P_R${rridx}_SET_effort")" = 1 ]; then
                die "Role [$host_section]/$r_id must not set both effort and $r_effort_key"
            fi
            r_effort=$(pget "P_R${rridx}_${r_effort_key}")
        elif [ "$(pget "P_R${rridx}_SET_effort")" = 1 ]; then
            r_effort_value=$(pget "P_R${rridx}_effort")
            case "$r_effort_value" in
                basic) r_effort=low ;;
                deep) r_effort=high ;;
                max) r_effort=max ;;
                *) die "Role [$host_section]/${r_id}: unsupported effort $r_effort_value" ;;
            esac
        elif [ "$(pget "P_R${rridx}_SET_${r_foreign_key}")" = 1 ]; then
            die "Role [$host_section]/$r_id sets only $r_foreign_key which is not consumed by this host; set effort or $r_effort_key"
        else
            die "Role [$host_section]/$r_id has neither effort nor $r_effort_key"
        fi
        if [ "$(pget "P_R${rridx}_SET_${r_foreign_key}")" = 1 ]; then
            printf '%s\n' "[$host_section]/${r_id}: $r_foreign_key is not consumed by this host" >> "$render_dir/ignored.txt"
        fi
        if [ "$(pget "P_R${rridx}_SET_body")" = 1 ]; then
            r_body_rel=$(pget "P_R${rridx}_body")
        else
            r_body_rel="$r_id.md"
        fi
        r_body_file=$preset_dir/roles/$r_body_rel
        if [ ! -f "$r_body_file" ]; then
            die "Role body file missing: $r_body_file"
        fi
        if ! LC_ALL=C awk -v sec="$host_section" -v rid="$r_id" -v names_tsv="$render_dir/names.tsv" '
            BEGIN {
                while ((getline tsvline < names_tsv) > 0) {
                    tsvpos = index(tsvline, "\t")
                    if (tsvpos > 0) refname[substr(tsvline, 1, tsvpos - 1)] = substr(tsvline, tsvpos + 1)
                }
            }
            {
                line = $0
                sub(/\r$/, "", line)
                out = ""
                while (match(line, /\{\{role:[A-Za-z0-9_-]+\}\}/)) {
                    ref = substr(line, RSTART + 7, RLENGTH - 9)
                    if (!(ref in refname)) {
                        printf "Role [%s]/%s references unknown role id: %s\n", sec, rid, ref > "/dev/stderr"
                        exit 1
                    }
                    out = out substr(line, 1, RSTART - 1) refname[ref]
                    line = substr(line, RSTART + RLENGTH)
                }
                print out line
            }
        ' "$r_body_file" > "$render_dir/body.pre.$rridx"; then
            die "Role [$host_section]/$r_id body references could not be resolved: $r_body_file"
        fi
        # 等价 TrimEnd：去掉文末全部空白（含最后一行的行尾空白与结尾空行）。
        LC_ALL=C awk '
            { sub(/\r$/, ""); lines[NR] = $0 }
            END {
                last = NR
                while (last >= 1 && lines[last] ~ /^[[:space:]]*$/) last--
                for (i = 1; i < last; i++) print lines[i]
                if (last >= 1) { l = lines[last]; sub(/[[:space:]]+$/, "", l); printf "%s", l }
            }
        ' "$render_dir/body.pre.$rridx" > "$render_dir/body.$rridx"

        if [ "$role_kind" = md ]; then
            if [ "$(pget "P_R${rridx}_SET_sandbox_mode")" = 1 ]; then
                printf '%s\n' "[$host_section]/${r_id}: sandbox_mode is not consumed by ZCode" >> "$render_dir/ignored.txt"
            fi
            if [ "$(pget "P_R${rridx}_SET_model_reasoning_effort")" = 1 ]; then
                printf '%s\n' "[$host_section]/${r_id}: model_reasoning_effort is not consumed by ZCode" >> "$render_dir/ignored.txt"
            fi
            if [ "$(pget "P_R${rridx}_SET_color")" = 1 ]; then
                r_color=$(pget "P_R${rridx}_color")
            elif [ "$r_readonly" != true ]; then
                r_color=green
            elif [ "$r_effort" = max ]; then
                r_color=orange
            else
                r_color=cyan
            fi
            r_desc_q=$(escape_quoted_apply "$r_desc"); r_desc_q=${r_desc_q%X}
            r_model_q=$(escape_quoted_apply "$r_model"); r_model_q=${r_model_q%X}
            {
                printf '%s\n' '---'
                printf 'name: %s\n' "$r_name"
                printf 'description: "%s"\n' "$r_desc_q"
                printf 'model: "%s"\n' "$r_model_q"
                printf 'thoughtLevel: %s\n' "$r_effort"
                printf 'color: %s\n' "$r_color"
                if [ "$r_readonly" = true ]; then
                    if [ "$(pget "P_R${rridx}_SET_tools")" = 1 ]; then
                        if [ "$(pget "P_R${rridx}_ARR_tools")" != 1 ]; then
                            die "Role [$host_section]/$r_id: tools must be an array"
                        fi
                        r_tools=
                        r_tool_count=$(pget "P_R${rridx}_ARRN_tools")
                        rt_j=1
                        while [ "$rt_j" -le "$r_tool_count" ]; do
                            rt_elem=$(pget "P_R${rridx}_ELEM_tools_${rt_j}")
                            if [ -z "$r_tools" ]; then r_tools=$rt_elem; else r_tools="$r_tools, $rt_elem"; fi
                            rt_j=$((rt_j+1))
                        done
                    else
                        r_tools='Read, Bash, WebFetch, WebSearch, TodoWrite'
                    fi
                    printf 'tools: [%s]\n' "$r_tools"
                else
                    if [ "$(pget "P_R${rridx}_SET_tools")" = 1 ]; then
                        die "Role [$host_section]/$r_id must not set tools for a writable role"
                    fi
                fi
                printf '%s\n' '---'
                printf '%s\n' ''
                cat "$render_dir/body.$rridx"
                printf '\n'
            } > "$rd_files/$r_name.md"
            printf '%s\n' "$r_name.md" >> "$render_dir/names.txt"
        else
            if [ "$(pget "P_R${rridx}_SET_tools")" = 1 ]; then
                printf '%s\n' "[$host_section]/${r_id}: tools is not consumed by Codex" >> "$render_dir/ignored.txt"
            fi
            if [ "$(pget "P_R${rridx}_SET_color")" = 1 ]; then
                printf '%s\n' "[$host_section]/${r_id}: color is not consumed by Codex" >> "$render_dir/ignored.txt"
            fi
            if [ "$(pget "P_R${rridx}_SET_sandbox_mode")" = 1 ]; then
                r_sandbox=$(pget "P_R${rridx}_sandbox_mode")
            elif [ "$r_readonly" = true ]; then
                r_sandbox='read-only'
            else
                r_sandbox='danger-full-access'
            fi
            r_name_q=$(escape_quoted_apply "$r_name"); r_name_q=${r_name_q%X}
            r_desc_q=$(escape_quoted_apply "$r_desc"); r_desc_q=${r_desc_q%X}
            r_model_q=$(escape_quoted_apply "$r_model"); r_model_q=${r_model_q%X}
            r_effort_q=$(escape_quoted_apply "$r_effort"); r_effort_q=${r_effort_q%X}
            r_sandbox_q=$(escape_quoted_apply "$r_sandbox"); r_sandbox_q=${r_sandbox_q%X}
            LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"""/\\"\\"\\"/g' "$render_dir/body.$rridx" > "$render_dir/body.toml.$rridx"
            {
                printf 'name = "%s"\n' "$r_name_q"
                printf 'description = "%s"\n' "$r_desc_q"
                printf 'developer_instructions = """\n'
                cat "$render_dir/body.toml.$rridx"
                printf '\n"""\n'
                printf 'model = "%s"\n' "$r_model_q"
                printf 'model_reasoning_effort = "%s"\n' "$r_effort_q"
                printf 'sandbox_mode = "%s"\n' "$r_sandbox_q"
            } > "$rd_files/$r_name.toml"
            printf '%s\n' "$r_name.toml" >> "$render_dir/names.txt"
        fi

        if [ "$(pget "P_R${rridx}_SET_skill_desc")" = 1 ]; then
            r_route_desc=$(pget "P_R${rridx}_skill_desc")
        else
            r_route_desc=$r_desc
        fi
        printf -- '- `%s`：%s\n' "$r_name" "$r_route_desc" >> "$render_dir/route.txt"
    done < "$render_dir/section-roles.txt"

    ROLE_COUNT_OUT=$section_role_count
}

# ---- md 产物结构校验（对应 Assert-AgentFile / Assert-AgentStructure / Assert-AgentFiles）----

assert_agent_file() {
    af_path=$1
    af_name=${af_path##*/}
    af_stem=${af_name%.md}
    awk -v stem="$af_stem" -v fname="$af_name" '
        { sub(/\r$/, "") }
        NR == 1 { if ($0 != "---") { err = 1; exit 1 } in_fm = 1; next }
        in_fm && $0 == "---" { terminated = 1; exit 0 }
        in_fm && /^(name|description|model|thoughtLevel)[[:space:]]*:/ {
            key = $0
            sub(/[[:space:]]*:.*$/, "", key)
            seen[key]++
            if (key == "name") {
                value = $0
                sub(/^[^:]*:[[:space:]]*/, "", value)
                gsub(/^"|"$/, "", value)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
                fm_name = value
            }
        }
        END {
            if (err) { printf "Agent frontmatter missing: %s\n", fname > "/dev/stderr"; exit 1 }
            if (!terminated) { printf "Agent frontmatter unterminated: %s\n", fname > "/dev/stderr"; exit 1 }
            bad = 0
            split("name description model thoughtLevel", required, " ")
            for (i = 1; i <= 4; i++) {
                if (seen[required[i]] != 1) { printf "Agent field missing or repeated: %s/%s\n", fname, required[i] > "/dev/stderr"; bad = 1 }
            }
            if (fm_name != stem) { printf "Agent name mismatch: %s/%s\n", fname, fm_name > "/dev/stderr"; bad = 1 }
            exit bad ? 1 : 0
        }
    ' "$af_path"
}

assert_agent_structure() {
    as_dir=$1
    as_expected=$2
    as_count=0
    for as_file in "$as_dir"/*.md; do
        if [ -f "$as_file" ]; then as_count=$((as_count+1)); fi
    done
    if [ "$as_count" -ne "$as_expected" ]; then
        die "Expected $as_expected managed agent files, found $as_count: $as_dir"
    fi
    for as_file in "$as_dir"/*.md; do
        if [ -f "$as_file" ]; then
            assert_agent_file "$as_file" || die "Invalid agent profile: ${as_file##*/}"
        fi
    done
}

assert_toml_structure() {
    ts_dir=$1
    ts_expected=$2
    ts_count=0
    for ts_file in "$ts_dir"/*.toml; do
        if [ -f "$ts_file" ]; then ts_count=$((ts_count+1)); fi
    done
    if [ "$ts_count" -ne "$ts_expected" ]; then
        die "Expected $ts_expected managed role files, found $ts_count: $ts_dir"
    fi
    for ts_file in "$ts_dir"/*.toml; do
        if [ ! -f "$ts_file" ]; then continue; fi
        if ! LC_ALL=C awk -v fname="${ts_file##*/}" '
            {
                if ($0 ~ /^(name|model|model_reasoning_effort|sandbox_mode|description|developer_instructions)[[:space:]]*=/) {
                    key = $0
                    sub(/[[:space:]]*=.*$/, "", key)
                    seen[key]++
                }
            }
            END {
                bad = 0
                split("name model model_reasoning_effort sandbox_mode description developer_instructions", required, " ")
                for (i = 1; i <= 6; i++) {
                    if (seen[required[i]] != 1) { printf "Role field missing or repeated: %s/%s\n", fname, required[i] > "/dev/stderr"; bad = 1 }
                }
                exit bad ? 1 : 0
            }
        ' "$ts_file"; then
            die "Invalid role structure: ${ts_file##*/}"
        fi
    done
}

# legacy 子目录探测：结构校验通过且文件名单与渲染产物一致时返回 0，允许在 if 条件上下文安全失败。
legacy_dir_matches_render() {
    lr_dir=$1
    lr_count=0
    for lr_file in "$lr_dir"/*.md; do
        if [ -f "$lr_file" ]; then lr_count=$((lr_count+1)); fi
    done
    if [ "$lr_count" -ne "$role_count" ]; then return 1; fi
    for lr_file in "$lr_dir"/*.md; do
        if [ -f "$lr_file" ]; then
            assert_agent_file "$lr_file" || return 1
        fi
    done
    lr_actual=
    for lr_file in "$lr_dir"/*.md; do
        if [ -f "$lr_file" ]; then
            lr_actual="$lr_actual${lr_file##*/}
"
        fi
    done
    lr_actual=$(printf '%s' "$lr_actual" | LC_ALL=C sort)
    lr_expected=$(LC_ALL=C sort "$render_dir/names.txt")
    [ "$lr_actual" = "$lr_expected" ] || return 1
    return 0
}

# ---- 预设选择：位置参数优先；未指定且为非交互 stdin 时报错；否则进入菜单 ----

preset_input=${2:-}
if [ -z "$preset_input" ]; then
    if [ ! -t 0 ]; then
        die "No preset specified. Usage: sh install.sh $client <$default_preset|name|path>"
    fi
    set --
    for preset_entry_path in "$presets_root"/*/; do
        if [ -d "$preset_entry_path" ] && [ -f "${preset_entry_path}preset.toml" ]; then
            set -- "$@" "$preset_entry_path"
        fi
    done
    if [ "$#" -eq 0 ]; then
        die "No presets found under: $presets_root"
    fi
    printf '%s\n' 'Select the role preset to install:'
    preset_index=1
    for preset_entry_path in "$@"; do
        preset_entry=$(basename -- "$preset_entry_path")
        preset_mark=
        if [ "$preset_entry" = "$default_preset" ]; then preset_mark=' [default]'; fi
        preset_desc=$(PRESET_QUIET=1; export PRESET_QUIET; read_preset "${preset_entry_path}preset.toml"; printf '%s' "$P_DESC") || preset_desc='<unreadable preset>'
        printf '  %s) %s%s - %s\n' "$preset_index" "$preset_entry" "$preset_mark" "$preset_desc"
        preset_index=$((preset_index+1))
    done
    printf 'Enter number or name (q to quit): '
    read -r preset_choice
    case "$preset_choice" in
        [qQ]) exit 0 ;;
    esac
    case "$preset_choice" in
        ''|*[!0-9]*) preset_input=$preset_choice ;;
        *)
            if [ "$preset_choice" -ge 1 ] && [ "$preset_choice" -le "$#" ]; then
                eval "preset_input=\$(basename -- \"\${$preset_choice}\")"
            else
                preset_input=$preset_choice
            fi
            ;;
    esac
fi

# ---- 预设解析、manifest 校验与渲染（先于路径安全检查与 stage 装配）----

preset_display_name=$preset_input
if [ -d "$preset_input" ]; then
    preset_dir=$(CDPATH= cd -- "$preset_input" && pwd -P) || die "Could not resolve preset directory: $preset_input"
else
    preset_dir=$presets_root/$preset_input
fi
preset_file=$preset_dir/preset.toml
if [ ! -f "$preset_file" ]; then
    die "Preset not found: $preset_input (expected $preset_file)"
fi
case "$preset_dir" in
    "$presets_root"|"$presets_root"/*) is_managed_preset=1 ;;
    *) is_managed_preset=0 ;;
esac
render_dir=$(mktemp -d "${TMPDIR:-/tmp}/install-preset-render.XXXXXX") || die 'Could not create preset render directory.'
trap 'rm -rf -- "$render_dir"' EXIT HUP INT TERM
if [ "$is_managed_preset" = 1 ]; then
    verify_preset_sources "$(basename -- "$preset_dir")"
fi
read_preset "$preset_file"
if [ "$(pget "P_HOST_${host_section}_SET")" != 1 ]; then
    die "Preset '$preset_display_name' has no [$host_section] section and cannot be installed for $client_label"
fi
render_preset
role_count=$ROLE_COUNT_OUT

required_sources="$presets_root $source_docs $source_system_docs $source_instructions $shared_skills $client_skills"
[ "$has_config" -eq 1 ] && required_sources="$required_sources $source_config $source_model_provider_settings"
for source_path in $required_sources; do
    [ -e "$source_path" ] || die "Missing source: $source_path"
done
for skill_spec in $skill_specs; do
    skill_dir=$(skill_source_dir "$skill_spec") || die "Unknown skill source: $skill_spec"
    [ -d "$skill_dir" ] || die "Missing skill: ${skill_spec%%:*}"
    [ -f "$skill_dir/SKILL.md" ] || die "Missing SKILL.md for skill: ${skill_spec%%:*}"
done
[ -d "$source_docs/system" ] && die "$source_docs must not contain a system/ directory; shared system docs are composed by the installer."
assert_path_chain "$script_dir" || die "Unsafe installer source path: $script_dir"
for source_path in $required_sources; do
    assert_no_symlink_tree "$source_path" || die "Source tree contains a symlink or unsafe entry: $source_path"
done

: "$HOME"
raw_home=$HOME/$default_home
if printenv "$home_env" >/dev/null 2>&1; then raw_home=$(printenv "$home_env"); fi
case "$raw_home" in
    ''|.) die "Refusing unsafe $client_label home: $raw_home" ;;
    /*) ;;
    *) raw_home=$(CDPATH= cd -- . && printf '%s/%s' "$PWD" "$raw_home") ;;
esac
assert_path_chain "$raw_home" || die "Unsafe $client_label home path: $raw_home"
client_home=$(normalize_absolute_path "$raw_home") || die "Could not normalize $client_label home: $raw_home"
case "$client_home" in /|.) die "Refusing unsafe $client_label home: $client_home" ;; esac
assert_path_chain "$client_home" || die "Unsafe $client_label home path: $client_home"
mkdir -p "$(dirname -- "$client_home")"
assert_path_chain "$client_home" || die "Unsafe $client_label home path: $client_home"
home_parent=$(CDPATH= cd -- "$(dirname -- "$client_home")" && pwd -P) || die "Could not resolve $client_label home parent: $client_home"
client_home=$home_parent/$(basename -- "$client_home")
mkdir -p "$client_home"
assert_path_chain "$client_home" || die "Unsafe $client_label home path: $client_home"

assert_safe_toml_merge_input() {
    config_path=$1
    if ! awk '
        function trim(value) { sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value); return value }
        function fail(message) { printf "%s:%d: unsupported TOML syntax for safe merge: %s\n", FILENAME, FNR, message > "/dev/stderr"; invalid = 1 }
        function closed(value, position, character, basic, literal, array_depth, inline_depth) {
            basic = 0; literal = 0; array_depth = 0; inline_depth = 0
            for (position = 1; position <= length(value); position++) {
                character = substr(value, position, 1)
                if (basic) { if (character == "\\") position++; else if (character == "\"") basic = 0; continue }
                if (literal) { if (character == "\047") literal = 0; continue }
                if (character == "\"") basic = 1
                else if (character == "\047") literal = 1
                else if (character == "[") array_depth++
                else if (character == "]") array_depth--
                else if (character == "{") inline_depth++
                else if (character == "}") inline_depth--
                if (array_depth < 0 || inline_depth < 0) return 0
            }
            return !basic && !literal && array_depth == 0 && inline_depth == 0
        }
        function hex_digit(character, position) {
            position = index("0123456789abcdef", tolower(character))
            return position ? position - 1 : -1
        }
        function safe_quoted_key(key, quote, position, character, digits, count, codepoint, decoded, digit_value) {
            quoted_key_value = ""
            if (length(key) < 2) return 0
            quote = substr(key, 1, 1)
            if (quote != "\"" && quote != "\047") return 0
            if (substr(key, length(key), 1) != quote) return 0
            decoded = ""
            for (position = 2; position < length(key); position++) {
                character = substr(key, position, 1)
                if (character ~ /[[:cntrl:]]/) return 0
                if (quote == "\047") {
                    if (character == "\047") return 0
                    decoded = decoded character
                    continue
                }
                if (character == "\"") return 0
                if (character != "\\") { decoded = decoded character; continue }
                position++
                if (position >= length(key)) return 0
                character = substr(key, position, 1)
                if (character == "u" || character == "U") {
                    count = (character == "u") ? 4 : 8
                    if (position + count >= length(key)) return 0
                    codepoint = 0
                    for (digits = 1; digits <= count; digits++) {
                        digit_value = hex_digit(substr(key, position + digits, 1))
                        if (digit_value < 0) return 0
                        codepoint = codepoint * 16 + digit_value
                    }
                    if (codepoint > 1114111 || (codepoint >= 55296 && codepoint <= 57343)) return 0
                    if (codepoint >= 32 && codepoint <= 126) decoded = decoded sprintf("%c", codepoint)
                    else decoded = decoded "\001"
                    position += count
                } else if (character == "\"" || character == "\\") decoded = decoded character
                else if (character == "b" || character == "t" || character == "n" || character == "f" || character == "r") decoded = decoded "\001"
                else return 0
            }
            quoted_key_value = decoded
            return 1
        }
        function safe_key(key) {
            key_identity = key
            if (key ~ /^[A-Za-z][A-Za-z0-9_-]*$/) return 1
            if (!safe_quoted_key(key)) return 0
            key_identity = quoted_key_value
            return 1
        }
        function assignment_separator(line, position, character, basic, literal) {
            basic = 0; literal = 0
            for (position = 1; position <= length(line); position++) {
                character = substr(line, position, 1)
                if (basic) { if (character == "\\") position++; else if (character == "\"") basic = 0; continue }
                if (literal) { if (character == "\047") literal = 0; continue }
                if (character == "\"") basic = 1
                else if (character == "\047") literal = 1
                else if (character == "=") return position
            }
            return 0
        }
        function table_header(line, opening, position, character, basic, literal, suffix) {
            basic = 0; literal = 0
            for (position = opening + 1; position <= length(line); position++) {
                character = substr(line, position, 1)
                if (basic) { if (character == "\\") position++; else if (character == "\"") basic = 0; continue }
                if (literal) { if (character == "\047") literal = 0; continue }
                if (character == "\"") { basic = 1; continue }
                if (character == "\047") { literal = 1; continue }
                if (character == "[") return 0
                if (character == "]") {
                    if (opening == 2 && substr(line, position + 1, 1) != "]") return 0
                    suffix = substr(line, position + opening)
                    if (suffix !~ /^[[:space:]]*(#.*)?$/) return 0
                    header = trim(substr(line, opening + 1, position - opening - 1))
                    return header != ""
                }
            }
            return 0
        }
        BEGIN { section = "root" }
        {
            line = trim($0)
            if (line == "" || line ~ /^#/) next
            if (line ~ /"""/ || line ~ /\047\047\047/) { fail("multiline strings are not supported"); next }
            if (line ~ /^\[\[/) { if (!table_header(line, 2)) fail("ambiguous array table header"); section = "other"; next }
            if (line ~ /^\[/) { if (!table_header(line, 1)) { fail("ambiguous table header"); next }; section = header; next }
            separator = assignment_separator(line)
            if (separator == 0) { fail("unrecognized line"); next }
            key = trim(substr(line, 1, separator - 1)); value = substr(line, separator + 1)
            if (!closed(value)) { fail("cross-line or unclosed value"); next }
            if (!safe_key(key)) { fail("unsupported key syntax"); next }
            managed = (section == "root" && (key_identity == "model" || key_identity == "model_reasoning_effort" || key_identity == "sandbox_mode" || key_identity == "approval_policy" || key_identity == "approvals_reviewer")) || (section == "agents" && (key_identity == "max_threads" || key_identity == "max_depth")) || (section == "features" && key_identity == "goals")
            if (managed && key != key_identity) { fail("quoted key aliases a managed key"); next }
            if (managed && seen[section "/" key_identity]++) fail("repeated managed key")
        }
        END { exit invalid ? 1 : 0 }
    ' "$config_path"; then
        die "Refusing unsafe TOML merge input: $config_path"
    fi
}

merge_managed_config() {
    config_input=$1
    config_output=$2
    awk '
        BEGIN {
            current = "root"
            source_section = "root"
            provider_order[1] = "request_max_retries"; provider_order[2] = "stream_max_retries"
            provider_order[3] = "stream_idle_timeout_ms"; provider_order[4] = "websocket_connect_timeout_ms"
        }
        function managed(section, key) {
            return (section == "root" && (key == "model" || key == "model_reasoning_effort" || key == "sandbox_mode" || key == "approval_policy" || key == "approvals_reviewer")) || (section == "agents" && (key == "max_threads" || key == "max_depth")) || (section == "features" && key == "goals")
        }
        function table_name(line, position, character, basic, literal) {
            sub(/^[[:space:]]*\[/, "", line)
            basic = 0; literal = 0
            for (position = 1; position <= length(line); position++) {
                character = substr(line, position, 1)
                if (basic) { if (character == "\\") position++; else if (character == "\"") basic = 0; continue }
                if (literal) { if (character == "\047") literal = 0; continue }
                if (character == "\"") basic = 1
                else if (character == "\047") literal = 1
                else if (character == "]") { line = substr(line, 1, position - 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", line); return line }
            }
            return ""
        }
        function flush_managed(section, key, position, count) {
            if (section == "root") { order[1]="model"; order[2]="model_reasoning_effort"; order[3]="sandbox_mode"; order[4]="approval_policy"; order[5]="approvals_reviewer"; count=5 }
            else if (section == "agents") { order[1]="max_threads"; order[2]="max_depth"; count=2 }
            else if (section == "features") { order[1]="goals"; count=1 }
            else return
            for (position=1; position<=count; position++) { key=order[position]; if (!seen[section SUBSEP key]) { print key " = " value[section SUBSEP key]; seen[section SUBSEP key]=1 } }
        }
        function is_provider_section(section) { return section ~ /^model_providers\.("[^"]+"|\047[^\047]+\047|[A-Za-z0-9_-]+)$/ }
        function flush_provider(key, position) {
            if (!in_provider) return
            for (position=1; position<=4; position++) { key=provider_order[position]; if (!provider_seen[key]) { print key " = " provider_value[key]; provider_seen[key]=1 } }
        }
        FILENAME == ARGV[1] {
            if ($0 ~ /^[[:space:]]*\[\[/) { source_section="other"; next }
            if ($0 ~ /^[[:space:]]*\[/) { header=table_name($0); source_section=(header=="agents" || header=="features") ? header : "other"; next }
            if (index($0,"=")>0) { key=substr($0,1,index($0,"=")-1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",key); if (managed(source_section,key)) { value[source_section SUBSEP key]=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",value[source_section SUBSEP key]) } }
            next
        }
        FILENAME == ARGV[2] {
            if ($0 ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_-]*[[:space:]]*=/) { key=$0; sub(/^[[:space:]]*/,"",key); sub(/[[:space:]]*=.*/,"",key); provider_value[key]=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",provider_value[key]) }
            next
        }
        {
            if ($0 ~ /^[[:space:]]*\[\[/) { flush_managed(current); flush_provider(); current="other"; in_provider=0; for (provider_key in provider_seen) delete provider_seen[provider_key]; print; next }
            if ($0 ~ /^[[:space:]]*\[/) {
                flush_managed(current); flush_provider()
                header=table_name($0)
                current=(header=="agents" || header=="features") ? header : "other"; in_provider=is_provider_section(header); if (in_provider) provider_found=1; for (provider_key in provider_seen) delete provider_seen[provider_key]; if (current=="agents" || current=="features") present[current]=1; print; next
            }
            if (in_provider && $0 ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_-]*[[:space:]]*=/) { key=$0; sub(/^[[:space:]]*/,"",key); sub(/[[:space:]]*=.*/,"",key); if (key in provider_value && !provider_seen[key]) { print key " = " provider_value[key]; provider_seen[key]=1; next } }
            if (index($0,"=")>0) { key=substr($0,1,index($0,"=")-1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",key); if (managed(current,key) && !seen[current SUBSEP key]) { print key " = " value[current SUBSEP key]; seen[current SUBSEP key]=1; next } }
            print
        }
        END {
            required["root" SUBSEP "model"]=1; required["root" SUBSEP "model_reasoning_effort"]=1; required["root" SUBSEP "sandbox_mode"]=1; required["root" SUBSEP "approval_policy"]=1; required["root" SUBSEP "approvals_reviewer"]=1; required["agents" SUBSEP "max_threads"]=1; required["agents" SUBSEP "max_depth"]=1; required["features" SUBSEP "goals"]=1
            for (setting in required) if (!(setting in value)) { print "Missing managed config setting: " setting > "/dev/stderr"; exit 1 }
            for (position=1; position<=4; position++) if (!(provider_order[position] in provider_value)) { print "Missing managed model provider setting: " provider_order[position] > "/dev/stderr"; exit 1 }
            if (!provider_found) print "No [model_providers.<provider-id>] table found in " ARGV[3] "; skipped managed model provider settings." > "/dev/stderr"
            flush_managed(current); flush_provider()
            if (!present["agents"]) { print ""; print "[agents]"; flush_managed("agents") }
            if (!present["features"]) { print ""; print "[features]"; flush_managed("features") }
        }
    ' "$source_config" "$source_model_provider_settings" "$config_input" > "$config_output" || die "Could not merge Codex TOML configuration."
}

for target_spec in \
    "$client_home/AGENTS.md file" \
    "$client_home/docs directory"; do
    target_path=${target_spec% *}
    target_kind=${target_spec##* }
    assert_target "$target_path" "$target_kind" || die "Unsafe install target: $target_path"
done
if [ "$role_kind" = toml ]; then
    assert_target "$client_home/agents/ai-vibecode-superpower" directory || die "Unsafe install target: $client_home/agents/ai-vibecode-superpower"
else
    while IFS= read -r agent_name || [ -n "$agent_name" ]; do
        [ -n "$agent_name" ] || continue
        assert_target "$client_home/agents/$agent_name" file || die "Unsafe install target: $client_home/agents/$agent_name"
    done < "$render_dir/names.txt"
fi
legacy_agents_dir=$client_home/agents/ai-vibecode-superpower
legacy_agents_managed=0
if [ "$role_kind" = md ] && [ -d "$legacy_agents_dir" ]; then
    if legacy_dir_matches_render "$legacy_agents_dir"; then
        assert_target "$legacy_agents_dir" directory || die "Unsafe install target: $legacy_agents_dir"
        legacy_agents_managed=1
    else
        printf '%s\n' "Warning: legacy managed agent directory does not match the preset; left untouched: $legacy_agents_dir" >&2
    fi
fi
managed_list=$client_home/agents/.ai-vibecode-superpower.managed
stale_list=$render_dir/stale.txt
: > "$stale_list"
if [ "$role_kind" = md ] && [ -f "$managed_list" ]; then
    while IFS= read -r managed_name || [ -n "$managed_name" ]; do
        managed_name=$(trim_ws "$managed_name")
        [ -n "$managed_name" ] || continue
        printf '%s\n' "$managed_name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*\.md$' || continue
        path_exists "$client_home/agents/$managed_name" || continue
        LC_ALL=C grep -Fqx -- "$managed_name" "$render_dir/names.txt" && continue
        printf '%s\n' "$managed_name" >> "$stale_list"
    done < "$managed_list"
fi
if [ "$role_kind" = md ]; then
    while IFS= read -r stale_name || [ -n "$stale_name" ]; do
        [ -n "$stale_name" ] || continue
        assert_target "$client_home/agents/$stale_name" file || die "Unsafe install target: $client_home/agents/$stale_name"
    done < "$stale_list"
fi
if [ "$has_config" -eq 1 ]; then
    assert_target "$client_home/config.toml" file || die "Unsafe install target: $client_home/config.toml"
fi
for skill_spec in $skill_specs; do
    assert_target "$client_home/skills/${skill_spec%%:*}" directory || die "Unsafe install target: $client_home/skills/${skill_spec%%:*}"
done
for container_path in "$client_home/agents" "$client_home/skills" "$client_home/backups"; do
    assert_directory_container "$container_path" || die "Unsafe managed container: $container_path"
done

has_state() {
    state_name=$1
    target_name=$2
    [ -f "$stage_dir/state/$state_name/$target_name" ]
}

mark_state() {
    state_name=$1
    target_name=$2
    marker=$stage_dir/state/$state_name/$target_name
    mkdir -p -- "$(dirname -- "$marker")"
    : > "$marker"
}

assert_directory_container "$client_home" || die 'Unsafe client home container.'
stage_dir=$(mktemp -d "$client_home/.install-stage.XXXXXX") || die 'Could not create staging directory.'
assert_directory_container "$stage_dir" || die 'Unsafe staging directory.'
backup_dir=
manifest=
completed=0
rollback() {
    rollback_failed=0
    [ -n "$manifest" ] && [ -f "$manifest" ] || return 0
    while IFS="$(printf '\t')" read -r target_name target_path candidate_path target_kind target_operation; do
        if [ -f "$stage_dir/state/install-started/$target_name" ] && path_exists "$target_path"; then
            if [ -L "$target_path" ] || ! rm -rf -- "$target_path"; then
                printf '%s\n' "Rollback failed removing $target_path" >&2
                rollback_failed=1
            fi
        fi
    done < "$manifest"
    while IFS="$(printf '\t')" read -r target_name target_path candidate_path target_kind target_operation; do
        backup_path=$backup_dir/$target_name
        if [ -f "$stage_dir/state/backed-up/$target_name" ] && path_exists "$backup_path"; then
            if ! assert_path_chain "$target_path"; then
                printf '%s\n' "Rollback refused unsafe destination: $target_path" >&2
                rollback_failed=1
            elif path_exists "$target_path"; then
                printf '%s\n' "Rollback could not restore because destination exists: $target_path" >&2
                rollback_failed=1
            elif ! mkdir -p -- "$(dirname -- "$target_path")" || ! mv -- "$backup_path" "$target_path"; then
                printf '%s\n' "Rollback failed restoring $target_path" >&2
                rollback_failed=1
            fi
        fi
    done < "$manifest"
    if [ "$rollback_failed" -ne 0 ]; then
        printf '%s\n' "Rollback was incomplete; backup retained at $backup_dir" >&2
    fi
}

cleanup() {
    status=$?
    if [ "$completed" -ne 1 ]; then
        set +e
        rollback
    fi
    if [ -n "$stage_dir" ] && [ -d "$stage_dir" ]; then rm -rf -- "$stage_dir"; fi
    if [ -n "$render_dir" ] && [ -d "$render_dir" ]; then rm -rf -- "$render_dir"; fi
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p -- "$stage_dir/state/backed-up" "$stage_dir/state/install-started" "$stage_dir/agents" "$stage_dir/skills"
cp "$source_instructions" "$stage_dir/AGENTS.md"
cp -R "$source_docs" "$stage_dir/docs"
cp -R "$source_system_docs" "$stage_dir/docs/system"
if [ "$role_kind" = md ]; then
    while IFS= read -r rendered_name || [ -n "$rendered_name" ]; do
        [ -n "$rendered_name" ] || continue
        cp -- "$render_dir/files/$rendered_name" "$stage_dir/agents/$rendered_name"
    done < "$render_dir/names.txt"
    LC_ALL=C sort "$render_dir/names.txt" > "$stage_dir/agents/.ai-vibecode-superpower.managed"
else
    mkdir -p -- "$stage_dir/agents/ai-vibecode-superpower"
    while IFS= read -r rendered_name || [ -n "$rendered_name" ]; do
        [ -n "$rendered_name" ] || continue
        cp -- "$render_dir/files/$rendered_name" "$stage_dir/agents/ai-vibecode-superpower/$rendered_name"
    done < "$render_dir/names.txt"
fi
for skill_spec in $skill_specs; do cp -R "$(skill_source_dir "$skill_spec")" "$stage_dir/skills/"; done
# SKILL.md 角色清单渲染：骨架保留 <!-- preset-roles --> 占位符，安装时替换为当前宿主小节的角色清单。
skill_doc=$stage_dir/skills/orchestrate-model-workflow/SKILL.md
if [ -f "$skill_doc" ] && LC_ALL=C grep -qF -- '<!-- preset-roles -->' "$skill_doc"; then
    if ! LC_ALL=C awk -v route_file="$render_dir/route.txt" '
        BEGIN {
            route = ""
            first = 1
            while ((getline routeline < route_file) > 0) {
                if (first) { route = routeline; first = 0 } else { route = route "\n" routeline }
            }
            close(route_file)
        }
        {
            line = $0
            while ((marker_pos = index(line, "<!-- preset-roles -->")) > 0) {
                line = substr(line, 1, marker_pos - 1) route substr(line, marker_pos + 21)
            }
            print line
        }
    ' "$skill_doc" > "$skill_doc.rendered"; then
        die 'Could not render the skill role route.'
    fi
    mv -- "$skill_doc.rendered" "$skill_doc"
fi
if [ "$has_config" -eq 1 ]; then
    config_input=$source_config
    if path_exists "$client_home/config.toml"; then cp "$client_home/config.toml" "$stage_dir/existing-config.toml"; config_input=$stage_dir/existing-config.toml; fi
    : > "$stage_dir/merged-config.toml"
    assert_safe_toml_merge_input "$source_config"
    assert_safe_toml_merge_input "$source_model_provider_settings"
    assert_safe_toml_merge_input "$config_input"
    merge_managed_config "$config_input" "$stage_dir/merged-config.toml"
    mv "$stage_dir/merged-config.toml" "$stage_dir/config.toml"
    assert_safe_toml_merge_input "$stage_dir/config.toml"
fi
if [ "$role_kind" = md ]; then
    assert_agent_structure "$stage_dir/agents" "$role_count"
else
    assert_toml_structure "$stage_dir/agents/ai-vibecode-superpower" "$role_count"
fi
escaped_home=$(printf '%s' "$client_home" | sed 's/[\\&|]/\\&/g')
file_list=$stage_dir/files.list
find "$stage_dir" -type f \( -name '*.md' -o -name '*.toml' -o -name '*.txt' \) -print > "$file_list" || die 'Could not enumerate staged text files.'
while IFS= read -r text_file || [ -n "$text_file" ]; do
    [ "$text_file" = "$file_list" ] && continue
    temporary_file=$text_file.tmp
    sed "s|<${placeholder}>|$escaped_home|g; s|\$${placeholder}|$escaped_home|g" "$text_file" > "$temporary_file" || die "Could not expand placeholders in: $text_file"
    mv "$temporary_file" "$text_file"
done < "$file_list"
rm -f "$file_list"

manifest=$stage_dir/targets.tsv
printf 'AGENTS.md\t%s\t%s\tfile\treplace\n' "$client_home/AGENTS.md" "$stage_dir/AGENTS.md" > "$manifest"
[ "$has_config" -eq 1 ] && printf 'config.toml\t%s\t%s\tfile\treplace\n' "$client_home/config.toml" "$stage_dir/config.toml" >> "$manifest"
printf 'docs\t%s\t%s\tdirectory\treplace\n' "$client_home/docs" "$stage_dir/docs" >> "$manifest"
if [ "$role_kind" = md ]; then
    while IFS= read -r agent_name || [ -n "$agent_name" ]; do
        [ -n "$agent_name" ] || continue
        printf 'agents/%s\t%s\t%s\tfile\treplace\n' "$agent_name" "$client_home/agents/$agent_name" "$stage_dir/agents/$agent_name" >> "$manifest"
    done < "$render_dir/names.txt"
    while IFS= read -r stale_name || [ -n "$stale_name" ]; do
        [ -n "$stale_name" ] || continue
        printf 'agents/%s\t%s\t-\tfile\tbackup-remove\n' "$stale_name" "$client_home/agents/$stale_name" >> "$manifest"
    done < "$stale_list"
    printf 'agents/.ai-vibecode-superpower.managed\t%s\t%s\tfile\treplace\n' "$managed_list" "$stage_dir/agents/.ai-vibecode-superpower.managed" >> "$manifest"
    [ "$legacy_agents_managed" -eq 1 ] && printf 'agents/ai-vibecode-superpower\t%s\t-\tdirectory\tbackup-remove\n' "$legacy_agents_dir" >> "$manifest"
else
    printf 'agents/ai-vibecode-superpower\t%s\t%s\tdirectory\treplace\n' "$client_home/agents/ai-vibecode-superpower" "$stage_dir/agents/ai-vibecode-superpower" >> "$manifest"
fi
for skill_spec in $skill_specs; do printf 'skills/%s\t%s\t%s\tdirectory\treplace\n' "${skill_spec%%:*}" "$client_home/skills/${skill_spec%%:*}" "$stage_dir/skills/${skill_spec%%:*}" >> "$manifest"; done
has_existing_target=0
while IFS="$(printf '\t')" read -r target_name target_path candidate_path target_kind target_operation; do
    if path_exists "$target_path"; then has_existing_target=1; break; fi
done < "$manifest"
if [ "$has_existing_target" -eq 1 ]; then
    mkdir -p -- "$client_home/backups"
    assert_directory_container "$client_home/backups" || die 'Unsafe backup container.'
    backup_dir=$(mktemp -d "$client_home/backups/backup-$(date +%Y%m%d-%H%M%S).XXXXXX") || die 'Could not create backup directory.'
fi
while IFS="$(printf '\t')" read -r target_name target_path candidate_path target_kind target_operation; do
    assert_target "$target_path" "$target_kind" || die "Unsafe install target: $target_path"
    if [ "$target_operation" = replace ]; then
        path_exists "$candidate_path" || die "Missing staged candidate: $candidate_path"
        if path_exists "$target_path"; then
            [ -n "$backup_dir" ] || die "Existing target has no backup directory: $target_path"
            backup_path=$backup_dir/$target_name
            mkdir -p -- "$(dirname -- "$backup_path")"
            mv -- "$target_path" "$backup_path"
            mark_state backed-up "$target_name"
        fi
        mark_state install-started "$target_name"
        assert_path_chain "$target_path" || die "Unsafe install destination: $target_path"
        mkdir -p -- "$(dirname -- "$target_path")"
        mv -- "$candidate_path" "$target_path"
    elif [ "$target_operation" = backup-remove ]; then
        if path_exists "$target_path"; then
            [ -n "$backup_dir" ] || die "Existing target has no backup directory: $target_path"
            backup_path=$backup_dir/$target_name
            mkdir -p -- "$(dirname -- "$backup_path")"
            mv -- "$target_path" "$backup_path"
            mark_state backed-up "$target_name"
        fi
    fi
done < "$manifest"
if [ "$role_kind" = md ]; then
    # 平铺目录含用户自建文件：只核对渲染名单内的文件存在且结构合法，不按目录计数。
    while IFS= read -r installed_name || [ -n "$installed_name" ]; do
        [ -n "$installed_name" ] || continue
        if [ ! -f "$client_home/agents/$installed_name" ]; then
            die "Managed agent file missing: $client_home/agents/$installed_name"
        fi
        assert_agent_file "$client_home/agents/$installed_name" || die "Invalid agent profile: $installed_name"
    done < "$render_dir/names.txt"
else
    assert_toml_structure "$client_home/agents/ai-vibecode-superpower" "$role_count"
fi
if [ -s "$render_dir/ignored.txt" ]; then
    while IFS= read -r ignored_note || [ -n "$ignored_note" ]; do
        [ -n "$ignored_note" ] || continue
        printf '%s\n' "Warning: Preset field not consumed: $ignored_note" >&2
    done < "$render_dir/ignored.txt"
fi
completed=1
printf '%s\n' "$client_label configuration installed in: $client_home" "Preset '$preset_display_name' rendered $role_count roles." 'Standalone skills and managed agent roles installed.' "Restart $client_label to load the new configuration and skills."
if [ "$client" = zcode ]; then printf '%s\n' 'Unmanaged ZCode state (cli/, v2/, plugins, other skills and agents) was not modified.'; fi
if [ -n "$backup_dir" ]; then printf '%s\n' "Backup directory: $backup_dir"; fi
