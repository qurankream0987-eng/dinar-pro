/**
 * Chat videos: private per-owner namespace, exact types and size, container signature, private ACL,
 * no mixing with photos, expiry and account cleanup. In-memory storage; no provider is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectNotFoundError } from "../src/lib/objectStorage";
import { isOwnedVisualSearchPath } from "../src/lib/visual-search-images";
import { isOwnedListingPhotoPath } from "../src/lib/listing-photos";
import {
  CHAT_VIDEO_RETENTION_MS, chatVideoObjectName, completeChatVideoUpload, deleteChatVideosForOwner,
  expireChatVideos, isOwnedChatVideoPath, verifyChatVideo, videoSignatureMatches,
} from "../src/lib/chat-video";

const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp" + brand, "ascii"), Buffer.alloc(52, 0)]);
const MP4 = ftyp("isom");
const MOV = ftyp("qt  ");
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(52, 0)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(62, 0)]);

function fakeStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string; owner?: string; visibility?: string; createdAt?: string }>();
  const file = (path: string) => ({
    path, name: path,
    getMetadata: async () => { const s = objects.get(path); return [{ size: s?.bytes.length, contentType: s?.contentType, timeCreated: s?.createdAt }]; },
    download: async () => [objects.get(path)!.bytes],
    delete: async () => { objects.delete(path); },
  });
  return {
    objects,
    async getObjectEntityFile(path: string) { if (!objects.has(path)) throw new ObjectNotFoundError(); return file(path); },
    async listObjectEntityFiles(prefix: string) { return [...objects.keys()].filter((p) => p.startsWith(`/objects/${prefix}`)).map(file); },
    async canAccessObjectEntity({ userId, objectFile }: any) { return objects.get(objectFile.path)?.owner === userId; },
    async trySetObjectEntityAclPolicy(path: string, policy: object) { Object.assign(objects.get(path)!, policy); },
  } as any;
}
const owner = randomUUID();
const stranger = randomUUID();

test("CV-01 names live in the owner's private chat-video namespace with exact types and size", () => {
  const name = chatVideoObjectName(owner, "video/mp4", 1000);
  assert.match(name, new RegExp(`^chat-video/${owner}/[0-9a-f-]{36}\\.mp4$`));
  assert.ok(isOwnedChatVideoPath(`/objects/${name}`, owner));
  assert.equal(isOwnedChatVideoPath(`/objects/${name}`, stranger), false);
  assert.equal(isOwnedVisualSearchPath(`/objects/${name}`, owner), false, "a video is not a search photo");
  assert.equal(isOwnedListingPhotoPath(`/objects/${name}`, owner), false, "a video is not a listing photo");
  for (const bad of ["video/x-msvideo", "image/jpeg", "application/octet-stream", "video/mp4; codecs=avc1"])
    assert.throws(() => chatVideoObjectName(owner, bad, 1000), /MP4/);
  assert.throws(() => chatVideoObjectName(owner, "video/mp4", 25 * 1024 * 1024 + 1), /25/);
  assert.throws(() => chatVideoObjectName(owner, "video/mp4", 0), /25/);
  assert.equal(isOwnedChatVideoPath(`/objects/chat-video/${owner}/../${stranger}/x.mp4`, owner), false);
});

test("CV-02 the container signature must match the declared type", () => {
  assert.ok(videoSignatureMatches(MP4, "video/mp4"));
  assert.ok(videoSignatureMatches(MOV, "video/quicktime"));
  assert.ok(videoSignatureMatches(WEBM, "video/webm"));
  assert.equal(videoSignatureMatches(MOV, "video/mp4"), false);
  assert.equal(videoSignatureMatches(MP4, "video/webm"), false);
  for (const bytes of [JPEG, EXE, Buffer.alloc(0), ftyp("XXXX")]) assert.equal(videoSignatureMatches(bytes, "video/mp4"), false);
});

test("CV-03 completion pins the video private; strangers, spoofed content and unfinished uploads are refused", async () => {
  const storage = fakeStorage();
  const path = `/objects/${chatVideoObjectName(owner, "video/mp4", MP4.length)}`;
  storage.objects.set(path, { bytes: MP4, contentType: "video/mp4" });
  await assert.rejects(verifyChatVideo(path, owner, { requireOwnerAccess: true }, storage), (e: any) => e.status === 403);
  await assert.rejects(completeChatVideoUpload(path, stranger, storage), (e: any) => e.status === 403);
  await completeChatVideoUpload(path, owner, storage);
  assert.deepEqual([storage.objects.get(path).owner, storage.objects.get(path).visibility], [owner, "private"]);
  assert.equal((await verifyChatVideo(path, owner, { requireOwnerAccess: true }, storage)).contentType, "video/mp4");
  // An executable uploaded with a video content type is refused and deleted.
  const spoof = `/objects/${chatVideoObjectName(owner, "video/mp4", EXE.length)}`;
  storage.objects.set(spoof, { bytes: EXE, contentType: "video/mp4" });
  await assert.rejects(completeChatVideoUpload(spoof, owner, storage), (e: any) => e.status === 400);
  assert.equal(storage.objects.has(spoof), false);
  await assert.rejects(verifyChatVideo(`/objects/${chatVideoObjectName(owner, "video/mp4", 10)}`, owner, undefined, storage), (e: any) => e.status === 400);
});

test("CV-04 expiry and account cleanup remove only chat videos", async () => {
  const storage = fakeStorage();
  const now = new Date("2026-11-12T00:00:00Z");
  const old = `/objects/${chatVideoObjectName(owner, "video/mp4", MP4.length)}`;
  const fresh = `/objects/${chatVideoObjectName(owner, "video/webm", WEBM.length)}`;
  const other = `/objects/${chatVideoObjectName(stranger, "video/mp4", MP4.length)}`;
  const photo = `/objects/visual-search/${owner}/${randomUUID()}.jpg`;
  storage.objects.set(old, { bytes: MP4, contentType: "video/mp4", createdAt: new Date(now.getTime() - CHAT_VIDEO_RETENTION_MS - 1000).toISOString() });
  storage.objects.set(fresh, { bytes: WEBM, contentType: "video/webm", createdAt: now.toISOString() });
  storage.objects.set(other, { bytes: MP4, contentType: "video/mp4", createdAt: now.toISOString() });
  storage.objects.set(photo, { bytes: JPEG, contentType: "image/jpeg" });
  assert.equal(await expireChatVideos(now, storage), 1);
  assert.equal(storage.objects.has(old), false);
  assert.equal(await deleteChatVideosForOwner(owner, storage), 1);
  assert.deepEqual([storage.objects.has(fresh), storage.objects.has(other), storage.objects.has(photo)], [false, true, true]);
});
