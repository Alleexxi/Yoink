const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createProgramMounts } = require('../engine/program.cjs');
const { verifyProgramSnapshot } = require('../engine/content.cjs');
const { traceMethod } = require('../engine/session.cjs');

const title = '0100e95004038000';
const runtimeProgramId = '0400e95004038001';
const baseline = [{ programId: title, applicationId: title, programIndex: 0, flags: 0 }];
const source = {
  runtimeProgramId, contentTitle: '0100e95004038800', programIndex: 1,
  applicationTitle: title, selection: 'update', storage: 5, attributes: 2,
  contentPath: '@SdCardContent://selected-program-1.nca', version: 1114112,
  contentType: 1, metaType: 0x81, contentId: '12'.repeat(16),
};
const originalSource = { storage: 2, attributes: 1, contentPath: '@GcContent://base.nca' };

// Exercise the real selection and mapping code using an in-memory console and
// the same run-directory module boundary used by ns2jb. No live console calls.
async function consoleFixture(t, { rows = baseline, previous = null, failure, programIndex = 1,
  selectedProgramId = programIndex ? runtimeProgramId : title } = {}) {
  const selected = { ...source, programIndex, runtimeProgramId: selectedProgramId };
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'yoink-program-'));
  const engine = path.join(run, 'switch2');
  await fs.mkdir(path.join(engine, 'ro'), { recursive: true });
  await fs.mkdir(path.join(engine, 'tools'));
  await fs.writeFile(path.join(engine, 'ro/test-layout.json'), '{}');
  await fs.writeFile(path.join(engine, 'ro/test-loader-root-copy.json'), JSON.stringify({ copy: { handle: 500 } }));
  const memoryModule = path.join(engine, 'tools/fs-memory.cjs');
  await fs.writeFile(memoryModule, 'exports.connect = async () => exports.memory;');
  t.after(async () => { delete require.cache[memoryModule]; await fs.rm(run, { recursive: true, force: true }); });
  const state = { rows: structuredClone(rows), location: previous, calls: [], locations: [] };
  const memory = Buffer.alloc(0x80000);
  const s = {
    base: 0x100000, handles: new Set(),
    async write(address, bytes) { bytes.copy(memory, address - this.base); },
    async readOwned(address, size) { return Buffer.from(memory.subarray(address - this.base, address - this.base + size)); },
    async close(handle) { this.handles.delete(handle); },
    async ipc(label, handle, command, input = Buffer.alloc(0), options) {
      state.calls.push({ label, handle, command, input: Buffer.from(input) });
      if (label === 'Open registered patch resolver') return { result: 0, handle: 40 };
      if (label === 'Open original location resolver') return { result: 0, handle: 50 + input[0] };
      if (command === 810) {
        const bytes = await this.readOwned(options.send[0].address, options.send[0].size);
        // Preserve the console behavior documented in fs-context.cjs: zero is a no-op.
        if (!input.readInt32LE()) return { result: 0 };
        state.rows = Array.from({ length: input.readInt32LE() }, (_, i) => ({
          programId: bytes.readBigUInt64LE(i * 32).toString(16).padStart(16, '0'),
          applicationId: bytes.readBigUInt64LE(i * 32 + 8).toString(16).padStart(16, '0'),
          programIndex: bytes[i * 32 + 16], flags: bytes[i * 32 + 17],
        }));
        return { result: 0 };
      }
      if (label === 'Open selected game CodeFS') {
        state.openedRows = structuredClone(state.rows);
        // Model the reported game-card + installed-update failure. The NCA's
        // location and the loader's original-program storage are separate inputs.
        if (input[1] !== originalSource.storage) return { result: 0x97000408, data: Buffer.alloc(0) };
        if (failure) throw failure;
        return { result: 0, handle: 21 };
      }
      if (label === 'Remove owned patch location') { state.location = null; return { result: 0 }; }
      throw new Error('Unexpected IPC: ' + label);
    },
  };
  const domain = {
    wire: { control: () => Buffer.alloc(0) },
    oneHandle(reply) { s.handles.add(reply.handle); return reply.handle; },
    async send(session, label, handle, wire) {
      state.calls.push({ label, handle });
      if (label === 'Clone held loader root for game CodeFS') return { result: 0, handle: 20 };
      if (!programIndex && (handle === 52 || handle === 55)) {
        const location = handle === 52 ? originalSource : selected;
        await s.write(s.base + 0x3800, Buffer.from(location.contentPath + '\0'));
        const data = Buffer.alloc(16); data[0] = location.attributes;
        return { result: 0, data };
      }
      assert.equal(handle, 40, 'Program[1] must not resolve Program[0] through a storage resolver');
      const command = wire.readUInt32LE(24);
      if (command === 0) {
        if (!state.location) return { result: 0x408 };
        await s.write(s.base + 0x3800, Buffer.from(state.location.contentPath + '\0'));
        return { result: 0, data: Buffer.from(state.location.attributes, 'hex') };
      }
      assert.equal(command, 1);
      const bytes = await s.readOwned(s.base + 0x4000, 0x300);
      state.location = {
        contentPath: bytes.subarray(0, bytes.indexOf(0)).toString(),
        attributes: wire.subarray(48, 64).toString('hex'),
      };
      state.locations.push({ ...state.location });
      return { result: 0 };
    },
  };
  const head = 0x450;
  require(memoryModule).memory = {
    async write() { throw new Error('Unexpected direct console memory mutation'); },
    async pointer(address) {
      const pointers = new Map([[0x110, 0x200], [0x218, 0x300], [0x358, 0x400]]);
      assert.ok(pointers.has(address)); return pointers.get(address);
    },
    async read(address, size) {
      const bytes = Buffer.alloc(size);
      if (address === head) { bytes.writeBigUInt64LE(BigInt(state.rows.length ? 0x1000 : head), 8); return bytes; }
      const i = (address - 0x1000) / 0x100;
      const row = state.rows[i]; assert.ok(row);
      bytes.writeBigUInt64LE(BigInt(i + 1 < state.rows.length ? address + 0x100 : head), 8);
      bytes.writeBigUInt64LE(BigInt('0x' + row.programId), 0x10);
      bytes.writeBigUInt64LE(BigInt('0x' + row.applicationId), 0x18);
      bytes[0x20] = row.programIndex; bytes[0x21] = row.flags;
      return bytes;
    },
  };
  const attachment = { s, domain, service: async () => 2, root: 99, run, live: { session: 'test' }, proof: { rootAddress: 0x100 } };
  const open = () => createProgramMounts(attachment).openUpdate({ title, source: selected, originalSource, programIndex, section: 'exefs' });
  return { state, s, open };
}

