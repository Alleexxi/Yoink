const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readControl } = require('../engine/content.cjs');
const { resultError } = require('../engine/protocol.cjs');
const { collectDebugReport } = require('../engine/debug.cjs');

const title = '0100b7c00933a000';
const update = { contentTitle: '0100b7c00933a800', version: 327680 };

function fixture({ prefix = '', nativeFailure, transportFailure, iconFailure, nacpSize = 0x4000,
  rootEntries, controlProgramId = '0400b7c00933a000' } = {}) {
  const memory = Buffer.alloc(0x10000);
  const handles = new Set();
  const files = new Map();
  const directories = new Map();
  const calls = [];
  let next = 10;
  let controlIndex;
  const own = () => { const handle = next++; handles.add(handle); return handle; };
  const nacp = Buffer.alloc(0x4000);
  nacp.write('Pikmin 4 Switch 2 Edition');
  nacp.write('Nintendo', 0x200); nacp.write('2.0.0', 0x3060);
  const key = Buffer.alloc(16); key.writeUInt32LE(update.version, 8); key[12] = 0x81;
  const s = { base: 0x100000, handles,
    async close(handle) { handles.delete(handle); },
    async write(address, bytes) { bytes.copy(memory, address - this.base); },
    async readOwned(address, size) { return Buffer.from(memory.subarray(address - this.base, address - this.base + size)); },
    async ipc(label, handle, command, input, options) {
      calls.push({ label, command, input });
      if (label.startsWith('Read Control directory ')) {
        const directory = directories.get(handle);
        assert.ok(directory);
        const rows = directory.entries.slice(directory.offset, directory.offset + 32);
        directory.offset += rows.length;
        const bytes = Buffer.alloc(rows.length * 0x310);
        rows.forEach((row, i) => {
          bytes.write(row.name, i * 0x310);
          bytes[i * 0x310 + 0x304] = row.type || 0;
          bytes.writeBigUInt64LE(BigInt(row.size || 0), i * 0x310 + 0x308);
        });
        await this.write(options.receive[0].address, bytes);
        const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(rows.length));
        return { result: 0, data };
      }
      if (label === 'OpenContentMetaDatabase' || label === 'OpenContentStorage') return { result: 0, handle: own() };
      if (label === 'GetLatestContentMetaKey') return { result: 0, data: key };
      if (label === 'Verify selected update application') {
        const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt('0x' + title)); return { result: 0, data };
      }
      if (label === 'GetContentIdByType' || label === 'GetContentIdByTypeAndIdOffset') {
        if (nativeFailure === 'resolve') return { result: 0xa05 };
        controlIndex = input[1]; return { result: 0, data: Buffer.alloc(16, controlIndex + 1) };
      }
      if (label === 'Get installed Control content information') return { result: 0, data: Buffer.alloc(24) };
      throw new Error('Unexpected IPC ' + label);
    },
  };
  const a = { s, root: 99, service: async () => 1,
    domain: {
      oneHandle(reply) {
        if (reply.result || !reply.handle) throw new Error('Expected one moved session handle');
        return reply.handle;
      },
      async send(session, label, handle, wire) {
        if (label === 'Read Control NCA ProgramId' || label === 'Debug NCA ProgramId') {
          if (nativeFailure === 'identity') return { result: 0xa05 };
          const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt('0x' + controlProgramId));
          return { result: 0, data };
        }
        if (label === 'Resolve installed game path') {
          const bytes = Buffer.alloc(0x300); bytes.write('@Gc/control-' + controlIndex + '.nca');
          await s.write(s.base + 0x3000, bytes); return { result: 0 };
        }
        assert.equal(label, 'Open installed game control metadata');
        if (nativeFailure === 'open') return { result: 0x7d802 };
        const openProgramId = wire.readBigUInt64LE(40).toString(16).padStart(16, '0');
        calls.push({ label, openProgramId });
        if (openProgramId !== controlProgramId) return { result: 0xb3635e02 };
        return { result: 0, handle: own() };
      },
    },
    filesystem: {
      async pathMethod(session, control, command, filename, mode) {
        calls.push({ label: 'pathMethod', command, filename });
        if (command === 9) {
          assert.equal(mode.readUInt32LE(), 3);
          let entries;
          if (filename === '/' && rootEntries) entries = rootEntries;
          else if (filename === (prefix || '/')) entries = [
            { name: 'control.nacp', type: 1, size: BigInt(nacpSize) },
            { name: 'icon_AmericanEnglish.dat', type: 1, size: 12n },
          ];
          else return { result: 0x202 };
          const handle = own(); directories.set(handle, { entries, offset: 0 });
          return { result: 0, handle };
        }
        assert.equal(command, 8);
        assert.equal(mode.readUInt32LE(), 1);
        if (transportFailure) throw transportFailure;
        if (filename !== prefix + '/control.nacp' && filename !== prefix + '/icon_AmericanEnglish.dat') {
          return { result: 0x202 };
        }
        const handle = own(); files.set(handle, filename); return { result: 0, handle };
      },
      async fileSize() { return BigInt(nacpSize); },
      async readFile(session, handle, offset, length) {
        if (files.get(handle).endsWith('.nacp')) return nacp.subarray(offset, offset + length);
        if (iconFailure) throw resultError('Read icon', 0x7d802);
        return Buffer.from('edition icon').subarray(offset, offset + length);
      },
      async verifiedBytes(session, address, size) { return s.readOwned(address, size); },
      async listDirectory() { throw new Error('Expected one moved session handle'); },
      async openFile() { throw new Error('Expected one moved session handle'); },
    },
  };
  const diagnostics = [];
  return { diagnostics, handles, calls, attachment: a,
    run: (options = {}) => readControl(a, title, [2], { update, diagnostics, ...options }) };
}

