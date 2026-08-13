import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { FilesystemContentStore } from "../src/eviction/store.js"

test("stores content by hash and retrieves it by handle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-context-engine-"))
  try {
    const store = new FilesystemContentStore(root)
    const first = await store.put("large deterministic output")
    const second = await store.put("large deterministic output")
    assert.equal(first.handle, second.handle)
    assert.equal(first.bytes, Buffer.byteLength("large deterministic output"))
    assert.ok(first.createdAt)
    assert.ok(first.lastAccessed)
    assert.equal(await store.get(first.handle), "large deterministic output")
    assert.equal(await store.get("ctx://invalid"), undefined)
    const metadata = await readFile(path.join(root, "sha256", first.hash.slice(0, 2), `${first.hash}.json`), "utf8")
    assert.deepEqual(Object.keys(JSON.parse(metadata)).sort(), ["byte_size", "content_type", "created_at", "hash", "last_accessed"])
    assert.equal(JSON.parse(metadata).byte_size, first.bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
