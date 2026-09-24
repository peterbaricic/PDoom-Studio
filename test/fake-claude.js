#!/usr/bin/env bun
// fake-claude.js: stands in for the Claude CLI in tests. $FAKE_CLAUDE_PLAN is
// { runs: [{ files: { path: content }, cost, isError, result, exit, sleep }] }, one entry per invocation in the same
// folder (counted in .fake-runs). Each invocation's arguments are appended as JSON to $FAKE_CLAUDE_LOG if set.
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const plan = JSON.parse(process.env.FAKE_CLAUDE_PLAN || '{"runs":[{}]}');
const n = existsSync('.fake-runs') ? +readFileSync('.fake-runs', 'utf8') : 0;
writeFileSync('.fake-runs', String(n + 1));
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
const run = plan.runs[Math.min(n, plan.runs.length - 1)];
const out = o => console.log(JSON.stringify(o));

out({ type: 'system', subtype: 'init', model: 'fake' });
if (run.sleep) await Bun.sleep(run.sleep);
for (const [p, c] of Object.entries(run.files || {})) {
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c);
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: p } }] } });
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } });
out({ type: 'result', subtype: run.isError ? 'error' : 'success', is_error: !!run.isError, result: run.result || 'ok', total_cost_usd: run.cost ?? .01 });
process.exit(run.exit ?? 0);
