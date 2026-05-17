import { describe, expect, it } from 'vitest';

import { ByteStream } from '../archive/byte-stream.js';
import { ChatInstantMessageToClient } from '../messages/game/chat/chat-instant-message-to-client.js';
import { chatAvatarId } from '../messages/game/chat/chat-avatar-id.js';
import { ChatSystemMessage } from '../messages/game/chat/chat-system-message.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  ObjControllerSubtypeIds,
  type SpatialChatData,
  SpatialChatKind,
  SpatialChatReceiveDecoder,
} from '../messages/game/obj-controller/index.js';
import { createFakeContext } from './script/test-helpers.js';

function makeSpatialChatReceive(data: SpatialChatData): ObjControllerMessage {
  const stream = new ByteStream();
  SpatialChatReceiveDecoder.encode(stream, data);
  return new ObjControllerMessage(
    CLIENT_TO_AUTH_SERVER_FLAGS,
    ObjControllerSubtypeIds.CM_spatialChatReceive,
    data.sourceId,
    0,
    stream.toBytes(),
    { kind: SpatialChatKind, data },
  );
}

describe('ChatHandlers', () => {
  describe('onSay', () => {
    it('fires for matching RegExp predicate', () => {
      const { ctx, simulateRecv } = createFakeContext();
      const calls: Array<{ text: string; name: string }> = [];
      ctx.chat.onSay(/follow me/i, (text, sender) => {
        calls.push({ text, name: sender.name });
      });

      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xaaaan,
          targetId: 0n,
          text: 'Hello world',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'Bob',
        }),
      );
      expect(calls).toEqual([]);

      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xaaaan,
          targetId: 0n,
          text: 'follow me everyone!',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'Bob',
        }),
      );
      expect(calls).toEqual([{ text: 'follow me everyone!', name: 'Bob' }]);
    });

    it('fires for matching function predicate', () => {
      const { ctx, simulateRecv } = createFakeContext();
      const calls: Array<{ text: string; id: bigint | null }> = [];
      ctx.chat.onSay(
        (text, sender) => text.startsWith('!') && sender.name === 'Carol',
        (text, sender) => {
          calls.push({ text, id: sender.id });
        },
      );

      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xb1n,
          targetId: 0n,
          text: 'hi there',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'Carol',
        }),
      );
      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xb2n,
          targetId: 0n,
          text: '!attack',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'Carol',
        }),
      );
      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xb3n,
          targetId: 0n,
          text: '!attack',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'Dave',
        }),
      );
      expect(calls).toEqual([{ text: '!attack', id: 0xb2n }]);
    });

    it('returns unsubscribe fn that stops firing', () => {
      const { ctx, simulateRecv } = createFakeContext();
      const calls: string[] = [];
      const unsub = ctx.chat.onSay(/.*/, (text) => calls.push(text));

      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xc1n,
          targetId: 0n,
          text: 'first',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'X',
        }),
      );
      unsub();
      simulateRecv(
        makeSpatialChatReceive({
          sourceId: 0xc1n,
          targetId: 0n,
          text: 'second',
          flags: 0,
          volume: 50,
          chatType: 0,
          moodType: 0,
          language: 0,
          outOfBand: '',
          sourceName: 'X',
        }),
      );
      expect(calls).toEqual(['first']);
    });

    it('handler errors do not break the dispatcher', () => {
      const { ctx, simulateRecv } = createFakeContext();
      ctx.chat.onSay(/.*/, () => {
        throw new Error('boom');
      });

      // Should not throw out of simulateRecv.
      expect(() =>
        simulateRecv(
          makeSpatialChatReceive({
            sourceId: 0xd1n,
            targetId: 0n,
            text: 'crash test',
            flags: 0,
            volume: 50,
            chatType: 0,
            moodType: 0,
            language: 0,
            outOfBand: '',
            sourceName: 'Y',
          }),
        ),
      ).not.toThrow();
    });
  });

  describe('onTell', () => {
    it('fires with sender name and null id', () => {
      const { ctx, simulateRecv } = createFakeContext();
      const calls: Array<{ text: string; name: string; id: bigint | null }> = [];
      ctx.chat.onTell(/hi/i, (text, sender) => {
        calls.push({ text, name: sender.name, id: sender.id });
      });

      simulateRecv(
        new ChatInstantMessageToClient(
          chatAvatarId('alice', 'swg', 'SWG'),
          'Hi there!',
          '',
        ),
      );
      expect(calls).toEqual([{ text: 'Hi there!', name: 'alice', id: null }]);
    });
  });

  describe('onSystemMessage', () => {
    it('fires with null sender', () => {
      const { ctx, simulateRecv } = createFakeContext();
      const calls: Array<{ text: string; sender: null }> = [];
      ctx.chat.onSystemMessage(/level/, (text, sender) => {
        calls.push({ text, sender });
      });

      simulateRecv(new ChatSystemMessage(0, 'You leveled up!', ''));
      simulateRecv(new ChatSystemMessage(0, 'Other thing', ''));
      expect(calls).toEqual([{ text: 'You leveled up!', sender: null }]);
    });
  });
});
