import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import type { Transform } from '../../archive/transform.js';
import { SceneCreateObjectByName } from './scene-create-object-by-name.js';

describe('SceneCreateObjectByName', () => {
  it('has the expected metadata', () => {
    expect(SceneCreateObjectByName.messageName).toBe('SceneCreateObjectByName');
    expect(SceneCreateObjectByName.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips', () => {
    const t: Transform = {
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      position: { x: 0, y: 0, z: 0 },
    };
    const m = new SceneCreateObjectByName(
      42n,
      t,
      'object/creature/player/shared_human_male.iff',
      true,
    );
    const s = new ByteStream();
    m.encodePayload(s);
    const iter = new ReadIterator(s.toBytes());
    const d = SceneCreateObjectByName.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.networkId).toBe(42n);
    expect(d.templateName).toBe('object/creature/player/shared_human_male.iff');
    expect(d.hyperspace).toBe(true);
  });
});
