import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// One file per key; atomic replacement keeps configuration intact on restart.
export class FileKV {
  constructor(directory) {
    this.directory = resolve(directory);
    this.ready = mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.writes = new Map();
  }

  path(key) {
    return join(this.directory, createHash('sha256').update(String(key)).digest('hex') + '.json');
  }

  async get(key, type = 'text') {
    await this.ready;
    await this.writes.get(String(key));
    try {
      const { value, expires } = JSON.parse(await readFile(this.path(key), 'utf8'));
      if (expires && expires <= Date.now()) return null;
      if (typeof type === 'object') type = type.type || 'text';
      if (type === 'json') return JSON.parse(value);
      if (type === 'arrayBuffer') return new TextEncoder().encode(value).buffer;
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  put(key, value, options = {}) {
    key = String(key);
    const pending = (this.writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      await this.ready;
      const target = this.path(key);
      const temporary = target + '.' + randomUUID() + '.tmp';
      const expires = options.expiration ? options.expiration * 1000
        : options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      try {
        await writeFile(temporary, JSON.stringify({ value: String(value), expires }), { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
    this.writes.set(key, pending);
    pending.finally(() => { if (this.writes.get(key) === pending) this.writes.delete(key); }).catch(() => {});
    return pending;
  }
}
