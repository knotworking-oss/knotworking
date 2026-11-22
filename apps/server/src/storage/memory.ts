import { Readable } from "node:stream";
import { assertStorageKey, type Storage } from "./types";

/** In-memory storage for tests. */
export class MemoryStorage implements Storage {
  readonly kind = "memory";
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(key: string, body: Readable | AsyncIterable<Uint8Array>, info: { contentType: string }) {
    assertStorageKey(key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    this.objects.set(key, { bytes: Buffer.concat(chunks), contentType: info.contentType });
  }

  async get(key: string) {
    assertStorageKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: Readable.toWeb(Readable.from([object.bytes])) as ReadableStream<Uint8Array>,
      size: object.bytes.length,
    };
  }

  async delete(key: string) {
    assertStorageKey(key);
    this.objects.delete(key);
  }
}
