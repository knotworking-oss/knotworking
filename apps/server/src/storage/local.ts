import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertStorageKey, type Storage } from "./types";

/**
 * Attachments on the local disk under `dir` (`UPLOAD_DIR`; in compose, a named volume). Writes go
 * to a temporary file that is renamed into place once complete, so a failed or aborted upload
 * never leaves a partial object behind.
 */
export class LocalStorage implements Storage {
  readonly kind = "local";
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private path(key: string) {
    assertStorageKey(key);
    return join(this.dir, ...key.split("/"));
  }

  async put(key: string, body: Readable | AsyncIterable<Uint8Array>) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.partial`;
    try {
      const source = body instanceof Readable ? body : Readable.from(body);
      // 0o600: only the API's user can read uploads.
      await pipeline(source, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string) {
    const path = this.path(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return {
        body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        size: info.size,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}
