import { describe, expect, it } from 'vitest';
import { createFakeContext } from '../../src/client/script/test-helpers.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import { ObjControllerMessage } from '../../src/messages/game/obj-controller-message.js';
import {
  adminStructurePermissionAdd,
  adminStructurePermissionList,
  adminStructurePermissionRemove,
} from './admin-permissions.js';

/**
 * Watch ctx.send() for every ConGenericMessage and synth a server reply with
 * matching msgId. `replyFor(cmd)` decides what bytes the server echoes back.
 * Mirrors the autoReply helper used in admin.test.ts but kept self-contained
 * here so the two test suites don't import each other's privates.
 */
function autoReply(
  fake: ReturnType<typeof createFakeContext>,
  replyFor: (cmd: string) => string,
): void {
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
}

/** Pick out every ConGenericMessage the script sent. */
function sentCommands(fake: ReturnType<typeof createFakeContext>): string[] {
  return fake.sent
    .filter((m): m is ConGenericMessage => m instanceof ConGenericMessage)
    .map((m) => m.msg);
}

/**
 * Count ObjControllerMessage sends — `useAbility('permissionListModify', ...)`
 * wraps in an ObjControllerMessage(CM_commandQueueEnqueue=278). We don't peek
 * at the trailer in these tests (CommandQueueEnqueue encoding is exercised
 * elsewhere); we just confirm that *something* was sent through the
 * command-queue path.
 */
function objControllerSends(fake: ReturnType<typeof createFakeContext>): ObjControllerMessage[] {
  return fake.sent.filter((m): m is ObjControllerMessage => m instanceof ObjControllerMessage);
}

/**
 * Build the exact text a real game server would emit for
 * `objvar get <oid> player_structure.<sub>` when the LIST contains zero or
 * more entries. Modeled on `listObjvars` (ConsoleCommandParserObjvar.cpp:480).
 */
