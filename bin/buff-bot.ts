#!/usr/bin/env node
/**
 * buff-bot CLI shim. Delegates to ../scripts/buff-bot.ts.
 *
 * Usage:
 *   pnpm tsx bin/buff-bot.ts --user=tslive03 --character=BuffBot
 *       [--host=10.254.0.253] [--port=44453]
 *       [--planet=tatooine --x=3528 --z=-4804]
 *       [--radius=5] [--rebuff-after-min=25] [--verbose]
 */

await import('../scripts/buff-bot.js');
