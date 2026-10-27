# argus-chat-media

Sending a file through a contract call, in pieces, for Argus plugins.

A plugin's screen has no upload endpoint. The only way from a bundle to its own contract is
`POST /api/v1/plugins/:pluginId/contracts/:contract/:method`, and that route accepts a body of
**100 KB** — enough for a sentence, useless for a photo.

This package is the way around it, and the arithmetic is the whole idea: bytes go in **48 KiB**
pieces, which is **64 KB** once base64 encoded, which fits inside that 100 KB with room to spare.
The bytes stay in the plugin's own storage, the call is already authenticated and already bound to
one company, and **no public URL is ever created**.

It is the shape `chat-tickets` ships, the WhatsApp connector uses in both directions, and the
internal chat adopted — which is why it lives in a package instead of being written a fourth time.
Two sides that disagree about where a chunk ends corrupt a file without anybody noticing.

## Using it

```ts
import { uploadMedia, downloadMedia, MAX_MEDIA_BYTES } from "@creativepetabyte/argus-chat-media";

// In the screen: `call` reaches this plugin's own contract, and it must THROW on refusal.
const ask = (method: string, input: Record<string, unknown>) => call(MY_CONTRACT, method, input);

const attachment = await uploadMedia(ask, { name: file.name, mimeType: file.type, bytes });
// → { id, name, mimeType, size }. Now name it in whatever method stores a message.

const bytes = await downloadMedia(ask, attachment, { messageId });
```

`uploadMedia` reserves the file, sends the pieces in order, and — if any piece fails — asks for the
reservation to be dropped before raising, so a failed upload leaves nothing behind.

## What the plugin has to answer

This package only moves bytes. The plugin owns the storage and the policy, and serves four methods
on its own contract:

| method | what it must do |
|---|---|
| `CreateAttachment({ name, mimeType, size })` | reserve an upload, answer `{ id, name, mimeType, size }` |
| `WriteAttachment({ attachmentId, offset, data })` | take one consecutive 48 KiB piece, base64 |
| `ReadAttachment({ ...scope, attachmentId, offset })` | answer `{ data }` for one piece |
| `DeleteAttachment({ attachmentId })` | drop an upload nobody has claimed |

The rules those four are expected to keep, learned from the implementations that exist:

- **Nothing is readable until it is whole and claimed by a message.** Until then an upload is
  pending — collectable, and never shown.
- **The same piece twice is one piece.** A retry must not corrupt an upload; a *different* piece at
  an offset already written is a conflict and is refused.
- **Pieces arrive in order.** The bytes received so far are also the next legal offset, so a gap
  cannot exist.
- **`ReadAttachment` takes a scope**, not just a file id. Whatever the plugin uses to decide who may
  read a message — a ticket id, a conversation id — travels with the request and is checked against
  the caller. A file id on its own would make every file readable by anyone who guessed one.
- **A quota and a sweep.** Pending uploads cost disk and belong to nobody: cap them per company and
  drop the old ones.
- **Files leave and are forgotten with the conversation**, through `ExportTenantData` and
  `DeleteTenantData`.

`chat-tickets`'s `media-store.ts` and the internal chat's are two independent implementations of
exactly this, and either reads as a specification.

## Limits

```ts
MAX_MEDIA_BYTES   // 10 MiB — the largest file
MEDIA_CHUNK_BYTES // 48 KiB — one piece, sized to fit the 100 KB a contract call accepts
```

`attachmentOf(raw)` validates an answer that came off the wire and throws `invalid_attachment`
rather than letting a malformed shape travel on. External data is validated, never asserted.

## What this is not

Not a streaming upload. A file is held in memory on both sides while it moves, which is why the
ceiling is 10 MiB and not a gigabyte. Video of any real length wants a different mechanism, and that
mechanism is a change to the kernel — tracked as
[argus-kernel#118](https://github.com/TimeWarpTech/argus-kernel/issues/118).

## Consuming it

It exports TypeScript directly, exactly as the kernel's own workspace packages do — there is no
build step and no `dist`. Bun, `tsx` and Vite all read it as it is, and the backend's bundler is
configured to pull `@creativepetabyte/*` in rather than leave it external.

Inside the kernel's monorepo it is a **git submodule** at `packages/chat-media`, so the workspace
resolves it as before while the code lives here:

```
git submodule update --init
```

A plugin outside the monorepo takes it as a dependency:

```json
"@creativepetabyte/argus-chat-media": "github:TimeWarpTech/argus-chat-media"
```

## Tests

```
npm install && npm test
```
