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

expect_role_contract() {
    role_path=$1
    expected_name=$2
    expected_model=$3
    expected_effort=$4
    expected_sandbox=$5

    expect_line "$role_path" "name = \"$expected_name\""
    expect_line "$role_path" "model = \"$expected_model\""
    expect_line "$role_path" "model_reasoning_effort = \"$expected_effort\""
    expect_line "$role_path" "sandbox_mode = \"$expected_sandbox\""
}

expect_exact_managed_role_files() {
    role_directory=$1
    role_count=0

    for role_path in "$role_directory"/* "$role_directory"/.[!.]* "$role_directory"/..?*; do
        [ -e "$role_path" ] || continue
        [ -f "$role_path" ] || fail "expected role file: $role_path"
        case $(basename "$role_path") in
            ai-vibecode-superpower-avsp_luna_high.toml|\
            ai-vibecode-superpower-avsp_luna_xhigh.toml|\
            ai-vibecode-superpower-avsp_sol_high.toml|\
            ai-vibecode-superpower-avsp_sol_xhigh.toml|\
            ai-vibecode-superpower-avsp_terra_high.toml|\
            ai-vibecode-superpower-avsp_terra_xhigh.toml|\
            ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml|\
            ai-vibecode-superpower-avsp_terra_low_readonly.toml|\
            ai-vibecode-superpower-avsp_terra_medium_readonly.toml)
                ;;
            *)
                fail "unexpected managed role file: $role_path"
                ;;
        esac
        role_count=$((role_count + 1))
    done
    [ "$role_count" -eq 9 ] || fail "expected 9 managed role files, found: $role_count"
}

copy_installer_fixture() {
    fixture_root=$1

    mkdir "$fixture_root"
    cp "$installer" "$fixture_root/install-codex.sh"
    cp -R "$repo_root/codex-global-config" "$fixture_root/codex-global-config"
    cp -R "$repo_root/skills" "$fixture_root/skills"
}

expect_invalid_source_rejected() {
    fixture_root=$1
    fixture_home=$2

    if CODEX_HOME=$fixture_home sh "$fixture_root/install-codex.sh" >/dev/null 2>&1; then
        fail "installer unexpectedly accepted invalid role source: $fixture_root"
    fi
    [ ! -e "$fixture_home/AGENTS.md" ] || fail "invalid source wrote a managed target: $fixture_root"
    [ ! -e "$fixture_home/config.toml" ] || fail "invalid source wrote a managed target: $fixture_root"
    [ ! -e "$fixture_home/docs" ] || fail "invalid source wrote a managed target: $fixture_root"
    [ ! -e "$fixture_home/agents/ai-vibecode-superpower" ] || fail "invalid source wrote a managed target: $fixture_root"
    [ ! -e "$fixture_home/skills" ] || fail "invalid source wrote a managed target: $fixture_root"
}

make_existing_install() {
    test_home=$1
    mkdir -p "$test_home/docs" "$test_home/agents/ai-vibecode-superpower" "$test_home/skills/gpt-image-2-cli" "$test_home/skills/unmanaged-skill"
    printf '%s\n' 'old agents' > "$test_home/AGENTS.md"
    printf '%s\n' 'model_provider = "custom"' > "$test_home/config.toml"
    printf '%s\n' 'model = "old-model"' >> "$test_home/config.toml"
    printf '%s\n' 'unmanaged_root_setting = true' >> "$test_home/config.toml"
    printf '%s\n' 'unmanaged_list = ["one", "two"]' >> "$test_home/config.toml"
    printf '%s\n' 'unmanaged_inline = { enabled = true }' >> "$test_home/config.toml"
    printf '%s\n' '[agents]' >> "$test_home/config.toml"
    printf '%s\n' 'max_threads = 1' >> "$test_home/config.toml"
    printf '%s\n' '[features]' >> "$test_home/config.toml"
    printf '%s\n' 'goals = false' >> "$test_home/config.toml"
    printf '%s\n' 'old docs' > "$test_home/docs/legacy.txt"
    printf '%s\n' 'old managed agent role' > "$test_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_high.toml"
    printf '%s\n' 'unmanaged agent role' > "$test_home/agents/user-role.toml"
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
expect_file "$backup_dir/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_high.toml"
expect_file "$backup_dir/skills/gpt-image-2-cli/legacy.txt"
expect_line "$success_home/config.toml" 'model_provider = "custom"'
expect_line "$success_home/config.toml" 'unmanaged_root_setting = true'
expect_line "$success_home/config.toml" 'unmanaged_list = ["one", "two"]'
expect_line "$success_home/config.toml" 'unmanaged_inline = { enabled = true }'
expect_line "$success_home/config.toml" 'model = "gpt-5.6-terra"'
expect_line "$success_home/config.toml" 'model_reasoning_effort = "xhigh"'
expect_file "$success_home/AGENTS.md"
expect_directory "$success_home/docs"
expect_file "$success_home/skills/orchestrate-model-workflow/SKILL.md"
rg -F '不要求 worker 自报不可见的运行时模型、推理强度或 sandbox' "$success_home/skills/orchestrate-model-workflow/SKILL.md" >/dev/null || fail 'installed workflow still requires worker runtime metadata self-reporting'
if rg -F '返回其固定 role、模型/推理强度和“未写入”确认' "$success_home/skills/orchestrate-model-workflow" >/dev/null; then
    fail 'installed workflow restored the worker runtime metadata self-reporting gate'
fi
expect_exact_managed_role_files "$success_home/agents/ai-vibecode-superpower"
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_high.toml" avsp_luna_high gpt-5.6-luna high read-only
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_xhigh.toml" avsp_luna_xhigh gpt-5.6-luna xhigh read-only
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_sol_high.toml" avsp_sol_high gpt-5.6-sol high read-only
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_sol_xhigh.toml" avsp_sol_xhigh gpt-5.6-sol xhigh read-only
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_terra_high.toml" avsp_terra_high gpt-5.6-terra high workspace-write
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_terra_xhigh.toml" avsp_terra_xhigh gpt-5.6-terra xhigh workspace-write
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_terra_xhigh_readonly.toml" avsp_terra_xhigh_readonly gpt-5.6-terra xhigh read-only
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_terra_low_readonly.toml" avsp_terra_low_readonly gpt-5.6-terra low read-only
expect_role_contract "$success_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_terra_medium_readonly.toml" avsp_terra_medium_readonly gpt-5.6-terra medium read-only
expect_file "$success_home/agents/user-role.toml"
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
    */agents/ai-vibecode-superpower:*/agents/ai-vibecode-superpower)
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
expect_line "$failure_home/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_high.toml" 'old managed agent role'
expect_file "$failure_home/agents/user-role.toml"
expect_file "$failure_home/skills/gpt-image-2-cli/legacy.txt"
expect_file "$failure_home/skills/unmanaged-skill/keep.txt"
[ ! -e "$failure_home/docs/README.md" ] || fail 'new docs remained after rollback'

