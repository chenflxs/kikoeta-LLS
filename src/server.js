const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library, workId, relativePath, MAX_FILE_BYTES } = require('./library');
const { Credentials, equalStrings } = require('./credentials');
const { TranslAuth } = require('./transl-auth');
const { importZip, MAX_UPLOAD_BYTES } = require('./zip-import');

const API_PREFIX = '/api/lyrics-library/v1/works';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_MS = 12 * 60 * 60 * 1000;
const STATIC_FILES = {
  '/': ['login.html', 'text/html; charset=utf-8'],
  '/library': ['library.html', 'text/html; charset=utf-8'],
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/settings': ['settings.html', 'text/html; charset=utf-8'],
  '/library.js': ['library.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
};
const STATIC_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

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
      if (route === API_PREFIX) {
        const params = new URL(request.url, 'http://localhost').searchParams;
        if (!params.has('limit')) return json(response, 200, { version: 1, works: await library.works() });
        const limit = Number(params.get('limit'));
        const after = params.get('after') || '';
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (after && !workId(after))) return json(response, 400, { error: 'invalid_query' });
        return json(response, 200, await library.broadcastPage({ after: after.toUpperCase(), limit }));
      }
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

function createTranslHandler(library, translAuth) {
  return async (request, response) => {
    try {
      const route = pathname(request);
      if (route === '/api/v1/health' && request.method === 'GET') return json(response, 200, { ok: true, name: 'kikoeta-lls-transl' });
      if (route !== '/api/v1/lyrics' || request.method !== 'POST') return json(response, 404, { error: 'not_found' });
      const authorization = request.headers.authorization || '';
      let allowed = false;
      if (authorization.startsWith('Bearer ')) allowed = translAuth.verifyKey(authorization.slice(7));
      else if (authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const split = decoded.indexOf(':');
        if (split > 0) allowed = await translAuth.verifyBasic(decoded.slice(0, split), decoded.slice(split + 1));
      }
      if (!allowed) return json(response, 401, { error: 'unauthorized' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 400, { error: 'invalid_file' });
      const data = await bodyJson(request, Math.ceil(32 * 1024 * 1024 * 4 / 3) + 1024 * 1024);
      const id = workId(data.workId);
      if (!id || !Array.isArray(data.files) || !data.files.length || data.files.length > 256) return json(response, 400, { error: 'invalid_file' });
      let total = 0;
      const files = [];
      for (const file of data.files) {
        if (!file || !relativePath(file.relativePath) || typeof file.content !== 'string' ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) return json(response, 400, { error: 'invalid_file' });
        const bytes = Buffer.from(file.content, 'base64');
        total += bytes.length;
        if (!bytes.length || bytes.length > MAX_FILE_BYTES || total > 32 * 1024 * 1024) return json(response, 413, { error: 'work_full' });
        files.push({ rel: file.relativePath, bytes });
      }
      return json(response, 200, await library.saveMany(id, files, true));
    } catch (error) {
      if (['invalid_file', 'invalid_json'].includes(error.message)) return json(response, 400, { error: error.message });
      if (['body_too_large', 'work_full'].includes(error.message)) return json(response, 413, { error: error.message });
      console.error('Transl request failed:', error);
      return json(response, 500, { error: 'request_failed' });
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
  const credentials = options.credentials;
  const translAuth = options.translAuth;
  if (!credentials) throw new Error('Administrator credentials are required');
  const secure = options.secure === true;
  const sessions = new Map();
  const attempts = new Map();
  const importJobs = new Map();
  const assetCache = new Map();
  const cookie = `lls_session=; Path=/api; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  function asset(filename) {
    if (!assetCache.has(filename)) {
      assetCache.set(filename, fs.readFile(path.join(PUBLIC_DIR, filename)).then((content) => ({
        content,
        etag: `"${crypto.createHash('sha256').update(content).digest('hex')}"`,
      })).catch((error) => { assetCache.delete(filename); throw error; }));
    }
    return assetCache.get(filename);
  }

  function sessionFor(request) {
    const value = /(?:^|;\s*)lls_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const session = sessions.get(value);
    if (!session) return null;
    if (session.expires <= Date.now() || session.credentialVersion !== credentials.version) { sessions.delete(value); return null; }
    return { value, session };
  }

  function renewSession(value) {
    sessions.clear();
    const csrf = crypto.randomBytes(32).toString('hex');
    sessions.set(value, { csrf, expires: Date.now() + SESSION_MS, credentialVersion: credentials.version });
    return csrf;
  }

  return async (request, response) => {
    try {
      const route = pathname(request);
      if (request.method === 'GET' && STATIC_FILES[route]) {
        const [filename, type] = STATIC_FILES[route];
        const page = type.startsWith('text/html');
        const { content, etag } = page
          ? { content: await fs.readFile(path.join(PUBLIC_DIR, filename)) }
          : await asset(filename);
        const headers = {
          'Content-Type': type,
          'Cache-Control': page ? 'no-store' : 'private, max-age=300, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': STATIC_CSP,
        };
        if (etag) {
          headers.ETag = etag;
          if (request.headers['if-none-match'] === etag) {
            response.writeHead(304, headers);
            return response.end();
          }
        }
        response.writeHead(200, headers);
        return response.end(content);
      }
      if (!route.startsWith('/api/')) return json(response, 404, { error: 'not_found' });
      if (!sameOrigin(request)) return json(response, 403, { error: 'forbidden' });

      if (route === '/api/login' && request.method === 'POST') {
        const ip = request.socket.remoteAddress || 'unknown';
        const state = attempts.get(ip);
        if (state && state.until > Date.now() && state.count >= 5) return json(response, 429, { error: 'too_many_attempts' });
        attempts.set(ip, { count: state && state.until > Date.now() ? state.count + 1 : 1, until: Date.now() + 15 * 60 * 1000 });
        const data = await bodyJson(request, 2048);
        const passwordCheck = await credentials.verify(data.password);
        if (!equalStrings(data.user, credentials.user) || !passwordCheck.valid || passwordCheck.version !== credentials.version) {
          return json(response, 401, { error: 'invalid_credentials' });
        }
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        const csrf = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { csrf, expires: Date.now() + SESSION_MS, credentialVersion: credentials.version });
        response.setHeader('Set-Cookie', `${cookie.replace('lls_session=', `lls_session=${token}`)}; Max-Age=${SESSION_MS / 1000}`);
        return json(response, 200, { user: credentials.user, csrf, mustChangePassword: credentials.mustChangePassword });
      }

      const authenticated = sessionFor(request);
      if (!authenticated) return json(response, 401, { error: 'unauthorized' });
      if (route === '/api/session' && request.method === 'GET') return json(response, 200, { user: credentials.user, csrf: authenticated.session.csrf, mustChangePassword: credentials.mustChangePassword });
      if (request.method !== 'GET' && request.headers['x-lls-csrf'] !== authenticated.session.csrf) return json(response, 403, { error: 'forbidden' });
      if (route === '/api/logout' && request.method === 'POST') {
        sessions.delete(authenticated.value);
        response.setHeader('Set-Cookie', `${cookie}; Max-Age=0`);
        return json(response, 200, { ok: true });
      }
      if (route === '/api/password' && request.method === 'POST') {
        const data = await bodyJson(request, 2048);
        await credentials.change(data.currentPassword, data.newPassword);
        const csrf = renewSession(authenticated.value);
        return json(response, 200, { ok: true, csrf, mustChangePassword: false });
      }
      if (credentials.mustChangePassword) return json(response, 403, { error: 'password_change_required' });
      if (route === '/api/import/jobs' && request.method === 'POST') {
        for (const [id, job] of importJobs) {
          if (job.updatedAt < Date.now() - 24 * 60 * 60 * 1000) importJobs.delete(id);
          else if (job.state === 'queued' && job.updatedAt < Date.now() - 2 * 60 * 1000) {
            job.state = 'error'; job.error = 'upload_interrupted'; job.updatedAt = Date.now();
          }
        }
        const active = [...importJobs.values()].filter((job) => job.owner === authenticated.value && ['queued', 'uploading', 'processing'].includes(job.state));
        if (active.length >= 4) return json(response, 429, { error: 'too_many_imports' });
        const id = crypto.randomUUID();
        importJobs.set(id, { owner: authenticated.value, state: 'queued', received: 0, total: 0, updatedAt: Date.now() });
        return json(response, 200, { id });
      }
      const importJobMatch = /^\/api\/import\/jobs\/([a-f0-9-]{36})$/.exec(route);
      if (importJobMatch && request.method === 'GET') {
        const job = importJobs.get(importJobMatch[1]);
        if (!job || job.owner !== authenticated.value) return json(response, 404, { error: 'not_found' });
        const { owner, ...status } = job;
        return json(response, 200, status);
      }
      if (route === '/api/transl-auth' && request.method === 'GET') {
        return translAuth ? json(response, 200, translAuth.status({ includeKey: true })) : json(response, 503, { error: 'not_available' });
      }
      if (route === '/api/transl-auth' && request.method === 'POST') {
        if (!translAuth) return json(response, 503, { error: 'not_available' });
        return json(response, 200, await translAuth.update(await bodyJson(request, 2048)));
      }
      if (route === '/api/username' && request.method === 'POST') {
        const data = await bodyJson(request, 2048);
        await credentials.changeUser(data.currentPassword, data.newUser);
        return json(response, 200, { ok: true, user: credentials.user, csrf: renewSession(authenticated.value) });
      }
      if (route === '/api/works' && request.method === 'GET') {
        const params = new URL(request.url, 'http://localhost').searchParams;
        return json(response, 200, await library.workPage({ after: params.get('after') || '', query: params.get('q') || '', limit: 50 }));
      }
      if (route === '/api/files' && request.method === 'GET') {
        const id = workId(new URL(request.url, 'http://localhost').searchParams.get('workId'));
        if (!id) return json(response, 400, { error: 'invalid_file' });
        return json(response, 200, { workId: id, files: await library.files(id) || [] });
      }
      if (route === '/api/files' && request.method === 'POST') {
        const data = await bodyJson(request, Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096);
        const id = workId(data.workId);
        const rel = relativePath(data.relativePath);
        if (!id || !rel || typeof data.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.content)) return json(response, 400, { error: 'invalid_file' });
        const bytes = Buffer.from(data.content, 'base64');
        if (!bytes.length || bytes.length > MAX_FILE_BYTES) return json(response, 400, { error: 'invalid_file' });
        await library.save(id, rel, bytes, data.isAi === true);
        return json(response, 200, { ok: true });
      }
      if (route === '/api/import/zip' && request.method === 'POST') {
        const url = new URL(request.url, 'http://localhost');
        const jobId = url.searchParams.get('job');
        const job = jobId ? importJobs.get(jobId) : null;
        if (jobId && (!job || job.owner !== authenticated.value || job.state !== 'queued')) return json(response, 404, { error: 'not_found' });
        const name = url.searchParams.get('name');
        const conflict = url.searchParams.get('conflict') || 'skip';
        const ai = url.searchParams.get('ai') === 'true';
        if (!name || name.length > 255 || !/\.zip$/i.test(name) || !['skip', 'overwrite'].includes(conflict) || !['true', 'false', null].includes(url.searchParams.get('ai')) ||
            !['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(String(request.headers['content-type']).split(';')[0])) {
          if (job) { job.state = 'error'; job.error = 'invalid_file'; job.updatedAt = Date.now(); }
          return json(response, 400, { error: 'invalid_file' });
        }
        if (job) {
          job.name = name;
          job.state = 'uploading';
          job.total = Number(request.headers['content-length']) || 0;
          job.updatedAt = Date.now();
        }
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
              if (job) { job.received = size; job.updatedAt = Date.now(); }
              let offset = 0;
              while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
            }
          } finally { await handle.close(); }
          if (!size) throw new Error('invalid_zip');
          if (job) { job.state = 'processing'; job.updatedAt = Date.now(); }
          result = await importZip(library, uploaded, name, { conflict, isAi: ai }, tempDir);
        } catch (error) {
          if (job) {
            job.state = 'error';
            job.error = error.message === 'aborted' ? 'upload_interrupted'
              : ['invalid_zip', 'invalid_file', 'zip_limit_exceeded', 'body_too_large', 'work_full'].includes(error.message) ? error.message : 'request_failed';
            job.updatedAt = Date.now();
          }
          throw error;
        } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
        if (job) { job.state = 'success'; job.result = result; job.updatedAt = Date.now(); }
        return json(response, 200, result);
      }
      if (route === '/api/files' && request.method === 'DELETE') {
        const data = await bodyJson(request, 2048);
        const id = workId(data.workId);
        const rel = relativePath(data.relativePath);
        if (!id || !rel) return json(response, 400, { error: 'invalid_file' });
        await library.remove(id, rel);
        return json(response, 200, { ok: true });
      }
      if (route === '/api/files/ai' && request.method === 'PATCH') {
        const data = await bodyJson(request, 2048);
        const id = workId(data.workId);
        const rel = relativePath(data.relativePath);
        if (!id || !rel || typeof data.isAi !== 'boolean') return json(response, 400, { error: 'invalid_file' });
        await library.setAi(id, rel, data.isAi);
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (request.destroyed && error.code === 'ECONNRESET') return;
      const code = error.message;
      if (code === 'invalid_file' || code === 'invalid_path' || code === 'invalid_json' || code === 'invalid_new_password' || code === 'invalid_new_user' || code === 'invalid_current_password' || code === 'invalid_auth_settings' || code === 'invalid_zip' || code === 'invalid_query') return json(response, 400, { error: code });
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
  const credentials = new Credentials(dataDir, process.env.ADMIN_USER || 'admin');
  await credentials.init();
  const translAuth = new TranslAuth(dataDir);
  await translAuth.init();
  const host = process.env.HOST || '0.0.0.0';
  const adminPort = Number(process.env.ADMIN_PORT || 2376);
  const apiPort = Number(process.env.API_PORT || 2377);
  const translPort = Number(process.env.TRANSL_PORT || 2378);
  if (![adminPort, apiPort, translPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535) ||
      new Set([adminPort, apiPort, translPort]).size !== 3) throw new Error('Invalid ports');
  const servers = [
    http.createServer(createAdminHandler(library, { credentials, translAuth, secure: process.env.COOKIE_SECURE === 'true' })),
    http.createServer(createApiHandler(library)),
    http.createServer(createTranslHandler(library, translAuth)),
  ];
  try {
    for (const [index, port] of [adminPort, apiPort, translPort].entries()) {
      await new Promise((resolve, reject) => servers[index].once('error', reject).listen(port, host, resolve));
      console.log(`${['Admin', 'Lyrics API', 'Transl upload'][index]} listening at http://${host}:${port}`);
    }
  } catch (error) {
    for (const server of servers) server.close();
    library.close();
    throw error;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
      .then(() => library.close())
      .catch((error) => { console.error('Shutdown failed:', error); process.exitCode = 1; });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  if (process.env.KIKOETA_TRAY_CONTROL === '1') {
    process.stdin.setEncoding('utf8');
    let input = '';
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.length > 64) input = input.slice(-64);
      if (/(?:^|\r?\n)quit\r?\n/.test(input)) {
        process.stdin.destroy();
        stop();
      }
    });
  }
}

if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { createApiHandler, createAdminHandler, createTranslHandler };
