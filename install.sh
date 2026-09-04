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
        expected_roles=12
        placeholder=CODEX_HOME
        source_roles=$script_dir/codex-global-config/agents/ai-vibecode-superpower
        source_manifest=$script_dir/codex-global-config/agents/ai-vibecode-superpower.sha256
        source_instructions=$script_dir/codex-global-config/AGENTS.md
        source_docs=$script_dir/codex-global-config/docs
        source_config=$script_dir/codex-global-config/config.toml
        source_model_provider_settings=$script_dir/codex-global-config/model-provider-settings.toml
        client_skills=$script_dir/codex-global-config/skills
        skill_specs='agent-toolchain:shared gpt-image-2-cli:codex project-doc-planner:shared orchestrate-model-workflow:codex'
        has_config=1
        ;;
    zcode)
        client_label=ZCode
        home_env=ZCODE_HOME
        default_home=.zcode
        role_kind=md
        expected_roles=5
        placeholder=ZCODE_HOME
        source_roles=$script_dir/zcode-global-config/agents/ai-vibecode-superpower
        source_manifest=$script_dir/zcode-global-config/agents/ai-vibecode-superpower.sha256
        source_instructions=$script_dir/zcode-global-config/AGENTS.md
        source_docs=$script_dir/zcode-global-config/docs
        client_skills=$script_dir/zcode-global-config/skills
        skill_specs='agent-toolchain:shared project-doc-planner:shared orchestrate-model-workflow:zcode'
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

required_sources="$source_roles $source_manifest $source_docs $source_system_docs $source_instructions $shared_skills $client_skills"
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

normalized_lf_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        awk '{ sub(/\r$/, ""); print }' "$1" | sha256sum | awk '{print $1}'
    else
        awk '{ sub(/\r$/, ""); print }' "$1" | shasum -a 256 | awk '{print $1}'
    fi
}

manifest_hash() {
    requested_role=$1
    manifest_path=${2:-$source_manifest}
    awk -v requested="$requested_role" '$0 ~ /^[0-9a-f]{64}  [^[:space:]]+$/ && $2 == requested { print $1; found = 1 } END { if (!found) exit 1 }' "$manifest_path"
}

assert_roles_toml() {
    roles_dir=${1:-$source_roles}
    manifest_path=${2:-$source_manifest}
    manifest_count=$(wc -l < "$manifest_path")
    [ "$manifest_count" -eq "$expected_roles" ] || die "Expected $expected_roles managed role hashes"
    for role_path in "$roles_dir"/*.toml; do
        [ -f "$role_path" ] || die "Missing managed role: $role_path"
        role_name=$(basename "$role_path")
        expected_hash=$(manifest_hash "$role_name" "$manifest_path") || die "Missing role hash: $role_name"
        actual_hash=$(normalized_lf_sha256 "$role_path")
        [ "$expected_hash" = "$actual_hash" ] || die "Role hash mismatch: $role_name"
        field_matches=$(rg -o '^(name|model|model_reasoning_effort|sandbox_mode|description|developer_instructions)[[:space:]]*=' "$role_path" | awk '{ sub(/[[:space:]]*=.*/, ""); print }') || die "Role fields missing: $role_name"
        printf '%s\n' "$field_matches" | awk 'BEGIN { wanted["name"]=1; wanted["model"]=1; wanted["model_reasoning_effort"]=1; wanted["sandbox_mode"]=1; wanted["description"]=1; wanted["developer_instructions"]=1 } { count[$0]++ } END { for (key in wanted) if (count[key] != 1) exit 1 }' || die "Role fields missing or repeated: $role_name"
    done
}

assert_agents_md() {
    agents_dir=${1:-$source_roles}
    manifest_path=${2:-$source_manifest}
    manifest_count=$(wc -l < "$manifest_path")
    [ "$manifest_count" -eq "$expected_roles" ] || die "Expected $expected_roles managed agent hashes"
    for agent_path in "$agents_dir"/*.md; do
        [ -f "$agent_path" ] || die "Missing managed agent: $agent_path"
        agent_name=$(basename "$agent_path")
        expected_hash=$(manifest_hash "$agent_name" "$manifest_path") || die "Missing agent hash: $agent_name"
        actual_hash=$(normalized_lf_sha256 "$agent_path")
        [ "$expected_hash" = "$actual_hash" ] || die "Agent hash mismatch: $agent_name"
        awk -v agent="${agent_name%.md}" '
            { sub(/\r$/, "") }
            NR == 1 { if ($0 != "---") { err = "frontmatter missing"; exit 1 } in_fm = 1; next }
            in_fm && $0 == "---" { terminated = 1; exit 0 }
            in_fm && /^(name|description|model|thoughtLevel)[[:space:]]*:/ {
                key = $0
                sub(/[[:space:]]*:.*$/, "", key)
                seen[key]++
                if (key == "name") {
                    value = $0
                    sub(/^[^:]*:[[:space:]]*/, "", value)
                    gsub(/^"|"$/, "", value)
                    fm_name = value
                }
            }
            END {
                bad = 0
                if (err != "") { printf "Agent %s: %s\n", agent, err > "/dev/stderr"; bad = 1 }
                else if (!terminated) { printf "Agent %s: frontmatter unterminated\n", agent > "/dev/stderr"; bad = 1 }
                else {
                    split("name description model thoughtLevel", required, " ")
                    for (i = 1; i <= 4; i++) if (seen[required[i]] != 1) { printf "Agent %s: field missing or repeated: %s\n", agent, required[i] > "/dev/stderr"; bad = 1 }
                    if (fm_name != agent) { printf "Agent %s: frontmatter name mismatch: %s\n", agent, fm_name > "/dev/stderr"; bad = 1 }
                }
                exit bad ? 1 : 0
            }
        ' "$agent_path" || die "Invalid agent profile: $agent_name"
    done
}