new_agents_failure_home=$test_root/new-agents-failure-home
make_existing_install "$new_agents_failure_home"
rm -rf "$new_agents_failure_home/agents"
if CODEX_HOME=$new_agents_failure_home REAL_MV=$real_mv PATH=$fake_bin:$PATH sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly succeeded after the intentional move failure with a new agents parent'
fi
expect_line "$new_agents_failure_home/AGENTS.md" 'old agents'
expect_line "$new_agents_failure_home/config.toml" 'model = "old-model"'
expect_file "$new_agents_failure_home/docs/legacy.txt"
[ ! -e "$new_agents_failure_home/agents" ] || fail 'rollback retained an empty agents parent created by the installer'

invalid_contract_fixture=$test_root/invalid-contract-fixture
copy_installer_fixture "$invalid_contract_fixture"
invalid_contract_role=$invalid_contract_fixture/codex-global-config/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_high.toml
awk '
    $0 == "model = \"gpt-5.6-luna\"" {
        print "model = \"unexpected-model\""
        next
    }
    { print }
' "$invalid_contract_role" > "$invalid_contract_role.tmp"
mv "$invalid_contract_role.tmp" "$invalid_contract_role"
expect_invalid_source_rejected "$invalid_contract_fixture" "$test_root/invalid-contract-home"

