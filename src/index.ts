/** Bounded binary transfer over the existing authenticated, tenant-bound contract transport. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_CHUNK_BYTES = 48 * 1024;
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
export type MediaCall = (method: string, input: Record<string, unknown>) => Promise<unknown>;
export function attachmentOf(raw: unknown): Attachment {
  if (!raw || typeof raw !== "object") throw new Error("invalid_attachment");
  const a = raw as Record<string, unknown>;
  if (
    typeof a.id !== "string" ||
    !a.id ||
    typeof a.name !== "string" ||
    !a.name ||
    typeof a.mimeType !== "string" ||
    typeof a.size !== "number" ||
    !Number.isInteger(a.size) ||
    a.size < 1 ||
    a.size > MAX_MEDIA_BYTES
  )
    throw new Error("invalid_attachment");
  return { id: a.id, name: a.name, mimeType: a.mimeType, size: a.size };
}
export function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function decodeBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
export async function uploadMedia(
  call: MediaCall,
  file: { name: string; mimeType: string; bytes: Uint8Array },
): Promise<Attachment> {
  if (!file.bytes.length || file.bytes.length > MAX_MEDIA_BYTES) throw new Error("media_size_limit");
  const a = attachmentOf(
    await call("CreateAttachment", {
      name: file.name,
      mimeType: file.mimeType || "application/octet-stream",
      size: file.bytes.length,
    }),
  );
  try {
    for (let offset = 0; offset < file.bytes.length; offset += MEDIA_CHUNK_BYTES)
      await call("WriteAttachment", {
        attachmentId: a.id,
        offset,
        data: encodeBytes(file.bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES)),
      });
    return a;
  } catch (error) {
    await call("DeleteAttachment", { attachmentId: a.id }).catch(() => {});
    throw error;
  }
}
export async function downloadMedia(
  call: MediaCall,
  a: Attachment,
  scope: Record<string, unknown>,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(a.size);
  for (let offset = 0; offset < a.size; offset += MEDIA_CHUNK_BYTES) {
    const raw = await call("ReadAttachment", { ...scope, attachmentId: a.id, offset });
    if (!raw || typeof raw !== "object" || !("data" in raw) || typeof raw.data !== "string")
      throw new Error("media_unavailable");
    const chunk = decodeBytes(raw.data);
    if (chunk.length !== Math.min(MEDIA_CHUNK_BYTES, a.size - offset)) throw new Error("invalid_media_chunk");
    bytes.set(chunk, offset);
  }
  return bytes;
}
