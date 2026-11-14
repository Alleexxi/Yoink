const assert = require('node:assert/strict');
const { test } = require('node:test');
const { discoverGames } = require('../engine/content.cjs');

const title = '0100b7c00933a000';
const editionTitle = '0400b7c00933a000';
const patchTitle = '0100b7c00933a800';

// Exercise discovery and real NCM resolution, mocking only console IPC. No game
// filesystem should be opened just to determine the library's edition marker.
function fixture({ storage = 2, basePrograms = { 0: title }, updatePrograms = { 0: editionTitle },
  identityResult = 0, shouldStop = () => false } = {}) {
  const records = [
    { contentTitle: title, version: 0, metaType: 0x80, programs: basePrograms },
    { contentTitle: patchTitle, version: 327680, metaType: 0x81, programs: updatePrograms },
  ];
  const memory = Buffer.alloc(0x40000);
  const handles = new Map();
  const paths = new Map();
  const probes = [];
  let next = 10;
  let selected;
  const own = (value) => { const handle = next++; handles.set(handle, value); return handle; };
  const key = (row) => {
    const data = Buffer.alloc(16);
    data.writeBigUInt64LE(BigInt('0x' + row.contentTitle));
    data.writeUInt32LE(row.version, 8);
    data[12] = row.metaType;
    return data;
  };
  const s = {
    base: 0x100000, bytes: memory.length, handles,
    async close(handle) { handles.delete(handle); },
    async write(address, bytes) { bytes.copy(memory, address - this.base); },
    async readOwned(address, size) { return Buffer.from(memory.subarray(address - this.base, address - this.base + size)); },
    async ipc(label, handle, command, input, options) {
      if (label.startsWith('Open ') && label.endsWith('metadata database')) {
        return { result: 0, handle: own({ storage: input[0] }) };
      }
      if (label.startsWith('List installed game ')) {
        const rows = handles.get(handle).storage === storage ? records.filter((row) => row.metaType === input[0]) : [];
        const data = Buffer.alloc(8);
        data.writeInt32LE(rows.length); data.writeInt32LE(rows.length, 4);
        await this.write(options.receive[0].address, Buffer.concat(rows.map(key)));
        return { result: 0, data };
      }
      if (label === 'Open read-only application names') return { result: 0, handle: own({ names: true }) };
      if (label === 'Read installed game name') {
        const nacp = Buffer.alloc(0x4000);
        nacp.write('Pikmin 4');
        await this.write(options.receive[0].address, nacp);
        return { result: 0 };
      }
      if (label === 'OpenContentMetaDatabase' || label === 'OpenContentStorage') {
        return { result: 0, handle: own({ storage: input[0] }) };
      }
      if (label === 'GetLatestContentMetaKey') {
        const row = handles.get(handle).storage === storage &&
          records.find((item) => item.contentTitle === input.readBigUInt64LE().toString(16).padStart(16, '0'));
        if (!row) return { result: 0xe05 };
        return { result: 0, data: key(row) };
      }
      if (label === 'Verify selected update application') {
        const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt('0x' + title));
        return { result: 0, data };
      }
      if (label === 'GetContentIdByTypeAndIdOffset' || label === 'GetContentIdByType') {
        const row = records.find((item) => item.contentTitle === input.readBigUInt64LE(8).toString(16).padStart(16, '0'));
        const programIndex = input[1];
        probes.push({ title: row.contentTitle, programIndex });
        if (!row.programs[programIndex]) return { result: 0xa05 };
        selected = { ...row, programIndex, runtimeId: row.programs[programIndex] };
        return { result: 0, data: Buffer.alloc(16, 1) };
      }
      if (label === 'Get installed Program content information') return { result: 0, data: Buffer.alloc(24) };
      throw new Error('Unexpected IPC: ' + label);
    },
  };
  const context = { s, root: 99, service: async () => 1, shouldStop,
    domain: {
      oneHandle(reply) { return reply.handle; },
      async send(session, label) {
        if (label === 'Resolve installed game path') {
          const filename = '@Gc/' + selected.contentTitle + '-' + selected.programIndex + '.nca';
          paths.set(filename, selected.runtimeId);
          const bytes = Buffer.alloc(0x300); bytes.write(filename);
          await s.write(s.base + 0x3000, bytes);
          return { result: 0 };
        }
        assert.equal(label, 'Check installed Switch 2 Edition');
        if (identityResult) return { result: identityResult };
        const filename = memory.subarray(0x2000, 0x2301).toString().split('\0')[0];
        const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt('0x' + paths.get(filename)));
        return { result: 0, data };
      },
    },
  };
  return { handles, probes, run: () => discoverGames(context) };
}

test('discovery marks a physical edition whose only Switch 2 program is update program 0', async () => {
  const f = fixture();
  const [game] = await f.run();
  assert.deepEqual(game, { title, name: 'Pikmin 4', storages: [2], switch2Edition: true });
  assert.ok(f.probes.some((probe) => probe.title === patchTitle && probe.programIndex === 0));
  assert.equal(f.handles.size, 0);
});

test('an ordinary multi-program game does not get an edition marker', async () => {
  const f = fixture({ basePrograms: { 0: title, 1: '0100b7c00933a001' },
    updatePrograms: { 0: title, 1: '0100b7c00933a001' } });
  assert.equal((await f.run())[0].switch2Edition, false);
  assert.equal(f.handles.size, 0);
});

test('discovery still recognizes program 1 editions in updates or base content', async () => {
  for (const options of [
    { storage: 4, updatePrograms: { 0: title, 1: '0400b7c00933a001' } },
    { basePrograms: { 0: title, 1: '0400b7c00933a001' }, updatePrograms: { 0: title } },
  ]) {
    const f = fixture(options);
    assert.equal((await f.run())[0].switch2Edition, true);
    assert.equal(f.handles.size, 0);
  }
});

test('library scans avoid extra program 0 probes for non-card updates', async () => {
  const f = fixture({ storage: 4, updatePrograms: { 0: title } });
  assert.equal((await f.run())[0].switch2Edition, false);
  assert.ok(f.probes.every((probe) => probe.programIndex === 1));
  assert.equal(f.handles.size, 0);
});

test('discovery propagates identity errors and closes temporary NCM handles', async () => {
  const f = fixture({ identityResult: 0x408 });
  await assert.rejects(f.run(), (error) => error.nativeResult?.canonical === 0x408);
  assert.equal(f.handles.size, 0);
});

test('discovery honors cancellation before console work', async () => {
  const f = fixture({ shouldStop: () => true });
  await assert.rejects(f.run(), { code: 'FTP_CANCELLED' });
  assert.equal(f.probes.length, 0);
  assert.equal(f.handles.size, 0);
});