invalid_developer_instructions_fixture=$test_root/invalid-developer-instructions-fixture
copy_installer_fixture "$invalid_developer_instructions_fixture"
invalid_developer_instructions_role=$invalid_developer_instructions_fixture/codex-global-config/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_luna_high.toml
awk '
    $0 == "\"\"\"" {
        print "\"\"\" trailing"
        next
    }
    { print }
' "$invalid_developer_instructions_role" > "$invalid_developer_instructions_role.tmp"
mv "$invalid_developer_instructions_role.tmp" "$invalid_developer_instructions_role"
expect_invalid_source_rejected "$invalid_developer_instructions_fixture" "$test_root/invalid-developer-instructions-home"

mutated_developer_instructions_fixture=$test_root/mutated-developer-instructions-fixture
copy_installer_fixture "$mutated_developer_instructions_fixture"
mutated_developer_instructions_role=$mutated_developer_instructions_fixture/codex-global-config/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_sol_high.toml
awk '
    /仅做只读分析/ {
        sub(/仅做只读分析/, "允许写入")
    }
    { print }
' "$mutated_developer_instructions_role" > "$mutated_developer_instructions_role.tmp"
mv "$mutated_developer_instructions_role.tmp" "$mutated_developer_instructions_role"
expect_invalid_source_rejected "$mutated_developer_instructions_fixture" "$test_root/mutated-developer-instructions-home"

missing_role_fixture=$test_root/missing-role-fixture
copy_installer_fixture "$missing_role_fixture"
rm -f "$missing_role_fixture/codex-global-config/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_terra_low_readonly.toml"
expect_invalid_source_rejected "$missing_role_fixture" "$test_root/missing-role-home"

unexpected_role_fixture=$test_root/unexpected-role-fixture
copy_installer_fixture "$unexpected_role_fixture"
printf '%s\n' 'name = "unexpected"' > "$unexpected_role_fixture/codex-global-config/agents/ai-vibecode-superpower/unexpected.toml"
expect_invalid_source_rejected "$unexpected_role_fixture" "$test_root/unexpected-role-home"

invalid_toml_fixture=$test_root/invalid-toml-fixture
copy_installer_fixture "$invalid_toml_fixture"
printf '%s\n' 'invalid_field = [' >> "$invalid_toml_fixture/codex-global-config/agents/ai-vibecode-superpower/ai-vibecode-superpower-avsp_sol_high.toml"
expect_invalid_source_rejected "$invalid_toml_fixture" "$test_root/invalid-toml-home"

reserved_name_home=$test_root/reserved-name-home
make_existing_install "$reserved_name_home"
printf '%s\n' 'name = "avsp_custom"' > "$reserved_name_home/agents/user-role.toml"
if CODEX_HOME=$reserved_name_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a user role in the reserved avsp_ namespace'
fi
expect_line "$reserved_name_home/AGENTS.md" 'old agents'
expect_file "$reserved_name_home/agents/user-role.toml"
[ ! -d "$reserved_name_home/backups" ] || fail 'reserved role conflict created a backup before rejecting the install'

literal_reserved_name_home=$test_root/literal-reserved-name-home
make_existing_install "$literal_reserved_name_home"
printf "%s\n" "name = 'avsp_custom'" > "$literal_reserved_name_home/agents/user-role.toml"
if CODEX_HOME=$literal_reserved_name_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a literal-string reserved agent role'
fi
[ ! -d "$literal_reserved_name_home/backups" ] || fail 'literal-string reserved role conflict created a backup before rejecting the install'

hidden_reserved_name_home=$test_root/hidden-reserved-name-home
make_existing_install "$hidden_reserved_name_home"
printf '%s\n' 'name = "avsp_custom"' > "$hidden_reserved_name_home/agents/.user-role.toml"
if CODEX_HOME=$hidden_reserved_name_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a hidden reserved agent role'
fi
[ ! -d "$hidden_reserved_name_home/backups" ] || fail 'hidden reserved role conflict created a backup before rejecting the install'

