const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const DEFAULT_PASSWORD = 'kikoeta-lrc';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const validStoredUser = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);

function equalStrings(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = crypto.createHash('sha256').update(actual).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

class Credentials {
  constructor(dataDir, initialUser = 'admin') {
    if (!validStoredUser(initialUser)) throw new Error('Invalid initial administrator username');
    this.file = path.join(path.resolve(dataDir), 'admin-credentials.json');
    this.initialUser = initialUser;
    this.record = null;
    this.version = 0;
    this.pending = Promise.resolve();
  }

  get mustChangePassword() { return this.record === null; }
  get user() { return this.record?.user ?? this.initialUser; }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const record = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (record?.version !== 1 || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{64}$/.test(record.hash) ||
          (record.user !== undefined && !validStoredUser(record.user))) {
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

  async save(record) {
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    this.record = record;
    this.version++;
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
      await this.save({ version: 1, user: this.user, salt: salt.toString('hex'), hash: hash.toString('hex') });
    });
    this.pending = change.catch(() => {});
    return change;
  }

  async changeUser(currentPassword, newUser) {
    if (typeof newUser !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(newUser)) throw new Error('invalid_new_user');
    const change = this.pending.then(async () => {
      if (this.mustChangePassword) throw new Error('password_change_required');
      const check = await this.verify(currentPassword);
      if (!check.valid) throw new Error('invalid_current_password');
      if (newUser === this.user) throw new Error('invalid_new_user');
      await this.save({ ...this.record, user: newUser });
    });
    this.pending = change.catch(() => {});
    return change;
  }
}

module.exports = { Credentials, DEFAULT_PASSWORD, equalStrings };
