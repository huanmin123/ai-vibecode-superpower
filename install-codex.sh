#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
source_agents=$script_dir/codex-global-config/AGENTS.md
source_config=$script_dir/codex-global-config/config.toml
source_docs=$script_dir/codex-global-config/docs
source_skills=$script_dir/skills

for source_path in "$source_agents" "$source_config"; do
    if [ ! -f "$source_path" ]; then
        printf '%s\n' "Missing source file: $source_path" >&2
        exit 1
    fi
done
for source_path in "$source_docs" "$source_skills"; do
    if [ ! -d "$source_path" ]; then
        printf '%s\n' "Missing source directory: $source_path" >&2
        exit 1
    fi
done

managed_skill_count=0
for source_skill in "$source_skills"/*; do
    [ -d "$source_skill" ] || continue
    managed_skill_count=$((managed_skill_count + 1))
done
if [ "$managed_skill_count" -eq 0 ]; then
    printf '%s\n' "No managed skill directories found in: $source_skills" >&2
    exit 1
fi

case $(uname -s) in
    Darwin|Linux) ;;
    *)
        printf '%s\n' "Unsupported operating system: $(uname -s)" >&2
        exit 1
        ;;
esac

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
   [ "$codex_home/docs" -ef "$source_docs" ]; then
    printf '%s\n' 'Destination target overlaps its source.' >&2
    exit 1
fi
for source_skill in "$source_skills"/*; do
    [ -d "$source_skill" ] || continue
    skill_name=$(basename "$source_skill")
    if [ "$codex_home/skills/$skill_name" -ef "$source_skill" ]; then
        printf '%s\n' "Destination target overlaps its source: $codex_home/skills/$skill_name" >&2
        exit 1
    fi
done

stage_dir=
backup_dir=
manifest=
completed=0
lock_dir=$codex_home/.install.lock
lock_acquired=0
skills_parent_created=0
tab=$(printf '\t')

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
        return
    fi
    for child_path in "$target_path"/* "$target_path"/.[!.]* "$target_path"/..?*; do
        path_exists "$child_path" || continue
        assert_no_symlink_tree "$child_path"
    done
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

merge_managed_config() {
    config_input=$1
    config_output=$2

    awk '
        BEGIN {
            section = "root"
            current = "root"
        }
        function managed_key(section, key) {
            return (section == "root" && (key == "model" || key == "model_reasoning_effort")) ||
                   (section == "agents" && (key == "max_threads" || key == "max_depth")) ||
                   (section == "features" && (key == "js_repl" || key == "goals"))
        }
        function flush_missing(section,    key, position, count) {
            count = 0
            if (section == "root") {
                order[1] = "model"; order[2] = "model_reasoning_effort"; count = 2
            } else if (section == "agents") {
                order[1] = "max_threads"; order[2] = "max_depth"; count = 2
            } else if (section == "features") {
                order[1] = "js_repl"; order[2] = "goals"; count = 2
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
            required["agents" SUBSEP "max_threads"] = 1
            required["agents" SUBSEP "max_depth"] = 1
            required["features" SUBSEP "js_repl"] = 1
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

    while IFS="$tab" read -r target_name target_path candidate_path target_kind; do
        if has_state install-started "$target_name" && path_exists "$target_path"; then
            rm -rf "$target_path" || rollback_failed=1
        fi
    done < "$manifest"

    while IFS="$tab" read -r target_name target_path candidate_path target_kind; do
        backup_path=$backup_dir/$target_name
        if has_state backed-up "$target_name" && path_exists "$backup_path"; then
            mkdir -p "$(dirname "$target_path")" || rollback_failed=1
            if ! path_exists "$target_path"; then
                mv "$backup_path" "$target_path" || rollback_failed=1
            fi
        fi
    done < "$manifest"

    if [ "$skills_parent_created" -eq 1 ] && [ -d "$codex_home/skills" ]; then
        rmdir "$codex_home/skills" 2>/dev/null || true
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
    if [ "$lock_acquired" -eq 1 ]; then
        rm -f "$lock_dir/pid"
        rmdir "$lock_dir" 2>/dev/null || true
    fi
    exit "$status"
}

trap cleanup 0
trap 'exit 1' 1 2 3 15

if ! mkdir "$lock_dir" 2>/dev/null; then
    lock_pid=
    lock_waits=0
    while [ ! -f "$lock_dir/pid" ] && [ "$lock_waits" -lt 10 ]; do
        lock_waits=$((lock_waits + 1))
        sleep 1
    done
    if [ -f "$lock_dir/pid" ]; then
        lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
    fi
    case $lock_pid in
        ''|*[!0-9]*) ;;
        *)
            if kill -0 "$lock_pid" 2>/dev/null; then
                printf '%s\n' "Another Codex installer is already running for: $codex_home" >&2
                exit 1
            fi
            ;;
    esac
    rm -f "$lock_dir/pid" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || {
        printf '%s\n' "Cannot acquire installer lock: $lock_dir" >&2
        exit 1
    }
    mkdir "$lock_dir" || exit 1
fi
printf '%s\n' "$$" > "$lock_dir/pid"
lock_acquired=1

stage_dir=$(mktemp -d "$codex_home/.install-stage.XXXXXX")
mkdir -p "$stage_dir/state/backed-up" "$stage_dir/state/install-started"
cp "$source_agents" "$stage_dir/AGENTS.md"
cp -R "$source_docs" "$stage_dir/docs"
mkdir "$stage_dir/skills"
for source_skill in "$source_skills"/*; do
    [ -d "$source_skill" ] || continue
    cp -R "$source_skill" "$stage_dir/skills/"
done

assert_target "$codex_home/config.toml" file
config_input=$codex_home/config.toml
if ! path_exists "$config_input"; then
    config_input=$stage_dir/empty-config.toml
    : > "$config_input"
fi
merge_managed_config "$config_input" "$stage_dir/merged-config.toml"

for name in AGENTS.md merged-config.toml docs; do
    if ! path_exists "$stage_dir/$name"; then
        printf '%s\n' "Staging failed for: $name" >&2
        exit 1
    fi
done
for staged_skill in "$stage_dir/skills"/*; do
    if [ ! -d "$staged_skill" ]; then
        printf '%s\n' "Staging failed for skill: $(basename "$staged_skill")" >&2
        exit 1
    fi
done

manifest=$stage_dir/targets.tsv
printf '%s\t%s\t%s\t%s\n' AGENTS.md "$codex_home/AGENTS.md" "$stage_dir/AGENTS.md" file > "$manifest"
printf '%s\t%s\t%s\t%s\n' config.toml "$codex_home/config.toml" "$stage_dir/merged-config.toml" file >> "$manifest"
printf '%s\t%s\t%s\t%s\n' docs "$codex_home/docs" "$stage_dir/docs" directory >> "$manifest"
for staged_skill in "$stage_dir/skills"/*; do
    skill_name=$(basename "$staged_skill")
    printf '%s\t%s\t%s\t%s\n' "skills/$skill_name" "$codex_home/skills/$skill_name" "$staged_skill" directory >> "$manifest"
done

# All source candidates exist now. Validate every destination and backup path before replacing any target.
assert_target "$codex_home/AGENTS.md" file
assert_target "$codex_home/config.toml" file
assert_target "$codex_home/docs" directory
assert_directory_container "$codex_home/skills"
if path_exists "$codex_home/backups"; then
    assert_directory_container "$codex_home/backups"
fi
while IFS="$tab" read -r target_name target_path candidate_path target_kind; do
    assert_target "$target_path" "$target_kind"
done < "$manifest"

has_existing_target=0
while IFS="$tab" read -r target_name target_path candidate_path target_kind; do
    if path_exists "$target_path"; then
        has_existing_target=1
        break
    fi
done < "$manifest"
if [ ! -d "$codex_home/skills" ]; then
    mkdir "$codex_home/skills"
    skills_parent_created=1
fi
if [ "$has_existing_target" -eq 1 ]; then
    mkdir -p "$codex_home/backups"
    backup_dir=$(mktemp -d "$codex_home/backups/backup-$(date +%Y%m%d-%H%M%S)-$$.XXXXXX")
fi

while IFS="$tab" read -r target_name target_path candidate_path target_kind; do
    if path_exists "$target_path"; then
        backup_path=$backup_dir/$target_name
        mkdir -p "$(dirname "$backup_path")"
        mv "$target_path" "$backup_path"
        mark_state backed-up "$target_name"
    fi
    mark_state install-started "$target_name"
    mv "$candidate_path" "$target_path"
done < "$manifest"

completed=1
printf '%s\n' "Codex configuration installed in: $codex_home"
if [ -n "$backup_dir" ]; then
    printf '%s\n' "Backup directory: $backup_dir"
else
    printf '%s\n' 'Backup directory: none (no managed targets existed)'
fi
