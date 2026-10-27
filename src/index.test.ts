import { describe, expect, it, vi } from "vitest";
import {
  type Attachment,
  attachmentOf,
  decodeBytes,
  downloadMedia,
  encodeBytes,
  MAX_MEDIA_BYTES,
  MEDIA_CHUNK_BYTES,
  uploadMedia,
} from "./index";

const bytesOf = (size: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_, index) => (index * 7) % 256);

/**
 * A plugin that answers the four methods, holding the pieces in memory.
 *
 * Deliberately strict about order and completeness: those are the rules a real implementation keeps,
 * and a fake that accepted anything would let a broken client pass.
 */
function fakePlugin() {
  const files = new Map<string, { file: Attachment; chunks: Map<number, string>; received: number }>();
  let next = 0;

  const call = vi.fn(async (method: string, input: Record<string, unknown>): Promise<unknown> => {
    if (method === "CreateAttachment") {
      next += 1;
      const file: Attachment = {
        id: `a-${next}`,
        name: String(input.name),
        mimeType: String(input.mimeType),
        size: Number(input.size),
      };
      files.set(file.id, { file, chunks: new Map(), received: 0 });
      return file;
    }
    const held = files.get(String(input.attachmentId));
    if (held === undefined) throw new Error("attachment_not_found");

    if (method === "WriteAttachment") {
      const offset = Number(input.offset);
      if (offset !== held.received) throw new Error("invalid_upload_offset");
      const data = String(input.data);
      held.chunks.set(offset, data);
      held.received += decodeBytes(data).length;
      return { ok: true };
    }
    if (method === "ReadAttachment") {
      const data = held.chunks.get(Number(input.offset));
      if (data === undefined) throw new Error("attachment_not_found");
      return { data };
    }
    if (method === "DeleteAttachment") {
      files.delete(held.file.id);
      return { ok: true };
    }
    throw new Error("unknown_method");
  });

  return { call, files };
}

describe("base64 framing", () => {
  it("survives a round trip, including bytes above 127", () => {
    const bytes = bytesOf(1000);
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
  });
});

describe("the chunk size", () => {
  it("still fits what a contract call accepts, which is the whole reason it exists", () => {
    // base64 inflates by 4/3. If this ever stops holding, uploads start failing at the kernel.
    expect(Math.ceil((MEDIA_CHUNK_BYTES * 4) / 3)).toBeLessThan(100 * 1024);
  });
});

describe("uploading", () => {
  it("sends a file in order and answers with what the plugin reserved", async () => {
    const plugin = fakePlugin();
    const bytes = bytesOf(MEDIA_CHUNK_BYTES * 2 + 17);

    const file = await uploadMedia(plugin.call, { name: "foto.png", mimeType: "image/png", bytes });

    expect(file.name).toBe("foto.png");
    expect(plugin.call.mock.calls.filter(([method]) => method === "WriteAttachment")).toHaveLength(3);
  });

  it("gives a file with no type one, rather than sending an empty string", async () => {
    const plugin = fakePlugin();
    await uploadMedia(plugin.call, { name: "x", mimeType: "", bytes: bytesOf(10) });
    expect(plugin.call.mock.calls[0]?.[1]).toMatchObject({ mimeType: "application/octet-stream" });
  });

  it("refuses an empty file and one over the ceiling, before any call is made", async () => {
    const plugin = fakePlugin();
    await expect(
      uploadMedia(plugin.call, { name: "x", mimeType: "image/png", bytes: new Uint8Array(0) }),
    ).rejects.toThrow("media_size_limit");
    await expect(
      uploadMedia(plugin.call, {
        name: "x",
        mimeType: "image/png",
        bytes: new Uint8Array(MAX_MEDIA_BYTES + 1),
      }),
    ).rejects.toThrow("media_size_limit");
    expect(plugin.call).not.toHaveBeenCalled();
  });

  it("drops the reservation when a piece fails, so nothing is left half-sent", async () => {
    const plugin = fakePlugin();
    plugin.call.mockImplementationOnce(async () => ({
      id: "a-1",
      name: "x",
      mimeType: "image/png",
      size: 10,
    }));
    plugin.call.mockImplementationOnce(async () => {
      throw new Error("invalid_media_chunk");
    });

    await expect(
      uploadMedia(plugin.call, { name: "x", mimeType: "image/png", bytes: bytesOf(10) }),
    ).rejects.toThrow("invalid_media_chunk");

    expect(plugin.call.mock.calls.at(-1)?.[0]).toBe("DeleteAttachment");
  });
});

describe("downloading", () => {
  it("comes back byte for byte", async () => {
    const plugin = fakePlugin();
    const bytes = bytesOf(MEDIA_CHUNK_BYTES + 123);
    const file = await uploadMedia(plugin.call, { name: "a.bin", mimeType: "application/pdf", bytes });

    expect(await downloadMedia(plugin.call, file, { messageId: "m-1" })).toEqual(bytes);
  });

  it("refuses a piece of the wrong length instead of handing back a holed file", async () => {
    const plugin = fakePlugin();
    const file = await uploadMedia(plugin.call, {
      name: "a.bin",
      mimeType: "application/pdf",
      bytes: bytesOf(100),
    });
    plugin.call.mockImplementationOnce(async () => ({ data: encodeBytes(bytesOf(99)) }));

    await expect(downloadMedia(plugin.call, file, {})).rejects.toThrow("invalid_media_chunk");
  });

  it("says so when the plugin answers something that is not a piece", async () => {
    const plugin = fakePlugin();
    const file = await uploadMedia(plugin.call, {
      name: "a.bin",
      mimeType: "application/pdf",
      bytes: bytesOf(10),
    });
    plugin.call.mockImplementationOnce(async () => ({ nope: true }));

    await expect(downloadMedia(plugin.call, file, {})).rejects.toThrow("media_unavailable");
  });
});

describe("validating what came off the wire", () => {
  it("accepts a well-formed attachment", () => {
    const file = { id: "a-1", name: "x.png", mimeType: "image/png", size: 10 };
    expect(attachmentOf(file)).toEqual(file);
  });

  it("refuses anything malformed, rather than letting it travel on", () => {
    const cases: unknown[] = [
      undefined,
      null,
      "a-1",
      { id: "", name: "x", mimeType: "image/png", size: 1 },
      { id: "a", name: "", mimeType: "image/png", size: 1 },
      { id: "a", name: "x", mimeType: "image/png", size: 0 },
      { id: "a", name: "x", mimeType: "image/png", size: 1.5 },
      { id: "a", name: "x", mimeType: "image/png", size: MAX_MEDIA_BYTES + 1 },
      { id: "a", name: "x", size: 1 },
    ];
    for (const bad of cases) expect(() => attachmentOf(bad)).toThrow("invalid_attachment");
  });
});
