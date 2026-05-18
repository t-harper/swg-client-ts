/**
 * _lib-survey.ts — shared survey-tool discovery helpers for example scripts.
 *
 * The server's `requestSurvey` command takes:
 *   - target  = NetworkId of an in-inventory survey tool (NOT the player)
 *   - params  = a SPECIFIC spawned resource type name (e.g. "Resotine"),
 *               NOT a class name like "mineral".
 *
 * Use these helpers from a `ScenarioFn` to:
 *   1. `findSurveyTools(ctx)` — scan the live `ctx.inventory` for survey
 *      tools and map each class (`mineral`, `gas`, ...) to its tool id.
 *      Also walks any nested containers (bag, datapad, …) via the live
 *      `ctx.findInContainer(id)` WorldModel query.
 *   2. `pickToolForClass(tools, 'mineral')` — return either the matching
 *      class tool or the universal tool if available.
 *   3. `fetchTypeNamesForClass(ctx, tools, 'mineral')` — return the list
 *      of spawned resource type names available at the current location.
 *
 * `survey-loop.ts`, `multi-resource-survey.ts`, `survey-walking-grid.ts`,
 * `gradient-ascent-survey.ts` and `find-best-resource.ts` all use this.
 *
 * The canonical reference implementation (with more diagnostic output) is
 * in `scripts/check-resources-at-location.ts`.
 */

import type { NetworkId, ResourceListItem, ScriptContext, WorldObject } from '../../src/index.js';

/**
 * Template short-names returned over the wire are truncated (e.g.
 * `survey_tool_geo_n` rather than `survey_tool_geo_thermal`). Patterns
 * match the leading prefix that fits inside the truncated form. Mirrors
 * the table in `scripts/check-resources-at-location.ts`.
 */
const TOOL_TEMPLATE_TO_CLASSES: Array<{ pattern: RegExp; classes: string[] }> = [
  { pattern: /survey_tool_all\b/, classes: ['*'] }, // universal — handles every class
  { pattern: /survey_tool_mineral/, classes: ['mineral'] }, // also matches _noob
  { pattern: /survey_tool_inorganic/, classes: ['inorganic_chemical'] },
  { pattern: /survey_tool_organic/, classes: ['organic_chemical'] },
  { pattern: /survey_tool_lumber/, classes: ['flora_resources'] },
  { pattern: /survey_tool_gas/, classes: ['gas'] },
  { pattern: /survey_tool_liquid/, classes: ['water'] },
  { pattern: /survey_tool_moisture/, classes: ['water'] },
  { pattern: /survey_tool_geo/, classes: ['geothermal_energy'] }, // truncated form: survey_tool_geo_n
  { pattern: /survey_tool_solar/, classes: ['solar_energy'] },
  { pattern: /survey_tool_wind/, classes: ['wind_energy'] },
];

/**
 * Scan the player's inventory + nested containers for survey tools.
 * Returns a `class → toolId` map. The universal tool (if found) is stored
 * under the key `"*"` and `pickToolForClass()` falls back to it when no
 * class-specific tool exists.
 *
 * Reads from `ctx.inventory.items` (auto-synced view) plus a BFS into any
 * sub-containers via `ctx.findInContainer`. The auto-sync layer is fed
 * from the WorldModel, so this stays accurate mid-script as items move
 * around without needing a fresh `openContainer` call.
 *
 * Convenience aliases mapped here use the SHORT class names returned by
 * the survey-tool patterns above:
 *   - mineral, inorganic_chemical, organic_chemical, flora_resources,
 *     gas, water, geothermal_energy, wind_energy, solar_energy
 *
 * To match legacy `--resource=inorganic_mineral` flags, callers should
 * pre-normalize their requested class to one of the above (or `*`).
 */
