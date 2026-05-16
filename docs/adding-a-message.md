# Adding a new GameNetworkMessage

This is the cookie-cutter recipe for adding any of the ~80 in-game
messages (movement, chat, combat, crafting, etc.) that the MVP doesn't
model yet. Each step is mechanical — the hardest part is finding the
right C++ file.

---

## Step 1. Find the message in the C++ source

Every `GameNetworkMessage` subclass lives under
`~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/`.
Grouped roughly by direction:

- `clientLoginServer/` — anything between client and LoginServer
- `clientGameServer/` — anything between client and ConnectionServer or GameServer
- `core/`, `common/` — shared utility types

To find a specific message by name:

```bash
grep -rln 'class MyNewMessage' /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/
```

The corresponding `.cpp` file has the constructor that defines the field
order via `addVariable()` calls. **This order IS the wire order.**

---

## Step 2. Count the `addVariable()` calls

The C++ constructor looks like this:

```cpp
MyNewMessage::MyNewMessage(int32 foo, std::string const & bar)
: GameNetworkMessage("MyNewMessage")  // adds `cmd` as the first AutoVariable
, m_foo(foo)
, m_bar(bar)
{
    addVariable(m_foo);
    addVariable(m_bar);
}
```

The **base ctor** (`GameNetworkMessage("MyNewMessage")`) implicitly adds
`cmd` as the first AutoVariable. Then the body adds each payload field
one by one. So `varCount = 1 + (number of addVariable() calls)`.

In this example, `varCount = 3` (cmd + foo + bar).

For **empty messages** (no payload fields, like `HeartBeat`,
`LogoutMessage`, `CmdSceneReady`), `varCount = 1`.

For **`GenericValueTypeMessage<T>`**, `varCount = 2` (cmd + value).

---

## Step 3. Identify the wire codec for each field

Map each C++ type to a TS codec from `src/archive/`:

| C++ type | Wire bytes | TS codec |
|----------|------------|----------|
| `bool` | 1 byte | `stream.writeBool / iter.readBool` |
| `int8 / uint8` | 1 byte | `writeI8/U8 / readI8/U8` |
| `int16 / uint16` | 2 LE | `writeI16/U16 / readI16/U16` |
| `int32 / uint32` | 4 LE | `writeI32/U32 / readI32/U32` |
| `int64 / uint64` | 8 LE | `writeI64/U64 / readI64/U64` (returns/takes `bigint`) |
| `float (f32)` | 4 LE IEEE 754 | `writeF32 / readF32` |
| `double (f64)` | 8 LE IEEE 754 | `writeF64 / readF64` |
| `std::string` | u16 LE length + UTF-8 bytes | `writeStdString / readStdString` from `string.ts` |
| `Unicode::String` | u32 LE char-count + UTF-16 LE bytes | `writeUnicodeString / readUnicodeString` from `unicode-string.ts` |
| `NetworkId` | i64 LE | `NetworkIdCodec` from `network-id.ts` |
| `Transform` | 7 f32 LE (28 bytes) | `TransformCodec` from `transform.ts` |
| `Vector` | 3 f32 LE | `Vector3Codec` from `transform.ts` |
| `std::vector<T>` | i32 LE count + T[] | `VectorCodec(T)` from `containers.ts` |
| `std::set<T>` | i32 LE count + T[] | `SetCodec(T)` |
| `std::map<K,V>` | u32 LE count + KV[] | `MapCodec(K, V)` |
| `std::pair<A,B>` | A then B | `PairCodec(A, B)` |
| `AutoArray<T>` | u32 LE count + T[] | `AutoArrayCodec(T)` |
| `AutoVariable<T>` | just T | `AutoVariableCodec(T)` (= identity) |

**Important corner cases:**

- `AutoArray<unsigned char>` is u32 LE count + raw bytes. Use
  `stream.writeU32(bytes.length); stream.writeBytes(bytes)` directly —
  don't try to wrap it in `AutoArrayCodec(U8)`.
- The `cmd` AutoVariable is the typeCrc — handled by `encodeMessage()`,
  not by your `encodePayload`. Do NOT write it in `encodePayload`.

---

## Step 4. Decide the folder

```
src/messages/login/      ← LoginServer ↔ client (rare; small fixed set)
src/messages/connection/ ← ConnectionServer ↔ client (and shared ErrorMessage)
src/messages/game/       ← GameServer ↔ client (the bulk of in-game traffic)
```

