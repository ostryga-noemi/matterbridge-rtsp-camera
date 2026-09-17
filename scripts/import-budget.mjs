import { performance } from 'node:perf_hooks';

const budgetMs = Number(process.env.PLUGIN_IMPORT_BUDGET_MS ?? 5000);
const started = performance.now();
await import('../dist/module.js');
const elapsed = performance.now() - started;
console.log(`Plugin entrypoint import: ${elapsed.toFixed(1)}ms (budget ${budgetMs}ms)`);
if (elapsed > budgetMs) {
  throw new Error(`Plugin entrypoint import ${elapsed.toFixed(1)}ms exceeds ${budgetMs}ms budget`);
}
