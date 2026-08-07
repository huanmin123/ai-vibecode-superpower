#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
source_agents=$script_dir/codex-global-config/AGENTS.md
source_config=$script_dir/codex-global-config/config.toml
source_docs=$script_dir/codex-global-config/docs
source_agent_roles=$script_dir/codex-global-config/agents/ai-vibecode-superpower
source_agent_role_manifest=$script_dir/codex-global-config/agents/ai-vibecode-superpower.sha256
managed_plugin_name=agnets-workflow
managed_marketplace_name=ai-vibecode-superpower-local
source_plugin=$script_dir/plugins/$managed_plugin_name
source_marketplace=$script_dir/.agents/plugins/marketplace.json
source_plugin_skills=$source_plugin/skills
source_standalone_skills=$script_dir/skills
managed_plugin_skill_names='agent-toolchain orchestrate-read-workflow orchestrate-model-workflow workflow-controller project-doc-planner'
managed_standalone_skill_names='gpt-image-2-cli'
managed_agent_role_files='ai-vibecode-superpower-avsp_luna_high.toml ai-vibecode-superpower-avsp_luna_xhigh.toml ai-vibecode-superpower-avsp_luna_high_writer.toml ai-vibecode-superpower-avsp_luna_xhigh_writer.toml ai-vibecode-superpower-avsp_luna_high_executor.toml ai-vibecode-superpower-avsp_luna_xhigh_executor.toml ai-vibecode-superpower-avsp_sol_high.toml ai-vibecode-superpower-avsp_sol_max.toml ai-vibecode-superpower-avsp_sol_xhigh.toml ai-vibecode-superpower-avsp_terra_high.toml ai-vibecode-superpower-avsp_terra_xhigh.toml ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml ai-vibecode-superpower-avsp_terra_low_readonly.toml ai-vibecode-superpower-avsp_terra_medium_readonly.toml'

for source_path in "$source_agents" "$source_config" "$source_agent_role_manifest" "$source_marketplace"; do
    if [ ! -f "$source_path" ]; then
        printf '%s\n' "Missing source file: $source_path" >&2
        exit 1
    fi
done
for source_path in "$source_docs" "$source_agent_roles" "$source_plugin" "$source_plugin_skills" "$source_standalone_skills"; do
    if [ ! -d "$source_path" ]; then
        printf '%s\n' "Missing source directory: $source_path" >&2
        exit 1
    fi
done
for agent_role_file in $managed_agent_role_files; do
    source_role=$source_agent_roles/$agent_role_file
    if [ ! -f "$source_role" ]; then
        printf '%s\n' "Missing managed agent role: $source_role" >&2
        exit 1
    fi
done

for skill_name in $managed_plugin_skill_names; do
    if [ ! -d "$source_plugin_skills/$skill_name" ]; then
        printf '%s\n' "Missing managed plugin skill: $skill_name" >&2
        exit 1
    fi
done
for skill_name in $managed_standalone_skill_names; do
    if [ ! -d "$source_standalone_skills/$skill_name" ]; then
        printf '%s\n' "Missing managed standalone skill: $skill_name" >&2
        exit 1
    fi
done

case $(uname -s) in
    Darwin|Linux) ;;
    *)
        printf '%s\n' "Unsupported operating system: $(uname -s)" >&2
        exit 1
        ;;
esac

command -v rg >/dev/null 2>&1 || {
    printf '%s\n' 'ripgrep (rg) is required to safely scan user agent roles.' >&2
    exit 1
}

if [ -n "${CODEX_HOME:-}" ]; then
    codex_home=$CODEX_HOME
else
    : "${HOME:?HOME must be set when CODEX_HOME is empty}"
    codex_home=$HOME/.codex
fi

mkdir -p "$codex_home"
codex_home=$(CDPATH= cd -- "$codex_home" && pwd -P) || exit 1
if [ "$codex_home" = / ]; then
    printf '%s\n' 'Refusing to install into a filesystem root.' >&2
    exit 1
fi

if [ "$codex_home/AGENTS.md" -ef "$source_agents" ] || \
   [ "$codex_home/config.toml" -ef "$source_config" ] || \
   [ "$codex_home/docs" -ef "$source_docs" ] || \
   [ "$codex_home/agents/ai-vibecode-superpower" -ef "$source_agent_roles" ]; then
    printf '%s\n' 'Destination target overlaps its source.' >&2
    exit 1
fi
for skill_name in $managed_standalone_skill_names; do
    if [ "$codex_home/skills/$skill_name" -ef "$source_standalone_skills/$skill_name" ]; then
        printf '%s\n' "Destination target overlaps its source: $codex_home/skills/$skill_name" >&2
        exit 1
    fi
