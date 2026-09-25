const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const validUser = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(value);
const validKey = (value) => typeof value === 'string' && /^[A-Za-z0-9]{12}$/.test(value);

function generateKey() {
  let key = '';
  for (let index = 0; index < 12; index++) key += KEY_CHARS[crypto.randomInt(KEY_CHARS.length)];
  return key;
}

class TranslAuth {
  constructor(dataDir) {
    this.file = path.join(path.resolve(dataDir), 'transl-credentials.json');
    this.record = { version: 1, basic: null, keyHash: null, key: null };
    this.pending = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const record = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const basic = record?.basic;
      if (record?.version !== 1 ||
          (basic !== null && (!validUser(basic?.user) || !/^[a-f0-9]{32}$/.test(basic.salt) || !/^[a-f0-9]{64}$/.test(basic.hash))) ||
          (record.keyHash !== null && !/^[a-f0-9]{64}$/.test(record.keyHash)) ||
          (record.key !== undefined && record.key !== null && (!validKey(record.key) || record.keyHash !== crypto.createHash('sha256').update(record.key).digest('hex'))) ||
          (record.key != null && record.keyHash === null)) throw new Error('Invalid Kikoeta Transl credential file');
      this.record = record;
      if (record.basic && record.keyHash) await this.save({ ...record, basic: null });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  status({ includeKey = false } = {}) {
    return {
      username: this.record.basic?.user || '',
      hasPassword: !!this.record.basic,
      hasKey: !!this.record.keyHash,
      ...(includeKey ? { key: this.record.key || '' } : {}),
    };
  }

  async verifyBasic(user, password) {
    const basic = this.record.basic;
    if (!basic || user !== basic.user || typeof password !== 'string') return false;
    const candidate = await scrypt(password, Buffer.from(basic.salt, 'hex'), 32, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(candidate, Buffer.from(basic.hash, 'hex'));
  }

  verifyKey(key) {
    if (!this.record.keyHash || !validKey(key)) return false;
    const candidate = crypto.createHash('sha256').update(key).digest();
    return crypto.timingSafeEqual(candidate, Buffer.from(this.record.keyHash, 'hex'));
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
  }

  async update(data) {
    if (!data || typeof data !== 'object') throw new Error('invalid_auth_settings');
    const action = data.action;
    if (!['set_password', 'clear_password', 'set_key', 'generate_key', 'clear_key'].includes(action)) throw new Error('invalid_auth_settings');
    if (action === 'set_password' && (!validUser(data.username) || typeof data.password !== 'string' || data.password.length < 6 || data.password.length > 128)) throw new Error('invalid_auth_settings');
    if (action === 'set_key' && !validKey(data.key)) throw new Error('invalid_auth_settings');
    const change = this.pending.then(async () => {
      const record = { ...this.record };
      let key;
      if (action === 'set_password') {
        const salt = crypto.randomBytes(16);
        const hash = await scrypt(data.password, salt, 32, SCRYPT_OPTIONS);
        record.basic = { user: data.username, salt: salt.toString('hex'), hash: hash.toString('hex') };
        record.keyHash = null;
        record.key = null;
      } else if (action === 'clear_password') record.basic = null;
      else if (action === 'set_key' || action === 'generate_key') {
        key = action === 'set_key' ? data.key : generateKey();
        record.keyHash = crypto.createHash('sha256').update(key).digest('hex');
        record.key = key;
        record.basic = null;
      } else {
        record.keyHash = null;
        record.key = null;
      }
      await this.save(record);
      return this.status({ includeKey: true });
    });
    this.pending = change.catch(() => {});
    return change;
  }
}

module.exports = { TranslAuth };
