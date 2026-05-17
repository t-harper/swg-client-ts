import { describe, expect, it } from 'vitest';
import { ChatSystemMessage } from '../../src/messages/game/chat/index.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import { ObjectMenuSelectMessage } from '../../src/messages/game/object-menu-select-message.js';
import { SceneCreateObjectByName } from '../../src/messages/game/scene-create-object-by-name.js';
import { SuiCreatePageMessage, SuiEventNotification } from '../../src/messages/game/sui/index.js';
import { createFakeContext } from '../../src/client/script/test-helpers.js';
import {
  classifyDeedKind,
  declareResidence,
  inferStructureBasename,
  matchesStructureTemplate,
  placeDeed,
  resolveInventoryOid,
  walkInAndDeclareResidence,
} from './place.js';

const IDENTITY_TRANSFORM = {
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  position: { x: 0, y: 0, z: 0 },
};

function makeSceneCreate(networkId: bigint, templateName: string): SceneCreateObjectByName {
  return new SceneCreateObjectByName(networkId, IDENTITY_TRANSFORM, templateName, false);
}

function autoReply(fake: ReturnType<typeof createFakeContext>, replyFor: (cmd: string) => string | null): { sentCommands: string[] } {
  const seen = new Set<ConGenericMessage>();
  const sentCommands: string[] = [];
  const interval = setInterval(() => {
    for (const m of fake.sent) {
      if (!(m instanceof ConGenericMessage)) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      sentCommands.push(m.msg);
      const reply = replyFor(m.msg);
      if (reply !== null) {
        fake.simulateRecv(new ConGenericMessage(reply, m.msgId));
      }
    }
  }, 1);
  interval.unref?.();
  return { sentCommands };
}

function makeSuiPage(pageId: number, label = 'page'): SuiCreatePageMessage {
  // Construct a minimal typed SuiPageData (Feat #3: pageData is now decoded
  // not opaque bytes). label is preserved in pageName for debugging.
  return new SuiCreatePageMessage({
    pageId,
    pageName: label,
    commands: [],
    associatedObjectId: 0n,
    associatedLocation: { x: 0, y: 0, z: 0 },
    maxRangeFromObject: 0,
  });
}

describe('resolveInventoryOid', () => {
  it('uses admin getInventoryId when reply is a clean OID', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      return null;
    });
    const oid = await resolveInventoryOid(fake.ctx);
    expect(oid).toBe(101n);
  });

  it('falls back to player NetworkId when getInventoryId says no inventory', async () => {
    const fake = createFakeContext({ playerNetworkId: 555n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return 'This Object has no inventory\n';
      return null;
    });
    const oid = await resolveInventoryOid(fake.ctx);
    expect(oid).toBe(555n);
  });
});

describe('placeDeed (cityhall = 2 SUI roundtrips)', () => {
  it('spawns deed, sends ITEM_USE, responds to 2 SUI dialogs with cityName', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    const tracker = autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 999\nSUCCESS';
      return null;
    });

    // Inject SUI messages after a short delay
    setTimeout(() => fake.simulateRecv(makeSuiPage(11, 'confirm')), 100);
    setTimeout(() => fake.simulateRecv(makeSuiPage(22, 'cityname')), 300);

    const result = await placeDeed(fake.ctx, 'object/tangible/deed/city_deed/cityhall_naboo_deed.iff', {
      cityName: 'TsHarbor',
      expectedSuiCount: 2,
      settleMs: 10,
      suiTimeoutMs: 3000,
    });

    expect(result.deedOid).toBe(999n);
    expect(result.rejected).toBe(false);
    expect(result.suiSeen).toBe(2);

    // Should have sent: getInventoryId, createIn, ObjectMenuSelect, SuiEventNotification × 2
    const radials = fake.sent.filter((m): m is ObjectMenuSelectMessage => m instanceof ObjectMenuSelectMessage);
    expect(radials.length).toBe(1);
    expect(radials[0]!.targetId).toBe(999n);

    const suiResponses = fake.sent.filter((m): m is SuiEventNotification => m instanceof SuiEventNotification);
    expect(suiResponses.length).toBe(2);
    expect(suiResponses[0]!.pageId).toBe(11);
    expect(suiResponses[0]!.returnList).toEqual([]); // confirm = empty returnList
    expect(suiResponses[1]!.pageId).toBe(22);
    // returnList is positional VALUES only — server maps to widget props by subscription order
    expect(suiResponses[1]!.returnList).toEqual(['TsHarbor']);
  });

  it('reports rejected=true when an obscene/no_room chat arrives during placement', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 1\nSUCCESS';
      return null;
    });

    setTimeout(() => fake.simulateRecv(makeSuiPage(1)), 50);
    setTimeout(() => fake.simulateRecv(makeSuiPage(2)), 200);
    setTimeout(() => fake.simulateRecv(new ChatSystemMessage(0, 'There is no_room for that structure here.', '')), 400);

    const result = await placeDeed(fake.ctx, 'object/tangible/deed/city_deed/cityhall_naboo_deed.iff', {
      cityName: 'TsHarbor',
      expectedSuiCount: 2,
      settleMs: 600,
      suiTimeoutMs: 1500,
    });

    expect(result.rejected).toBe(true);
    expect(result.chatErrors[0]).toMatch(/no_room/i);
  });
});

