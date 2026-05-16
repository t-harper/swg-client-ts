import { defineConfig } from 'vitest/config';

// When CI_REUSE_ACCOUNT is set, the live tests all share one account/character
// pair. The SWG server only allows one active session per account, so parallel
// test files would step on each other. Force-serial in that mode.
const reuseMode = process.env.CI_REUSE_ACCOUNT !== undefined && process.env.CI_REUSE_ACCOUNT !== '';

export default defineConfig({
  test: {
    fileParallelism: !reuseMode,
    // Don't scan ephemeral agent worktrees or other infra dirs.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '**/.git/**'],
  },
});