If unsure, follow the C++ filename: `clientLoginServer/` → `login/`,
`clientGameServer/` → `connection/` or `game/`. Anything used in
gameplay (movement, combat, chat) goes in `game/`.

---

## Step 5. Write the class

File: `src/messages/<folder>/my-new-message.ts`

```typescript
/**
 * MyNewMessage — <direction>.
 *
 * <one-paragraph description of when/why this is sent>.
 *
 * Wire layout (addVariable order — note this may NOT match the
 * constructor argument order):
 *   [i32]     foo
 *   [string]  bar
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MyNewMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('MyNewMessage');

export class MyNewMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + foo + bar */
  static override readonly varCount = 3;

  constructor(
    public readonly foo: number,
    public readonly bar: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.foo);
    writeStdString(stream, this.bar);
  }

  static decodePayload(iter: IReadIterator): MyNewMessage {
    const foo = iter.readI32();
    const bar = readStdString(iter);
    return new MyNewMessage(foo, bar);
  }
}

export const MyNewMessageDecoder = registerMessage(asDecoder(MyNewMessage));
```

The boilerplate that's important:

1. `static override readonly messageName` — must be the EXACT C++ class
   name (case-sensitive). Used by `constcrc` to compute the typeCrc.
2. `static readonly typeCrc` — computed at module-load time.
3. `static override readonly varCount` — must be `1 + addVariable() count`.
   Wrong values cause the server to fail to decode the message — usually
   resulting in a `ReadException` somewhere or a silent drop.
4. `encodePayload(stream)` and `static decodePayload(iter)` — must be
   the inverse of each other.
5. The trailing `registerMessage(asDecoder(MyNewMessage))` registers
   the decoder with the singleton registry so inbound messages can be
   dispatched by CRC.

---

### Variant: GenericValueTypeMessage helper

For single-field messages, use the helper from `base.ts`:

```typescript
import { I32 } from '../../archive/primitives.js';
import { defineGenericValueTypeMessage } from '../base.js';
import { registerMessage } from '../registry.js';

const def = defineGenericValueTypeMessage<number>('MyIntMessage', I32);
export const MyIntMessage = def.Message;
export const MyIntMessageDecoder = registerMessage(def.decoder);
```

This expands to a class with `varCount = 2` and a `value: number` field.
See `src/messages/login/server-now-epoch-time.ts` for the pattern.

---

## Step 6. Add to the registration test

Append to `src/messages/_registration.test.ts`:

```typescript
import { MyNewMessage } from './<folder>/my-new-message.js';

const ALL_DECODERS = [
  // ...existing classes
  MyNewMessage,
];

describe('message registration', () => {
  it('exports N message classes', () => {
    expect(ALL_DECODERS.length).toBe(<N + 1>);  // bump
  });
  // The other tests iterate ALL_DECODERS and don't need editing.
});
```

If your new message is a server→client message that's known to arrive
during the lifecycle, also add it to the side-effect import list at the
top of `src/client/swg-client.ts` so the orchestrator's first dispatcher
has its decoder available.

---

## Step 7. Write a golden-byte round-trip test

File: `src/messages/<folder>/my-new-message.test.ts`

```typescript
import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../base.js';
import { messageRegistry } from '../registry.js';
import { MyNewMessage } from './my-new-message.js';

// Side-effect import (registration)
import './my-new-message.js';

describe('MyNewMessage', () => {
  it('has the right metadata', () => {
    expect(MyNewMessage.messageName).toBe('MyNewMessage');
    expect(MyNewMessage.varCount).toBe(3);
    expect(MyNewMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new MyNewMessage(42, 'hello');
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(3);
    expect(typeCrc).toBe(MyNewMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(MyNewMessage);
    if (!(decoded instanceof MyNewMessage)) throw new Error('typeguard');

    expect(decoded.foo).toBe(42);
    expect(decoded.bar).toBe('hello');
  });

  it('has the exact byte layout we expect', () => {
    const msg = new MyNewMessage(1, 'ab');
    const bytes = encodeMessage(msg);
    // varCount = 3 (LE u16) → 03 00
    // typeCrc (LE u32)
    // foo = 1 (LE i32) → 01 00 00 00
    // bar = "ab": u16 length 2 → 02 00; bytes 61 62
    // Total: 2 + 4 + 4 + 2 + 2 = 14 bytes
    expect(bytes.length).toBe(14);
    // varCount prefix
    expect(bytes[0]).toBe(0x03);
    expect(bytes[1]).toBe(0x00);
    // foo == 1 LE
    expect(bytes[6]).toBe(0x01);
    expect(bytes[7]).toBe(0x00);
    // string "ab"
    expect(bytes[12]).toBe(0x61);
    expect(bytes[13]).toBe(0x62);
  });
});
```

