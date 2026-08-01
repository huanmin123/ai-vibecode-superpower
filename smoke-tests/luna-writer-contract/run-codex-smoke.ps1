$ErrorActionPreference = 'Stop'

$smokeDirectory = $PSScriptRoot
$lastMessagePath = Join-Path $smokeDirectory 'artifacts\last-message.txt'
$prompt = @'
这是一次隔离的角色链路验证。必须遵守已安装的 orchestrate-model-workflow：主控不得直接写入；主控应派遣 avsp_terra_high，Terra/high 持有一级责任并作为 avsp_luna_high_writer 的直接父代理。请由 Terra 给 Luna writer 下达以下完整 ImplementationContract，并让 Luna writer 实施；Terra 只审核 diff、运行验证并总结，不得替 Luna 写 src/order-total.mjs。

work_id: luna-writer-production-code-smoke
目标行为：实现 calculateOrderTotal(lines)，返回每项 unitPriceCents * quantity 的整数分之和；空数组返回 0。
允许目标及唯一所有权：仅 src/order-total.mjs，唯一 writer 为 avsp_luna_high_writer。
不变量：lines 必须是数组；每项必须是非 null 对象，unitPriceCents 为非负安全整数，quantity 为正安全整数；任一条件不满足时抛 TypeError；不得修改输入数组或其中对象。
基线/示例：现有 test/order-total.test.mjs 是验收示例，199*2 + 450*1 必须返回 848。
验证：只运行 npm test，并在父 Terra 的结果中回传实际 diff 与命令输出。
停止条件：若发现契约缺口、所有权冲突、测试与契约矛盾、范围漂移或需要设计取舍，Luna 立即停止并交回 Terra；不得修改 package.json、test/ 或 artifacts/。

完成后只报告角色链路、修改文件、测试结果和任何停止/升级情况。
'@

& 'E:\node\node_global\codex.ps1' exec --json --output-last-message $lastMessagePath --cd $smokeDirectory $prompt
exit $LASTEXITCODE
