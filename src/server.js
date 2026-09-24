const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library, workId, relativePath, MAX_FILE_BYTES } = require('./library');
const { Credentials, equalStrings } = require('./credentials');
const { importZip, MAX_UPLOAD_BYTES } = require('./zip-import');

const API_PREFIX = '/api/lyrics-library/v1/works';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_MS = 12 * 60 * 60 * 1000;

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

function pathname(request) {
  try { return new URL(request.url, 'http://localhost').pathname; } catch { return ''; }
}

function createApiHandler(library) {
  return async (request, response) => {
    try {
      if (request.method !== 'GET') return json(response, 405, { error: 'read_only' });
      const route = pathname(request);
      if (route === API_PREFIX) return json(response, 200, { version: 1, works: await library.works() });
      const match = /^\/api\/lyrics-library\/v1\/works\/([^/]+)\/(files|lyrics)$/.exec(route);
      if (!match) return json(response, 404, { error: 'not_found' });
      let id;
      try { id = workId(decodeURIComponent(match[1])); } catch { /* Invalid encoding. */ }
      if (!id) return json(response, 404, { error: 'work_not_found' });
      if (match[2] === 'files') {
        const files = await library.files(id);
        return files?.length ? json(response, 200, { workId: id, files }) : json(response, 404, { error: 'work_not_found' });
      }
      const files = await library.lyrics(id);
      return files?.length ? json(response, 200, { workId: id, files }) : json(response, 404, { error: 'work_not_found' });
    } catch (error) {
      console.error('API request failed:', error);
      if (!response.headersSent) json(response, 500, { error: 'request_failed' });
      else response.destroy();
    }
  };
}

async function bodyJson(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_json'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_json');
  return data;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