test('Switch 2 CodeFS resolves the base storage while registering the selected update NCA', async (t) => {
  const f = await consoleFixture(t);
  assert.equal(await f.open(), 21);
  const code = f.state.calls.find((call) => call.label === 'Open selected game CodeFS');
  assert.equal(code.input[0], source.attributes);
  assert.equal(code.input[1], originalSource.storage);
  assert.equal(code.input.readBigUInt64LE(8), BigInt('0x' + runtimeProgramId));
  assert.equal(f.state.locations[0].contentPath, source.contentPath);
  assert.equal(Buffer.from(f.state.locations[0].attributes, 'hex')[0], source.attributes);
  const registered = f.state.calls.filter((call) => call.command === 810);
  assert.equal(registered.length, 2);
  assert.deepEqual(f.state.rows, baseline);
  assert.equal(f.state.location, null);
  assert.ok(!f.s.handles.has(40));
});

test('previous program location and map are restored on success and CodeFS timeout', async (t) => {
  const previous = { contentPath: '@UserContent://previous.nca', attributes: '03' + '00'.repeat(15) };
  for (const failure of [undefined, new Error('Console response timed out; restart the application')]) {
    const f = await consoleFixture(t, { previous, failure });
    if (failure) await assert.rejects(f.open(), (error) => error === failure);
    else await f.open();
    assert.deepEqual(f.state.location, previous);
    assert.deepEqual(f.state.rows, baseline);
    assert.ok(!f.s.handles.has(40));
  }
});

