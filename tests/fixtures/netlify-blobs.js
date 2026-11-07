export function blobStore() {
  const values = new Map(); let version = 0;
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const write = async (key, data, options = {}) => {
    const current = values.get(key);
    if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
    const row = { data: copy(data), metadata: copy(options.metadata || {}), etag: '"v' + ++version + '"' };
    values.set(key, row); return { modified: true, etag: row.etag };
  };
  return { values,
    async get(key) { return copy(values.get(key)?.data) ?? null; },
    async getWithMetadata(key) { return copy(values.get(key)) || null; },
    async getMetadata(key) { const row = values.get(key); return row ? { etag: row.etag, metadata: copy(row.metadata) } : null; },
    setJSON: write, set: write, async delete(key) { values.delete(key); },
    list({ prefix = "", paginate } = {}) {
      const page = { blobs: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, etag: row.etag })), directories: [] };
      return paginate ? (async function* () { yield page; })() : Promise.resolve(page);
    }
  };
}
