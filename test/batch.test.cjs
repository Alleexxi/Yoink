const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { batchFilename, parseBatchSelection, planBatch, dumpBatch } = require('../engine/batch.cjs');
const { getArgs, pickGame } = require('../yoink.cjs');

const games = [
  { title: '0100000000000001', name: 'Same game', storages: [4] },
  { title: '0100000000000002', name: 'Same game', storages: [5], switch2Edition: true },
  { title: '0100000000000003', name: 'Third game', storages: [4] },
];

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoink-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function consoleServices({ failAt, failure = new Error('Simulated console failure'), afterPack, afterClose } = {}) {
  const events = [];
  const packs = [];
  let sequence = 0;
  const event = (name) => { events.push(name); if (name === failAt) throw failure; };
  const services = {
    async attachGame(run) {
      const id = sequence++;
      event('attach:' + id);
      return { id, async close() { event('attachment.close:' + id); } };
    },
    async getConsoleIp(attachment) { event('ip:' + attachment.id); return '192.168.2.162'; },
    async prepareGame(options) {
      event('prepare:' + options.attachment.id);
      assert.equal(options.images, true);
      return { views: [{ id: options.attachment.id }], control: { name: options.title },
        updateControls: { [options.title + ':131072']: { name: 'Update', version: '1.1.0' } } };
    },
    async deployFtp({ attachment }) {
      event('ftp:' + attachment.id);
      return { async close() { event('ftp.close:' + attachment.id); await afterClose?.(attachment.id); } };
    },
    async packNup(options) {
      const id = options.views[0].id;
      event('pack:' + id);
      packs.push(options);
      await fs.writeFile(options.output, options.title);
      if (options.edition === 'both') await fs.writeFile(options.output.slice(0, -4) + '-switch2.nup', options.title);
      options.onProgress?.({ path: '/base/romfs.img', done: 1, total: 1, bytesPerSecond: 1 });
      await afterPack?.(id);
    },
  };
  return { services, events, packs, failure };
}

