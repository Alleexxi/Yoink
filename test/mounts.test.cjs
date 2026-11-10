const assert = require('node:assert/strict');
const { test } = require('node:test');
const content = require('../engine/content.cjs');
const program = require('../engine/program.cjs');
const { resultError } = require('../engine/protocol.cjs');

const title = '0100e95004038000';
const patch = { contentTitle: '0100e95004038800', storage: 4, version: 1114112 };
const runtimeId = '0400e95004038001';
const addon = { contentTitle: '0100e95004039001', storage: 4, version: 0 };

// Mock the console-facing content/program services; exercise the actual mount
// planner, RomFS parsing, ExeFS enumeration and failure handling together.
function fixture(t, { missingProgram = false, failure, badHeader = false, secondStorageAbsent = false,
  title: selectedTitle = title, readControl = async () => null, baseFailure, licenseFailure } = {}) {
  const selectedPatch = { ...patch,
    contentTitle: (BigInt('0x' + selectedTitle) + 0x800n).toString(16).padStart(16, '0') };
  const calls = [];
  const bytes = Buffer.alloc(0x80000);
  const handles = new Set();
  let next = 100;
  const directoryReads = new Set();
  const own = () => { const handle = next++; handles.add(handle); return handle; };
  const sourceFor = ({ storage, update, dlc, programIndex = 0 }) => ({
    storage, contentTitle: dlc?.contentTitle || update?.contentTitle,
    version: dlc?.version || update?.version || 0,
    contentId: (programIndex ? '22' : '11').repeat(16),
    contentType: dlc ? 2 : 1, metaType: dlc ? 0x82 : update ? 0x81 : 0x80,
    selection: dlc ? 'dlc' : update ? 'update' : undefined,
    contentPath: '@UserContent://' + (dlc ? 'dlc' : 'program-' + programIndex) + '.nca', attributes: 0, programIndex,
  });
  t.mock.method(content, 'discoverUpdates', async () => secondStorageAbsent ? [selectedPatch, { ...selectedPatch, storage: 5 }] : [selectedPatch]);
  t.mock.method(content, 'discoverDlc', async () => [addon]);
  t.mock.method(content, 'discoverDataPatches', async () => []);
  t.mock.method(content, 'readControl', readControl);
  t.mock.method(program, 'prepareInstalledLicense', async () => { if (licenseFailure) throw licenseFailure; });
  t.mock.method(content, 'verifyProgramSnapshot', async ({ sources }) => {
    calls.push('verify:' + [...new Set(sources.map((source) => source.programIndex))].join(','));
  });
  t.mock.method(content, 'resolveProgramContent', async (options) => {
    if (options.programIndex && (missingProgram || (secondStorageAbsent && options.storage === 5))) {
      throw resultError('GetContentIdByTypeAndIdOffset', 0xa05);
    }
    return sourceFor(options);
  });
  t.mock.method(content, 'resolveDlcContent', async (options) => sourceFor(options));
  t.mock.method(program, 'createProgramMounts', () => ({
    async openCode() { calls.push('base:exefs'); if (baseFailure) throw baseFailure; return own(); },
    async openUpdate(options) {
      calls.push('program' + (options.programIndex || 0) + ':' + options.section);
      if (options.programIndex && options.section === 'exefs' && failure) throw failure;
      return own();
    },
  }));
  const image = Buffer.alloc(0x100);
  [0x50, 0x50, 4, 0x54, 24, 0x6c, 4, 0x70, 0, 0x70].forEach((n, i) => image.writeBigUInt64LE(BigInt(n), i * 8));
  image.writeUInt32LE(0xffffffff, 0x58);
  image.writeUInt32LE(0xffffffff, 0x5c);
  image.writeUInt32LE(0xffffffff, 0x60);
  const directoryBytes = Buffer.alloc(2 * 0x310);
  ['/main', '/main.npdm'].forEach((name, i) => {
    directoryBytes.write(name.slice(1), i * 0x310);
    directoryBytes[i * 0x310 + 0x304] = 1;
    directoryBytes.writeBigUInt64LE(BigInt(i ? 0x80 : 0x100), i * 0x310 + 0x308);
  });
  const s = {
    base: 0x100000, bytes: bytes.length, handles,
    async write(address, value) { value.copy(bytes, address - this.base); },
    async close(handle) { handles.delete(handle); },
    async ipc(label, handle, command, input) {
      if (label === 'Game storage size') { const data = Buffer.alloc(8); data.writeBigUInt64LE(0x100n); return { result: 0, data }; }
      if (label === 'Read game directory') {
        const data = Buffer.alloc(8); data.writeBigUInt64LE(directoryReads.has(handle) ? 0n : 2n);
        directoryReads.add(handle); return { result: 0, data };
      }
      if (label === 'FTP pin source database') return { result: 0, handle: own() };
      if (label === 'FTP pin source version') return { result: 0, data: Buffer.alloc(16) };
      throw new Error('Unexpected IPC ' + label);
    },
  };
  const attachment = { s, root: 99, service: async () => 1,
    domain: {
      oneHandle(reply) { handles.add(reply.handle); return reply.handle; },
      async send(session, label) {
        if (label === 'Read selected NCA ProgramId') {
          const filename = bytes.subarray(0x2000, 0x2301).toString();
          const data = Buffer.alloc(8);
          data.writeBigUInt64LE(BigInt('0x' + (filename.includes('program-1') ? runtimeId : selectedTitle)));
          return { result: 0, data };
        }
        assert.equal(label, 'OpenDataStorageByPath');
        const filename = bytes.subarray(0x2000, 0x2301).toString();
        calls.push('storage:' + (filename.includes('program-1') ? 'program1' : filename.includes('dlc') ? 'dlc' : 'base'));
        return { result: 0, handle: own() };
      },
    },
    filesystem: {
      async pathMethod() { return { result: 0, handle: own() }; },
      async verifiedBytes() { return directoryBytes; },
      async readStorage(session, handle, offset, length) { return image.subarray(offset, offset + length); },
    },
  };
  // Track filenames independently: validation must read both executable headers.
  const files = new Map();
  attachment.filesystem.openFile = async (session, handle, filename) => {
    const opened = own(); files.set(opened, filename); return { result: 0, handle: opened };
  };
  attachment.filesystem.readFile = async (session, handle) => Buffer.from(badHeader ? 'FAIL' : files.get(handle) === '/main' ? 'NSO0' : 'META');
  const modulePath = require.resolve('../engine/mounts.cjs');
  delete require.cache[modulePath];
  const { prepareGame } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  return { calls, run: (options = {}) => prepareGame({ attachment, title: selectedTitle, ...options }) };
}