describe('placeDeed (reclaim-able = 0 SUI)', () => {
  it('just sends ITEM_USE; no SUI responses', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 42\nSUCCESS';
      return null;
    });

    const result = await placeDeed(fake.ctx, 'object/tangible/deed/player_house_deed/naboo_house_small_deed.iff', {
      expectedSuiCount: 0,
      settleMs: 50,
    });

    expect(result.deedOid).toBe(42n);
    expect(result.suiSeen).toBe(0);
    expect(result.rejected).toBe(false);
    const radials = fake.sent.filter((m): m is ObjectMenuSelectMessage => m instanceof ObjectMenuSelectMessage);
    expect(radials.length).toBe(1);
    const suiResponses = fake.sent.filter((m): m is SuiEventNotification => m instanceof SuiEventNotification);
    expect(suiResponses.length).toBe(0);
  });
});

describe('declareResidence', () => {
  it('returns true when a residence-related ChatSystemMessage arrives', async () => {
    const fake = createFakeContext();
    setTimeout(() => {
      fake.simulateRecv(new ChatSystemMessage(0, 'You have changed your residence to TsHome.', ''));
    }, 50);
    const ok = await declareResidence(fake.ctx, { timeoutMs: 500 });
    expect(ok).toBe(true);
  });

  it('returns false on timeout', async () => {
    const fake = createFakeContext();
    const ok = await declareResidence(fake.ctx, { timeoutMs: 100 });
    expect(ok).toBe(false);
  });
});

describe('walkInAndDeclareResidence', () => {
  it('walks to slot.x + entryOffset then declares residence', async () => {
    const fake = createFakeContext({ startPosition: { x: 100, y: 0, z: 50 } });
    const chatTicker = setInterval(() => {
      fake.simulateRecv(new ChatSystemMessage(0, 'change_residence ok', ''));
    }, 100);
    chatTicker.unref?.();

    try {
      const ok = await walkInAndDeclareResidence(
        fake.ctx,
        { x: 102, z: 47, entryOffset: { x: 0, z: -2 } },
        { settleMs: 50, declareTimeoutMs: 3000 },
      );
      expect(ok).toBe(true);
    } finally {
      clearInterval(chatTicker);
    }
  }, 15000);
});

describe('inferStructureBasename', () => {
  it('strips _deed.iff from a cityhall deed path', () => {
    expect(
      inferStructureBasename('object/tangible/deed/city_deed/cityhall_naboo_deed.iff'),
    ).toBe('cityhall_naboo');
  });

  it('strips _deed.iff from a house deed path', () => {
    expect(
      inferStructureBasename('object/tangible/deed/player_house_deed/naboo_house_small_deed.iff'),
    ).toBe('naboo_house_small');
  });

  it('strips _deed.iff from a guild deed path', () => {
    expect(
      inferStructureBasename('object/tangible/deed/guild_deed/naboo_guild_deed.iff'),
    ).toBe('naboo_guild');
  });

  it('strips _deed.iff from a garden deed path', () => {
    expect(
      inferStructureBasename(
        'object/tangible/deed/player_house_deed/garden_naboo_lrg_01_deed.iff',
      ),
    ).toBe('garden_naboo_lrg_01');
  });

  it('returns null when the path does not end in _deed.iff', () => {
    expect(inferStructureBasename('object/building/naboo/cityhall_naboo.iff')).toBeNull();
    expect(inferStructureBasename('garbage')).toBeNull();
    expect(inferStructureBasename('')).toBeNull();
  });

  it('handles a bare filename without a directory prefix', () => {
    expect(inferStructureBasename('cityhall_naboo_deed.iff')).toBe('cityhall_naboo');
  });
});

