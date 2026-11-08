import type { Readable } from "node:stream";

export type ObjectMetadata = {
  size?: string | number;
  generation?: string;
  timeCreated?: string | Date;
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
};

/** The small storage-object surface used by routes and ACL enforcement. */
export interface ObjectFileLike {
  name: string;
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[ObjectMetadata]>;
  setMetadata(input: { metadata: Record<string, string> }): Promise<unknown>;
  download(options?: { start?: number; end?: number }): Promise<[Buffer]>;
  createReadStream(): Readable;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
}
