const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zstdDecompressSync } = require('node:zlib');
const { test } = require('node:test');
const { packNup } = require('../engine/nup.cjs');
const { FtpClient } = require('../engine/ftp-client.cjs');

const hash = (bytes) => createHash('sha256').update(bytes).digest();
const baseId = '0100abcd00010000';
const editionId = '0400abcd00010001';
const addonId = '0100abcd00011001';
process.env.YOINK_RESUME_DELAY_MS = '0';

async function ftpServer(t, files, { greeting = 220, short = false, drop = new Set() } = {}) {
  const sockets = new Set();
  const servers = new Set();
  const requests = [];
  const listen = (server) => new Promise((resolve, reject) => {
    servers.add(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const port = await listen(net.createServer((connection) => {
    const control = track(connection);
    control.setEncoding('utf8');
    control.write(greeting + ' Test server\r\n');
    let input = '';
    let data;
    let passive;
    let restart = 0;
    let pending = Promise.resolve();
    control.on('data', (chunk) => {
      input += chunk;
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        pending = pending.then(async () => {
          const [command] = line.split(' ');
          if (command === 'TYPE' || command === 'NOOP') control.write('200 OK\r\n');
          else if (command === 'REST') {
            restart = Number(line.slice(5));
            requests.push(line);
            control.write('350 Restart offset accepted\r\n');
          }
          else if (command === 'EPSV') {
            data = new Promise((resolve) => {
              passive = net.createServer((socket) => resolve(track(socket)));
            });
            const dataPort = await listen(passive);
            control.write('229 Entering Extended Passive Mode (|||' + dataPort + '|)\r\n');
          } else if (command === 'RETR') {
            const name = line.slice(5);
            requests.push(name);
            const bytes = files.get(name);
            if (!bytes) throw new Error('Unexpected transfer: ' + name);
            control.write('150 Opening data connection\r\n');
            const socket = await data;
            const from = restart;
            restart = 0;
            passive.close();
            // drop: send the first half of the file, then cut the data connection like a flaky link would
            if (drop.has(name)) {
              drop.delete(name);
              const half = from + Math.ceil((bytes.length - from) / 2);
              await new Promise((resolve) => socket.write(bytes.subarray(from, half), resolve));
              socket.destroy();
              control.write('426 Transfer interrupted\r\n');
              return;
            }
            await new Promise((resolve) => socket.end(short ? bytes.subarray(from, -1) : bytes.subarray(from), resolve));
            control.write('226 Transfer complete\r\n');
          } else if (command === 'QUIT') control.end('221 Goodbye\r\n');
          else throw new Error('Unexpected FTP command: ' + line);
        }).catch((error) => control.destroy(error));
      }
    });
  }));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  return { host: '127.0.0.1', port, requests };
}

function fixture() {
  const files = new Map();
  const views = [];
  function romfs(prefix, source, contents) {
    let offset = 0;
    const chunks = [];
    const entries = Object.entries(contents).map(([name, value]) => {
      const bytes = Buffer.from(value);
      const entry = { path: name, type: 'file', offset, size: bytes.length };
      chunks.push(bytes);
      offset += bytes.length;
      return entry;
    });
    const name = prefix + '/romfs';
    files.set(name + '.img', Buffer.concat(chunks));
    views.push({ path: name, source, size: offset, entries });
  }
  function exefs(prefix, source, id) {
    const main = Buffer.alloc(0x60, 1);
    main.write('NSO0');
    const npdm = Buffer.alloc(0x30);
    npdm.write('ACI0');
    npdm.writeBigUInt64LE(BigInt('0x' + id), 0x10);
    const entries = [['/main', main], ['/main.npdm', npdm]].map(([name, bytes]) => {
      files.set(prefix + '/exefs' + name, bytes);
      return { path: name, type: 'file', size: bytes.length };
    });
    views.push({ path: prefix + '/exefs', source, entries });
  }
  const base = { version: 0, contentTitle: baseId };
  const update = { version: 720896, contentTitle: baseId };
  const edition = { version: 720896, contentTitle: editionId, runtimeProgramId: editionId };
  exefs('/base', base, baseId);
  exefs('/updates/720896', update, baseId);
  exefs('/switch2/updates/720896', edition, editionId);
  romfs('/base', base, { '/shared.txt': 'old', '/deleted.txt': 'deleted by update' });
  romfs('/updates/720896', update, { '/shared.txt': 'updated', '/big.txt': 'compressible '.repeat(1000), '/empty': '' });
  romfs('/switch2/updates/720896', edition, { '/edition.txt': 'program 1' });
  romfs('/dlc/' + addonId + '/0', { version: 0, contentTitle: addonId }, {
    '/shared.txt': 'upgrade', '/System/AoCUpgradeVersion.txt': '1',
  });
  romfs('/dlc/0100abcd00011801/262144', {
    version: 262144, contentTitle: '0100abcd00011801', metaType: 0x84, dataTitle: addonId,
  }, { '/shared.txt': 'patched upgrade', '/System/AoCUpgradeVersion.txt': '1' });
  romfs('/dlc/0100abcd00011002/0', { version: 0, contentTitle: '0100abcd00011002' }, { '/aoc/bonus.txt': 'ordinary DLC' });
  const control = {
    name: 'Original game', version: '1.0.0', nacp: Buffer.alloc(0x4000),
    switch2: { name: 'Official Nintendo Switch 2 Edition', version: '1.4.3', nacp: Buffer.alloc(0x4000, 2), icon: Buffer.from('edition icon') },
  };
  return { files, views, control };
}

function readArchive(bytes) {
  assert.equal(bytes.subarray(0, 4).toString('hex'), '4e555001');
  assert.equal(Number(bytes.readBigUInt64LE(0x40)), bytes.length);
  const tocAt = Number(bytes.readBigUInt64LE(8));
  const toc = bytes.subarray(tocAt, tocAt + Number(bytes.readBigUInt64LE(16)));
  assert.deepEqual(hash(toc), bytes.subarray(0x18, 0x38));
  const count = toc.readUInt32LE(4);
  const dirs = Number(toc.readBigUInt64LE(8));
  const files = Number(toc.readBigUInt64LE(16));
  const dirAt = 0x30 + count * 0x40;
  const fileAt = dirAt + dirs * 0x18;
  const childrenAt = fileAt + files * 0x50;
  const poolAt = Number(toc.readBigUInt64LE(0x18));
  const name = (at) => toc.subarray(poolAt + toc.readUInt32LE(at), poolAt + toc.readUInt32LE(at) + toc.readUInt32LE(at + 4)).toString();
  const contents = new Map();
  for (let i = 0; i < files; i++) {
    const at = fileAt + i * 0x50;
    const offset = Number(toc.readBigUInt64LE(at + 0x10));
    const size = Number(toc.readBigUInt64LE(at + 0x18));
    let data = bytes.subarray(offset, offset + size);
    if (toc[at + 0x40] === 1) data = zstdDecompressSync(data);
    assert.equal(data.length, Number(toc.readBigUInt64LE(at + 8)));
    assert.deepEqual(hash(data), toc.subarray(at + 0x20, at + 0x40));
    contents.set(i, data);
  }
  function tree(index, prefix, out) {
    const at = dirAt + index * 0x18;
    const first = toc.readUInt32LE(at + 8);
    const count = toc.readUInt32LE(at + 12);
    for (let i = 0; i < count; i++) {
      const child = toc.readUInt32LE(childrenAt + (first + i) * 4);
      if (child < dirs) tree(child, prefix + name(dirAt + child * 0x18) + '/', out);
      else out.set(prefix + name(fileAt + (child - dirs) * 0x50), contents.get(child - dirs));
    }
  }
  return Array.from({ length: count }, (_, i) => {
    const at = 0x30 + i * 0x40;
    const metaAt = Number(toc.readBigUInt64LE(at + 0x20));
    const meta = bytes.subarray(metaAt, metaAt + toc.readUInt32LE(at + 0x28));
    const tags = new Map();
    for (let n = 0; n < meta.length;) {
      const size = meta.readUInt32LE(n + 4);
      tags.set(meta.readUInt16LE(n), meta.subarray(n + 8, n + 8 + size));
      n += 8 + size;
    }
    const romfs = new Map();
    const romfsDir = toc.readUInt32LE(at + 0x10);
    if (romfsDir !== 0xffffffff) tree(romfsDir, '/', romfs);
    const exefs = new Map();
    const exefsDir = toc.readUInt32LE(at + 0xc);
    if (exefsDir !== 0xffffffff) tree(exefsDir, '/', exefs);
    const all = new Map();
    tree(toc.readUInt32LE(at + 0x08), '/', all);
    return { id: toc.readBigUInt64LE(at).toString(16).padStart(16, '0'), version: toc.readUInt32LE(at + 0x14), kind: toc[at + 0x18], tags, romfs, exefs, all };
  });
}

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoink-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('both editions retain their own metadata and flatten only the Switch 2 output', async (t) => {
  const data = fixture();
  const server = await ftpServer(t, data.files);
  const output = path.join(await directory(t), 'game.nup');
  const progress = [];
  await packNup({ ...server, ...data, title: baseId, output, edition: 'both', onProgress: (event) => progress.push(event) });
  const s1 = readArchive(await fs.readFile(output));
  const s2 = readArchive(await fs.readFile(output.replace('.nup', '-switch2.nup')));
  assert.equal(s1[0].tags.get(5).toString(), data.control.name);
  assert.equal(s1[0].tags.get(4).toString(), '1.0.0');
  assert.ok(!s1.some((pack) => pack.id === editionId));
  const program = s2.find((pack) => pack.kind === 0);
  assert.equal(program.id, editionId);
  assert.equal(program.tags.get(5).toString(), data.control.switch2.name);
  assert.equal(program.tags.get(4).toString(), '1.4.3');
  assert.deepEqual(program.tags.get(2), data.control.switch2.nacp);
  assert.deepEqual(program.tags.get(3), data.control.switch2.icon);
  assert.equal(program.romfs.get('/shared.txt').toString(), 'patched upgrade');
  assert.equal(program.romfs.get('/edition.txt').toString(), 'program 1');
  assert.ok(!program.romfs.has('/deleted.txt'));
  assert.ok(!program.romfs.has('/aoc/bonus.txt'));
  assert.ok(s2.some((pack) => pack.id === '0100abcd00011002'));
  assert.equal(new Set(server.requests).size, server.requests.length, 'shared input transfers must happen once');
  const finished = progress.filter((event) => event.finished);
  assert.deepEqual(finished.map((event) => event.path).sort(), [...server.requests].sort());
  assert.ok(finished.every((event) => event.done === event.total && Number.isFinite(event.bytesPerSecond)));
});

test('all mode retains base, both programs and the add-on data patch identity', async (t) => {
  const data = fixture();
  const server = await ftpServer(t, data.files);
  const output = path.join(await directory(t), 'game.nup');
  await packNup({ ...server, ...data, title: baseId, output, edition: 'all' });
  const packages = readArchive(await fs.readFile(output));
  assert.equal(packages.length, 6);
  assert.equal(packages.find((pack) => pack.kind === 3).id, addonId);
  assert.equal(packages.find((pack) => pack.id === editionId).tags.get(5).toString(), data.control.switch2.name);
  assert.equal(packages.find((pack) => pack.kind === 0).tags.get(5).toString(), data.control.name);
});

test('DLC patch identity and layering follow metadata even when its ID sorts before the base', async (t) => {
  const data = fixture();
  const patch = data.views.find((view) => view.source.metaType === 0x84);
  const oldPath = patch.path + '.img';
  patch.source.contentTitle = '0100000000001001';
  patch.path = '/dlc/' + patch.source.contentTitle + '/262144/romfs';
  data.files.set(patch.path + '.img', data.files.get(oldPath));
  data.files.delete(oldPath);
  const server = await ftpServer(t, data.files);
  const output = path.join(await directory(t), 'game.nup');
  await packNup({ ...server, ...data, title: baseId, output, edition: 'both' });
  const s1 = readArchive(await fs.readFile(output));
  assert.equal(s1.find((pack) => pack.kind === 3).id, addonId);
  const s2 = readArchive(await fs.readFile(output.replace('.nup', '-switch2.nup')));
  assert.equal(s2.find((pack) => pack.kind === 0).romfs.get('/shared.txt').toString(), 'patched upgrade');
});

test('non-edition games fall back to normal base/update packing', async (t) => {
  const data = fixture();
  data.views = data.views.filter((view) => !view.path.startsWith('/switch2/') && !view.path.startsWith('/dlc/'));
  const server = await ftpServer(t, data.files);
  const output = path.join(await directory(t), 'game.nup');
  await packNup({ ...server, ...data, title: baseId, output });
  const packages = readArchive(await fs.readFile(output));
  assert.equal(packages.length, 2);
  assert.equal(packages[0].id, baseId);
  assert.equal(packages[0].tags.get(5).toString(), data.control.name);
});

test('base and matching update packages carry their own control metadata', async (t) => {
  const data = fixture();
  data.views = data.views.filter((view) => !view.path.startsWith('/switch2/') && !view.path.startsWith('/dlc/'));
  const updateControl = { name: 'Updated game', publisher: 'Publisher', version: '2.0.0',
    nacp: Buffer.alloc(0x4000, 3), icon: Buffer.from('update icon') };
  data.updateControls = { [baseId + ':720896']: updateControl };
  const server = await ftpServer(t, data.files);
  const output = path.join(await directory(t), 'game.nup');
  await packNup({ ...server, ...data, title: baseId, output });
  const packages = readArchive(await fs.readFile(output));
  assert.equal(packages.find((pack) => pack.kind === 0).tags.get(5).toString(), data.control.name);
  const update = packages.find((pack) => pack.kind === 1);
  assert.deepEqual(update.tags.get(2), updateControl.nacp);
  assert.deepEqual(update.tags.get(3), updateControl.icon);
  assert.equal(update.tags.get(4).toString(), updateControl.version);
  assert.equal(update.tags.get(5).toString(), updateControl.name);
  assert.equal(update.tags.get(6).toString(), updateControl.publisher);
});

test('missing Switch 2 executable files abort packing before connecting or creating output', async (t) => {
  const dir = await directory(t);
  for (const edition of ['switch2', 'both', 'all']) {
    for (const missing of ['exefs', '/main', '/main.npdm']) {
      const data = fixture();
      const code = data.views.find((view) => view.path.startsWith('/switch2/') && view.path.endsWith('/exefs'));
      if (missing === 'exefs') data.views = data.views.filter((view) => view !== code);
      else code.entries = code.entries.filter((entry) => entry.path !== missing);
      await assert.rejects(packNup({ ...data, title: baseId, host: '127.0.0.1', port: 0,
        output: path.join(dir, 'game.nup'), edition }), /missing Switch 2 ExeFS/);
      assert.deepEqual(await fs.readdir(dir), []);
    }
  }
});

test('composed card views pack as one base at the patch version with unchanged executable bytes', async (t) => {
  const data = fixture();
  const nativeId = '040094b02455c000';
  data.files.get('/updates/720896/exefs/main.npdm').writeBigUInt64LE(BigInt('0x' + nativeId), 0x10);
  data.views = data.views.filter((view) => view.path.startsWith('/updates/'));
  for (const view of data.views) {
    const oldPath = view.path + (view.path.endsWith('/romfs') ? '.img' : '');
    view.path = view.path.replace('/updates/720896', '/base');
    view.source = { ...view.source, version: 65536, selection: 'update', contentTitle: '040094b02455c800' };
    if (view.path.endsWith('/romfs')) data.files.set(view.path + '.img', data.files.get(oldPath));
    else for (const entry of view.entries) data.files.set(view.path + entry.path, data.files.get(oldPath + entry.path));
  }
  const server = await ftpServer(t, data.files);
  const output = path.join(await directory(t), 'card.nup');
  await packNup({ ...server, ...data, title: nativeId, output });
  const packages = readArchive(await fs.readFile(output));
  assert.equal(packages.length, 1);
  assert.equal(packages[0].kind, 0);
  assert.equal(packages[0].id, nativeId);
  assert.equal(packages[0].version, 65536);
  assert.deepEqual(packages[0].exefs.get('/main'), data.files.get('/base/exefs/main'));
  assert.deepEqual(packages[0].exefs.get('/main.npdm'), data.files.get('/base/exefs/main.npdm'));
  assert.equal(packages[0].romfs.get('/shared.txt').toString(), 'updated');
  assert.ok(server.requests.every((name) => name.startsWith('/base/')));
});

test('failed FTP setup leaves no output or temporary directory', async (t) => {
  const data = fixture();
  const server = await ftpServer(t, data.files, { greeting: 500 });
  const dir = await directory(t);
  await assert.rejects(packNup({ ...server, ...data, title: baseId, output: path.join(dir, 'game.nup') }), /greeting failed/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('cancellation before connecting leaves no partial dump', async (t) => {
  const dir = await directory(t);
  await assert.rejects(packNup({ ...fixture(), host: '127.0.0.1', port: 0, title: baseId,
    output: path.join(dir, 'game.nup'), shouldStop: () => true }), { code: 'FTP_CANCELLED' });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('failed FTP setup preserves a partial file from an earlier run', async (t) => {
  const data = fixture();
  const server = await ftpServer(t, data.files, { greeting: 500 });
  const dir = await directory(t);
  const output = path.join(dir, 'game.nup');
  await fs.writeFile(output + '.part', 'earlier transfer');
  await assert.rejects(packNup({ ...server, ...data, title: baseId, output }), /greeting failed/);
  assert.equal(await fs.readFile(output + '.part', 'utf8'), 'earlier transfer');
  assert.deepEqual(await fs.readdir(dir), ['game.nup.part']);
});

test('short transfers are rejected and partial outputs are removed', async (t) => {
  const data = fixture();
  const server = await ftpServer(t, data.files, { short: true });
  const dir = await directory(t);
  await assert.rejects(packNup({ ...server, ...data, title: baseId, output: path.join(dir, 'game.nup') }), /was short/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('FTP client reads binary bytes without modification', async (t) => {
  const bytes = Buffer.from([0, 10, 13, 128, 255]);
  const server = await ftpServer(t, new Map([['/binary', bytes]]));
  const client = await FtpClient.open(server.host, server.port);
  try {
    const chunks = [];
    await client.retrieve('/binary', bytes.length, async (chunk) => chunks.push(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
  } finally { await client.close(); }
});

test('a dropped data connection resumes from the received offset', async (t) => {
  const data = fixture();
  const image = '/updates/720896/romfs.img';
  const server = await ftpServer(t, data.files, { drop: new Set([image, '/base/exefs/main']) });
  const output = path.join(await directory(t), 'game.nup');
  await packNup({ ...server, ...data, title: baseId, output, edition: 'all' });
  const packages = readArchive(await fs.readFile(output));
  const update = packages.find((pack) => pack.kind === 1 && pack.id === baseId);
  assert.equal(update.romfs.get('/big.txt').toString(), 'compressible '.repeat(1000));
  assert.equal(update.romfs.get('/shared.txt').toString(), 'updated');
  const base = packages.find((pack) => pack.kind === 0);
  assert.deepEqual(base.exefs.get('/main'), data.files.get('/base/exefs/main'));
  const half = Math.ceil(data.files.get(image).length / 2);
  assert.ok(server.requests.includes('REST ' + half), 'resumed with REST at the received byte count');
});
