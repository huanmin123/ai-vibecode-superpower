#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
source_agents=$script_dir/codex-global-config/AGENTS.md
source_config=$script_dir/codex-global-config/config.toml
source_docs=$script_dir/codex-global-config/docs
source_skills=$script_dir/skills

if [ ! -f "$source_agents" ]; then
    printf '%s\n' "Missing source file: $source_agents" >&2
    exit 1
fi
if [ ! -f "$source_config" ]; then
    printf '%s\n' "Missing source file: $source_config" >&2
    exit 1
fi
if [ ! -d "$source_docs" ]; then
    printf '%s\n' "Missing source directory: $source_docs" >&2
    exit 1
fi
if [ ! -d "$source_skills" ]; then
    printf '%s\n' "Missing source directory: $source_skills" >&2
    exit 1
fi

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
agents_backed_up=0
agents_installed=0
completed=0
lock_dir=$codex_home/.install.lock
lock_acquired=0

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
        [ -e "$child_path" ] || [ -L "$child_path" ] || continue
        assert_no_symlink_tree "$child_path"
    done
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
            return (section == "root" && (key == "model_provider" || key == "model" || key == "model_reasoning_effort")) ||
                   (section == "agents" && (key == "max_threads" || key == "max_depth")) ||
                   (section == "features" && (key == "js_repl" || key == "goals"))
        }
        function flush_missing(section,    key, order, index) {
            if (section == "root") {
                order[1] = "model_provider"; order[2] = "model"; order[3] = "model_reasoning_effort"; count = 3
            } else if (section == "agents") {
                order[1] = "max_threads"; order[2] = "max_depth"; count = 2
            } else if (section == "features") {
                order[1] = "js_repl"; order[2] = "goals"; count = 2
            } else {
                count = 0
            }
            for (index = 1; index <= count; index++) {
                key = order[index]
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
                if (managed_key(section == "other" ? "other" : (section == "" ? "root" : section), key)) {
                    value[(section == "" ? "root" : section) SUBSEP key] = substr($0, index($0, "=") + 1)
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value[(section == "" ? "root" : section) SUBSEP key])
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
            required["root" SUBSEP "model_provider"] = 1
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

cleanup() {
    status=$?
    if [ "$completed" -ne 1 ]; then
        if [ "$agents_installed" -eq 1 ] && { [ -e "$codex_home/AGENTS.md" ] || [ -L "$codex_home/AGENTS.md" ]; }; then
            rm -f "$codex_home/AGENTS.md"
        fi
        if [ "$agents_backed_up" -eq 1 ] && { [ -e "$backup_dir/AGENTS.md" ] || [ -L "$backup_dir/AGENTS.md" ]; } && \
           [ ! -e "$codex_home/AGENTS.md" ] && [ ! -L "$codex_home/AGENTS.md" ]; then
            mv "$backup_dir/AGENTS.md" "$codex_home/AGENTS.md"
        fi
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
cp "$source_agents" "$stage_dir/AGENTS.md"
cp "$source_config" "$stage_dir/config.toml"
cp -R "$source_docs" "$stage_dir/docs"
mkdir "$stage_dir/skills"
for source_skill in "$source_skills"/*; do
    [ -d "$source_skill" ] || continue
    cp -R "$source_skill" "$stage_dir/skills/"
done

for name in AGENTS.md config.toml docs; do
    if [ ! -e "$stage_dir/$name" ]; then
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

mkdir -p "$codex_home/docs"
assert_no_symlink_tree "$codex_home/docs"
cp -R "$stage_dir/docs"/. "$codex_home/docs/"
config_input=$codex_home/config.toml
assert_no_symlink_tree "$config_input"
if [ ! -f "$config_input" ]; then
    config_input=$stage_dir/empty-config.toml
    : > "$config_input"
fi
merge_managed_config "$config_input" "$stage_dir/merged-config.toml"
cp "$stage_dir/merged-config.toml" "$codex_home/config.toml"
mkdir -p "$codex_home/skills"
for staged_skill in "$stage_dir/skills"/*; do
    skill_name=$(basename "$staged_skill")
    mkdir -p "$codex_home/skills/$skill_name"
    assert_no_symlink_tree "$codex_home/skills/$skill_name"
    cp -R "$staged_skill"/. "$codex_home/skills/$skill_name/"
done

if [ -e "$codex_home/AGENTS.md" ] || [ -L "$codex_home/AGENTS.md" ]; then
    mkdir -p "$codex_home/backups"
    backup_dir=$(mktemp -d "$codex_home/backups/$(date +%Y%m%d-%H%M%S)-$$.XXXXXX")
    mv "$codex_home/AGENTS.md" "$backup_dir/AGENTS.md"
    agents_backed_up=1
fi
mv "$stage_dir/AGENTS.md" "$codex_home/AGENTS.md"
agents_installed=1

completed=1
printf '%s\n' "Codex configuration installed in: $codex_home"
if [ -n "$backup_dir" ]; then
    printf '%s\n' "Backup directory: $backup_dir"
else
    printf '%s\n' 'Backup directory: none (AGENTS.md did not exist)'
fi