quoted_key_reserved_name_home=$test_root/quoted-key-reserved-name-home
make_existing_install "$quoted_key_reserved_name_home"
printf '%s\n' '"name" = "avsp_custom"' > "$quoted_key_reserved_name_home/agents/user-role.toml"
if CODEX_HOME=$quoted_key_reserved_name_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a quoted-key reserved agent role'
fi
[ ! -d "$quoted_key_reserved_name_home/backups" ] || fail 'quoted-key reserved role conflict created a backup before rejecting the install'

escaped_reserved_name_home=$test_root/escaped-reserved-name-home
make_existing_install "$escaped_reserved_name_home"
printf '%s\n' 'name = "\u0061vsp_custom"' > "$escaped_reserved_name_home/agents/user-role.toml"
if CODEX_HOME=$escaped_reserved_name_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted an escaped reserved agent role'
fi
[ ! -d "$escaped_reserved_name_home/backups" ] || fail 'escaped reserved role conflict created a backup before rejecting the install'

unsafe_toml_home=$test_root/unsafe-toml-home
make_existing_install "$unsafe_toml_home"
printf '%s\n' 'notes = """' > "$unsafe_toml_home/config.toml"
printf '%s\n' 'model = "inside-a-string"' >> "$unsafe_toml_home/config.toml"
printf '%s\n' '"""' >> "$unsafe_toml_home/config.toml"
cp "$unsafe_toml_home/config.toml" "$unsafe_toml_home/config.before.toml"
if CODEX_HOME=$unsafe_toml_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a multiline TOML value'
fi
cmp -s "$unsafe_toml_home/config.toml" "$unsafe_toml_home/config.before.toml" || fail 'unsafe TOML changed config.toml before rejection'
[ ! -d "$unsafe_toml_home/backups" ] || fail 'unsafe TOML created a backup before rejection'

quoted_managed_key_home=$test_root/quoted-managed-key-home
make_existing_install "$quoted_managed_key_home"
printf '%s\n' '"model" = "old-model"' > "$quoted_managed_key_home/config.toml"
cp "$quoted_managed_key_home/config.toml" "$quoted_managed_key_home/config.before.toml"
if CODEX_HOME=$quoted_managed_key_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a quoted managed TOML key'
fi
cmp -s "$quoted_managed_key_home/config.toml" "$quoted_managed_key_home/config.before.toml" || fail 'quoted managed TOML key changed config.toml before rejection'
[ ! -d "$quoted_managed_key_home/backups" ] || fail 'quoted managed TOML key created a backup before rejection'

cross_line_value_home=$test_root/cross-line-value-home
make_existing_install "$cross_line_value_home"
printf '%s\n' 'plugins = [' > "$cross_line_value_home/config.toml"
printf '%s\n' '  "plugin-a",' >> "$cross_line_value_home/config.toml"
printf '%s\n' ']' >> "$cross_line_value_home/config.toml"
cp "$cross_line_value_home/config.toml" "$cross_line_value_home/config.before.toml"
if CODEX_HOME=$cross_line_value_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a cross-line TOML value'
fi
cmp -s "$cross_line_value_home/config.toml" "$cross_line_value_home/config.before.toml" || fail 'cross-line TOML value changed config.toml before rejection'
[ ! -d "$cross_line_value_home/backups" ] || fail 'cross-line TOML value created a backup before rejection'

embedded_cross_line_value_home=$test_root/embedded-cross-line-value-home
make_existing_install "$embedded_cross_line_value_home"
printf '%s\n' 'plugins = ["plugin-a",' > "$embedded_cross_line_value_home/config.toml"
printf '%s\n' 'model = "inside"]' >> "$embedded_cross_line_value_home/config.toml"
cp "$embedded_cross_line_value_home/config.toml" "$embedded_cross_line_value_home/config.before.toml"
if CODEX_HOME=$embedded_cross_line_value_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted an embedded cross-line TOML value'
fi
cmp -s "$embedded_cross_line_value_home/config.toml" "$embedded_cross_line_value_home/config.before.toml" || fail 'embedded cross-line TOML value changed config.toml before rejection'
[ ! -d "$embedded_cross_line_value_home/backups" ] || fail 'embedded cross-line TOML value created a backup before rejection'

