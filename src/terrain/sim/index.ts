/**
 * Public surface of the procedural-terrain simulator.
 *
 * Use:
 *   const template = await loadPlanetTrnTemplate('naboo');
 *   const appearance = new ProceduralTerrainAppearance(template);
 *   const h = appearance.getHeight(2800, -2800);
 *
 * For bulk scans (e.g. find-flat-land):
 *   const heights = appearance.scanHeights(originX, originZ, width, height, cellSize);
 */

export type { ProceduralTerrainTemplate } from './proc-terrain-template.js';
export { loadProceduralTerrainTemplate, loadPlanetTrnTemplate } from './proc-terrain-template.js';

export type { AppearanceOptions } from './proc-terrain-appearance.js';
export { ProceduralTerrainAppearance } from './proc-terrain-appearance.js';

// Types consumers may need for advanced use:
export type { GeneratorChunkData, Vector3, Vector2d, Rectangle2d } from './types.js';
export { TGM, Operation, FeatherFunction, CombinationRule } from './types.js';

// Foundation classes (rarely needed externally but stable):
export { TerrainGenerator } from './generator/terrain-generator.js';
export { FractalGroup } from './generator/fractal-group.js';
export { MultiFractal } from './fractal/multi-fractal.js';
export { NoiseGenerator } from './fractal/noise-generator.js';
