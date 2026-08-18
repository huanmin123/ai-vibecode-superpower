import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { maintainGlobalWorkflowStoreSpace } from './global_workflow_store.mjs';
import { pruneExpiredTasksAtMcpStartup } from './workflow_controller.mjs';

// This process is intentionally silent. It is an internal retention worker;
// MCP clients should only observe task state, never maintenance chatter.
export async function main() {
  await pruneExpiredTasksAtMcpStartup();
  await maintainGlobalWorkflowStoreSpace();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch { process.exitCode = 1; }
}
