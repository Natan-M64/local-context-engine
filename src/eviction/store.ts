import { createHash } from "node:crypto"
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export interface StoredContent {
  handle: string
  hash: string
  bytes: number
  createdAt: string
  lastAccessed: string
}

export interface ContentStore {
  put(content: string): Promise<StoredContent>
  get(handle: string): Promise<string | undefined>
}

function hashFromHandle(handle: string): string | undefined {
  const match = /^ctx:\/\/sha256\/([a-f0-9]{64})$/.exec(handle)
  return match?.[1]
}

export class FilesystemContentStore implements ContentStore {
  constructor(private readonly root: string) {}

  private filePath(hash: string): string {
    return path.join(this.root, "sha256", hash.slice(0, 2), hash)
  }

  private metadataPath(hash: string): string {
    return `${this.filePath(hash)}.json`
  }

  async put(content: string): Promise<StoredContent> {
    const bytes = Buffer.byteLength(content)
    const hash = createHash("sha256").update(content).digest("hex")
    const file = this.filePath(hash)
    const metadata = this.metadataPath(hash)
    const now = new Date().toISOString()
    await mkdir(path.dirname(file), { recursive: true })
    const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporaryFile, content, { encoding: "utf8", flag: "wx" })
      await link(temporaryFile, file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    } finally {
      await unlink(temporaryFile).catch(() => undefined)
    }
    const metadataContent = JSON.stringify({
      hash,
      created_at: now,
      last_accessed: now,
      byte_size: bytes,
      content_type: "text/plain; charset=utf-8",
    })
    const temporaryMetadata = `${metadata}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporaryMetadata, metadataContent, { encoding: "utf8", flag: "wx" })
      await link(temporaryMetadata, metadata).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    } finally {
      await unlink(temporaryMetadata).catch(() => undefined)
    }
    const existingMetadata = await readFile(metadata, "utf8").then((value) => JSON.parse(value) as {
      created_at: string
      last_accessed: string
    })
    return {
      handle: `ctx://sha256/${hash}`,
      hash,
      bytes,
      createdAt: existingMetadata.created_at,
      lastAccessed: existingMetadata.last_accessed,
    }
  }

  async get(handle: string): Promise<string | undefined> {
    const hash = hashFromHandle(handle)
    if (!hash) return undefined
    const file = this.filePath(hash)
    const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (content === undefined) return undefined
    const now = new Date()
    const metadata = this.metadataPath(hash)
    const existing = await readFile(metadata, "utf8").then((value) => JSON.parse(value) as Record<string, unknown>).catch(() => undefined)
    if (existing) {
      const temporary = `${metadata}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ ...existing, last_accessed: now.toISOString() }), "utf8")
        await rename(temporary, metadata)
      } catch (error) {
        await writeFile(temporary, "", "utf8").catch(() => undefined)
        throw error
      }
    }
    return content
  }
}
