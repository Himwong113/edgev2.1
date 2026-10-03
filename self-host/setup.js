import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';

try {
  const { values } = parseArgs({ options: { url: { type: 'string' }, bind: { type: 'string' }, output: { type: 'string' } } });
  const url = new URL(values.url || 'http://localhost:8080');
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('--url must be an http(s) origin without a path');
  const bind = values.bind || '127.0.0.1';
  if (!isIP(bind)) throw new Error('--bind must be a local IP address');
  const output = resolve(values.output || '.env');
  const content = `ADMIN=${randomBytes(24).toString('hex')}\nUUID=${randomUUID()}\nKEY=${randomBytes(24).toString('hex')}\nPUBLIC_URL=${url.origin}\nBIND_ADDRESS=${bind}\nHTTP_PORT=8080\nVPN_DOMAIN=${url.hostname}\nTUNNEL_PATH=/\nOFF_LOG=true\nDEBUG=false\nPROXYIP=\n`;
  await writeFile(output, content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${output} with random credentials. Read ADMIN in that file to sign in. Existing files are never overwritten.`);
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Configuration file already exists; edit it to keep your current credentials.' : error.message);
  process.exitCode = 1;
}
