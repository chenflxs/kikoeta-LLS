const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Library } = require('../src/library');
const { Credentials } = require('../src/credentials');
const { createApiHandler, createAdminHandler } = require('../src/server');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('admin upload, public compatibility, persistence and path boundaries', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeta-lls-'));
  const library = new Library(dataDir);
  await library.init();
  const credentials = new Credentials(dataDir);
  await credentials.init();
  const api = await listen(createApiHandler(library));
  const admin = await listen(createAdminHandler(library, { credentials }));
  let restarted;
  t.after(async () => {
    await Promise.all([new Promise((resolve) => api.server.close(resolve)), new Promise((resolve) => admin.server.close(resolve))]);
    restarted?.close();
    library.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function get(route) {
    const response = await fetch(api.url + route);
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const base = '/api/lyrics-library/v1/works';
  const adminPage = await fetch(admin.url + '/admin');
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Kikoeta-LLS/);
  assert.equal((await fetch(admin.url + '/admin/app.js')).status, 200);
  const logo = await fetch(admin.url + '/admin/logo.png');
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /^image\/png/);
  assert.equal((await fetch(admin.url + '/admin/api/works')).status, 401);
  assert.deepEqual((await get(base)).body, { version: 1, works: [] });
  assert.equal((await get(base + '/BAD/files')).body.error, 'work_not_found');
  assert.equal((await get(base + '/RJ123/files')).body.error, 'work_not_found');
  assert.equal((await get(base + '/RJ123/other')).body.error, 'not_found');
  assert.equal((await fetch(api.url + base, { method: 'POST' })).status, 405);

  const loginResponse = await fetch(admin.url + '/admin/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const login = await loginResponse.json();
  assert.equal(login.mustChangePassword, true);
  const otherLoginResponse = await fetch(admin.url + '/admin/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  assert.equal(otherLoginResponse.status, 200);
  const otherCookie = otherLoginResponse.headers.get('set-cookie').split(';')[0];
  let csrf = login.csrf;
  async function adminRequest(route, method, body, token = csrf) {
    const response = await fetch(admin.url + '/admin/api/' + route, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-LLS-CSRF': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const bytes = Buffer.from([0, 255, 10, 65]);
  const upload = { workId: 'rj123', relativePath: 'disc1/track01.lrc', content: bytes.toString('base64'), isAi: true };
  assert.equal((await adminRequest('works', 'GET')).body.error, 'password_change_required');
  assert.equal((await adminRequest('files', 'POST', upload)).body.error, 'password_change_required');
  assert.equal((await adminRequest('password', 'POST', { newPassword: '12345' })).body.error, 'invalid_new_password');
  assert.equal((await adminRequest('password', 'POST', { newPassword: 'kikoeta-lrc' })).body.error, 'invalid_new_password');
  const changed = await adminRequest('password', 'POST', { newPassword: '123456' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.mustChangePassword, false);
  csrf = changed.body.csrf;
  assert.equal((await fetch(admin.url + '/admin/api/session', { headers: { Cookie: otherCookie } })).status, 401);
  assert.equal((await adminRequest('session', 'GET')).body.mustChangePassword, false);
  const savedCredentials = JSON.parse(await fs.readFile(path.join(dataDir, 'admin-credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(savedCredentials).sort(), ['hash', 'salt', 'version']);
  assert.match(savedCredentials.hash, /^[a-f0-9]{64}$/);
  const restartedCredentials = new Credentials(dataDir);
  await restartedCredentials.init();
  assert.equal((await restartedCredentials.verify('kikoeta-lrc')).valid, false);
  assert.equal((await restartedCredentials.verify('123456')).valid, true);
  const afterRestart = await listen(createAdminHandler(library, { credentials: restartedCredentials }));
  t.after(() => new Promise((resolve) => afterRestart.server.close(resolve)));
  const oldLogin = await fetch(afterRestart.url + '/admin/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(afterRestart.url + '/admin/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: '123456' }),
  });
  assert.equal(newLogin.status, 200);
  assert.equal((await newLogin.json()).mustChangePassword, false);
  assert.equal((await adminRequest('files', 'POST', upload, 'wrong')).status, 403);
  assert.equal((await adminRequest('files', 'POST', { ...upload, relativePath: '../outside.lrc' })).status, 400);
  assert.equal((await adminRequest('files', 'POST', { ...upload, relativePath: 'track.mp3' })).status, 400);
  assert.equal((await adminRequest('files', 'POST', { ...upload, relativePath: '/outside.lrc' })).status, 400);
  assert.equal((await adminRequest('files', 'POST', upload)).status, 200);
  const adminWorks = await adminRequest('works', 'GET');
  assert.equal(adminWorks.body.workCount, 1);
  assert.equal(adminWorks.body.fileCount, 1);
  assert.deepEqual(adminWorks.body.works, [{ workId: 'RJ123', isAi: true, fileCount: 1 }]);
  assert.equal(adminWorks.body.nextCursor, null);
  assert.equal((await adminRequest('files?workId=RJ123', 'GET')).body.files[0].relativePath, 'disc1/track01.lrc');
  assert.deepEqual((await get(base)).body, { version: 1, works: [{ workId: 'RJ123', isAi: true, fileCount: 1 }] });
  const files = await get(base + '/rj123/files');
  assert.equal(files.status, 200);
  assert.equal(files.headers.get('cache-control'), 'no-store');
  assert.equal(files.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(files.body, { workId: 'RJ123', files: [{ relativePath: 'disc1/track01.lrc', name: 'track01.lrc', extension: '.lrc', isAi: true }] });
  const lyrics = await get(base + '/RJ123/lyrics');
  assert.deepEqual(lyrics.body, { workId: 'RJ123', files: [{ ...files.body.files[0], content: bytes.toString('base64') }] });
  assert.equal((await fs.stat(path.join(dataDir, 'library.sqlite'))).isFile(), true);
  assert.equal(await fs.access(path.join(dataDir, 'works', 'RJ123')).then(() => true, () => false), false);

  restarted = new Library(dataDir);
  await restarted.init();
  assert.equal((await restarted.works())[0].isAi, true);
  assert.equal((await adminRequest('files/ai', 'PATCH', { workId: 'RJ123', relativePath: 'disc1/track01.lrc', isAi: false })).status, 200);
  assert.equal((await get(base)).body.works[0].isAi, false);
  assert.equal((await adminRequest('files', 'DELETE', { workId: 'RJ123', relativePath: 'disc1/track01.lrc' })).status, 200);
  assert.deepEqual((await get(base)).body.works, []);
  assert.equal((await get(base + '/RJ123/lyrics')).status, 404);
  assert.equal((await adminRequest('password', 'POST', { newPassword: 'abcdef' })).body.error, 'invalid_current_password');
  assert.equal((await adminRequest('password', 'POST', { currentPassword: 'wrong', newPassword: 'abcdef' })).body.error, 'invalid_current_password');
  const secondChange = await adminRequest('password', 'POST', { currentPassword: '123456', newPassword: 'abcdef' });
  assert.equal(secondChange.status, 200);
  const latestCredentials = new Credentials(dataDir);
  await latestCredentials.init();
  assert.equal((await latestCredentials.verify('123456')).valid, false);
  assert.equal((await latestCredentials.verify('abcdef')).valid, true);
});
