const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXTENSIONS = new Set(['.lrc', '.txt', '.srt', '.vtt', '.ass', '.ssa']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_WORK = 256;
const MAX_WORK_BYTES = 32 * 1024 * 1024;
const METADATA = '.kikoeta-lls.json';

function workId(value) {
  const id = typeof value === 'string' ? value.toUpperCase() : '';
  return /^(?:RJ|VJ|BJ)[0-9]+$/.test(id) ? id : null;
}

function relativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') || value.includes(':')) return null;
  const parts = value.split('/');
  if (parts.length > 16 || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part) || part.length > 255)) return null;
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return EXTENSIONS.has(path.posix.extname(value).toLowerCase()) ? value : null;
}

async function regularDirectory(dir) {
  try { return (await fs.lstat(dir)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function metadataFor(dir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, METADATA), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeMetadata(dir, data) {
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, path.join(dir, METADATA));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

class Library {
  constructor(dataDir) {
    this.root = path.resolve(dataDir, 'works');
    this.pending = Promise.resolve();
  }

  async init() { await fs.mkdir(this.root, { recursive: true }); }

  mutate(fn) {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }

  async files(id) {
    id = workId(id);
    if (!id) return null;
    const dir = path.join(this.root, id);
    if (!await regularDirectory(dir)) return null;
    const flags = await metadataFor(dir);
    const found = [];
    let totalBytes = 0;
    async function visit(current, parts) {
      if (parts.length > 15 || found.length >= MAX_FILES_PER_WORK) return;
      const entries = await fs.readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (found.length >= MAX_FILES_PER_WORK) break;
        if (entry.name.startsWith('.')) continue;
        const nextParts = [...parts, entry.name];
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(next, nextParts);
        } else if (entry.isFile()) {
          const rel = relativePath(nextParts.join('/'));
          if (!rel) continue;
          try {
            const stat = await fs.stat(next);
            if (stat.size === 0 || stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_WORK_BYTES) continue;
            await fs.access(next, constants.R_OK);
            found.push({ relativePath: rel, name: entry.name, extension: path.extname(entry.name).toLowerCase(), isAi: flags[rel] === true });
            totalBytes += stat.size;
          } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
        }
      }
    }
    await visit(dir, []);
    return found;
  }

  async works() {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const ids = entries.filter((entry) => entry.isDirectory() && workId(entry.name) === entry.name).map((entry) => entry.name).sort();
    const works = [];
    for (const id of ids) {
      const files = await this.files(id);
      if (files?.length) works.push({ workId: id, isAi: files.some((file) => file.isAi), fileCount: files.length });
    }
    return works;
  }

  async lyrics(id) {
    const files = await this.files(id);
    if (!files?.length) return null;
    const dir = path.join(this.root, id);
    const output = [];
    for (const file of files) {
      const target = path.join(dir, ...file.relativePath.split('/'));
      try {
        const resolved = await fs.realpath(target);
        if (!resolved.startsWith(dir + path.sep)) continue;
        const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;
          const bytes = await handle.readFile();
          output.push({ ...file, content: bytes.toString('base64') });
        } finally { await handle.close(); }
      } catch { /* A removed or unreadable file is omitted, as in Kikoeta. */ }
    }
    return output;
  }

  async checkedDirectory(id, rel, create) {
    const parts = rel.split('/');
    let current = this.root;
    for (const part of [id, ...parts.slice(0, -1)]) {
      current = path.join(current, part);
      if (create) {
        try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!await regularDirectory(current)) return null;
    }
    return current;
  }

  async save(id, rel, bytes, isAi) {
    id = workId(id);
    if (!id || !relativePath(rel) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('invalid_file');
    return this.mutate(async () => {
      const existing = await this.files(id) || [];
      const samePath = existing.find((file) => file.relativePath === rel);
      if (!samePath && existing.length >= MAX_FILES_PER_WORK) throw new Error('work_full');
      const usedBytes = (await Promise.all(existing.filter((file) => file.relativePath !== rel).map((file) => fs.stat(path.join(this.root, id, ...file.relativePath.split('/')))))).reduce((sum, stat) => sum + stat.size, 0);
      if (usedBytes + bytes.length > MAX_WORK_BYTES) throw new Error('work_full');
      const dir = await this.checkedDirectory(id, rel, true);
      if (!dir) throw new Error('invalid_path');
      const target = path.join(dir, path.basename(rel));
      const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, target);
      } finally { await fs.rm(temp, { force: true }); }
      const workDir = path.join(this.root, id);
      const flags = await metadataFor(workDir);
      flags[rel] = isAi === true;
      await writeMetadata(workDir, flags);
    });
  }

  async remove(id, rel) {
    id = workId(id);
    if (!id || !relativePath(rel)) throw new Error('invalid_file');
    return this.mutate(async () => {
      const dir = await this.checkedDirectory(id, rel, false);
      if (!dir) throw new Error('not_found');
      const target = path.join(dir, path.basename(rel));
      if (!(await fs.lstat(target)).isFile()) throw new Error('not_found');
      await fs.unlink(target);
      const workDir = path.join(this.root, id);
      const flags = await metadataFor(workDir);
      delete flags[rel];
      await writeMetadata(workDir, flags);
    });
  }

  async setAi(id, rel, isAi) {
    id = workId(id);
    if (!id || !relativePath(rel) || typeof isAi !== 'boolean') throw new Error('invalid_file');
    return this.mutate(async () => {
      const files = await this.files(id);
      if (!files?.some((file) => file.relativePath === rel)) throw new Error('not_found');
      const dir = path.join(this.root, id);
      const flags = await metadataFor(dir);
      flags[rel] = isAi;
      await writeMetadata(dir, flags);
    });
  }
}

module.exports = { Library, workId, relativePath, MAX_FILE_BYTES };