test('Switch 2 executable is validated before its RomFS and DLC mounts', async (t) => {
  const f = fixture(t);
  const prepared = await f.run();
  assert.ok(f.calls.indexOf('program1:exefs') < f.calls.indexOf('storage:program1'));
  assert.ok(f.calls.indexOf('storage:program1') < f.calls.indexOf('storage:dlc'));
  assert.ok(prepared.views.some((view) => view.path === '/switch2/updates/1114112/exefs'));
  assert.ok(f.calls.includes('verify:0,1'), 'both program indexes must be checked before FTP');
  const dlc = prepared.sources.find((source) => source.source.selection === 'dlc');
  assert.equal(dlc.kind, 2, 'ordinary DLC remains deferred');
});

test('CodeFS timeout aborts preparation before DLC or FTP verification', async (t) => {
  const failure = new Error('Console response timed out; restart the application');
  const f = fixture(t, { failure });
  await assert.rejects(f.run(), (error) => error === failure);
  assert.ok(!f.calls.includes('storage:program1'));
  assert.ok(!f.calls.includes('storage:dlc'));
  assert.ok(!f.calls.some((call) => call.startsWith('verify:')));
});

test('absent Program[1] permits ordinary game preparation', async (t) => {
  const f = fixture(t, { missingProgram: true });
  const prepared = await f.run();
  assert.ok(!prepared.views.some((view) => view.path.startsWith('/switch2/')));
  assert.ok(prepared.views.some((view) => view.path.startsWith('/dlc/')));
});

test('a failed installed CodeFS is not hidden by missing content on another storage', async (t) => {
  const f = fixture(t, { failure: resultError('Open selected game CodeFS', 0x408), secondStorageAbsent: true });
  await assert.rejects(f.run(), /Open selected game CodeFS/);
  assert.ok(!f.calls.some((call) => call.startsWith('verify:')));
});

test('invalid Switch 2 executable headers stop preparation', async (t) => {
  const f = fixture(t, { badHeader: true });
  await assert.rejects(f.run(), /invalid \/main header/);
  assert.ok(!f.calls.includes('storage:program1'));
});

test('Switch 1 NUP preparation does not attempt Switch 2 CodeFS', async (t) => {
  const f = fixture(t, { failure: new Error('Must not open Program[1]') });
  const prepared = await f.run({ images: true, edition: 'switch1' });
  assert.ok(!f.calls.includes('program1:exefs'));
  assert.ok(!prepared.views.some((view) => view.path.startsWith('/switch2/')));
});

