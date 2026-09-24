const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const EXTENSIONS = new Set(['.lrc', '.txt', '.srt', '.vtt', '.ass', '.ssa']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_WORK = 256;
const MAX_WORK_BYTES = 32 * 1024 * 1024;

function workId(value) {
  const id = typeof value === 'string' ? value.toUpperCase() : '';
  return /^(?:RJ|VJ|BJ)[0-9]+$/.test(id) ? id : null;
}
function relativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') || value.includes(':')) return null;
  const parts = value.split('/');
  if (parts.length > 16 || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part) || Buffer.byteLength(part) > 255)) return null;
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return EXTENSIONS.has(path.posix.extname(value).toLowerCase()) ? value : null;
}
function fileInfo(row) {
  return { relativePath: row.relative_path, name: path.posix.basename(row.relative_path), extension: path.posix.extname(row.relative_path).toLowerCase(), isAi: row.is_ai === 1 };
}
function workInfo(row) { return { workId: row.work_id, isAi: row.ai_count > 0, fileCount: row.file_count }; }

class Library {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.databaseFile = path.join(this.dataDir, 'library.sqlite');
    this.pending = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.databaseFile, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS works (
        work_id TEXT PRIMARY KEY, file_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0, ai_count INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS files (
        work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, size INTEGER NOT NULL,
        is_ai INTEGER NOT NULL CHECK (is_ai IN (0, 1)), content BLOB NOT NULL,
        PRIMARY KEY (work_id, relative_path)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS files_insert AFTER INSERT ON files BEGIN
        UPDATE works SET file_count = file_count + 1, total_bytes = total_bytes + NEW.size,
          ai_count = ai_count + NEW.is_ai WHERE work_id = NEW.work_id;
      END;
      CREATE TRIGGER IF NOT EXISTS files_delete AFTER DELETE ON files BEGIN
        UPDATE works SET file_count = file_count - 1, total_bytes = total_bytes - OLD.size,
          ai_count = ai_count - OLD.is_ai WHERE work_id = OLD.work_id;
      END;
      CREATE TRIGGER IF NOT EXISTS files_update AFTER UPDATE OF size, is_ai ON files BEGIN
        UPDATE works SET total_bytes = total_bytes + NEW.size - OLD.size,
          ai_count = ai_count + NEW.is_ai - OLD.is_ai WHERE work_id = NEW.work_id;
      END;
    `);
    this.insertWork = this.db.prepare('INSERT INTO works(work_id) VALUES (?) ON CONFLICT(work_id) DO NOTHING');
    this.upsertFile = this.db.prepare(`INSERT INTO files(work_id, relative_path, size, is_ai, content)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id, relative_path) DO UPDATE SET
      size = excluded.size, is_ai = excluded.is_ai, content = excluded.content`);
    this.getWork = this.db.prepare('SELECT file_count, total_bytes FROM works WHERE work_id = ?');
    this.getFile = this.db.prepare('SELECT size FROM files WHERE work_id = ? AND relative_path = ?');
    this.getWorkSizes = this.db.prepare('SELECT relative_path, size FROM files WHERE work_id = ?');
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
  mutate(fn) {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* The transaction may already have ended. */ } throw error; }
  }

  async files(id) {
    id = workId(id);
    if (!id) return null;
    const rows = this.db.prepare('SELECT relative_path, is_ai FROM files WHERE work_id = ? ORDER BY relative_path').all(id);
    return rows.length ? rows.map(fileInfo) : null;
  }
  async works() {
    return this.db.prepare('SELECT work_id, file_count, ai_count FROM works WHERE file_count > 0 ORDER BY work_id').all().map(workInfo);
  }
  async stats() {
    const row = this.db.prepare('SELECT COUNT(*) AS work_count, COALESCE(SUM(file_count), 0) AS file_count FROM works WHERE file_count > 0').get();
    return { workCount: row.work_count, fileCount: row.file_count };
  }
  async workPage({ after = '', query = '', limit = 50 } = {}) {
    if (typeof after !== 'string' || after.length > 64 || typeof query !== 'string' || query.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_query');
    const q = query.trim();
    let rows;
    if (!q) {
      rows = this.db.prepare('SELECT work_id, file_count, ai_count FROM works WHERE file_count > 0 AND work_id > ? ORDER BY work_id LIMIT ?').all(after, limit + 1);
    } else if (/^(?:RJ|VJ|BJ)[0-9]*$/i.test(q)) {
      const prefix = q.toUpperCase();
      rows = this.db.prepare('SELECT work_id, file_count, ai_count FROM works WHERE file_count > 0 AND work_id > ? AND work_id >= ? AND work_id < ? ORDER BY work_id LIMIT ?').all(after, prefix, prefix + '\uffff', limit + 1);
    } else {
      const needle = q.toLowerCase();
      rows = this.db.prepare(`SELECT w.work_id, w.file_count, w.ai_count FROM works AS w WHERE w.file_count > 0 AND w.work_id > ? AND
        (instr(lower(w.work_id), ?) > 0 OR EXISTS (SELECT 1 FROM files AS f WHERE f.work_id = w.work_id AND instr(lower(f.relative_path), ?) > 0))
        ORDER BY w.work_id LIMIT ?`).all(after, needle, needle, limit + 1);
    }
    const hasMore = rows.length > limit;
    const works = rows.slice(0, limit).map(workInfo);
    return { works, nextCursor: hasMore ? works.at(-1).workId : null, ...(await this.stats()) };
  }
  async lyrics(id) {
    id = workId(id);
    if (!id) return null;
    const rows = this.db.prepare('SELECT relative_path, is_ai, content FROM files WHERE work_id = ? ORDER BY relative_path').all(id);
    return rows.length ? rows.map((row) => ({ ...fileInfo(row), content: Buffer.from(row.content).toString('base64') })) : null;
  }

  async save(id, rel, bytes, isAi) {
    id = workId(id);
    if (!id || !relativePath(rel) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('invalid_file');
    return this.mutate(() => this.transaction(() => {
      const work = this.getWork.get(id), old = this.getFile.get(id, rel);
      if (!old && (work?.file_count || 0) >= MAX_FILES_PER_WORK || (work?.total_bytes || 0) - (old?.size || 0) + bytes.length > MAX_WORK_BYTES) throw new Error('work_full');
      this.insertWork.run(id);
      this.upsertFile.run(id, rel, bytes.length, isAi === true ? 1 : 0, bytes);
    }));
  }

  async importBatch(staged, { conflict = 'skip', isAi = false } = {}) {
    if (!['skip', 'overwrite'].includes(conflict) || typeof isAi !== 'boolean') throw new Error('invalid_file');
    return this.mutate(async () => {
      const states = new Map(), changed = new Set();
      const result = { imported: 0, overwritten: 0, skipped: 0, works: 0, workIds: [] };
      let batch = [], batchBytes = 0;
      const flush = () => {
        if (!batch.length) return;
        this.transaction(() => {
          for (const item of batch) {
            this.insertWork.run(item.id);
            this.upsertFile.run(item.id, item.rel, item.bytes.length, isAi ? 1 : 0, item.bytes);
          }
        });
        batch = []; batchBytes = 0;
      };
      for (const item of staged) {
        const id = workId(item.id), rel = relativePath(item.rel);
        if (!id || !rel || !Number.isInteger(item.size) || item.size < 1 || item.size > MAX_FILE_BYTES) { result.skipped++; continue; }
        let state = states.get(id);
        if (!state) {
          const work = this.getWork.get(id);
          state = { count: work?.file_count || 0, bytes: work?.total_bytes || 0,
            sizes: new Map(work ? this.getWorkSizes.all(id).map((row) => [row.relative_path, row.size]) : []) };
          states.set(id, state);
        }
        const oldSize = state.sizes.get(rel);
        if (oldSize !== undefined && conflict === 'skip' || oldSize === undefined && state.count >= MAX_FILES_PER_WORK || state.bytes - (oldSize || 0) + item.size > MAX_WORK_BYTES) { result.skipped++; continue; }
        const bytes = await fs.readFile(item.path);
        if (bytes.length !== item.size) throw new Error('invalid_file');
        if (batchBytes + bytes.length > 32 * 1024 * 1024) flush();
        batch.push({ id, rel, bytes }); batchBytes += bytes.length;
        state.bytes += bytes.length - (oldSize || 0);
        if (oldSize === undefined) { state.count++; result.imported++; } else result.overwritten++;
        state.sizes.set(rel, bytes.length);
        changed.add(id);
        if (batch.length >= 128) flush();
      }
      flush();
      result.workIds = [...changed]; result.works = changed.size;
      return result;
    });
  }

  async remove(id, rel) {
    id = workId(id);
    if (!id || !relativePath(rel)) throw new Error('invalid_file');
    return this.mutate(() => this.transaction(() => {
      const removed = this.db.prepare('DELETE FROM files WHERE work_id = ? AND relative_path = ?').run(id, rel);
      if (!removed.changes) throw new Error('not_found');
      this.db.prepare('DELETE FROM works WHERE work_id = ? AND file_count = 0').run(id);
    }));
  }
  async setAi(id, rel, isAi) {
    id = workId(id);
    if (!id || !relativePath(rel) || typeof isAi !== 'boolean') throw new Error('invalid_file');
    return this.mutate(() => this.transaction(() => {
      const changed = this.db.prepare('UPDATE files SET is_ai = ? WHERE work_id = ? AND relative_path = ?').run(isAi ? 1 : 0, id, rel);
      if (!changed.changes) throw new Error('not_found');
    }));
  }
}

module.exports = { Library, workId, relativePath, MAX_FILE_BYTES };
