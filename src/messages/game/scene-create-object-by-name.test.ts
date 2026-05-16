import { describe, expect, it } from 'vitest';
import {
  StubByteStream,
  StubReadIterator,
  type Transform,
} from '../../archive/_stub-byte-stream.js';
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
    const s = new StubByteStream();
    m.encodePayload(s);
    const iter = new StubReadIterator(s.toBytes());
    const d = SceneCreateObjectByName.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.networkId).toBe(42n);
    expect(d.templateName).toBe('object/creature/player/shared_human_male.iff');
    expect(d.hyperspace).toBe(true);
  });
});