test('native Switch 2 game-key-card title never opens the edition Program[1]', async (t) => {
  const f = fixture(t, { title: '0400e140216d4000',
    failure: Object.assign(new Error('Requires original content'), { code: 'GAME_ORIGINAL_CONTENT_REQUIRED' }) });
  const prepared = await f.run({ images: true });
  assert.ok(f.calls.includes('program0:romfs'));
  assert.ok(f.calls.includes('program0:exefs'));
  assert.ok(!f.calls.includes('program1:exefs'));
  assert.ok(!prepared.views.some((view) => view.path.startsWith('/switch2/')));
});

test('key-card icon fallback takes the whole control, NACP included, from its matching update', async (t) => {
  const cardTitle = '0400e140216d4000';
  const base = { name: 'Card name', nacp: Buffer.alloc(0x4000, 1), icon: null,
    source: { storage: 2, metaType: 0x80 } };
  const iconSource = { storage: 4, metaType: 0x81, selection: 'update' };
  const update = { name: 'Update name', nacp: Buffer.alloc(0x4000, 2),
    icon: Buffer.from('update icon'), source: iconSource, iconSource };
  const controls = [];
  const f = fixture(t, { title: cardTitle, readControl: async (attachment, title, storages, options) => {
    controls.push({ title, storages, options });
    return options?.update ? update : base;
  } });
  const prepared = await f.run({ images: true });
  assert.equal(prepared.control.nacp, update.nacp);
  assert.equal(prepared.control.name, update.name);
  assert.equal(prepared.control.icon, update.icon);
  assert.equal(prepared.control.iconSource, iconSource);
  assert.equal(prepared.updateControls['0400e140216d4800:' + patch.version], update);
  assert.equal(controls.length, 2, 'fallback control is reused for the update package');
  assert.deepEqual(controls[1], { title: cardTitle, storages: [4],
    options: { update: { contentTitle: '0400e140216d4800', version: patch.version } } });
});

test('update control is read even when the base has an icon', async (t) => {
  const base = { name: 'Base', icon: Buffer.from('base') };
  const update = { name: 'Update', icon: Buffer.from('update') };
  const f = fixture(t, { readControl: async (attachment, title, storages, options) => options?.update ? update : base });
  const prepared = await f.run({ images: true });
  assert.equal(prepared.control.name, base.name);
  assert.equal(prepared.control.icon, base.icon);
  assert.equal(prepared.updateControls[patch.contentTitle + ':' + patch.version], update);
});

test('missing base control uses the update NACP even when neither has an icon', async (t) => {
  const update = { name: 'Update', nacp: Buffer.alloc(0x4000, 2), icon: null };
  const f = fixture(t, { missingProgram: true,
    readControl: async (attachment, title, storages, options) => options?.update ? update : null });
  const prepared = await f.run({ images: true });
  assert.equal(prepared.control, update);
  assert.equal(prepared.updateControls[patch.contentTitle + ':' + patch.version], update);
});

test('an update without an icon preserves existing base control', async (t) => {
  const base = { name: 'Base', nacp: Buffer.alloc(0x4000, 1), icon: null };
  const update = { name: 'Update', nacp: Buffer.alloc(0x4000, 2), icon: null };
  const f = fixture(t, { missingProgram: true,
    readControl: async (attachment, title, storages, options) => options?.update ? update : base });
  const prepared = await f.run({ images: true });
  assert.equal(prepared.control, base);
  assert.equal(prepared.updateControls[patch.contentTitle + ':' + patch.version], update);
});

test('license preparation failure retains the mount, selected source and original FS error', async (t) => {
  const baseFailure = resultError('Open selected game CodeFS', 0x7d802);
  const licenseFailure = Object.assign(new Error('Requires original content'), {
    code: 'GAME_ORIGINAL_CONTENT_REQUIRED' });
  const f = fixture(t, { title: '0400e140216d4000', baseFailure, licenseFailure });
  await assert.rejects(f.run({ images: true }), (error) => {
    assert.equal(error, licenseFailure);
    assert.equal(error.mountPath, '/base/exefs');
    assert.equal(error.source.metaType, 0x80);
    assert.equal(error.source.contentPath, '@UserContent://program-0.nca');
    assert.equal(error.cause, baseFailure);
    assert.ok(!f.calls.some((call) => call.startsWith('verify:')));
    return true;
  });
});
