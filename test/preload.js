// preload.js: runs before every `bun test` file (bunfig.toml's [test] preload). No test may ever run the real Claude
// CLI, not even `claude auth status` behind the studio's health check: CLAUDE_BIN is pinned to the fake here, so an
// in-process app (createApp's default is process.env.CLAUDE_BIN || 'claude') and every spawned server (they inherit
// process.env, through isolatedEnv or directly) get the fake unless a test names another stand-in itself.
import { join } from 'node:path';

export const FAKE_CLAUDE_BIN = `bun ${join(import.meta.dir, 'fake-claude.js')}`;
process.env.CLAUDE_BIN = FAKE_CLAUDE_BIN;