describe('matchesStructureTemplate', () => {
  it('matches a cityhall structure template against the deed basename', () => {
    expect(
      matchesStructureTemplate(
        'object/building/naboo/cityhall_naboo.iff',
        'cityhall_naboo',
      ),
    ).toBe(true);
  });

  it('matches a house structure template against the deed basename', () => {
    expect(
      matchesStructureTemplate(
        'object/building/player/naboo_house_small.iff',
        'naboo_house_small',
      ),
    ).toBe(true);
  });

  it('matches an installation-path structure (e.g. shuttleport)', () => {
    expect(
      matchesStructureTemplate(
        'object/installation/general/shuttleport_naboo.iff',
        'shuttleport_naboo',
      ),
    ).toBe(true);
  });

  it('rejects matching the deed against itself (template ends with _deed.iff)', () => {
    expect(
      matchesStructureTemplate(
        'object/tangible/deed/city_deed/cityhall_naboo_deed.iff',
        'cityhall_naboo',
      ),
    ).toBe(false);
  });

  it('rejects mismatched basenames', () => {
    expect(
      matchesStructureTemplate(
        'object/building/naboo/cityhall_naboo.iff',
        'naboo_house_small',
      ),
    ).toBe(false);
  });

  it('rejects observed templates from non-structure paths', () => {
    expect(
      matchesStructureTemplate(
        'object/creature/player/human_male.iff',
        'human_male',
      ),
    ).toBe(false);
  });

  it('handles case-insensitive matching', () => {
    expect(
      matchesStructureTemplate(
        'object/Building/Naboo/Cityhall_Naboo.iff',
        'cityhall_naboo',
      ),
    ).toBe(true);
  });

  it('returns false for empty deed basename', () => {
    expect(matchesStructureTemplate('object/building/naboo/cityhall.iff', '')).toBe(false);
  });
});

describe('classifyDeedKind', () => {
  it('classifies cityhall', () => {
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/cityhall_naboo_deed.iff'),
    ).toBe('cityhall');
  });

  it('classifies civic deeds (bank, cantina, hospital, cloning, shuttleport, garage, theater)', () => {
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/bank_naboo_deed.iff'),
    ).toBe('civic');
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/cantina_naboo_deed.iff'),
    ).toBe('civic');
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/hospital_naboo_deed.iff'),
    ).toBe('civic');
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/cloning_naboo_deed.iff'),
    ).toBe('civic');
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/shuttleport_naboo_deed.iff'),
    ).toBe('civic');
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/garage_naboo_deed.iff'),
    ).toBe('civic');
    expect(
      classifyDeedKind('object/tangible/deed/city_deed/theater_naboo_deed.iff'),
    ).toBe('civic');
  });

  it('classifies guildhall', () => {
    expect(
      classifyDeedKind('object/tangible/deed/guild_deed/naboo_guild_deed.iff'),
    ).toBe('guildhall');
  });

  it('classifies gardens', () => {
    expect(
      classifyDeedKind(
        'object/tangible/deed/player_house_deed/garden_naboo_lrg_01_deed.iff',
      ),
    ).toBe('garden');
  });

  it('classifies regular houses as house', () => {
    expect(
      classifyDeedKind('object/tangible/deed/player_house_deed/naboo_house_small_deed.iff'),
    ).toBe('house');
    expect(
      classifyDeedKind('object/tangible/deed/player_house_deed/naboo_house_medium_deed.iff'),
    ).toBe('house');
    expect(
      classifyDeedKind('object/tangible/deed/player_house_deed/naboo_house_large_deed.iff'),
    ).toBe('house');
  });

  it('defaults to house for unrecognized deed paths', () => {
    expect(classifyDeedKind('object/tangible/deed/something_weird_deed.iff')).toBe('house');
  });
});

