#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
source_agents=$script_dir/codex-global-config/AGENTS.md
source_docs=$script_dir/codex-global-config/docs
source_skills=$script_dir/skills

if [ ! -f "$source_agents" ]; then
    printf '%s\n' "Missing source file: $source_agents" >&2
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
backed_targets=
installed_targets=
completed=0
lock_dir=$codex_home/.install.lock
lock_acquired=0

cleanup() {
    status=$?
    if [ "$completed" -ne 1 ]; then
        for name in $installed_targets; do
            rm -rf "$codex_home/$name"
        done
        for name in $backed_targets; do
            if [ -e "$backup_dir/$name" ] || [ -L "$backup_dir/$name" ]; then
                if [ ! -e "$codex_home/$name" ] && [ ! -L "$codex_home/$name" ]; then
                    mkdir -p "$(dirname "$codex_home/$name")"
                    mv "$backup_dir/$name" "$codex_home/$name"
                fi
            fi
        done
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
cp -R "$source_docs" "$stage_dir/docs"
mkdir "$stage_dir/skills"
for source_skill in "$source_skills"/*; do
    [ -d "$source_skill" ] || continue
    cp -R "$source_skill" "$stage_dir/skills/"
done

for name in AGENTS.md docs; do
    if [ ! -e "$stage_dir/$name" ]; then
        printf '%s\n' "Staging failed for: $name" >&2
        exit 1
    fi
done
for staged_skill in "$stage_dir/skills"/*; do
    [ -d "$staged_skill" ] || continue
done

mkdir -p "$codex_home/backups"
backup_dir=$(mktemp -d "$codex_home/backups/$(date +%Y%m%d-%H%M%S)-$$.XXXXXX")

for name in AGENTS.md docs; do
    if [ -e "$codex_home/$name" ] || [ -L "$codex_home/$name" ]; then
        mv "$codex_home/$name" "$backup_dir/$name"
        backed_targets="$backed_targets $name"
    fi
done
for staged_skill in "$stage_dir/skills"/*; do
    [ -d "$staged_skill" ] || continue
    skill_name=$(basename "$staged_skill")
    if [ -e "$codex_home/skills/$skill_name" ] || [ -L "$codex_home/skills/$skill_name" ]; then
        mkdir -p "$backup_dir/skills"
        mv "$codex_home/skills/$skill_name" "$backup_dir/skills/$skill_name"
        backed_targets="$backed_targets skills/$skill_name"
    fi
done

for name in AGENTS.md docs; do
    mv "$stage_dir/$name" "$codex_home/$name"
    installed_targets="$installed_targets $name"
done
mkdir -p "$codex_home/skills"
for staged_skill in "$stage_dir/skills"/*; do
    [ -d "$staged_skill" ] || continue
    skill_name=$(basename "$staged_skill")
    mv "$staged_skill" "$codex_home/skills/$skill_name"
    installed_targets="$installed_targets skills/$skill_name"
done

completed=1
printf '%s\n' "Codex configuration installed in: $codex_home"
printf '%s\n' "Backup directory: $backup_dir"
