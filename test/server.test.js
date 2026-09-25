const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Library } = require('../src/library');
const { Credentials } = require('../src/credentials');
const { TranslAuth } = require('../src/transl-auth');
const { createApiHandler, createAdminHandler, createTranslHandler } = require('../src/server');

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
  const adminPage = await fetch(admin.url + '/library');
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /id="nav-settings"/);
  assert.equal((await fetch(admin.url + '/library.js')).status, 200);
  assert.equal((await fetch(admin.url + '/admin')).status, 404);
  const logo = await fetch(admin.url + '/logo.png');
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /^image\/png/);
  assert.equal((await fetch(admin.url + '/api/works')).status, 401);
  assert.deepEqual((await get(base)).body, { version: 1, works: [] });
  assert.equal((await get(base + '/BAD/files')).body.error, 'work_not_found');
  assert.equal((await get(base + '/RJ123/files')).body.error, 'work_not_found');
  assert.equal((await get(base + '/RJ123/other')).body.error, 'not_found');
  assert.equal((await fetch(api.url + base, { method: 'POST' })).status, 405);

  const loginResponse = await fetch(admin.url + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const login = await loginResponse.json();
  assert.equal(login.mustChangePassword, true);
  const otherLoginResponse = await fetch(admin.url + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  assert.equal(otherLoginResponse.status, 200);
  const otherCookie = otherLoginResponse.headers.get('set-cookie').split(';')[0];
  let csrf = login.csrf;
  async function adminRequest(route, method, body, token = csrf) {
    const response = await fetch(admin.url + '/api/' + route, {
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
  assert.equal((await fetch(admin.url + '/api/session', { headers: { Cookie: otherCookie } })).status, 401);
  assert.equal((await adminRequest('session', 'GET')).body.mustChangePassword, false);
  const savedCredentials = JSON.parse(await fs.readFile(path.join(dataDir, 'admin-credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(savedCredentials).sort(), ['hash', 'salt', 'user', 'version']);
  assert.equal(savedCredentials.user, 'admin');
  assert.match(savedCredentials.hash, /^[a-f0-9]{64}$/);
  const restartedCredentials = new Credentials(dataDir);
  await restartedCredentials.init();
  assert.equal((await restartedCredentials.verify('kikoeta-lrc')).valid, false);
  assert.equal((await restartedCredentials.verify('123456')).valid, true);
  const afterRestart = await listen(createAdminHandler(library, { credentials: restartedCredentials }));
  t.after(() => new Promise((resolve) => afterRestart.server.close(resolve)));
  const oldLogin = await fetch(afterRestart.url + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(afterRestart.url + '/api/login', {
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

test('administrator username changes persist and revoke other sessions', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeta-lls-user-'));
  const library = new Library(dataDir);
  await library.init();
  const credentials = new Credentials(dataDir, 'initialAdmin');
  await credentials.init();
  const admin = await listen(createAdminHandler(library, { credentials }));
  t.after(async () => {
    await new Promise((resolve) => admin.server.close(resolve));
    library.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function login(user, password) {
    const response = await fetch(admin.url + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password }),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  async function post(route, cookie, csrf, body) {
    const response = await fetch(admin.url + '/api/' + route, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-LLS-CSRF': csrf }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const first = await login('initialAdmin', 'kikoeta-lrc');
  assert.equal(first.status, 200);
  const changedPassword = await post('password', first.cookie, first.body.csrf, { newPassword: '123456' });
  assert.equal(changedPassword.status, 200);
  const other = await login('initialAdmin', '123456');
  assert.equal(other.status, 200);
  assert.equal((await post('username', first.cookie, changedPassword.body.csrf, { currentPassword: 'wrong', newUser: 'newAdmin' })).body.error, 'invalid_current_password');
  assert.equal((await post('username', first.cookie, changedPassword.body.csrf, { currentPassword: '123456', newUser: 'a' })).body.error, 'invalid_new_user');
  const changedUser = await post('username', first.cookie, changedPassword.body.csrf, { currentPassword: '123456', newUser: 'newAdmin' });
  assert.equal(changedUser.status, 200);
  assert.equal(changedUser.body.user, 'newAdmin');
  assert.equal((await fetch(admin.url + '/api/session', { headers: { Cookie: other.cookie } })).status, 401);
  assert.equal((await login('initialAdmin', '123456')).status, 401);
  assert.equal((await login('newAdmin', '123456')).status, 200);
  assert.equal((await fetch(admin.url + '/api/session', { headers: { Cookie: first.cookie } }).then((response) => response.json())).user, 'newAdmin');
  const changedAgain = await post('password', first.cookie, changedUser.body.csrf, { currentPassword: '123456', newPassword: 'abcdef' });
  assert.equal(changedAgain.status, 200);
  const restarted = new Credentials(dataDir, 'differentEnv');
  await restarted.init();
  assert.equal(restarted.user, 'newAdmin');
  assert.equal((await restarted.verify('abcdef')).valid, true);
});

test('Transl port accepts only the selected credential type and saves AI lyrics', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeta-lls-transl-'));
  const library = new Library(dataDir);
  await library.init();
  const credentials = new Credentials(dataDir);
  await credentials.init();
  const translAuth = new TranslAuth(dataDir);
  await translAuth.init();
  const admin = await listen(createAdminHandler(library, { credentials, translAuth }));
  const transl = await listen(createTranslHandler(library, translAuth));
  t.after(async () => {
    await Promise.all([admin.server, transl.server].map((server) => new Promise((resolve) => server.close(resolve))));
    library.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(admin.url + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'kikoeta-lrc' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  let csrf = (await login.json()).csrf;
  async function adminPost(body) {
    const response = await fetch(admin.url + '/api/transl-auth', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-LLS-CSRF': csrf }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const change = await fetch(admin.url + '/api/password', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-LLS-CSRF': csrf }, body: JSON.stringify({ newPassword: '123456' }),
  });
  csrf = (await change.json()).csrf;
  const payload = { workId: 'RJ123', files: [{ relativePath: 'disc/track.zh.lrc', content: Buffer.from('translated').toString('base64') }] };
  async function upload(auth, body = payload) {
    const response = await fetch(transl.url + '/api/v1/lyrics', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await upload()).status, 401);
  assert.equal((await adminPost({ action: 'set_password', username: 'transl-user', password: 'separate123' })).status, 200);
  const basic = 'Basic ' + Buffer.from('transl-user:separate123').toString('base64');
  assert.equal((await upload('Basic ' + Buffer.from('admin:123456').toString('base64'))).status, 401);
  assert.equal((await upload(basic)).status, 200);
  assert.equal((await library.files('RJ123'))[0].isAi, true);
  assert.equal((await upload(basic, { ...payload, files: [{ relativePath: '../bad.lrc', content: 'YQ==' }] })).status, 400);
  const generated = await adminPost({ action: 'generate_key' });
  assert.match(generated.body.key, /^[A-Za-z0-9]{12}$/);
  assert.equal(generated.body.hasPassword, false);
  assert.equal(generated.body.hasKey, true);
  assert.equal((await upload(basic)).status, 401);
  assert.equal((await upload('Bearer ' + generated.body.key)).status, 200);
  assert.equal((await adminPost({ action: 'set_key', key: 'a1B2c3D4e5F6' })).status, 200);
  assert.equal((await upload('Bearer ' + generated.body.key)).status, 401);
  assert.equal((await upload('Bearer a1B2c3D4e5F6')).status, 200);
  const restarted = new TranslAuth(dataDir);
  await restarted.init();
  assert.equal(await restarted.verifyBasic('transl-user', 'separate123'), false);
  assert.equal(restarted.verifyKey('a1B2c3D4e5F6'), true);
  const switched = await adminPost({ action: 'set_password', username: 'transl-user', password: 'newpass123' });
  assert.equal(switched.body.hasPassword, true);
  assert.equal(switched.body.hasKey, false);
  assert.equal((await upload('Bearer a1B2c3D4e5F6')).status, 401);
  assert.equal((await upload('Basic ' + Buffer.from('transl-user:newpass123').toString('base64'))).status, 200);
  assert.equal(JSON.stringify(restarted.record).includes('separate123'), false);
  assert.equal(JSON.stringify(restarted.record).includes('a1B2c3D4e5F6'), false);
});
