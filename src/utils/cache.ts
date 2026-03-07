interface MtimeCacheEntry<T> {
  mtimeMs: number
  value: T
}

const mtimeCache = new Map<string, MtimeCacheEntry<unknown>>()

/** Returns a cached value when the source mtime is unchanged. */
export async function withMtimeCache<T>(
  cacheKey: string,
  mtimeMs: number | undefined,
  loader: () => Promise<T> | T,
): Promise<T> {
  if (typeof mtimeMs === "number") {
    const cached = mtimeCache.get(cacheKey) as MtimeCacheEntry<T> | undefined
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.value
    }
  }

  const value = await loader()
  if (typeof mtimeMs === "number") {
    mtimeCache.set(cacheKey, { mtimeMs, value })
  }

  return value
}

/** Clears cached mtime entries, optionally scoped by key prefix. */
export function clearMtimeCache(prefix?: string): void {
  if (!prefix) {
    mtimeCache.clear()
    return
  }

  for (const key of mtimeCache.keys()) {
    if (key.startsWith(prefix)) {
      mtimeCache.delete(key)
    }
  }
}