test('Program[0] retains base-storage composition and restores the previous registration', async (t) => {
  const previous = { contentPath: '@UserContent://previous-program-0.nca', attributes: '01' + '00'.repeat(15) };
  const f = await consoleFixture(t, { programIndex: 0, previous });
  await f.open();
  const code = f.state.calls.find((call) => call.label === 'Open selected game CodeFS');
  assert.equal(code.input[1], originalSource.storage);
  assert.equal(code.input[0], source.attributes);
  assert.equal(code.input.readBigUInt64LE(8), BigInt('0x' + title));
  assert.deepEqual(f.state.location, previous);
  assert.ok(!f.state.calls.some((call) => call.command === 810));
  for (const handle of [40, 52, 55]) assert.ok(!f.s.handles.has(handle));
});

test('a program 0 edition maps its 0400 runtime ID to index 0 and restores console state', async (t) => {
  const selectedProgramId = '0400e95004038000';
  const previous = { contentPath: '@GcContent://previous-program-0.nca', attributes: '01' + '00'.repeat(15) };
  for (const failure of [undefined, new Error('Console response timed out')]) {
    const f = await consoleFixture(t, { programIndex: 0, selectedProgramId, previous, failure });
    if (failure) await assert.rejects(f.open(), (error) => error === failure);
    else assert.equal(await f.open(), 21);
    const code = f.state.calls.find((call) => call.label === 'Open selected game CodeFS');
    assert.equal(code.input[1], originalSource.storage);
    assert.equal(code.input.readBigUInt64LE(8), BigInt('0x' + selectedProgramId));
    assert.deepEqual(f.state.openedRows, [...baseline,
      { programId: selectedProgramId, applicationId: title, programIndex: 0, flags: 0 }]);
    assert.deepEqual(f.state.rows, baseline);
    assert.deepEqual(f.state.location, previous);
    for (const handle of [40, 52, 55]) assert.ok(!f.s.handles.has(handle));
  }
});

test('a matching existing mapping is reused without resetting the global map', async (t) => {
  const f = await consoleFixture(t, { rows: [...baseline, { programId: runtimeProgramId, applicationId: title, programIndex: 1, flags: 0 }] });
  await f.open();
  assert.ok(!f.state.calls.some((call) => call.command === 810));
});

test('conflicting or unrestorable mappings fail before opening CodeFS', async (t) => {
  for (const rows of [[], [...baseline, { programId: runtimeProgramId, applicationId: title, programIndex: 0, flags: 0 }],
    [...baseline, { programId: runtimeProgramId, applicationId: '0100999900000000', programIndex: 1, flags: 0 }]]) {
    const f = await consoleFixture(t, { rows });
    await assert.rejects(f.open(), /mapping/);
    assert.ok(!f.state.calls.some((call) => call.command === 810 || call.label === 'Open selected game CodeFS'));
    assert.equal(f.state.location, null);
    assert.deepEqual(f.state.rows, rows);
  }
});

test('program snapshot checks Program[1] as well as Program[0]', async () => {
  const latestKey = Buffer.alloc(16);
  latestKey.writeUInt32LE(source.version, 8); latestKey[12] = source.metaType;
  const sources = [{ ...source, programIndex: 0, contentId: '34'.repeat(16) }, source];
  const calls = [];
  const s = { async ipc(label, handle, command, input) {
    calls.push([command, input[1]]);
    return { result: 0, data: Buffer.from(sources[input[1]].contentId, 'hex') };
  } };
  await verifyProgramSnapshot({ s, database: 1, latestKey, sources });
  assert.deepEqual(calls, [[3, 0], [20, 1]]);
  await assert.rejects(verifyProgramSnapshot({ s, database: 1, latestKey, sources: [{ ...source, version: 0 }] }), /version changed/);
  await assert.rejects(verifyProgramSnapshot({ s, database: 1, latestKey, sources: [{ ...source, contentId: 'ff'.repeat(16) }] }), /content changed at index 1/);
  await assert.rejects(verifyProgramSnapshot({ s, database: 1, latestKey,
    sources: [source, { ...source, contentId: 'ff'.repeat(16) }] }), /content changed at index 1/);
});

test('failed console calls retain the operation label without enabling trace', async () => {
  const failure = new Error('Console response timed out; restart the application');
  const target = { async ipc() { throw failure; } };
  traceMethod(target, 'ipc', (label) => 'ipc ' + label);
  await assert.rejects(target.ipc('Open selected game CodeFS'), (error) => error === failure &&
    error.message.includes('ipc Open selected game CodeFS: Console response timed out'));
});
