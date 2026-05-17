import { describe, expect, it } from 'vitest';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import { createFakeContext } from '../../src/client/script/test-helpers.js';
import {
  adminConsole,
  adminGetObjVar,
  adminGiveMoney,
  adminGodModeOff,
  adminGodModeOn,
  adminReloadAdminTable,
  adminSetObjVar,
  adminSpawnAt,
  adminSpawnInto,
} from './admin.js';

function autoReply(fake: ReturnType<typeof createFakeContext>, replyFor: (cmd: string) => string): void {
  // Watch every send, echo a ConGenericMessage with same msgId and given reply.
  // Polls the sent[] in a microtask loop — sufficient for these single-shot tests.
  const seen = new Set<ConGenericMessage>();
  const interval = setInterval(() => {
    for (const m of fake.sent) {
      if (!(m instanceof ConGenericMessage)) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      const reply = replyFor(m.msg);
      fake.simulateRecv(new ConGenericMessage(reply, m.msgId));
    }
  }, 1);
  interval.unref?.();
  // No cleanup — tests run brief, interval is unref'd
}

describe('adminGodModeOn', () => {
  it('sends useAbility(setGodMode, 1) via the command queue and returns', async () => {
    const fake = createFakeContext();
    await adminGodModeOn(fake.ctx);
    // The command queue path wraps inside ObjControllerMessage(CM_commandQueueEnqueue);
    // we don't decode here, just assert *something* was sent.
    expect(fake.sent.length).toBeGreaterThan(0);
  });
});

describe('adminGodModeOff', () => {
  it('sends useAbility(setGodMode, 0)', async () => {
    const fake = createFakeContext();
    await adminGodModeOff(fake.ctx);
    expect(fake.sent.length).toBeGreaterThan(0);
  });
});

describe('adminConsole', () => {
  it('round-trips a ConGenericMessage with matching msgId', async () => {
    const fake = createFakeContext();
    autoReply(fake, (cmd) => `echo: ${cmd}`);
    const reply = await adminConsole(fake.ctx, 'server reloadAdminTable');
    expect(reply).toBe('echo: server reloadAdminTable');
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent.length).toBe(1);
    expect(sent[0]?.msg).toBe('server reloadAdminTable');
    expect(sent[0]?.msgId).toBeGreaterThan(0);
  });

  it('uses monotonically-increasing msgIds across multiple calls', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'ok');
    await adminConsole(fake.ctx, 'a');
    await adminConsole(fake.ctx, 'b');
    await adminConsole(fake.ctx, 'c');
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent.length).toBe(3);
    expect(sent[0]?.msgId).toBe(1);
    expect(sent[1]?.msgId).toBe(2);
    expect(sent[2]?.msgId).toBe(3);
  });

  it('rejects on timeout when no reply arrives', async () => {
    const fake = createFakeContext();
    await expect(adminConsole(fake.ctx, 'never-answered', { timeoutMs: 50 })).rejects.toThrow(
      /Timed out/,
    );
  });

  it('only resolves for matching msgId (ignores other ConGeneric traffic)', async () => {
    const fake = createFakeContext();
    // Inject a noise reply with msgId 999 first.
    setTimeout(() => fake.simulateRecv(new ConGenericMessage('noise', 999)), 5);
    autoReply(fake, () => 'real-reply');
    const reply = await adminConsole(fake.ctx, 'foo');
    expect(reply).toBe('real-reply');
  });
});

describe('adminSpawnInto', () => {
  it('parses "NetworkId: <n>" from the reply', async () => {
    const fake = createFakeContext();
    autoReply(
      fake,
      () => 'NetworkId: 16039260784\nSUCCESS: object createIn',
    );
    const oid = await adminSpawnInto(
      fake.ctx,
      'object/tangible/deed/city_deed/cityhall_naboo_deed.iff',
      9000n,
    );
    expect(oid).toBe(16039260784n);
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent.length).toBe(1);
    expect(sent[0]?.msg).toBe(
      'object createIn object/tangible/deed/city_deed/cityhall_naboo_deed.iff 9000',
    );
  });

  it('handles negative NetworkIds (some server objects use negatives)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'NetworkId: -42\nSUCCESS');
    const oid = await adminSpawnInto(fake.ctx, 'foo', 1n);
    expect(oid).toBe(-42n);
  });

  it('throws when the reply is missing the NetworkId line', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'Error: invalid template');
    await expect(adminSpawnInto(fake.ctx, 'bogus', 9000n)).rejects.toThrow(
      /did not contain "NetworkId/,
    );
  });
});

describe('adminSpawnAt', () => {
  it('sends `object createAt <template>` and parses NetworkId', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'NetworkId: 7777\n');
    const oid = await adminSpawnAt(fake.ctx, 'object/tangible/furniture/lamp.iff');
    expect(oid).toBe(7777n);
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe('object createAt object/tangible/furniture/lamp.iff');
  });
});

describe('adminSetObjVar', () => {
  it('sends `objvar set <oid> <key> <value>`', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'ok');
    await adminSetObjVar(fake.ctx, 12345n, 'cityName', 'TsHarbor');
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe('objvar set 12345 cityName TsHarbor');
  });

  it('formats numeric values without quotes', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'ok');
    await adminSetObjVar(fake.ctx, 99n, 'player_structure.deed.surplusMaintenance', 10_000_000);
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe(
      'objvar set 99 player_structure.deed.surplusMaintenance 10000000',
    );
  });
});

describe('adminGiveMoney', () => {
  it('sends `money deposit <oid> <amount>`', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'Deposited 100000000 credits to 555');
    await adminGiveMoney(fake.ctx, 555n, 100_000_000);
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe('money deposit 555 100000000');
  });
});

describe('adminGetObjVar', () => {
  it('returns the raw reply text', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'cityName = TsHarbor (string)');
    const reply = await adminGetObjVar(fake.ctx, 12345n, 'cityName');
    expect(reply).toBe('cityName = TsHarbor (string)');
  });
});

describe('adminReloadAdminTable', () => {
  it('sends `server reloadAdminTable`', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'Command [server r...] succeeded.');
    const reply = await adminReloadAdminTable(fake.ctx);
    expect(reply).toContain('succeeded');
    const sent = fake.sent.filter((m): m is ConGenericMessage => m instanceof ConGenericMessage);
    expect(sent[0]?.msg).toBe('server reloadAdminTable');
  });
});