root_table_key_home=$test_root/root-table-key-home
make_existing_install "$root_table_key_home"
printf '%s\n' 'agents = { custom = true }' > "$root_table_key_home/config.toml"
cp "$root_table_key_home/config.toml" "$root_table_key_home/config.before.toml"
if CODEX_HOME=$root_table_key_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a managed table root key'
fi
cmp -s "$root_table_key_home/config.toml" "$root_table_key_home/config.before.toml" || fail 'managed table root key changed config.toml before rejection'
[ ! -d "$root_table_key_home/backups" ] || fail 'managed table root key created a backup before rejection'

managed_scalar_table_home=$test_root/managed-scalar-table-home
make_existing_install "$managed_scalar_table_home"
printf '%s\n' '[model_reasoning_effort]' > "$managed_scalar_table_home/config.toml"
printf '%s\n' 'value = "xhigh"' >> "$managed_scalar_table_home/config.toml"
cp "$managed_scalar_table_home/config.toml" "$managed_scalar_table_home/config.before.toml"
if CODEX_HOME=$managed_scalar_table_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a managed scalar table'
fi
cmp -s "$managed_scalar_table_home/config.toml" "$managed_scalar_table_home/config.before.toml" || fail 'managed scalar table changed config.toml before rejection'
[ ! -d "$managed_scalar_table_home/backups" ] || fail 'managed scalar table created a backup before rejection'

managed_array_table_home=$test_root/managed-array-table-home
make_existing_install "$managed_array_table_home"
printf '%s\n' '[[agents]]' > "$managed_array_table_home/config.toml"
printf '%s\n' 'custom = true' >> "$managed_array_table_home/config.toml"
cp "$managed_array_table_home/config.toml" "$managed_array_table_home/config.before.toml"
if CODEX_HOME=$managed_array_table_home sh "$installer" >/dev/null 2>&1; then
    fail 'installer unexpectedly accepted a managed array table'
fi
cmp -s "$managed_array_table_home/config.toml" "$managed_array_table_home/config.before.toml" || fail 'managed array table changed config.toml before rejection'
[ ! -d "$managed_array_table_home/backups" ] || fail 'managed array table created a backup before rejection'

complex_existing_home=$test_root/complex-existing-home
make_existing_install "$complex_existing_home"
printf '%s\n' '[projects."/tmp/example"]' >> "$complex_existing_home/config.toml"
printf '%s\n' 'name = "kept"' >> "$complex_existing_home/config.toml"
printf '%s\n' '[[skills.config]]' >> "$complex_existing_home/config.toml"
printf '%s\n' 'path = "kept"' >> "$complex_existing_home/config.toml"
CODEX_HOME=$complex_existing_home sh "$installer" >/dev/null
expect_line "$complex_existing_home/config.toml" '[projects."/tmp/example"]'
expect_line "$complex_existing_home/config.toml" '[[skills.config]]'
expect_line "$complex_existing_home/config.toml" 'path = "kept"'

existing_lock_home=$test_root/existing-lock-home
make_existing_install "$existing_lock_home"
printf '%s\n' 'old lock metadata is harmless without an active advisory lock' > "$existing_lock_home/.install.lock"
CODEX_HOME=$existing_lock_home sh "$installer" >/dev/null
expect_file "$existing_lock_home/.install.lock"

if [ "$(uname -s)" = Darwin ]; then
    lock_contention_home=$test_root/lock-contention-home
    make_existing_install "$lock_contention_home"
    lockf "$lock_contention_home/.install.lock" sleep 3 &
    lock_holder_pid=$!
    sleep 1
    if AVSP_INSTALL_LOCK_HELD=1 CODEX_HOME=$lock_contention_home sh "$installer" >/dev/null 2>&1; then
        kill "$lock_holder_pid" 2>/dev/null || true
        wait "$lock_holder_pid" 2>/dev/null || true
        fail 'installer unexpectedly acquired an active advisory lock'
    fi
    wait "$lock_holder_pid"
    expect_line "$lock_contention_home/AGENTS.md" 'old agents'
fi

printf '%s\n' 'install-codex.sh regression tests passed'