function createAdminHandler(library, options = {}) {
  const user = options.user ?? 'admin';
  const credentials = options.credentials;
  if (!credentials) throw new Error('Administrator credentials are required');
  const secure = options.secure === true;
  const sessions = new Map();
  const attempts = new Map();
  const cookie = `lls_session=; Path=/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  function sessionFor(request) {
    const value = /(?:^|;\s*)lls_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const session = sessions.get(value);
    if (!session) return null;
    if (session.expires <= Date.now() || session.credentialVersion !== credentials.version) { sessions.delete(value); return null; }
    return { value, session };
  }

  return async (request, response) => {
    try {
      const route = pathname(request);
      if (request.method === 'GET' && route === '/') {
        response.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store' });
        return response.end();
      }
      const staticFiles = {
        '/admin': ['index.html', 'text/html; charset=utf-8'],
        '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/admin/style.css': ['style.css', 'text/css; charset=utf-8'],
        '/admin/logo.png': ['logo.png', 'image/png'],
      };
      if (request.method === 'GET' && staticFiles[route]) {
        const [filename, type] = staticFiles[route];
        const content = await fs.readFile(path.join(PUBLIC_DIR, filename));
        response.writeHead(200, {
          'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        return response.end(content);
      }
      if (!route.startsWith('/admin/api/')) return json(response, 404, { error: 'not_found' });
      if (!sameOrigin(request)) return json(response, 403, { error: 'forbidden' });

      if (route === '/admin/api/login' && request.method === 'POST') {
        const ip = request.socket.remoteAddress || 'unknown';
        const state = attempts.get(ip);
        if (state && state.until > Date.now() && state.count >= 5) return json(response, 429, { error: 'too_many_attempts' });
        attempts.set(ip, { count: state && state.until > Date.now() ? state.count + 1 : 1, until: Date.now() + 15 * 60 * 1000 });
        const data = await bodyJson(request, 2048);
        const passwordCheck = await credentials.verify(data.password);
        if (!equalStrings(data.user, user) || !passwordCheck.valid || passwordCheck.version !== credentials.version) {
          return json(response, 401, { error: 'invalid_credentials' });
        }
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        const csrf = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { csrf, expires: Date.now() + SESSION_MS, credentialVersion: credentials.version });
        response.setHeader('Set-Cookie', `${cookie.replace('lls_session=', `lls_session=${token}`)}; Max-Age=${SESSION_MS / 1000}`);
        return json(response, 200, { user, csrf, mustChangePassword: credentials.mustChangePassword });
      }

      const authenticated = sessionFor(request);
      if (!authenticated) return json(response, 401, { error: 'unauthorized' });
      if (route === '/admin/api/session' && request.method === 'GET') return json(response, 200, { user, csrf: authenticated.session.csrf, mustChangePassword: credentials.mustChangePassword });
      if (request.method !== 'GET' && request.headers['x-lls-csrf'] !== authenticated.session.csrf) return json(response, 403, { error: 'forbidden' });
      if (route === '/admin/api/logout' && request.method === 'POST') {
        sessions.delete(authenticated.value);
        response.setHeader('Set-Cookie', `${cookie}; Max-Age=0`);
        return json(response, 200, { ok: true });
      }
      if (route === '/admin/api/password' && request.method === 'POST') {
        const data = await bodyJson(request, 2048);
        await credentials.change(data.currentPassword, data.newPassword);
        sessions.clear();
        const csrf = crypto.randomBytes(32).toString('hex');
        sessions.set(authenticated.value, { csrf, expires: Date.now() + SESSION_MS, credentialVersion: credentials.version });
        return json(response, 200, { ok: true, csrf, mustChangePassword: false });
      }
      if (credentials.mustChangePassword) return json(response, 403, { error: 'password_change_required' });
      if (route === '/admin/api/works' && request.method === 'GET') {
        const params = new URL(request.url, 'http://localhost').searchParams;
        return json(response, 200, await library.workPage({ after: params.get('after') || '', query: params.get('q') || '', limit: 50 }));
      }
      if (route === '/admin/api/files' && request.method === 'GET') {
        const id = workId(new URL(request.url, 'http://localhost').searchParams.get('workId'));
        if (!id) return json(response, 400, { error: 'invalid_file' });
        return json(response, 200, { workId: id, files: await library.files(id) || [] });
      }
      if (route === '/admin/api/files' && request.method === 'POST') {
        const data = await bodyJson(request, Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096);
        const id = workId(data.workId);
        const rel = relativePath(data.relativePath);
        if (!id || !rel || typeof data.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.content)) return json(response, 400, { error: 'invalid_file' });
        const bytes = Buffer.from(data.content, 'base64');
        if (!bytes.length || bytes.length > MAX_FILE_BYTES) return json(response, 400, { error: 'invalid_file' });
        await library.save(id, rel, bytes, data.isAi === true);
        return json(response, 200, { ok: true });
      }
      if (route === '/admin/api/import/zip' && request.method === 'POST') {
        const url = new URL(request.url, 'http://localhost');
        const name = url.searchParams.get('name');
        const conflict = url.searchParams.get('conflict') || 'skip';
        const ai = url.searchParams.get('ai') === 'true';
        if (!name || name.length > 255 || !/\.zip$/i.test(name) || !['skip', 'overwrite'].includes(conflict) || !['true', 'false', null].includes(url.searchParams.get('ai'))) return json(response, 400, { error: 'invalid_file' });
        if (!['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(String(request.headers['content-type']).split(';')[0])) return json(response, 400, { error: 'invalid_file' });
        const tempDir = await fs.mkdtemp(path.join(library.dataDir, 'zip-import-'));
        let result;
        try {
          const uploaded = path.join(tempDir, 'upload.zip');
          const handle = await fs.open(uploaded, 'wx', 0o600);
          let size = 0;
          try {
            for await (const chunk of request) {
              size += chunk.length;
              if (size > MAX_UPLOAD_BYTES) throw new Error('body_too_large');
              let offset = 0;
              while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
            }
          } finally { await handle.close(); }
          if (!size) throw new Error('invalid_zip');
          result = await importZip(library, uploaded, name, { conflict, isAi: ai }, tempDir);
        } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
        return json(response, 200, result);
      }
      if (route === '/admin/api/files' && request.method === 'DELETE') {
        const data = await bodyJson(request, 2048);
        const id = workId(data.workId);
        const rel = relativePath(data.relativePath);
        if (!id || !rel) return json(response, 400, { error: 'invalid_file' });
        await library.remove(id, rel);
        return json(response, 200, { ok: true });
      }
      if (route === '/admin/api/files/ai' && request.method === 'PATCH') {
        const data = await bodyJson(request, 2048);
        const id = workId(data.workId);
        const rel = relativePath(data.relativePath);
        if (!id || !rel || typeof data.isAi !== 'boolean') return json(response, 400, { error: 'invalid_file' });
        await library.setAi(id, rel, data.isAi);
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      const code = error.message;
      if (code === 'invalid_file' || code === 'invalid_path' || code === 'invalid_json' || code === 'invalid_new_password' || code === 'invalid_current_password' || code === 'invalid_zip' || code === 'invalid_query') return json(response, 400, { error: code });
      if (code === 'body_too_large' || code === 'zip_limit_exceeded') return json(response, 413, { error: code });
      if (code === 'work_full') return json(response, 413, { error: code });
      if (code === 'not_found' || error.code === 'ENOENT') return json(response, 404, { error: 'not_found' });
      console.error('Admin request failed:', error);
      if (!response.headersSent) json(response, 500, { error: 'request_failed' });
      else response.destroy();
    }
  };
}

async function start() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const library = new Library(dataDir);
  await library.init();
  const credentials = new Credentials(dataDir);
  await credentials.init();
  const host = process.env.HOST || '0.0.0.0';
  const adminPort = Number(process.env.ADMIN_PORT || 2376);
  const apiPort = Number(process.env.API_PORT || 2377);
  if (!Number.isInteger(adminPort) || !Number.isInteger(apiPort) || adminPort === apiPort || adminPort < 1 || apiPort < 1 || adminPort > 65535 || apiPort > 65535) throw new Error('Invalid ports');
  const servers = [
    http.createServer(createAdminHandler(library, { user: process.env.ADMIN_USER, credentials, secure: process.env.COOKIE_SECURE === 'true' })),
    http.createServer(createApiHandler(library)),
  ];
  try {
    for (const [index, port] of [adminPort, apiPort].entries()) {
      await new Promise((resolve, reject) => servers[index].once('error', reject).listen(port, host, resolve));
      console.log(`${index === 0 ? 'Admin' : 'Lyrics API'} listening at http://${host}:${port}`);
    }
  } catch (error) {
    for (const server of servers) server.close();
    library.close();
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
      .then(() => library.close())
      .catch((error) => { console.error('Shutdown failed:', error); process.exitCode = 1; });
  });
}

if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { createApiHandler, createAdminHandler };
