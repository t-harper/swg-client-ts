import { describe, expect, it } from 'vitest';
import { ChatSystemMessage } from '../../src/messages/game/chat/index.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import { ObjectMenuSelectMessage } from '../../src/messages/game/object-menu-select-message.js';
import { SuiCreatePageMessage, SuiEventNotification } from '../../src/messages/game/sui/index.js';
import { createFakeContext } from '../../src/client/script/test-helpers.js';
import { declareResidence, placeDeed, resolveInventoryOid, walkInAndDeclareResidence } from './place.js';

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
  // SuiPageData starts with [i32 LE pageId]; remaining bytes are opaque widget tree
  const buf = Buffer.alloc(64);
  buf.writeInt32LE(pageId, 0);
  buf.write(label, 4);
  return new SuiCreatePageMessage(new Uint8Array(buf));
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