done
stage_dir=
backup_dir=
manifest=
completed=0
lock_file=$codex_home/.install.lock
agents_parent_created=0
tab=$(printf '\t')
carriage_return=$(printf '\r')

install_managed_plugin() {
    command -v codex >/dev/null 2>&1 || {
        printf '%s\n' 'Codex CLI is required to install the managed plugin, but codex was not found.' >&2
        return 1
    }
    command -v node >/dev/null 2>&1 || {
        printf '%s\n' 'Node.js is required for the agnets-workflow workflow-controller MCP server, but the node command was not found.' >&2
        return 1
    }
    CODEX_HOME="$codex_home" codex plugin marketplace add "$script_dir"
    CODEX_HOME="$codex_home" codex plugin add "$managed_plugin_name@$managed_marketplace_name"
}

remove_legacy_managed_plugin() {
    legacy_plugin_id=workflow-controller@ai-vibecode-superpower-local
    config_path=$codex_home/config.toml
    [ -f "$config_path" ] || return 0

    if ! rg -F -q -- "[plugins.\"$legacy_plugin_id\"]" "$config_path" && \
       ! rg -F -q -- "[plugins.'$legacy_plugin_id']" "$config_path"; then
        return 0
    fi

    command -v codex >/dev/null 2>&1 || {
        printf '%s\n' 'Codex CLI is required to remove the legacy managed plugin, but codex was not found.' >&2
        return 1
    }
    attempt=1
    while :; do
        if CODEX_HOME="$codex_home" codex plugin remove "$legacy_plugin_id"; then
            return 0
        else
            exit_code=$?
        fi
        if [ "$attempt" -ge 8 ]; then
            printf '%s\n' "Could not remove legacy managed plugin after 8 attempts: $legacy_plugin_id (exit code $exit_code)" >&2
            return "$exit_code"
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
}

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