assert_managed_roles() {
    if [ "$role_kind" = toml ]; then
        assert_roles_toml "$@"
    else
        assert_agents_md "$@"
    fi
}

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
        BEGIN { section = "root" }
        {
            line = trim($0)
            if (line == "" || line ~ /^#/) next
            if (line ~ /"""/ || line ~ /\047\047\047/) { fail("multiline strings are not supported"); next }
            if (line ~ /^\[\[/) { if (line !~ /^\[\[[^]]+\]\][[:space:]]*(#.*)?$/) fail("ambiguous array table header"); section = "other"; next }
            if (line ~ /^\[/) { if (line !~ /^\[[^]]+\][[:space:]]*(#.*)?$/) { fail("ambiguous table header"); next }; header = line; sub(/^\[/, "", header); sub(/\][[:space:]]*(#.*)?$/, "", header); section = header; next }
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
            if ($0 ~ /^[[:space:]]*\[[^]]+\]/) { header=$0; sub(/^[[:space:]]*\[/,"",header); sub(/\][[:space:]]*(#.*)?$/,"",header); source_section=(header=="agents" || header=="features") ? header : "other"; next }
            if (index($0,"=")>0) { key=substr($0,1,index($0,"=")-1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",key); if (managed(source_section,key)) { value[source_section SUBSEP key]=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",value[source_section SUBSEP key]) } }
            next
        }
        FILENAME == ARGV[2] {
            if ($0 ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_-]*[[:space:]]*=/) { key=$0; sub(/^[[:space:]]*/,"",key); sub(/[[:space:]]*=.*/,"",key); provider_value[key]=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",provider_value[key]) }
            next
        }
        {
            if ($0 ~ /^[[:space:]]*\[\[/) { flush_managed(current); flush_provider(); current="other"; in_provider=0; for (provider_key in provider_seen) delete provider_seen[provider_key]; print; next }
            if ($0 ~ /^[[:space:]]*\[[^]]+\]/) {
                flush_managed(current); flush_provider()
                header=$0; sub(/^[[:space:]]*\[/,"",header); sub(/\][[:space:]]*(#.*)?$/,"",header); gsub(/^[[:space:]]+|[[:space:]]+$/,"",header)
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
    "$client_home/docs directory" \
    "$client_home/agents/ai-vibecode-superpower directory"; do
    target_path=${target_spec% *}
    target_kind=${target_spec##* }
    assert_target "$target_path" "$target_kind" || die "Unsafe install target: $target_path"
done
if [ "$has_config" -eq 1 ]; then
    assert_target "$client_home/config.toml" file || die "Unsafe install target: $client_home/config.toml"
fi
for skill_spec in $skill_specs; do
    assert_target "$client_home/skills/${skill_spec%%:*}" directory || die "Unsafe install target: $client_home/skills/${skill_spec%%:*}"
done
for container_path in "$client_home/agents" "$client_home/skills" "$client_home/backups"; do
    assert_directory_container "$container_path" || die "Unsafe managed container: $container_path"
done
assert_managed_roles

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
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p -- "$stage_dir/state/backed-up" "$stage_dir/state/install-started" "$stage_dir/agents" "$stage_dir/skills"
cp "$source_instructions" "$stage_dir/AGENTS.md"
cp -R "$source_docs" "$stage_dir/docs"
cp -R "$source_system_docs" "$stage_dir/docs/system"
cp -R "$source_roles" "$stage_dir/agents/"
for skill_spec in $skill_specs; do cp -R "$(skill_source_dir "$skill_spec")" "$stage_dir/skills/"; done
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
assert_managed_roles "$stage_dir/agents/ai-vibecode-superpower" "$source_manifest"
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
printf 'agents/ai-vibecode-superpower\t%s\t%s\tdirectory\treplace\n' "$client_home/agents/ai-vibecode-superpower" "$stage_dir/agents/ai-vibecode-superpower" >> "$manifest"
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
    fi
done < "$manifest"
assert_managed_roles "$client_home/agents/ai-vibecode-superpower" "$source_manifest"
completed=1
printf '%s\n' "$client_label configuration installed in: $client_home" 'Standalone skills and managed agent roles installed.'
if [ "$client" = zcode ]; then printf '%s\n' 'Unmanaged ZCode state (cli/, v2/, plugins, other skills and agents) was not modified.'; fi
if [ -n "$backup_dir" ]; then printf '%s\n' "Backup directory: $backup_dir"; fi