Run with `pnpm test src/messages/<folder>/my-new-message.test.ts`.

---

## Step 8. (Optional) Use it from the orchestrator

If your message is part of an automated flow:

- Outbound: `dispatcher.send(new MyNewMessage(42, 'hello'))`
- Inbound (one-shot): `const msg = await dispatcher.waitFor(MyNewMessage)`
- Inbound (every): `dispatcher.onMessage(MyNewMessage, (m) => { ... })`

See `src/client/login-stage.ts`, `connection-stage.ts`, `game-stage.ts`
for examples.

---

## Verification checklist

Before commit:

- [ ] `pnpm typecheck` is clean
- [ ] `pnpm lint` is clean
- [ ] `pnpm test src/messages/<folder>/my-new-message.test.ts` passes
- [ ] `pnpm test src/messages/_registration.test.ts` passes
- [ ] The `messageName` exactly matches the C++ class name
- [ ] `varCount` equals 1 + the number of `addVariable()` calls in the C++ ctor
- [ ] `encodePayload` writes fields in `addVariable()` order, NOT
      constructor argument order (these can differ!)
- [ ] The wire layout in your file's docstring cross-references the C++ source

If the message is inbound and you have a real captured packet, add a
golden-byte fixture to `tests/fixtures/` and a test that decodes it. The
existing `tests/integration/wire-parse.test.ts` is a good template.

---

## Common pitfalls

### 1. addVariable() order ≠ constructor argument order

C++ constructors often take args in a "human-friendly" order but call
`addVariable` in a different order for backward compatibility:

```cpp
ClientCreateCharacter::ClientCreateCharacter(...)
{
    addVariable(m_appearanceData);   // FIRST — but it's the 5th ctor arg!
    addVariable(m_characterName);
    addVariable(m_templateName);
    // ...
}
```

**Always** read the `.cpp` constructor body, not the `.h` field
declarations.

### 2. AutoArray<unsigned char> is special

Don't wrap it in `AutoArrayCodec(U8)` — that would emit a u32 count then
loop one byte at a time, which works but is slower. Just:

```typescript
encodePayload(stream): {
  stream.writeU32(this.token.length);
  stream.writeBytes(this.token);
}
```

See `src/messages/login/login-client-token.ts:42`.

### 3. The `cmd` AutoVariable is implicit

You don't write it in `encodePayload`. The framework's `encodeMessage()`
already prepends `[varCount u16 LE][typeCrc u32 LE]` for you. Your job
is only the payload bytes.

### 4. Some messages have non-AutoVariable trailers

`ObjControllerMessage` is the canonical example: its 5 AutoVariables
include 4 header fields + `value`, but the C++ `pack()` then writes
arbitrary additional bytes (the controller-specific payload). The
AutoByteStream `varCount` prefix says 5; the trailing bytes are
"out-of-band" and the receiver knows their length from the message-type
sub-dispatch.

We model this by parsing the 5 normal fields, then capturing any
remaining bytes as an opaque `data: Uint8Array`. See
`src/messages/game/obj-controller-message.ts:71-78`.

### 5. NetworkVersionId must match the server

Hardcoded `"20100225-17:43"` in
`sharedNetworkMessages/.../GameNetworkMessage.cpp:21`. Mismatched
versions get a `LoginIncorrectClientId` from the LoginServer (PRODUCTION
builds only — dev builds skip the check). Our default is set in
`src/messages/base.ts:NETWORK_VERSION_ID` — bump it if you're targeting
a newer server.

### 6. constcrc collisions

Adding a message with the same name as an existing one is caught at
module-load time by `messageRegistry.register()` (throws on duplicate
CRC). You should never have a real collision — the SOE CRC has a 32-bit
output space and ~28 messages is nowhere near the birthday bound — but
if you typo the name, you'll get a hash that happens to collide. The
fix is: re-check the C++ class name spelling.
