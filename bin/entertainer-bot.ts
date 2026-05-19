#!/usr/bin/env node
/**
 * entertainer-bot CLI shim. Delegates to ../scripts/entertainer-bot.ts.
 *
 * Usage:
 *   pnpm tsx bin/entertainer-bot.ts --user=tslive06 --character=Bard
 *       [--host=10.254.0.253] [--port=44453]
 *       [--planet=tatooine --x=3477 --z=-4857]
 *       [--rebuff-after-min=2] [--verbose]
 */

await import('../scripts/entertainer-bot.js');