function fmtObjvarList(leaf: string, entries: readonly string[]): string {
  if (entries.length === 0) {
    // The LIST parent exists but the leaf STRING_ARRAY is empty (or absent).
    // Server still emits "objvar list" + empty body + SUCCESS.
    return ['objvar list', `${leaf}\t[`, '\t]', 'SUCCESS: objvar get'].join('\n');
  }
  const padded = entries.map((e) => `\t${e}`).join('\n');
  return ['objvar list', `${leaf}\t[`, padded, '\t]', 'SUCCESS: objvar get'].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// adminStructurePermissionList
// ─────────────────────────────────────────────────────────────────────────────

describe('adminStructurePermissionList', () => {
  it('returns all four lists, parsed from per-list objvar get calls', async () => {
    const fake = createFakeContext();
    autoReply(fake, (cmd) => {
      // Route on the var the caller asked for
      if (/player_structure\.enter\b/.test(cmd))
        return fmtObjvarList('enterList', ['Alice', 'Bob']);
      if (/player_structure\.admin\b/.test(cmd)) return fmtObjvarList('adminList', ['Carol']);
      if (/player_structure\.hopper\b/.test(cmd)) return fmtObjvarList('hopperList', []);
      if (/player_structure\.ban\b/.test(cmd)) return fmtObjvarList('banList', ['Mallory']);
      return 'unknown';
    });
    const perms = await adminStructurePermissionList(fake.ctx, 99999n);
    expect(perms.entry).toEqual(['Alice', 'Bob']);
    expect(perms.admin).toEqual(['Carol']);
    expect(perms.hopper).toEqual([]);
    expect(perms.banned).toEqual(['Mallory']);
  });

  it('treats INVALID_OBJVAR replies as empty lists (parent never created)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => 'ERR_INVALID_OBJVAR: no such objvar');
    const perms = await adminStructurePermissionList(fake.ctx, 42n);
    expect(perms).toEqual({ entry: [], admin: [], hopper: [], banned: [] });
  });

  it('parses LIST replies even when the leaf carries guild:<abbrev> tokens', async () => {
    const fake = createFakeContext();
    autoReply(fake, (cmd) => {
      if (/player_structure\.enter\b/.test(cmd))
        return fmtObjvarList('enterList', ['Alice', 'guild:TSC']);
      return fmtObjvarList('placeholder', []);
    });
    const perms = await adminStructurePermissionList(fake.ctx, 1n);
    expect(perms.entry).toEqual(['Alice', 'guild:TSC']);
  });

  it('issues one objvar-get per permission type (4 console roundtrips)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('x', []));
    await adminStructurePermissionList(fake.ctx, 12345n);
    const cmds = sentCommands(fake);
    expect(cmds).toHaveLength(4);
    expect(cmds.some((c) => /player_structure\.enter\b/.test(c))).toBe(true);
    expect(cmds.some((c) => /player_structure\.admin\b/.test(c))).toBe(true);
    expect(cmds.some((c) => /player_structure\.hopper\b/.test(c))).toBe(true);
    expect(cmds.some((c) => /player_structure\.ban\b/.test(c))).toBe(true);
  });

  it('addresses the structure OID by decimal string in the console command', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('x', []));
    await adminStructurePermissionList(fake.ctx, 16039260784n);
    const cmds = sentCommands(fake);
    for (const c of cmds) {
      expect(c).toContain('16039260784');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// adminStructurePermissionAdd
// ─────────────────────────────────────────────────────────────────────────────

describe('adminStructurePermissionAdd', () => {
  it('queries the list and fires the toggle when the name is absent', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('enterList', ['Bob']));
    await adminStructurePermissionAdd(fake.ctx, 100n, 'entry', 'Alice');
    // 1 console read + 1 useAbility (ObjControllerMessage wrapping commandQueueEnqueue)
    expect(sentCommands(fake)).toHaveLength(1);
    expect(objControllerSends(fake)).toHaveLength(1);
  });

  it('is idempotent when the name is already present (no permissionListModify send)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('enterList', ['Alice', 'Bob']));
    await adminStructurePermissionAdd(fake.ctx, 100n, 'entry', 'Alice');
    expect(sentCommands(fake)).toHaveLength(1); // only the objvar-get
    expect(objControllerSends(fake)).toHaveLength(0); // no toggle fired
  });

  it('compares names case-insensitively (matches server isNameOn*List behavior)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('enterList', ['Alice']));
    // Caller passes "ALICE" — server stored "Alice". Should NOT re-send.
    await adminStructurePermissionAdd(fake.ctx, 100n, 'entry', 'ALICE');
    expect(objControllerSends(fake)).toHaveLength(0);
  });

  it('queries the right parent LIST for each permission type', async () => {
    for (const perm of ['entry', 'admin', 'hopper', 'banned'] as const) {
      const fake = createFakeContext();
      autoReply(fake, () => fmtObjvarList('whatever', []));
      await adminStructurePermissionAdd(fake.ctx, 1n, perm, 'X');
      const cmd = sentCommands(fake)[0]!;
      const expected: Record<typeof perm, string> = {
        entry: 'player_structure.enter',
        admin: 'player_structure.admin',
        hopper: 'player_structure.hopper',
        banned: 'player_structure.ban',
      };
      expect(cmd).toContain(expected[perm]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// adminStructurePermissionRemove
// ─────────────────────────────────────────────────────────────────────────────

describe('adminStructurePermissionRemove', () => {
  it('fires the toggle when the name is present', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('adminList', ['Carol', 'Dave']));
    await adminStructurePermissionRemove(fake.ctx, 5n, 'admin', 'Carol');
    expect(objControllerSends(fake)).toHaveLength(1);
  });

  it('is idempotent when the name is absent (no useAbility send)', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('adminList', ['Dave']));
    await adminStructurePermissionRemove(fake.ctx, 5n, 'admin', 'Carol');
    expect(objControllerSends(fake)).toHaveLength(0);
  });

  it('accepts the uppercase listName "BAN" as an alias for "banned"', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('banList', ['Mallory']));
    await adminStructurePermissionRemove(fake.ctx, 5n, 'BAN', 'Mallory');
    expect(objControllerSends(fake)).toHaveLength(1);
    // Should have queried the banned list (player_structure.ban)
    const cmd = sentCommands(fake)[0]!;
    expect(cmd).toContain('player_structure.ban');
  });

  it('throws on an unknown permission type', async () => {
    const fake = createFakeContext();
    autoReply(fake, () => fmtObjvarList('x', []));
    await expect(
      adminStructurePermissionRemove(fake.ctx, 5n, 'bogus', 'X'),
    ).rejects.toThrow(/unknown permissionType/);
  });
});
