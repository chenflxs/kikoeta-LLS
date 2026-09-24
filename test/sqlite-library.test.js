const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library } = require('../src/library');

test('100,001 works remain indexed and admin pages stay bounded', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lls-scale-'));
  const library = new Library(dir);
  t.after(async () => { library.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await library.init();
  library.db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index <= 100000; index++) {
      const id = `RJ${String(index).padStart(6, '0')}`;
      library.insertWork.run(id);
      library.upsertFile.run(id, 'song.lrc', 1, index === 50000 ? 1 : 0, Buffer.from('x'));
    }
    library.db.exec('COMMIT');
  } catch (error) { library.db.exec('ROLLBACK'); throw error; }
  assert.deepEqual(await library.stats(), { workCount: 100001, fileCount: 100001 });
  const first = await library.workPage();
  assert.equal(first.works.length, 50);
  assert.equal(first.works[0].workId, 'RJ000000');
  assert.equal(first.nextCursor, 'RJ000049');
  const second = await library.workPage({ after: first.nextCursor });
  assert.equal(second.works[0].workId, 'RJ000050');
  assert.equal((await library.workPage({ query: 'RJ050000' })).works[0].isAi, true);
  assert.deepEqual((await library.workPage({ query: 'missing-track-name' })).works, []);
  assert.equal((await library.files('RJ050000'))[0].relativePath, 'song.lrc');
  assert.equal((await library.works()).length, 100001);
});