describe('placeDeed structure-OID capture', () => {
  it('captures the placed structure OID from a SceneCreateObjectByName with matching template', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 42\nSUCCESS';
      return null;
    });

    // During the settle window, the server pushes the new structure's
    // SceneCreateObjectByName. The deed basename `naboo_house_small_deed.iff` →
    // `naboo_house_small`; the placed structure template ends with that.
    setTimeout(() => {
      fake.simulateRecv(makeSceneCreate(7777n, 'object/building/player/naboo_house_small.iff'));
    }, 20);

    const result = await placeDeed(
      fake.ctx,
      'object/tangible/deed/player_house_deed/naboo_house_small_deed.iff',
      { expectedSuiCount: 0, settleMs: 200 },
    );

    expect(result.deedOid).toBe(42n);
    expect(result.structureOid).toBe(7777n);
    expect(result.structureTemplate).toBe('object/building/player/naboo_house_small.iff');
    expect(result.rejected).toBe(false);
  });

  it('returns structureOid=null when no matching SceneCreateObjectByName arrives', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 42\nSUCCESS';
      return null;
    });

    const result = await placeDeed(
      fake.ctx,
      'object/tangible/deed/player_house_deed/naboo_house_small_deed.iff',
      { expectedSuiCount: 0, settleMs: 50 },
    );

    expect(result.deedOid).toBe(42n);
    expect(result.structureOid).toBeNull();
    expect(result.structureTemplate).toBeNull();
    expect(result.rejected).toBe(false);
  });

  it('ignores SceneCreateObjectByName events for unrelated templates', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 42\nSUCCESS';
      return null;
    });

    // Inject a noise event (e.g. a nearby creature spawning during settle) and
    // the actual structure event — only the latter should be captured.
    setTimeout(() => {
      fake.simulateRecv(makeSceneCreate(111n, 'object/creature/npc/theed/townsperson.iff'));
    }, 10);
    setTimeout(() => {
      fake.simulateRecv(makeSceneCreate(7777n, 'object/building/player/naboo_house_small.iff'));
    }, 30);

    const result = await placeDeed(
      fake.ctx,
      'object/tangible/deed/player_house_deed/naboo_house_small_deed.iff',
      { expectedSuiCount: 0, settleMs: 200 },
    );

    expect(result.structureOid).toBe(7777n);
    expect(result.structureTemplate).toBe('object/building/player/naboo_house_small.iff');
  });

  it('captures structureOid for cityhall via the full 2-SUI flow', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 999\nSUCCESS';
      return null;
    });

    setTimeout(() => fake.simulateRecv(makeSuiPage(11, 'confirm')), 50);
    setTimeout(() => fake.simulateRecv(makeSuiPage(22, 'cityname')), 200);
    // The placed cityhall arrives during the settle window after SUI #2 reply.
    setTimeout(() => {
      fake.simulateRecv(makeSceneCreate(123456n, 'object/building/naboo/cityhall_naboo.iff'));
    }, 400);

    const result = await placeDeed(
      fake.ctx,
      'object/tangible/deed/city_deed/cityhall_naboo_deed.iff',
      { cityName: 'TsHarbor', expectedSuiCount: 2, settleMs: 400, suiTimeoutMs: 3000 },
    );

    expect(result.suiSeen).toBe(2);
    expect(result.structureOid).toBe(123456n);
    expect(result.structureTemplate).toBe('object/building/naboo/cityhall_naboo.iff');
  });

  it('takes the first matching SceneCreateObjectByName when multiple arrive', async () => {
    const fake = createFakeContext({ playerNetworkId: 100n });
    autoReply(fake, (cmd) => {
      if (cmd.startsWith('object getInventoryId')) return '101\nSUCCESS';
      if (cmd.startsWith('object createIn')) return 'NetworkId: 42\nSUCCESS';
      return null;
    });

    setTimeout(() => {
      fake.simulateRecv(makeSceneCreate(7777n, 'object/building/player/naboo_house_small.iff'));
    }, 10);
    // A second create event for the same template (e.g. a neighbor's house in
    // view) shouldn't displace our captured OID.
    setTimeout(() => {
      fake.simulateRecv(makeSceneCreate(8888n, 'object/building/player/naboo_house_small.iff'));
    }, 30);

    const result = await placeDeed(
      fake.ctx,
      'object/tangible/deed/player_house_deed/naboo_house_small_deed.iff',
      { expectedSuiCount: 0, settleMs: 200 },
    );

    expect(result.structureOid).toBe(7777n);
  });
});
