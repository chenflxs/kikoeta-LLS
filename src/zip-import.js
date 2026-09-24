const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline, Transform } = require('node:stream');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const iconv = require('iconv-lite');
const { workId, relativePath, MAX_FILE_BYTES } = require('./library');

const pipe = promisify(pipeline);
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_DEPTH = 8;

function fail(code) { throw new Error(code); }
function zipOpen(file) {
  return new Promise((resolve, reject) => yauzl.open(file, {
    lazyEntries: true, decodeStrings: false, validateEntrySizes: true,
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}
function nextEntry(zip) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError); };
    const onEntry = (entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error) => { cleanup(); reject(error); };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}
function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}
function entryName(entry, encoding) {
  const bytes = entry.fileName;
  const unicode = entry.extraFields?.find((field) => field.id === 0x7075 && field.data[0] === 1);
  if (unicode && unicode.data.length > 5) return unicode.data.subarray(5).toString('utf8');
  if (entry.generalPurposeBitFlag & 0x800) return bytes.toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Legacy ZIP name. */ }
  return iconv.decode(bytes, encoding);
}
function legacyEncoding(samples) {
  if (!samples.length) return 'gb18030';
  let best = 'gb18030';
  let bestScore = -Infinity;
  for (const encoding of ['gb18030', 'shift_jis', 'big5']) {
    const value = iconv.decode(Buffer.concat(samples), encoding);
    const score = (value.match(/[\u3041-\u30fa]/g) || []).length * 4
      + (value.match(/[\u3400-\u9fff]/g) || []).length
      - (value.match(/\ufffd/g) || []).length * 100;
    if (score > bestScore) { best = encoding; bestScore = score; }
  }
  return best;
}
function idInName(value) {
  const match = /(?:^|[^a-z0-9])((?:RJ|VJ|BJ)\d+)(?!\d)/i.exec(value);
  return match ? workId(match[1]) : null;
}
function shortenPart(value) {
  if (Buffer.byteLength(value) <= 240) return value;
  const extension = path.posix.extname(value);
  const suffix = `-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}${Buffer.byteLength(extension) <= 24 ? extension : ''}`;
  let prefix = '';
  for (const char of value) {
    if (Buffer.byteLength(prefix + char + suffix) > 240) break;
    prefix += char;
  }
  return prefix + suffix;
}
function safeName(raw) {
  const value = raw.replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\0')) return null;
  const parts = value.split('/').filter((part, index, list) => index !== list.length - 1 || part !== '');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':') || /[\x00-\x1f]/.test(part))) return null;
  if (parts.some((part) => ['__MACOSX', '.DS_Store', 'Thumbs.db'].includes(part))) return null;
  return parts.map(shortenPart).join('/');
}
function outputPath(clean, ids) {
  const parts = clean.split('/');
  const at = parts.findIndex((part) => idInName(part));
  if (at >= 0) {
    const id = idInName(parts[at]);
    const rel = at === parts.length - 1 ? parts.at(-1) : parts.slice(at + 1).join('/');
    return relativePath(rel) ? { id, rel } : null;
  }
  if (ids.size === 1 && relativePath(clean)) return { id: [...ids][0], rel: clean };
  return null;
}
async function scan(file, budget) {
  const zip = await zipOpen(file);
  const closed = new Promise((resolve) => zip.once('close', resolve));
  const rawEntries = [];
  const samples = [];
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      if (++budget.entries > MAX_ENTRIES) fail('zip_limit_exceeded');
      rawEntries.push(entry);
      if (!(entry.generalPurposeBitFlag & 0x800) && entry.fileName.some((byte) => byte > 127) && samples.length < 1024) samples.push(entry.fileName);
    }
  } finally { zip.close(); await closed; }
  const encoding = legacyEncoding(samples);
  const names = rawEntries.map((entry) => entryName(entry, encoding));
  const ids = new Set();
  for (const raw of names) {
    const clean = safeName(raw);
    if (!clean) continue;
    for (const part of clean.split('/')) {
      const id = idInName(part);
      if (id) { ids.add(id); break; }
    }
  }
  return { names, ids, encoding };
}
async function extract(file, sourceName, inheritedIds, depth, state) {
  if (depth > MAX_DEPTH) fail('zip_limit_exceeded');
  const found = await scan(file, state.budget);
  const archiveId = idInName(path.basename(sourceName).replace(/\.zip$/i, ''));
  const ids = found.ids.size ? found.ids : (archiveId ? new Set([archiveId]) : inheritedIds);
  const zip = await zipOpen(file);
  const closed = new Promise((resolve) => zip.once('close', resolve));
  try {
    let index = 0;
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const rawName = found.names[index++];
      const clean = safeName(rawName);
      if (!clean || rawName.endsWith('/')) { state.ignored++; continue; }
      const nested = path.posix.extname(clean).toLowerCase() === '.zip';
      const output = nested ? null : outputPath(clean, ids);
      if (!nested && !output) { state.ignored++; continue; }
      if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) { state.ignored++; continue; }
      const limit = nested ? MAX_UPLOAD_BYTES : MAX_FILE_BYTES;
      if (entry.uncompressedSize > limit) fail('zip_limit_exceeded');
      const target = path.join(state.tempDir, crypto.randomUUID());
      const stream = await openEntry(zip, entry);
      let size = 0;
      const bound = new Transform({ transform(chunk, _, callback) {
        size += chunk.length;
        state.budget.expanded += chunk.length;
        callback(size > limit || state.budget.expanded > MAX_EXPANDED_BYTES ? new Error('zip_limit_exceeded') : null, chunk);
      } });
      try {
        await pipe(stream, bound, (await fs.open(target, 'wx', 0o600)).createWriteStream());
        if (nested) await extract(target, clean, ids, depth + 1, state);
        else if (size) state.files.push({ ...output, path: target, size });
        else state.ignored++;
      } finally { if (nested || !size) await fs.rm(target, { force: true }); }
    }
  } finally { zip.close(); await closed; }
}

async function importZip(library, uploaded, name, options, tempDir) {
  const state = { tempDir, budget: { entries: 0, expanded: 0 }, files: [], ignored: 0 };
  try {
    await extract(uploaded, name, new Set(), 0, state);
    if (!state.files.length) return { imported: 0, overwritten: 0, skipped: 0, ignored: state.ignored, works: 0, workIds: [] };
    return { ...(await library.importBatch(state.files, options)), ignored: state.ignored };
  } catch (error) {
    if (['zip_limit_exceeded', 'invalid_file', 'invalid_path'].includes(error.message)) throw error;
    throw new Error('invalid_zip');
  }
}

module.exports = { importZip, MAX_UPLOAD_BYTES };
