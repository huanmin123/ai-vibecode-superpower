# sql.js

This plugin bundles `sql.js` 1.14.1 for its task-state SQLite runtime.

- Upstream: https://github.com/sql-js/sql.js
- License: MIT, reproduced in `LICENSE`.
- npm package integrity: `sha512-gcj8zBWU5cFsi9WUP+4bFNXAyF1iRpA3LLyS/DP5xlrNzGmPIizUeBggKa8DbDwdqaKwUcTEnChtd2grWo/x/A==`

Only `sql-wasm.js` and `sql-wasm.wasm` are loaded at runtime. The controller uses
one SQLite database per task and atomically replaces the database file after a
successful state update.
