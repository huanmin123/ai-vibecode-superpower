#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
installer=$repo_root/install-codex.sh
test_root=$(mktemp -d "${TMPDIR:-/tmp}/codex-install-test.XXXXXX")

cleanup() {
    status=$?
    trap - 0 1 2 3 15
    rm -rf "$test_root"
    exit "$status"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

fail() {
    printf '%s\n' "FAIL: $*" >&2
    exit 1
}

expect_file() {
    [ -f "$1" ] || fail "expected file: $1"
}

expect_directory() {
    [ -d "$1" ] || fail "expected directory: $1"
}

expect_line() {
    rg -Fqx "$2" "$1" >/dev/null || fail "expected line '$2' in $1"
}

make_existing_install() {
    test_home=$1
    mkdir -p "$test_home/docs" "$test_home/skills/gpt-image-2-cli" "$test_home/skills/unmanaged-skill"
    printf '%s\n' 'old agents' > "$test_home/AGENTS.md"
    printf '%s\n' 'model_provider = "custom"' > "$test_home/config.toml"
    printf '%s\n' 'model = "old-model"' >> "$test_home/config.toml"
    printf '%s\n' 'unmanaged_root_setting = true' >> "$test_home/config.toml"
    printf '%s\n' '[agents]' >> "$test_home/config.toml"
    printf '%s\n' 'max_threads = 1' >> "$test_home/config.toml"
    printf '%s\n' '[features]' >> "$test_home/config.toml"
    printf '%s\n' 'goals = false' >> "$test_home/config.toml"
    printf '%s\n' 'old docs' > "$test_home/docs/legacy.txt"
    printf '%s\n' 'old managed skill' > "$test_home/skills/gpt-image-2-cli/legacy.txt"
    printf '%s\n' 'unmanaged skill' > "$test_home/skills/unmanaged-skill/keep.txt"
}

success_home=$test_root/success-home
make_existing_install "$success_home"
CODEX_HOME=$success_home sh "$installer"

backup_dir=$(find "$success_home/backups" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -print -quit)
[ -n "$backup_dir" ] || fail 'successful install did not create a backup directory'
expect_file "$backup_dir/AGENTS.md"
expect_file "$backup_dir/config.toml"
expect_file "$backup_dir/docs/legacy.txt"
expect_file "$backup_dir/skills/gpt-image-2-cli/legacy.txt"
expect_line "$success_home/config.toml" 'model_provider = "custom"'
expect_line "$success_home/config.toml" 'unmanaged_root_setting = true'
expect_line "$success_home/config.toml" 'model = "gpt-5.6-terra"'
expect_file "$success_home/AGENTS.md"
expect_directory "$success_home/docs"
expect_directory "$success_home/skills/gpt-image-2-cli"
expect_file "$success_home/skills/unmanaged-skill/keep.txt"
[ ! -e "$success_home/docs/legacy.txt" ] || fail 'old docs were merged instead of replaced'
[ ! -e "$success_home/skills/gpt-image-2-cli/legacy.txt" ] || fail 'old managed skill was merged instead of replaced'

failure_home=$test_root/failure-home
make_existing_install "$failure_home"
fake_bin=$test_root/fake-bin
mkdir "$fake_bin"
real_mv=$(command -v mv)
cat > "$fake_bin/mv" <<'EOF'
#!/bin/sh
case $1:$2 in
    */merged-config.toml:*/config.toml)
            printf '%s\n' 'intentional move failure' >&2
            exit 1
            ;;
esac
exec "$REAL_MV" "$@"
EOF
chmod +x "$fake_bin/mv"

if CODEX_HOME=$failure_home REAL_MV=$real_mv PATH=$fake_bin:$PATH sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly succeeded after the intentional move failure'
fi

expect_line "$failure_home/AGENTS.md" 'old agents'
expect_line "$failure_home/config.toml" 'model_provider = "custom"'
expect_line "$failure_home/config.toml" 'model = "old-model"'
expect_file "$failure_home/docs/legacy.txt"
expect_file "$failure_home/skills/gpt-image-2-cli/legacy.txt"
expect_file "$failure_home/skills/unmanaged-skill/keep.txt"
[ ! -e "$failure_home/docs/README.md" ] || fail 'new docs remained after rollback'

printf '%s\n' 'install-codex.sh regression tests passed'