test('batch filenames stay inside the folder and distinguish duplicate display names', async (t) => {
  const outputDir = path.join(await directory(t), 'new folder');
  const jobs = await planBatch({ games, outputDir, edition: 'both' });
  assert.equal(new Set(jobs.flatMap((job) => job.outputs)).size, 6);
  for (const job of jobs) assert.equal(path.dirname(job.output), outputDir);
  const hostile = batchFilename({ ...games[0], name: '../CON: /bad\\name?*' });
  assert.ok(!/[<>:"/\\|?*]/.test(hostile));
  const long = batchFilename({ ...games[0], name: '🎮'.repeat(200) });
  assert.ok(Buffer.byteLength(long) < 255);
  await fs.writeFile(path.join(outputDir, long), 'valid filename');
});

test('batch selection validates numbers and removes repeated selections', () => {
  assert.deepEqual(parseBatchSelection('2, 1 2', games), [games[1], games[0]]);
  for (const value of ['', '0', '4', '1,,2', '1-3', '-1', '1.5', 'all', '99999999999999999999']) {
    assert.throws(() => parseBatchSelection(value, games), /Enter|Choose/);
  }
});

test('CLI accepts batch options and rejects conflicting single-game modes', () => {
  const options = getArgs(['--batch', '--output-dir', 'dumps', '--edition', 'both', '--ip', '192.168.2.162', '--no-tui']);
  assert.equal(options.batch, true);
  assert.equal(options.outputDir, path.resolve('dumps'));
  assert.equal(options.edition, 'both');
  for (const args of [['--batch', '--nup', 'game.nup'], ['--batch', '--probe'], ['--batch', games[0].title],
    ['--output-dir', 'dumps'], ['--batch', '--output-dir']]) assert.throws(() => getArgs(args), /batch|output-dir/);
});

test('plain batch picker retries invalid numbers and returns several games', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const choice = pickGame(games, new AbortController().signal, { multiple: true, input, output });
  input.end('99\n2,1,2\n');
  assert.deepEqual(await choice, [games[1], games[0]]);
  assert.match(text, /Choose game numbers/);
});

test('batch runs sequentially and closes FTP then its attachment before the next game', async (t) => {
  const outputDir = await directory(t);
  const f = consoleServices();
  const stages = [];
  const progress = [];
  const result = await dumpBatch({ run: '/run', games: games.slice(0, 2), outputDir, image: Buffer.alloc(1), edition: 'both',
    onStage: (stage, details) => stages.push({ stage, details }), onProgress: (value) => progress.push(value) }, f.services);
  assert.deepEqual(f.events, [
    'attach:0', 'ip:0', 'prepare:0', 'ftp:0', 'pack:0', 'ftp.close:0', 'attachment.close:0',
    'attach:1', 'ip:1', 'prepare:1', 'ftp:1', 'pack:1', 'ftp.close:1', 'attachment.close:1',
  ]);
  assert.equal(result.completed.length, 2);
  assert.equal((await fs.readdir(outputDir)).length, 4);
  assert.deepEqual(f.packs.map((options) => options.title), games.slice(0, 2).map((game) => game.title));
  assert.ok(f.packs.every((options) => options.edition === 'both'));
  for (const options of f.packs) {
    assert.equal(options.updateControls[options.title + ':131072'].version, '1.1.0');
  }
  assert.deepEqual(stages.filter((item) => item.stage === 'Connecting to your console').map((item) => item.details.batch.index), [1, 2]);
  assert.equal(progress.length, 2);
});

test('preflight refuses existing output, companion and partial files before RPC', async (t) => {
  for (const suffix of ['', '-switch2', '.part']) {
    const outputDir = path.join(await directory(t), 'queue');
    await fs.mkdir(outputDir);
    const output = path.join(outputDir, batchFilename(games[1]));
    const existing = suffix === '-switch2' ? output.slice(0, -4) + suffix + '.nup' : output + suffix;
    await fs.writeFile(existing, 'keep me');
    const f = consoleServices();
    await assert.rejects(dumpBatch({ games, outputDir, edition: 'both' }, f.services), /already exists/);
    assert.deepEqual(f.events, []);
    assert.equal(await fs.readFile(existing, 'utf8'), 'keep me');
  }
});

test('a file appearing between games stops the queue before a second attachment', async (t) => {
  const outputDir = await directory(t);
  const next = path.join(outputDir, batchFilename(games[1]));
  const f = consoleServices({ afterClose: async (id) => { if (id === 0) await fs.writeFile(next, 'external file'); } });
  await assert.rejects(dumpBatch({ games, outputDir }, f.services), (error) => error.batch.completed.length === 1 && /already exists/.test(error.message));
  assert.ok(!f.events.includes('attach:1'));
  assert.equal(await fs.readFile(next, 'utf8'), 'external file');
});

test('failed game keeps earlier output, cleans its resources and stops the queue', async (t) => {
  const outputDir = await directory(t);
  const f = consoleServices({ failAt: 'pack:1' });
  await assert.rejects(dumpBatch({ games, outputDir }, f.services), (error) =>
    error === f.failure && error.batch.completed.length === 1 && error.batch.failed.title === games[1].title);
  assert.deepEqual(f.events.slice(-2), ['ftp.close:1', 'attachment.close:1']);
  assert.ok(!f.events.includes('attach:2'));
  assert.equal(await fs.readFile(path.join(outputDir, batchFilename(games[0])), 'utf8'), games[0].title);
});

test('preparation failure releases the attachment without starting FTP', async (t) => {
  const f = consoleServices({ failAt: 'prepare:0' });
  await assert.rejects(dumpBatch({ games, outputDir: await directory(t) }, f.services), /Simulated console failure/);
  assert.deepEqual(f.events, ['attach:0', 'ip:0', 'prepare:0', 'attachment.close:0']);
});

test('cleanup failure still releases the attachment and prevents the next game', async (t) => {
  const f = consoleServices({ failAt: 'ftp.close:0' });
  await assert.rejects(dumpBatch({ games, outputDir: await directory(t) }, f.services), (error) =>
    error.batch.completed.length === 1 && /Simulated console failure/.test(error.message));
  assert.deepEqual(f.events.slice(-2), ['ftp.close:0', 'attachment.close:0']);
  assert.ok(!f.events.includes('attach:1'));
});

test('the next game waits until asynchronous native FTP shutdown finishes', async (t) => {
  const outputDir = await directory(t);
  let release;
  let notify;
  const gate = new Promise((resolve) => { release = resolve; });
  const shuttingDown = new Promise((resolve) => { notify = resolve; });
  const f = consoleServices({ afterClose: async (id) => { if (id === 0) { notify(); await gate; } } });
  const running = dumpBatch({ games: games.slice(0, 2), outputDir }, f.services);
  await shuttingDown;
  try {
    assert.ok(!f.events.includes('attachment.close:0'));
    assert.ok(!f.events.includes('attach:1'));
  } finally { release(); }
  const result = await running;
  assert.equal(result.completed.length, 2);
  assert.ok(f.events.indexOf('attachment.close:0') < f.events.indexOf('attach:1'));
});

test('cancelling after a game cleans up and does not start the next', async (t) => {
  let cancelled = false;
  const f = consoleServices({ afterPack: async () => { cancelled = true; } });
  await assert.rejects(dumpBatch({ games, outputDir: await directory(t), shouldStop: () => cancelled }, f.services), { code: 'FTP_CANCELLED' });
  assert.deepEqual(f.events.slice(-2), ['ftp.close:0', 'attachment.close:0']);
  assert.ok(!f.events.includes('attach:1'));
});

test('an already-cancelled batch never creates output folders or attaches', async (t) => {
  const outputDir = path.join(await directory(t), 'not-created');
  const f = consoleServices();
  await assert.rejects(dumpBatch({ games, outputDir, shouldStop: () => true }, f.services), { code: 'FTP_CANCELLED' });
  await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
  assert.deepEqual(f.events, []);
});

test('batch validates its queue and honors an explicit console IP', async (t) => {
  const outputDir = await directory(t);
  await assert.rejects(planBatch({ games: [], outputDir }), /at least one/);
  await assert.rejects(planBatch({ games: [games[0], games[0]], outputDir }), /selected twice/);
  const f = consoleServices();
  await dumpBatch({ games: [games[0]], outputDir, ip: '192.168.2.99' }, f.services);
  assert.ok(!f.events.includes('ip:0'));
  assert.equal(f.packs[0].host, '192.168.2.99');
});

test('main routes a multi-selection into the real queue and releases its library session first', async (t) => {
  const outputDir = await directory(t);
  const session = require('../engine/session.cjs');
  const content = require('../engine/content.cjs');
  const runtime = require('../engine/runtime.cjs');
  const mounts = require('../engine/mounts.cjs');
  const ftp = require('../engine/ftp.cjs');
  const nup = require('../engine/nup.cjs');
  const network = require('../engine/network.cjs');
  const tui = require('../engine/tui.cjs');
  const f = consoleServices();
  const screens = [];
  t.mock.method(session, 'attachGame', f.services.attachGame);
  t.mock.method(content, 'discoverGames', async (context) => {
    assert.equal(context.id, 0); f.events.push('discover:0'); return games;
  });
  t.mock.method(runtime, 'resolveRun', async () => '/run');
  t.mock.method(mounts, 'prepareGame', f.services.prepareGame);
  t.mock.method(ftp, 'readImage', async () => Buffer.alloc(1));
  t.mock.method(ftp, 'deployFtp', f.services.deployFtp);
  t.mock.method(nup, 'packNup', f.services.packNup);
  t.mock.method(network, 'getConsoleIp', f.services.getConsoleIp);
  t.mock.method(tui, 'supportsTui', () => true);
  t.mock.method(tui, 'TerminalUI', function () {
    return { start() {}, close() {}, setStage() {}, progress() {}, log() {},
      async chooseGame() { return games.slice(0, 2); },
      async configureBatch({ games: selected }) {
        assert.equal(selected.length, 2); return { outputDir, edition: 'switch1' };
      },
      async done(stage) { screens.push(stage); },
    };
  });
  const modules = ['../engine/batch.cjs', '../yoink.cjs'].map(require.resolve);
  for (const file of modules) delete require.cache[file];
  t.after(() => { for (const file of modules) delete require.cache[file]; });
  await require('../yoink.cjs').main([]);
  assert.deepEqual(f.events.slice(0, 4), ['attach:0', 'discover:0', 'attachment.close:0', 'attach:1']);
  assert.ok(f.events.indexOf('attachment.close:1') < f.events.indexOf('attach:2'));
  assert.equal(f.events.filter((event) => event === 'attachment.close:0').length, 1);
  assert.deepEqual(screens, ['Batch complete (2/2)']);
  assert.equal(f.packs.length, 2);
  assert.ok(f.packs.every((options) => options.edition === 'switch1'));
  assert.equal((await fs.readdir(outputDir)).length, 2);
});