test('Control diagnostics distinguish missing NCM content from an unopened filesystem', async () => {
  for (const [nativeFailure, stage, result] of [
    ['resolve', 'resolve Control NCA', 0xa05], ['open', 'open Control filesystem', 0x7d802],
  ]) {
    const f = fixture({ nativeFailure });
    assert.equal(await f.run(), null);
    assert.equal(f.diagnostics[0].status, 'error');
    assert.equal(f.diagnostics[0].stage, stage);
    assert.equal(f.diagnostics[0].error.nativeResult.canonical, result);
    assert.equal(f.handles.size, 0);
  }
});

test('Control opens use the NCA identity even when its NCM owner is the Switch 1 application', async () => {
  for (const controlProgramId of [title, '0400b7c00933a000']) {
    const f = fixture({ controlProgramId });
    // Run without inspection too: the normal dump must use the same fixed path.
    const control = await f.run();
    assert.equal(control.name, 'Pikmin 4 Switch 2 Edition');
    assert.equal(control.source.runtimeProgramId, controlProgramId);
    assert.equal(f.calls.find((call) => call.label === 'Open installed game control metadata').openProgramId, controlProgramId);
    assert.equal(f.diagnostics[0].openProgramId, controlProgramId);
    assert.equal(f.handles.size, 0);
  }
});

test('a failed NCA identity query preserves the owner-ID route and its diagnostic warning', async () => {
  const f = fixture({ nativeFailure: 'identity', controlProgramId: title });
  assert.equal((await f.run()).source.runtimeProgramId, undefined);
  assert.equal(f.diagnostics[0].openProgramId, title);
  assert.equal(f.diagnostics[0].warnings[0].stage, 'read Control NCA ProgramId');
  assert.equal(f.handles.size, 0);
});

test('failed root NACP still records edition directories and the resolved Control NCA', async () => {
  const f = fixture({ prefix: '/Acd_0', rootEntries: [{ name: 'Acd_0', type: 0, size: 0n }] });
  assert.equal(await f.run({ inspect: true }), null);
  const attempt = f.diagnostics[0];
  assert.equal(attempt.stage, 'open /control.nacp');
  assert.equal(attempt.source.contentPath, '@Gc/control-0.nca');
  assert.equal(attempt.runtimeProgramId, '0400b7c00933a000');
  assert.ok(attempt.directories.find((row) => row.path === '/Acd_0').entries.some((entry) => entry.name === 'control.nacp'));
  assert.ok(!attempt.directories.some((row) => row.path === '/Acd_1'), 'only listed edition directories are enumerated');
  assert.equal(f.handles.size, 0);
});

test('shared Acd_1 and separately indexed Control probes read names, versions and icon hashes', async () => {
  for (const options of [{ programIndex: 1 }, { programIndex: 1, controlIndex: 1, controlPrefix: '' }]) {
    const f = fixture({ prefix: options.controlPrefix ?? '/Acd_1' });
    const control = await f.run(options);
    assert.equal(control.name, 'Pikmin 4 Switch 2 Edition');
    assert.equal(control.version, '2.0.0');
    assert.equal(control.icon.toString(), 'edition icon');
    assert.equal(control.metadataPath, (options.controlPrefix ?? '/Acd_1') + '/control.nacp');
    assert.equal(f.diagnostics[0].control.metadataPath, control.metadataPath);
    assert.equal(f.diagnostics[0].control.iconSha256.length, 64);
    assert.equal(f.diagnostics[0].control.nacpSha256.length, 64);
    assert.equal(f.diagnostics[0].status, 'read');
    const lookup = f.calls.find((call) => call.label.startsWith('GetContentIdByType'));
    assert.equal(lookup.command, options.controlIndex ? 20 : 3);
    assert.equal(lookup.input[1], options.controlIndex || 0);
    assert.equal(f.handles.size, 0);
  }
});

