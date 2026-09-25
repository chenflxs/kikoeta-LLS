const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { Library } = require('../src/library');
const { Credentials } = require('../src/credentials');
const { createAdminHandler } = require('../src/server');
const iconv = require('iconv-lite');

function crc32(bytes) {
  let value = -1;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ -1) >>> 0;
}
function zip(entries, compress = false) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const label = Buffer.isBuffer(name) ? name : Buffer.from(name);
    const flags = Buffer.isBuffer(name) ? 0 : 0x800;
    const bytes = Buffer.from(data);
    const stored = compress ? zlib.deflateRawSync(bytes) : bytes;
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(stored.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(label.length, 26);
    local.push(header, label, stored);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(compress ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(stored.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(label.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, label);
    offset += header.length + label.length + stored.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test('ZIP import maps multiple works and nested packages, applies conflicts and rejects unsafe archives', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lls-zip-test-'));
  const library = new Library(dir);
  await library.init();
  const credentials = new Credentials(dir);
  await credentials.init();
  const server = http.createServer(createAdminHandler(library, { credentials }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); library.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  let csrf = (await login.json()).csrf;
  async function post(route, body, type = 'application/json') {
    const response = await fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'X-LLS-CSRF': csrf, 'Content-Type': type }, body });
    return { status: response.status, body: await response.json() };
  }
  const password = await post('/api/password', JSON.stringify({ newPassword: '123456' }));
  csrf = password.body.csrf;
  const inner = zip([['disc/track.lrc', 'nested'], ['cover.jpg', 'ignore']], true);
  const archive = zip([
    ['collection/RJ123 title/track.lrc', 'first'],
    ['collection/VJ456/other.srt', 'second'],
    ['collection/BJ789.zip', inner],
    ['../escape.lrc', 'unsafe'],
    ['collection/RJ123 title/cover.jpg', 'ignore'],
  ], true);
  const endpoint = '/api/import/zip?name=collection.zip&conflict=skip&ai=true';
  const created = await post('/api/import/jobs');
  assert.equal(created.status, 200);
  const jobId = created.body.id;
  async function jobStatus() {
    const response = await fetch(base + `/api/import/jobs/${jobId}`, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await jobStatus()).body.state, 'queued');
  assert.equal((await fetch(base + `/api/import/jobs/${jobId}`)).status, 401);
  const first = await post(`${endpoint}&job=${jobId}`, archive, 'application/zip');
  assert.equal(first.status, 200);
  assert.equal(first.body.imported, 3);
  assert.equal((await jobStatus()).body.state, 'success');
  assert.deepEqual((await jobStatus()).body.result, first.body);
  assert.equal((await post(`${endpoint}&job=${jobId}`, archive, 'application/zip')).status, 404);
  assert.deepEqual(first.body.workIds, ['RJ123', 'VJ456', 'BJ789']);
  assert.deepEqual((await library.works()).map((item) => item.workId), ['BJ789', 'RJ123', 'VJ456']);
  assert.equal(Buffer.from((await library.lyrics('BJ789'))[0].content, 'base64').toString(), 'nested');
  assert.equal((await library.files('RJ123'))[0].isAi, true);
  assert.equal((await post(endpoint, archive, 'application/zip')).body.skipped, 3);
  const replace = zip([['RJ123/track.lrc', 'changed']]);
  assert.equal((await post('/api/import/zip?name=change.zip&conflict=overwrite&ai=false', replace, 'application/zip')).body.overwritten, 1);
  assert.equal(Buffer.from((await library.lyrics('RJ123'))[0].content, 'base64').toString(), 'changed');
  assert.equal((await library.files('RJ123'))[0].isAi, false);
  const fallback = zip([['song.lrc', 'fallback']]);
  assert.equal((await post('/api/import/zip?name=RJ999.zip', fallback, 'application/zip')).body.imported, 1);
  const legacy = zip([[iconv.encode('RJ222/歌曲.lrc', 'gb18030'), 'legacy']]);
  assert.equal((await post('/api/import/zip?name=legacy.zip', legacy, 'application/zip')).body.imported, 1);
  assert.equal(Buffer.from((await library.lyrics('RJ222'))[0].content, 'base64').toString(), 'legacy');
  assert.equal(await fs.access(path.join(dir, 'escape.lrc')).then(() => true, () => false), false);
  assert.equal((await post('/api/import/zip?name=bad.zip', Buffer.from('bad'), 'application/zip')).status, 400);
  const failedJob = (await post('/api/import/jobs')).body.id;
  assert.equal((await post(`/api/import/zip?job=${failedJob}&name=bad.zip`, Buffer.from('bad'), 'application/zip')).status, 400);
  const failedStatus = await fetch(base + `/api/import/jobs/${failedJob}`, { headers: { Cookie: cookie } });
  assert.equal((await failedStatus.json()).state, 'error');
  const interruptedJob = (await post('/api/import/jobs')).body.id;
  await new Promise((resolve) => {
    const upload = http.request(base + `/api/import/zip?job=${interruptedJob}&name=partial.zip`, {
      method: 'POST', headers: { Cookie: cookie, 'X-LLS-CSRF': csrf, 'Content-Type': 'application/zip' },
    });
    upload.on('error', resolve);
    upload.write(Buffer.alloc(1024), () => upload.destroy());
  });
  let interruptedStatus;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(base + `/api/import/jobs/${interruptedJob}`, { headers: { Cookie: cookie } });
    interruptedStatus = await response.json();
    if (interruptedStatus.state === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(interruptedStatus.state, 'error');
  assert.equal(interruptedStatus.error, 'upload_interrupted');
  const bomb = zip([['RJ111/large.lrc', Buffer.alloc(8 * 1024 * 1024 + 1, 65)]]);
  assert.equal((await post('/api/import/zip?name=large.zip', bomb, 'application/zip')).status, 413);
  assert.equal((await post(endpoint, archive, 'application/zip')).body.skipped, 3);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.startsWith('zip-import-')), []);
});
