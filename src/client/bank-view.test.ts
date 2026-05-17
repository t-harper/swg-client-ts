import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
// Side-effect: register all baseline decoders.
import '../messages/game/baselines/index.js';
import { ObjectMenuSelectMessage, RadialMenuTypes } from '../messages/game/object-menu-select-message.js';
import { SceneCreateObjectByName } from '../messages/game/scene-create-object-by-name.js';
import { UpdateContainmentMessage } from '../messages/game/update-containment-message.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { BankViewImpl } from './bank-view.js';
import type { MessageDispatcher } from './dispatcher.js';
import { createFakeContext } from './script/test-helpers.js';
import { WorldModel } from './world-model.js';

const IDENTITY = { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } };
const BANK_TEMPLATE = 'object/tangible/bank/shared_character_bank.iff';
const BANK_TERMINAL_TEMPLATE = 'object/tangible/terminal/shared_terminal_bank.iff';

/**
 * Minimal fake dispatcher — mirrors the world-model.test.ts pattern. Lets
 * us construct a WorldModel and inject inbound messages while capturing
 * any sends.
 */
function makeFakeDispatcher(): {
  dispatcher: MessageDispatcher;
  recv: (msg: GameNetworkMessage) => void;
  sent: GameNetworkMessage[];
} {
  const listeners = new Map<number, Array<(m: GameNetworkMessage) => void>>();
  const sent: GameNetworkMessage[] = [];
  const fake = {
    onMessage<T extends GameNetworkMessage>(
      ctor: { typeCrc: number },
      handler: (m: T) => void,
    ): () => void {
      let arr = listeners.get(ctor.typeCrc);
      if (arr === undefined) {
        arr = [];
        listeners.set(ctor.typeCrc, arr);
      }
      arr.push(handler as (m: GameNetworkMessage) => void);
      return () => {
        const list = listeners.get(ctor.typeCrc);
        if (list === undefined) return;
        const idx = list.indexOf(handler as (m: GameNetworkMessage) => void);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    send(msg: GameNetworkMessage): void {
      sent.push(msg);
    },
    waitFor(): Promise<GameNetworkMessage> {
      return new Promise(() => undefined);
    },
    onAny(): () => void {
      return () => undefined;
    },
    handleAppMessage(): void {},
    cancelAllWaiters(): void {},
    transcript: [],
    stageLabel: 'test',
  };
  const recv = (msg: GameNetworkMessage): void => {
    const ctor = msg.constructor as unknown as { typeCrc: number };
    const list = listeners.get(ctor.typeCrc);
    if (list === undefined) return;
    for (const h of list.slice()) h(msg);
  };
  return { dispatcher: fake as unknown as MessageDispatcher, recv, sent };
}

describe('BankView', () => {
  describe('discovery', () => {
    it('containerId is null until a bank container appears in the world', () => {
      const { dispatcher } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();
      expect(bank.containerId).toBeNull();
      expect(bank.ready).toBe(false);
      expect(bank.items).toEqual([]);
    });

    it('picks up the bank container via template-name match on SceneCreateObjectByName', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      const bankId = 0xb1n;
      recv(new SceneCreateObjectByName(bankId, IDENTITY, BANK_TEMPLATE, false));
      expect(bank.containerId).toBe(bankId);
      expect(bank.ready).toBe(true);
    });

    it('picks up the bank via SHARED-baseline nameStringId={item_n, bank} on a player-direct child', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const playerId = 0xfeedn;
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, playerId);
      bank.attach();

      // Player-direct child arrives via ByCrc — no template-name.
      const bankId = 0xb1n;
      recv(new SceneCreateObjectByName(bankId, IDENTITY, 'some/random/template.iff', false));
      recv(new UpdateContainmentMessage(bankId, playerId, 4));
      // SHARED baseline carries the slot name.
      recv(
        new BaselinesMessage(
          bankId,
          ObjectTypeTags.TANO,
          BaselinePackageIds.SHARED,
          new Uint8Array(0),
          {
            kind: 'TangibleObjectShared',
            data: {
              objectName: '',
              nameStringId: { table: 'item_n', text: 'bank' },
            },
          },
        ),
      );

      expect(bank.containerId).toBe(bankId);
    });

    it('items reflect WorldModel objects with containerId === bank id', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      const bankId = 0xb1n;
      recv(new SceneCreateObjectByName(bankId, IDENTITY, BANK_TEMPLATE, false));
      recv(new UpdateContainmentMessage(0xa1n, bankId, 1));
      recv(new UpdateContainmentMessage(0xa2n, bankId, 2));

      const ids = bank.items.map((it) => it.networkId).sort();
      expect(ids).toEqual([0xa1n, 0xa2n]);
    });

    it('setContainerId pins the bank manually', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      const bankId = 0xbeefn;
      recv(new UpdateContainmentMessage(0xa1n, bankId, 1));
      bank.setContainerId(bankId);

      expect(bank.containerId).toBe(bankId);
      expect(bank.ready).toBe(true);
      expect(bank.items.map((it) => it.networkId)).toEqual([0xa1n]);
    });
  });

  describe('use()', () => {
    it('use(terminalId) sends ObjectMenuSelectMessage with ITEM_USE on the given id', () => {
      const { dispatcher, sent } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      const terminalId = 0xc0dean;
      const returned = bank.use(terminalId);
      expect(returned).toBe(terminalId);
      expect(sent).toHaveLength(1);
      const msg = sent[0] as ObjectMenuSelectMessage;
      expect(msg).toBeInstanceOf(ObjectMenuSelectMessage);
      expect(msg.targetId).toBe(terminalId);
      expect(msg.selectedItemId).toBe(RadialMenuTypes.ITEM_USE);
    });

    it('use() with no terminalId finds the nearest bank terminal in the world', () => {
      const { dispatcher, recv, sent } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      // Drop a bank terminal into the world.
      const terminalId = 0x7e00n;
      recv(
        new SceneCreateObjectByName(
          terminalId,
          { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 10, y: 0, z: 5 } },
          BANK_TERMINAL_TEMPLATE,
          false,
        ),
      );

      const returned = bank.use();
      expect(returned).toBe(terminalId);
      expect(sent).toHaveLength(1);
      const msg = sent[0] as ObjectMenuSelectMessage;
      expect(msg.targetId).toBe(terminalId);
      expect(msg.selectedItemId).toBe(RadialMenuTypes.ITEM_USE);
    });

    it('use() with no terminal in the world throws', () => {
      const { dispatcher } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      expect(() => bank.use()).toThrow(/no bank terminal/i);
    });

    it('use() ignores the per-character bank slot template when auto-scanning', () => {
      const { dispatcher, recv } = makeFakeDispatcher();
      const world = new WorldModel({ dispatcher });
      const bank = new BankViewImpl(world, dispatcher, 0x1n);
      bank.attach();

      // The per-player bank slot also has "bank" in its template — but
      // it's NOT a terminal you walk up to.
      recv(new SceneCreateObjectByName(0xb1n, IDENTITY, BANK_TEMPLATE, false));
      expect(() => bank.use()).toThrow();
    });
  });

  describe('ScriptContext integration', () => {
    it('ctx.bank is wired up and discoverable via simulated baselines', () => {
      const playerId = 0xfeedn;
      const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
      expect(ctx.bank).toBeDefined();
      expect(ctx.bank.containerId).toBeNull();

      const bankId = 0xb1n;
      simulateRecv(new SceneCreateObjectByName(bankId, IDENTITY, BANK_TEMPLATE, false));
      expect(ctx.bank.containerId).toBe(bankId);

      simulateRecv(new UpdateContainmentMessage(0xa1n, bankId, 1));
      expect(ctx.bank.items.map((it) => it.networkId)).toEqual([0xa1n]);
    });

    it('ctx.bank.use(terminalId) sends ObjectMenuSelectMessage via the script dispatcher', () => {
      const { ctx, sent } = createFakeContext();
      const terminalId = 0x7e01n;
      const returned = ctx.bank.use(terminalId);
      expect(returned).toBe(terminalId);
      // findIndex because ctx may have sent other messages already (none expected here).
      const found = sent.find(
        (m): m is ObjectMenuSelectMessage =>
          m instanceof ObjectMenuSelectMessage &&
          m.targetId === terminalId &&
          m.selectedItemId === RadialMenuTypes.ITEM_USE,
      );
      expect(found).toBeDefined();
    });
  });
});