test('an unreadable icon preserves the NACP and exposes the original error', async () => {
  const f = fixture({ iconFailure: true });
  const control = await f.run();
  assert.equal(control.name, 'Pikmin 4 Switch 2 Edition');
  assert.equal(control.icon, null);
  const warning = f.diagnostics[0].warnings[0];
  assert.equal(warning.stage, 'read /icon_AmericanEnglish.dat');
  assert.equal(warning.error.nativeResult.canonicalHex, '0x7d802');
  assert.equal(f.handles.size, 0);
});

test('undersized NACP is reported instead of being an unexplained null', async () => {
  const f = fixture({ nacpSize: 32 });
  assert.equal(await f.run(), null);
  assert.equal(f.diagnostics[0].status, 'invalid-nacp-size');
  assert.equal(f.diagnostics[0].nacpSize, 32);
  assert.equal(f.handles.size, 0);
});

test('transport failures propagate with diagnostic context and close all Control handles', async () => {
  const failure = new Error('Console response timed out');
  const f = fixture({ transportFailure: failure });
  await assert.rejects(f.run(), (error) => error === failure);
  assert.equal(f.diagnostics[0].stage, 'open /control.nacp');
  assert.equal(f.diagnostics[0].error.message, failure.message);
  assert.equal(f.handles.size, 0);
});

test('large Control directory listings have bounded report samples', async () => {
  const f = fixture({ rootEntries: Array.from({ length: 200 }, (_, i) => ({ name: 'file-' + i, size: 0n })) });
  await f.run({ inspect: true });
  const root = f.diagnostics[0].directories[0];
  assert.equal(root.total, 200);
  assert.equal(root.entries.length, 128);
  assert.equal(root.truncated, true);
  assert.equal(f.handles.size, 0);
});

test('missing optional Control files preserve the native result before moved-handle decoding', async () => {
  const f = fixture();
  assert.equal(await f.run({ programIndex: 1, inspect: true }), null);
  const attempt = f.diagnostics[0];
  assert.equal(attempt.stage, 'open /Acd_1/control.nacp');
  assert.equal(attempt.error.nativeResult.canonicalHex, '0x202');
  assert.ok(!f.calls.some((call) => call.command === 9 && call.filename !== '/'));
  assert.equal((await f.run()).name, 'Pikmin 4 Switch 2 Edition');
  assert.equal(f.handles.size, 0);
});

test('an edition directory disappearing after enumeration does not discard readable root metadata', async () => {
  const f = fixture({ rootEntries: [{ name: 'Acd_0', type: 0, size: 0n }] });
  assert.equal((await f.run({ inspect: true })).name, 'Pikmin 4 Switch 2 Edition');
  const attempt = f.diagnostics[0];
  assert.equal(attempt.status, 'read');
  assert.equal(attempt.directories.find((row) => row.path === '/Acd_0').error.nativeResult.canonicalHex, '0x202');
  assert.equal(f.handles.size, 0);
});

test('the reported ns2jb helper behavior cannot prevent debug from reaching update metadata', async () => {
  const f = fixture();
  let prepared = false;
  const report = await collectDebugReport({ attachment: f.attachment, title }, {
    buildInfo: async () => ({}),
    listApplicationContent: async () => [
      { id: title, version: 0, type: 0x80, storage: 2 },
      { id: update.contentTitle, version: update.version, type: 0x81, storage: 2 },
    ],
    discoverUpdates: async () => [{ ...update, storage: 2 }],
    async resolveProgramContent(options) {
      if (options.programIndex) throw resultError('GetContentIdByTypeAndIdOffset', 0xa05);
      return { contentPath: '@Gc/program.nca', attributes: 0, storage: 2 };
    },
    readControl,
    async prepareGame() {
      prepared = true;
      return { views: [], sources: [], control: null };
    },
  });
  assert.equal(report.diagnosticError, undefined);
  assert.equal(report.controlProbes.length, 8);
  assert.equal(report.controlProbes[0].status, 'read');
  assert.equal(report.controlProbes[1].error.nativeResult.canonicalHex, '0x202');
  assert.equal(report.updateControls[0].control.name, 'Pikmin 4 Switch 2 Edition');
  assert.equal(report.prepareStatus, 'complete');
  assert.equal(prepared, true);
  assert.equal(f.handles.size, 0);
});
