import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { CmdStartScene } from './cmd-start-scene.js';

describe('CmdStartScene', () => {
  it('has the expected metadata', () => {
    expect(CmdStartScene.messageName).toBe('CmdStartScene');
    expect(CmdStartScene.typeCrc).toBeGreaterThan(0);
  });

  it('encodes disableWorldSnapshot FIRST despite ctor ordering', () => {
    const m = new CmdStartScene({
      playerNetworkId: 0n,
      sceneName: '',
      startPosition: { x: 0, y: 0, z: 0 },
      startYaw: 0,
      templateName: '',
      serverTimeSeconds: 0n,
      serverEpoch: 0,
      disableWorldSnapshot: true,
    });
    const s = new ByteStream();
    m.encodePayload(s);
    const bytes = s.toBytes();
    expect(bytes[0]).toBe(0x01); // disableWorldSnapshot = true
    // Next 8 bytes are the player NetworkId.
    for (let i = 1; i < 9; ++i) expect(bytes[i]).toBe(0x00);
  });

  it('round-trips a realistic CmdStartScene', () => {
    const m = new CmdStartScene({
      playerNetworkId: 0x0011_2233_4455_6677n,
      sceneName: 'tatooine',
      startPosition: { x: 3500.5, y: 5.0, z: -4700.25 },
      startYaw: 1.5,
      templateName: 'object/creature/player/shared_human_male.iff',
      serverTimeSeconds: 1700000000n,
      serverEpoch: 42,
      disableWorldSnapshot: false,
    });
    const s = new ByteStream();
    m.encodePayload(s);
    const iter = new ReadIterator(s.toBytes());
    const d = CmdStartScene.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.disableWorldSnapshot).toBe(false);
    expect(d.playerNetworkId).toBe(0x0011_2233_4455_6677n);
    expect(d.sceneName).toBe('tatooine');
    expect(d.startPosition.x).toBeCloseTo(3500.5, 4);
    expect(d.startPosition.y).toBeCloseTo(5.0, 4);
    expect(d.startPosition.z).toBeCloseTo(-4700.25, 4);
    expect(d.startYaw).toBeCloseTo(1.5, 5);
    expect(d.templateName).toBe('object/creature/player/shared_human_male.iff');
    expect(d.serverTimeSeconds).toBe(1700000000n);
    expect(d.serverEpoch).toBe(42);
  });
});