export function findSurveyTools(ctx: ScriptContext): Map<string, NetworkId> {
  const result = new Map<string, NetworkId>();

  // Seed the BFS with every item in the inventory (the auto-synced view
  // already filters to direct children of the inventory container).
  const queue: Array<{ id: NetworkId; templateName: string | null; name: string | null }> = [];
  for (const item of ctx.inventory.items) {
    queue.push({ id: item.networkId, templateName: item.templateName, name: item.name });
  }
  // Also walk anything that's directly contained by the player (datapad,
  // appearance inventory, etc.) — those don't live "in the inventory".
  for (const obj of ctx.findInContainer(ctx.sceneStart.playerNetworkId)) {
    queue.push({
      id: obj.id,
      templateName: obj.templateName ?? null,
      name: deriveName(obj),
    });
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) continue;
    const key = cur.id.toString();
    if (visited.has(key)) continue;
    visited.add(key);

    const candidates = [cur.templateName ?? '', cur.name ?? ''];
    let matchedAsTool = false;
    for (const text of candidates) {
      if (text === '') continue;
      for (const { pattern, classes } of TOOL_TEMPLATE_TO_CLASSES) {
        if (pattern.test(text)) {
          for (const cls of classes) {
            if (!result.has(cls)) result.set(cls, cur.id);
          }
          matchedAsTool = true;
          break;
        }
      }
      if (matchedAsTool) break;
    }

    // Recurse into nested containers (bags inside the inventory, etc.).
    for (const child of ctx.findInContainer(cur.id)) {
      queue.push({
        id: child.id,
        templateName: child.templateName ?? null,
        name: deriveName(child),
      });
    }
  }
  return result;
}

/**
 * Best-effort name pulled from the SHARED baseline (the WorldModel keeps
 * it on `WorldObject.baselines.get(BaselinePackageIds.SHARED)`). Used for
 * matching admin-spawned tools that don't carry a templateName.
 */
function deriveName(obj: WorldObject): string | null {
  // BaselinePackageIds.SHARED = 3
  const shared = obj.baselines.get(3) as
    | { objectName?: string; nameStringId?: { text?: string } }
    | undefined;
  if (shared === undefined) return null;
  if (typeof shared.objectName === 'string' && shared.objectName !== '') return shared.objectName;
  if (typeof shared.nameStringId?.text === 'string' && shared.nameStringId.text !== '') {
    return shared.nameStringId.text;
  }
  return null;
}

/**
 * Map common legacy resource-class names to the canonical short names this
 * library uses internally. Lets `--resource=inorganic_mineral` continue to
 * work even though the tool-template patterns use `mineral`.
 */
function normalizeClass(cls: string): string {
  // The legacy names below all collapse to a single canonical bucket.
  // Returned value MUST match a key produced by `findSurveyTools()`.
  switch (cls) {
    case 'inorganic_mineral':
    case 'mineral':
      return 'mineral';
    case 'inorganic_chemical':
    case 'chemical':
      return 'inorganic_chemical';
    case 'organic_chemical':
      return 'organic_chemical';
    case 'flora':
    case 'flora_resources':
    case 'lumber':
      return 'flora_resources';
    case 'gas':
      return 'gas';
    case 'water':
    case 'liquid':
    case 'moisture':
      return 'water';
    case 'geothermal':
    case 'geothermal_energy':
      return 'geothermal_energy';
    case 'solar':
    case 'solar_energy':
      return 'solar_energy';
    case 'wind':
    case 'wind_energy':
      return 'wind_energy';
    default:
      return cls;
  }
}

/**
 * Return the survey-tool NetworkId for the given class, or `undefined` if
 * the inventory doesn't hold a matching tool (or universal).
 */
export function pickToolForClass(
  tools: Map<string, NetworkId>,
  resourceClass: string,
): NetworkId | undefined {
  const cls = normalizeClass(resourceClass);
  const exact = tools.get(cls);
  if (exact !== undefined) return exact;
  return tools.get('*');
}

/**
 * Fetch the resource list for the class's tool. Returns `null` if no
 * matching tool is in the character's inventory.
 *
 * `timeoutMs` defaults to 8000 (matches `fetchSurveyResources` default).
 */
export async function fetchTypeNamesForClass(
  ctx: ScriptContext,
  tools: Map<string, NetworkId>,
  resourceClass: string,
  opts: { timeoutMs?: number } = {},
): Promise<ResourceListItem[] | null> {
  const toolId = pickToolForClass(tools, resourceClass);
  if (toolId === undefined) return null;
  try {
    return await ctx.fetchSurveyResources(toolId, opts);
  } catch {
    return null;
  }
}
