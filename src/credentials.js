const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const DEFAULT_PASSWORD = 'kikoeta-lrc';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

function equalStrings(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = crypto.createHash('sha256').update(actual).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

class Credentials {
  constructor(dataDir) {
    this.file = path.join(path.resolve(dataDir), 'admin-credentials.json');
    this.record = null;
    this.version = 0;
    this.pending = Promise.resolve();
  }

  get mustChangePassword() { return this.record === null; }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const record = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (record?.version !== 1 || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{64}$/.test(record.hash)) {
        throw new Error('Invalid administrator credential file');
      }
      this.record = record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async verify(password) {
    const version = this.version;
    if (typeof password !== 'string') return { valid: false, version };
    if (!this.record) return { valid: equalStrings(password, DEFAULT_PASSWORD), version };
    const candidate = await scrypt(password, Buffer.from(this.record.salt, 'hex'), 32, SCRYPT_OPTIONS);
    return { valid: crypto.timingSafeEqual(candidate, Buffer.from(this.record.hash, 'hex')), version };
  }

  async change(currentPassword, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128 ||
        newPassword === DEFAULT_PASSWORD || newPassword === currentPassword) {
      throw new Error('invalid_new_password');
    }
    const change = this.pending.then(async () => {
      if (!this.mustChangePassword) {
        const check = await this.verify(currentPassword);
        if (!check.valid) throw new Error('invalid_current_password');
      }
      const salt = crypto.randomBytes(16);
      const hash = await scrypt(newPassword, salt, 32, SCRYPT_OPTIONS);
      const record = { version: 1, salt: salt.toString('hex'), hash: hash.toString('hex') };
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp, { force: true });
      }
      this.record = record;
      this.version++;
    });
    this.pending = change.catch(() => {});
    return change;
  }
}

module.exports = { Credentials, DEFAULT_PASSWORD, equalStrings };
