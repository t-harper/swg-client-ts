/**
 * verifyAbilities — best-effort check that the character has the signature
 * abilities the profession's rotation expects. Logs (does NOT throw) when
 * abilities are missing: provisioning is the host's responsibility, and
 * the framework still installs cleanly so cooldown-gated slots simply skip.
 */

import type { CreatureObjectClientServerNpBaseline } from '../../../messages/game/baselines/creature-object-baseline-4.js';
import { BaselinePackageIds } from '../../../messages/game/baselines/registry.js';
import type { NetworkId } from '../../../types.js';
import type { WorldModel } from '../../world-model.js';
import type { ProfessionId, Rotation } from './types.js';

export interface AbilityCheckResult {
  /** True when every signature ability is present. */
  ok: boolean;
  /** Count of known commands on the player CREO. */
  knownCount: number;
  /** Signature abilities that are missing (lowercase). */
  missing: readonly string[];
}

export interface VerifyAbilitiesOpts {
  /** Override the rotation that supplies `signatureAbilities`. */
  rotation: Rotation;
  /** Logger override; defaults to `console.warn`. */
  logFn?: (msg: string) => void;
}

/**
 * The minimal surface `verifyAbilities` needs. Defined locally so tests can
 * construct a fake without bringing in the whole ScriptContext.
 */
export interface VerifyAbilitiesHost {
  readonly world: WorldModel;
  readonly sceneStart: { playerNetworkId: NetworkId };
}

/**
 * Scan the player's CREO `CLIENT_SERVER_NP` baseline for the `commands`
 * map and check that every entry in `opts.rotation.signatureAbilities` is
 * present. Returns the check result; if any are missing, also logs via
 * `opts.logFn` (defaults to `console.warn`).
 *
 * Never throws — a missing CREO baseline or empty commands map simply
 * means we can't verify yet, and the result reports every signature
 * ability as missing.
 */
export function verifyAbilities(
  host: VerifyAbilitiesHost,
  profession: ProfessionId,
  opts: VerifyAbilitiesOpts,
): AbilityCheckResult {
  const logFn = opts.logFn ?? ((msg: string): void => console.warn(msg));
  const known = readKnownCommands(host);

  const missing: string[] = [];
  for (const name of opts.rotation.signatureAbilities) {
    if (!known.has(name.toLowerCase())) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    logFn(
      `[combat:${profession}] missing ${missing.length} signature ${
        missing.length === 1 ? 'ability' : 'abilities'
      }: ${missing.join(', ')}`,
    );
  }

  return {
    ok: missing.length === 0,
    knownCount: known.size,
    missing,
  };
}

/**
 * Read the lowercased set of known commands from the player's CREO p4
 * baseline. Returns an empty set if the player CREO isn't visible or the
 * baseline hasn't decoded yet.
 *
 * Exposed for tests and advanced consumers that want to introspect the
 * command set directly (e.g. to filter rotations to "abilities I actually
 * have at this tier").
 */
export function readKnownCommands(host: VerifyAbilitiesHost): Set<string> {
  const out = new Set<string>();
  const player = host.world.get(host.sceneStart.playerNetworkId);
  if (player === undefined) return out;
  const p4 = player.baselines.get(BaselinePackageIds.CLIENT_SERVER_NP) as
    | CreatureObjectClientServerNpBaseline
    | undefined;
  if (p4 === undefined || !Array.isArray(p4.commands)) return out;
  for (const entry of p4.commands) {
    if (typeof entry?.name === 'string') {
      out.add(entry.name.toLowerCase());
    }
  }
  return out;
}
