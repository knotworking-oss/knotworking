import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LocalStorage } from "./local";
import { S3Storage, type S3Config } from "./s3";
import type { Storage } from "./types";

export { LocalStorage } from "./local";
export { MemoryStorage } from "./memory";
export { S3Storage, signV4, type S3Config } from "./s3";
export { assertStorageKey, type Storage, type StoredObject } from "./types";

export type StorageConfig = { kind: "local"; dir: string } | ({ kind: "s3" } & S3Config);

/** `<repo>/.data/uploads` in a checkout (next to the PGlite database), else `./.data/uploads`. */
export function defaultUploadDir(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(".data/uploads");
    dir = parent;
  }
  return join(dir, ".data", "uploads");
}

export function createStorage(config: StorageConfig): Storage {
  if (config.kind === "s3") {
    const { kind: _kind, ...s3 } = config;
    return new S3Storage(s3);
  }
  return new LocalStorage(config.dir);
}