assert_no_symlink_tree() {
    target_path=$1

    if [ -L "$target_path" ]; then
        printf '%s\n' "Refusing to copy through a symbolic link: $target_path" >&2
        exit 1
    fi
    if [ ! -d "$target_path" ]; then
        return 0
    fi
    for child_path in "$target_path"/* "$target_path"/.[!.]* "$target_path"/..?*; do
        path_exists "$child_path" || continue
        assert_no_symlink_tree "$child_path"
    done
}

is_managed_agent_role_file() {
    case $1 in
        ai-vibecode-superpower-avsp_luna_high.toml|\
        ai-vibecode-superpower-avsp_luna_xhigh.toml|\
        ai-vibecode-superpower-avsp_luna_high_writer.toml|\
        ai-vibecode-superpower-avsp_luna_xhigh_writer.toml|\
        ai-vibecode-superpower-avsp_luna_high_executor.toml|\
        ai-vibecode-superpower-avsp_luna_xhigh_executor.toml|\
        ai-vibecode-superpower-avsp_sol_high.toml|\
        ai-vibecode-superpower-avsp_sol_max.toml|\
        ai-vibecode-superpower-avsp_sol_xhigh.toml|\
        ai-vibecode-superpower-avsp_terra_high.toml|\
        ai-vibecode-superpower-avsp_terra_xhigh.toml|\
        ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml|\
        ai-vibecode-superpower-avsp_terra_low_readonly.toml|\
        ai-vibecode-superpower-avsp_terra_medium_readonly.toml)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

normalized_lf_sha256() {
    case $(uname -s) in
        Darwin)
            sed "s/${carriage_return}\$//" "$1" | shasum -a 256 | awk '{ print $1 }'
            ;;
        Linux)
            sed "s/${carriage_return}\$//" "$1" | sha256sum | awk '{ print $1 }'
            ;;
    esac
}

parse_managed_agent_role_manifest_line() {
    manifest_line=$1
    case $manifest_line in
        *"  "*) ;;
        *) return 1 ;;
    esac
    manifest_hash=${manifest_line%"  "*}
    manifest_role_file=${manifest_line#"$manifest_hash"  }
    [ "$manifest_hash  $manifest_role_file" = "$manifest_line" ] || return 1
    [ -n "$manifest_role_file" ] || return 1
    case $manifest_hash in
        *[!0-9a-f]*|'') return 1 ;;
    esac
    [ "${#manifest_hash}" -eq 64 ] || return 1
    case $manifest_role_file in
        *[[:space:]]*) return 1 ;;
    esac
    return 0
}

managed_agent_role_manifest_hash() {
    requested_role_file=$1
    while IFS= read -r manifest_line || [ -n "$manifest_line" ]; do
        if ! parse_managed_agent_role_manifest_line "$manifest_line"; then
            printf '%s\n' "Invalid managed agent role manifest: $source_agent_role_manifest" >&2
            return 1
        fi
        if [ "$manifest_role_file" = "$requested_role_file" ]; then
            printf '%s\n' "$manifest_hash"
            return 0
        fi
    done < "$source_agent_role_manifest"
    printf '%s\n' "Missing managed agent role hash: $requested_role_file" >&2
    return 1
}

assert_managed_agent_role_manifest() {
    manifest_path=$1
    manifest_count=0
    manifest_role_files=

    while IFS= read -r manifest_line || [ -n "$manifest_line" ]; do
        if ! parse_managed_agent_role_manifest_line "$manifest_line"; then
            printf '%s\n' "Invalid managed agent role manifest: $manifest_path" >&2
            exit 1
        fi
        if ! is_managed_agent_role_file "$manifest_role_file"; then
            printf '%s\n' "Unexpected managed agent role manifest entry: $manifest_role_file" >&2
            exit 1
        fi
        case " $manifest_role_files " in
            *" $manifest_role_file "*)
                printf '%s\n' "Repeated managed agent role hash: $manifest_role_file" >&2
                exit 1
                ;;
        esac
        manifest_role_files="$manifest_role_files $manifest_role_file"
        manifest_count=$((manifest_count + 1))
    done < "$manifest_path"

    expected_role_count=0
    for role_file in $managed_agent_role_files; do
        expected_role_count=$((expected_role_count + 1))
        case " $manifest_role_files " in
            *" $role_file "*) ;;
            *)
                printf '%s\n' "Missing managed agent role hash: $role_file" >&2
                exit 1
                ;;
        esac
    done
    if [ "$manifest_count" -ne "$expected_role_count" ]; then
        printf '%s\n' "Unexpected managed agent role manifest entry count: $manifest_path" >&2
        exit 1
    fi
}

assert_managed_agent_role_contract() {
    role_path=$1
    role_file=$(basename "$role_path")

    case $role_file in
        ai-vibecode-superpower-avsp_luna_high.toml)
            expected_name=avsp_luna_high
            expected_model=gpt-5.6-luna
            expected_effort=high
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_luna_xhigh.toml)
            expected_name=avsp_luna_xhigh
            expected_model=gpt-5.6-luna
            expected_effort=xhigh
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_luna_high_writer.toml)
            expected_name=avsp_luna_high_writer
            expected_model=gpt-5.6-luna
            expected_effort=high
            expected_sandbox=danger-full-access
            ;;
        ai-vibecode-superpower-avsp_luna_xhigh_writer.toml)
            expected_name=avsp_luna_xhigh_writer
            expected_model=gpt-5.6-luna
            expected_effort=xhigh
            expected_sandbox=danger-full-access
            ;;
        ai-vibecode-superpower-avsp_luna_high_executor.toml)
            expected_name=avsp_luna_high_executor
            expected_model=gpt-5.6-luna
            expected_effort=high
            expected_sandbox=danger-full-access
            ;;
        ai-vibecode-superpower-avsp_luna_xhigh_executor.toml)
            expected_name=avsp_luna_xhigh_executor
            expected_model=gpt-5.6-luna
            expected_effort=xhigh
            expected_sandbox=danger-full-access
            ;;
        ai-vibecode-superpower-avsp_sol_high.toml)
            expected_name=avsp_sol_high
            expected_model=gpt-5.6-sol
            expected_effort=high
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_sol_max.toml)
            expected_name=avsp_sol_max
            expected_model=gpt-5.6-sol
            expected_effort=max
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_sol_xhigh.toml)
            expected_name=avsp_sol_xhigh
            expected_model=gpt-5.6-sol
            expected_effort=xhigh
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_terra_high.toml)
            expected_name=avsp_terra_high
            expected_model=gpt-5.6-terra
            expected_effort=high
            expected_sandbox=danger-full-access
            ;;
        ai-vibecode-superpower-avsp_terra_xhigh.toml)
            expected_name=avsp_terra_xhigh
            expected_model=gpt-5.6-terra
            expected_effort=xhigh
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml)
            expected_name=avsp_terra_xhigh_readonly
            expected_model=gpt-5.6-terra
            expected_effort=xhigh
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_terra_low_readonly.toml)
            expected_name=avsp_terra_low_readonly
            expected_model=gpt-5.6-terra
            expected_effort=low
            expected_sandbox=read-only
            ;;
        ai-vibecode-superpower-avsp_terra_medium_readonly.toml)
            expected_name=avsp_terra_medium_readonly
            expected_model=gpt-5.6-terra
            expected_effort=medium
            expected_sandbox=read-only
            ;;
        *)
            printf '%s\n' "Unexpected managed agent role: $role_path" >&2
            exit 1
            ;;
    esac

    expected_hash=$(managed_agent_role_manifest_hash "$role_file")
    actual_hash=$(normalized_lf_sha256 "$role_path")
    if [ "$actual_hash" != "$expected_hash" ]; then
        printf '%s\n' "Managed agent role content does not match its contract: $role_path" >&2
        exit 1
    fi

    if ! awk \
        -v expected_name="$expected_name" \
        -v expected_model="$expected_model" \
        -v expected_effort="$expected_effort" \
        -v expected_sandbox="$expected_sandbox" '
        function trim(value) {
            sub(/^[[:space:]]*/, "", value)
            sub(/[[:space:]]*$/, "", value)
            return value
        }
        function validate_scalar(key, expected) {
            seen[key]++
            if (seen[key] != 1 || line != key " = \"" expected "\"") {
                invalid = 1
            }
        }
        BEGIN {
            in_developer_instructions = 0
            developer_instructions_count = 0
            description_count = 0
        }
        {
            line = trim($0)

            if (in_developer_instructions) {
                if (line == "\"\"\"") {
                    in_developer_instructions = 0
                }
                next
            }
            if (line == "" || line ~ /^#/) {
                next
            }
            if (line ~ /^developer_instructions[[:space:]]*=[[:space:]]*"""[[:space:]]*$/) {
                developer_instructions_count++
                if (developer_instructions_count != 1) {
                    invalid = 1
                }
                in_developer_instructions = 1
                next
            }
            if (line ~ /^description[[:space:]]*=/) {
                description_count++
                if (description_count != 1 || line !~ /^description[[:space:]]*=[[:space:]]*"[^"]*"[[:space:]]*$/) {
                    invalid = 1
                }
                next
            }
            if (line ~ /^name[[:space:]]*=/) {
                validate_scalar("name", expected_name)
                next
            }
            if (line ~ /^model[[:space:]]*=/) {
                validate_scalar("model", expected_model)
                next
            }
            if (line ~ /^model_reasoning_effort[[:space:]]*=/) {
                validate_scalar("model_reasoning_effort", expected_effort)
                next
            }
            if (line ~ /^sandbox_mode[[:space:]]*=/) {
                validate_scalar("sandbox_mode", expected_sandbox)
                next
            }
            invalid = 1
        }
        END {
            if (in_developer_instructions || developer_instructions_count != 1 || description_count != 1 ||
                seen["name"] != 1 || seen["model"] != 1 ||
                seen["model_reasoning_effort"] != 1 || seen["sandbox_mode"] != 1) {
                invalid = 1
            }
            exit invalid ? 1 : 0
        }
    ' "$role_path"; then
        printf '%s\n' "Invalid managed agent role contract: $role_path" >&2
        exit 1
    fi
}

assert_managed_agent_role_directory() {
    role_directory=$1
    expected_role_count=0
    actual_role_count=0

    assert_no_symlink_tree "$role_directory"
    for role_path in "$role_directory"/* "$role_directory"/.[!.]* "$role_directory"/..?*; do
        path_exists "$role_path" || continue
        if [ ! -f "$role_path" ]; then
            printf '%s\n' "Expected a regular managed agent role file: $role_path" >&2
            exit 1
        fi
        role_file=$(basename "$role_path")
        if ! is_managed_agent_role_file "$role_file"; then
            printf '%s\n' "Unexpected managed agent role file: $role_path" >&2
            exit 1
        fi
        actual_role_count=$((actual_role_count + 1))
    done
    for role_file in $managed_agent_role_files; do
        expected_role_count=$((expected_role_count + 1))
        role_path=$role_directory/$role_file
        if [ ! -f "$role_path" ]; then
            printf '%s\n' "Missing managed agent role: $role_path" >&2
            exit 1
        fi
        assert_managed_agent_role_contract "$role_path"
    done
    if [ "$actual_role_count" -ne "$expected_role_count" ]; then
        printf '%s\n' "Unexpected managed agent role file count in: $role_directory" >&2
        exit 1
    fi
}

assert_target() {
    target_path=$1
    target_kind=$2

    path_exists "$target_path" || return 0
    if [ -L "$target_path" ]; then
        printf '%s\n' "Refusing to replace a symbolic link: $target_path" >&2
        exit 1
    fi
    case $target_kind in
        file)
            if [ ! -f "$target_path" ]; then
                printf '%s\n' "Expected a regular file target: $target_path" >&2
                exit 1
            fi
            ;;
        directory)
            if [ ! -d "$target_path" ]; then
                printf '%s\n' "Expected a directory target: $target_path" >&2
                exit 1
            fi
            assert_no_symlink_tree "$target_path"
            ;;
        *)
            printf '%s\n' "Unknown target type: $target_kind" >&2
            exit 1
            ;;
    esac
}

assert_directory_container() {
    target_path=$1

    path_exists "$target_path" || return 0
    if [ -L "$target_path" ] || [ ! -d "$target_path" ]; then
        printf '%s\n' "Expected a non-symbolic-link directory: $target_path" >&2
        exit 1
    fi
}

assert_no_reserved_agent_role_name_conflict() {
    agents_directory=$1

    [ -d "$agents_directory" ] || return 0
    assert_no_symlink_tree "$agents_directory"
    conflict_found=0
    for scan_root in "$agents_directory"/* "$agents_directory"/.[!.]* "$agents_directory"/..?*; do
        path_exists "$scan_root" || continue
        [ "$(basename "$scan_root")" = ai-vibecode-superpower ] && continue
        if conflicting_roles=$(rg -il --hidden --no-ignore --glob '*.toml' '^[[:space:]]*(?:name|["\x27]name["\x27])[[:space:]]*=[[:space:]]*["\x27]{1,3}(?:avsp_|\\u0061vsp_|\\U00000061vsp_)' "$scan_root"); then
            if [ "$conflict_found" -eq 0 ]; then
                printf '%s\n' "User agent role uses the reserved avsp_ namespace:" >&2
            fi
            printf '%s\n' "$conflicting_roles" >&2
            conflict_found=1
        else
            search_status=$?
            if [ "$search_status" -ne 1 ]; then
                printf '%s\n' "Could not safely scan user agent roles in: $scan_root" >&2
                exit "$search_status"
            fi
        fi
    done
    if [ "$conflict_found" -ne 0 ]; then
        exit 1
    fi
}

mark_state() {
    state_name=$1
    target_name=$2
    marker=$stage_dir/state/$state_name/$target_name
    mkdir -p "$(dirname "$marker")"
    : > "$marker"
}

has_state() {
    state_name=$1
    target_name=$2
    [ -f "$stage_dir/state/$state_name/$target_name" ]
}

assert_managed_agent_role_manifest "$source_agent_role_manifest"
assert_managed_agent_role_directory "$source_agent_roles"

assert_safe_toml_merge_input() {
    config_path=$1

    if ! awk '
        function trim(value) {
            sub(/^[[:space:]]*/, "", value)
            sub(/[[:space:]]*$/, "", value)
            return value
        }
        function fail(message) {
            printf "%s:%d: unsupported TOML syntax for safe merge: %s\\n", FILENAME, FNR, message > "/dev/stderr"
            invalid = 1
        }
        function assert_single_line_value(value,    position, character, next_character, in_basic_string, in_literal_string, array_depth, table_depth) {
            in_basic_string = 0
            in_literal_string = 0
            array_depth = 0
            table_depth = 0
            for (position = 1; position <= length(value); position++) {
                character = substr(value, position, 1)
                if (in_basic_string) {
                    if (character == "\\") {
                        position++
                    } else if (character == "\"") {
                        in_basic_string = 0
                    }
                    continue
                }
                if (in_literal_string) {
                    if (character == "\047") {
                        in_literal_string = 0
                    }
                    continue
                }
                if (character == "#") {
                    break
                }
                if (character == "\"") {
                    in_basic_string = 1
                } else if (character == "\047") {
                    in_literal_string = 1
                } else if (character == "[") {
                    array_depth++
                } else if (character == "]") {
                    array_depth--
                } else if (character == "{") {
                    table_depth++
                } else if (character == "}") {
                    table_depth--
                }
                if (array_depth < 0 || table_depth < 0) {
                    return 0
                }
            }
            return !in_basic_string && !in_literal_string && array_depth == 0 && table_depth == 0
        }
        BEGIN {
            section = "root"
        }
        {
            line = trim($0)
            if (line ~ /"""/ || line ~ /\047\047\047/) {
                fail("multiline strings are not supported")
                next
            }
            if (line == "" || line ~ /^#/) {
                next
            }
            if (line ~ /^\[/) {
                array_table = line ~ /^\[\[/
                if (array_table) {
                    if (line !~ /^\[\[[^]]+\]\][[:space:]]*(#.*)?$/) {
                        fail("ambiguous array table header")
                        next
                    }
                    header = line
                    sub(/^\[\[/, "", header)
                    sub(/\][[:space:]]*\][[:space:]]*(#.*)?$/, "", header)
                } else if (line !~ /^\[[^]]+\][[:space:]]*(#.*)?$/) {
                    fail("ambiguous table header")
                    next
                } else {
                    header = line
                    sub(/^[[:space:]]*\[/, "", header)
                    sub(/\][[:space:]]*(#.*)?$/, "", header)
                }
                if (array_table && (header == "agents" || header == "features")) {
                    fail("managed table cannot be an array table")
                    next
                }
                if (header ~ /^("agents"|agents|"features"|features|"model"|model|"model_reasoning_effort"|model_reasoning_effort|"sandbox_mode"|sandbox_mode)(\.|$)/ && header != "agents" && header != "features") {
                    fail("managed namespace table is ambiguous")
                    next
                }
                section = header
                if (!array_table) {
                    table_seen[section]++
                }
                if (!array_table && (section == "agents" || section == "features") && table_seen[section] != 1) {
                    fail("managed table is repeated")
                }
                next
            }
            if (index(line, "=") == 0) {
                fail("unrecognized non-comment line")
                next
            }
            key = substr(line, 1, index(line, "=") - 1)
            key = trim(key)
            value = substr(line, index(line, "=") + 1)
            if (!assert_single_line_value(value)) {
                fail("cross-line or unclosed value")
                next
            }
            if (key !~ /^[A-Za-z][A-Za-z0-9_-]*$/) {
                if (section == "root" && key ~ /^("|\047)?(model|model_reasoning_effort|sandbox_mode|agents|features)/) {
                    fail("quoted or dotted managed key")
                } else if ((section == "agents" || section == "features") && key ~ /^("|\047)?(max_threads|max_depth|goals)/) {
                    fail("quoted or dotted managed key")
                }
                next
            }
            if (section == "root" && (key == "agents" || key == "features")) {
                fail("managed table cannot be a root key")
                next
            }
            if (section == "root" && (key == "model" || key == "model_reasoning_effort" || key == "sandbox_mode")) {
                managed_seen[section SUBSEP key]++
                if (managed_seen[section SUBSEP key] != 1) {
                    fail("managed key is repeated")
                }
            }
            if (section == "agents" && (key == "max_threads" || key == "max_depth")) {
                managed_seen[section SUBSEP key]++
                if (managed_seen[section SUBSEP key] != 1) {
                    fail("managed key is repeated")
                }
            }
            if (section == "features" && key == "goals") {
                managed_seen[section SUBSEP key]++
                if (managed_seen[section SUBSEP key] != 1) {
                    fail("managed key is repeated")
                }
            }
        }
        END {
            exit invalid ? 1 : 0
        }
    ' "$config_path"; then
        printf '%s\n' "Refusing to merge $config_path; no files were changed." >&2
        exit 1
    fi
}

merge_managed_config() {
    config_input=$1
    config_output=$2

    awk '
        BEGIN {
            section = "root"
            current = "root"
        }
        function managed_key(section, key) {
            return (section == "root" && (key == "model" || key == "model_reasoning_effort" || key == "sandbox_mode")) ||
                   (section == "agents" && (key == "max_threads" || key == "max_depth")) ||
                   (section == "features" && key == "goals")
        }
        function flush_missing(section,    key, position, count) {
            count = 0
            if (section == "root") {
                order[1] = "model"; order[2] = "model_reasoning_effort"; order[3] = "sandbox_mode"; count = 3
            } else if (section == "agents") {
                order[1] = "max_threads"; order[2] = "max_depth"; count = 2
            } else if (section == "features") {
                order[1] = "goals"; count = 1
            }
            for (position = 1; position <= count; position++) {
                key = order[position]
                if (!seen[section SUBSEP key]) {
                    print key " = " value[section SUBSEP key]
                    seen[section SUBSEP key] = 1
                }
            }
        }
        FNR == NR {
            if ($0 ~ /^[[:space:]]*\[[^]]+\][[:space:]]*(#.*)?$/) {
                header = $0
                sub(/^[[:space:]]*\[/, "", header)
                sub(/\][[:space:]]*(#.*)?$/, "", header)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", header)
                section = (header == "agents" || header == "features") ? header : "other"
                next
            }
            if (index($0, "=") > 0) {
                key = substr($0, 1, index($0, "=") - 1)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
                if (managed_key(section, key)) {
                    value[section SUBSEP key] = substr($0, index($0, "=") + 1)
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value[section SUBSEP key])
                }
            }
            next
        }
        {
            if ($0 ~ /^[[:space:]]*\[[^]]+\][[:space:]]*(#.*)?$/) {
                flush_missing(current)
                header = $0
                sub(/^[[:space:]]*\[/, "", header)
                sub(/\][[:space:]]*(#.*)?$/, "", header)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", header)
                current = (header == "agents" || header == "features") ? header : "other"
                present[current] = 1
                print
                next
            }
            if (index($0, "=") > 0) {
                key = substr($0, 1, index($0, "=") - 1)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
                if (managed_key(current, key) && !seen[current SUBSEP key]) {
                    print key " = " value[current SUBSEP key]
                    seen[current SUBSEP key] = 1
                    next
                }
            }
            print
        }
        END {
            required["root" SUBSEP "model"] = 1
            required["root" SUBSEP "model_reasoning_effort"] = 1
            required["root" SUBSEP "sandbox_mode"] = 1
            required["agents" SUBSEP "max_threads"] = 1
            required["agents" SUBSEP "max_depth"] = 1
            required["features" SUBSEP "goals"] = 1
            for (setting in required) {
                if (!(setting in value)) {
                    print "Missing managed config setting: " setting > "/dev/stderr"
                    exit 1
                }
            }
            flush_missing(current)
            if (!present["agents"]) {
                print ""
                print "[agents]"
                flush_missing("agents")
            }
            if (!present["features"]) {
                print ""
                print "[features]"
                flush_missing("features")
            }
        }
    ' "$source_config" "$config_input" > "$config_output"
}

rollback() {
    rollback_failed=0
    [ -n "$manifest" ] && [ -f "$manifest" ] || return 0

    while IFS="$tab" read -r target_name target_path candidate_path target_kind target_operation; do
        if has_state install-started "$target_name" && path_exists "$target_path"; then
            rm -rf "$target_path" || rollback_failed=1
        fi
    done < "$manifest"

    while IFS="$tab" read -r target_name target_path candidate_path target_kind target_operation; do
        backup_path=$backup_dir/$target_name
        if has_state backed-up "$target_name" && path_exists "$backup_path"; then
            mkdir -p "$(dirname "$target_path")" || rollback_failed=1
            if ! path_exists "$target_path"; then
                mv "$backup_path" "$target_path" || rollback_failed=1
            fi
        fi
    done < "$manifest"

    if [ "$agents_parent_created" -eq 1 ] && [ -d "$codex_home/agents" ]; then
        rmdir "$codex_home/agents" 2>/dev/null || true
    fi
    if [ "$rollback_failed" -ne 0 ]; then
        printf '%s\n' "Rollback was incomplete; retained backup directory: $backup_dir" >&2
    fi
}

cleanup() {
    status=$?
    if [ "$completed" -ne 1 ]; then
        set +e
        rollback
    fi
    if [ -n "$stage_dir" ] && [ -d "$stage_dir" ]; then
        rm -rf "$stage_dir"
    fi
    exit "$status"
}

trap cleanup 0
trap 'exit 1' 1 2 3 15

# Keep the kernel advisory lock on this process's descriptor for the whole
# transaction. The ordinary lock file is intentionally retained between runs.
if [ -L "$lock_file" ] || { path_exists "$lock_file" && [ ! -f "$lock_file" ]; }; then
    printf '%s\n' "Expected a regular lock file target: $lock_file" >&2
    exit 1
fi
exec 9>> "$lock_file" || exit 1
case $(uname -s) in
    Darwin)
        command -v lockf >/dev/null 2>&1 || {
            printf '%s\n' 'lockf is required to serialize the macOS installer.' >&2
            exit 1
        }
        lockf -k -t 0 9 || {
            printf '%s\n' "Another Codex installer is already running for: $codex_home" >&2
            exit 1
        }
        ;;
    Linux)
        command -v flock >/dev/null 2>&1 || {
            printf '%s\n' 'flock is required to serialize the Linux installer.' >&2
            exit 1
        }
        flock -n 9 || {
            printf '%s\n' "Another Codex installer is already running for: $codex_home" >&2
            exit 1
        }
        ;;
esac

stage_dir=$(mktemp -d "$codex_home/.install-stage.XXXXXX")
mkdir -p "$stage_dir/state/backed-up" "$stage_dir/state/install-started"
cp "$source_agents" "$stage_dir/AGENTS.md"
cp -R "$source_docs" "$stage_dir/docs"
mkdir -p "$stage_dir/agents"
cp -R "$source_agent_roles" "$stage_dir/agents/"
mkdir -p "$stage_dir/skills"
for skill_name in $managed_standalone_skill_names; do
    cp -R "$source_standalone_skills/$skill_name" "$stage_dir/skills/"
done

assert_target "$codex_home/config.toml" file
config_input=$codex_home/config.toml
if ! path_exists "$config_input"; then
    config_input=$stage_dir/empty-config.toml
    : > "$config_input"
fi
assert_safe_toml_merge_input "$source_config"
assert_safe_toml_merge_input "$config_input"
merge_managed_config "$config_input" "$stage_dir/merged-config.toml"
assert_safe_toml_merge_input "$stage_dir/merged-config.toml"

for name in AGENTS.md merged-config.toml docs agents/ai-vibecode-superpower; do
    if ! path_exists "$stage_dir/$name"; then
        printf '%s\n' "Staging failed for: $name" >&2
        exit 1
    fi
done
for agent_role_file in $managed_agent_role_files; do
    if [ ! -f "$stage_dir/agents/ai-vibecode-superpower/$agent_role_file" ]; then
        printf '%s\n' "Staging failed for managed agent role: $agent_role_file" >&2
        exit 1
    fi
done
for skill_name in $managed_standalone_skill_names; do
    if [ ! -d "$stage_dir/skills/$skill_name" ]; then
        printf '%s\n' "Staging failed for standalone skill: $skill_name" >&2
        exit 1
    fi
done
assert_managed_agent_role_directory "$stage_dir/agents/ai-vibecode-superpower"

manifest=$stage_dir/targets.tsv
printf '%s\t%s\t%s\t%s\t%s\n' AGENTS.md "$codex_home/AGENTS.md" "$stage_dir/AGENTS.md" file replace > "$manifest"
printf '%s\t%s\t%s\t%s\t%s\n' config.toml "$codex_home/config.toml" "$stage_dir/merged-config.toml" file replace >> "$manifest"
printf '%s\t%s\t%s\t%s\t%s\n' docs "$codex_home/docs" "$stage_dir/docs" directory replace >> "$manifest"
printf '%s\t%s\t%s\t%s\t%s\n' agents/ai-vibecode-superpower "$codex_home/agents/ai-vibecode-superpower" "$stage_dir/agents/ai-vibecode-superpower" directory replace >> "$manifest"
for skill_name in $managed_standalone_skill_names; do
    printf '%s\t%s\t%s\t%s\t%s\n' "skills/$skill_name" "$codex_home/skills/$skill_name" "$stage_dir/skills/$skill_name" directory replace >> "$manifest"
done
for skill_name in $managed_plugin_skill_names; do
    printf '%s\t%s\t%s\t%s\t%s\n' "skills/$skill_name" "$codex_home/skills/$skill_name" - directory remove >> "$manifest"
done

# All source candidates exist now. Validate every destination and backup path before replacing or removing any target.
assert_target "$codex_home/AGENTS.md" file
assert_target "$codex_home/config.toml" file
assert_target "$codex_home/docs" directory
assert_directory_container "$codex_home/agents"
assert_no_reserved_agent_role_name_conflict "$codex_home/agents"
assert_directory_container "$codex_home/skills"
if path_exists "$codex_home/backups"; then
    assert_directory_container "$codex_home/backups"
fi
while IFS="$tab" read -r target_name target_path candidate_path target_kind target_operation; do
    assert_target "$target_path" "$target_kind"
done < "$manifest"

has_existing_target=0
while IFS="$tab" read -r target_name target_path candidate_path target_kind target_operation; do
    if path_exists "$target_path"; then
        has_existing_target=1
        break
    fi
done < "$manifest"
if [ ! -d "$codex_home/agents" ]; then
    mkdir "$codex_home/agents"
    agents_parent_created=1
fi
if [ "$has_existing_target" -eq 1 ]; then
    mkdir -p "$codex_home/backups"
    backup_dir=$(mktemp -d "$codex_home/backups/backup-$(date +%Y%m%d-%H%M%S)-$$.XXXXXX")
fi

while IFS="$tab" read -r target_name target_path candidate_path target_kind target_operation; do
    [ "$target_operation" = replace ] || continue
    if path_exists "$target_path"; then
        backup_path=$backup_dir/$target_name
        mkdir -p "$(dirname "$backup_path")"
        mv "$target_path" "$backup_path"
        mark_state backed-up "$target_name"
    fi
    mark_state install-started "$target_name"
    if [ "$target_operation" = replace ]; then
        mv "$candidate_path" "$target_path"
    fi
done < "$manifest"

# Plugin commands update config.toml. Run them only after its staged version
# is installed, while the transaction can still restore the previous config.
install_managed_plugin

# The CLI may briefly retain config.toml after plugin add. The bounded retry
# preserves the final error and occurs before any legacy skill is removed.
remove_legacy_managed_plugin

while IFS="$tab" read -r target_name target_path candidate_path target_kind target_operation; do
    [ "$target_operation" = remove ] || continue
    if path_exists "$target_path"; then
        backup_path=$backup_dir/$target_name
        mkdir -p "$(dirname "$backup_path")"
        mv "$target_path" "$backup_path"
        mark_state backed-up "$target_name"
    fi
    mark_state install-started "$target_name"
done < "$manifest"

# Re-validate the installed role directory, not only the staging copy.
# Codex Desktop/CLI loads role profiles at process start and does not hot-reload them.
assert_managed_agent_role_directory "$codex_home/agents/ai-vibecode-superpower"

completed=1
printf '%s\n' "Codex configuration installed in: $codex_home"
printf '%s\n' "Managed plugin installed: $managed_plugin_name@$managed_marketplace_name"
printf '%s\n' 'Managed standalone skills installed; obsolete global copies of plugin skills removed.'
if [ -n "$backup_dir" ]; then
    printf '%s\n' "Backup directory: $backup_dir"
else
    printf '%s\n' 'Backup directory: none (no managed targets existed)'
fi
printf '%s\n' 'Restart Codex Desktop/CLI before starting a new workflow so newly installed agent roles are loaded.' >&2
