const assert = require('node:assert/strict');
const { test } = require('node:test');
const { collectDebugReport, buildInfo } = require('../engine/debug.cjs');
const { getArgs } = require('../yoink.cjs');
const { resultError } = require('../engine/protocol.cjs');

const title = '0100b7c00933a000';
const runtimeProgramId = '0400b7c00933a000';
const patch = { contentTitle: '0100b7c00933a800', version: 327680, storage: 2 };
const file = (path) => ({ path, type: 'file', size: 12 });

function fixture({ prepareFailure, controlFailure, cancelAfterIdentity = false } = {}) {
  const calls = [];
  let selected;
  let cancelled = false;
  const base = { storage: 2, metaType: 0x80, contentType: 1, version: 0, runtimeProgramId: title };
  const update = { ...base, ...patch, metaType: 0x81, runtimeProgramId };
  const views = [
    { path: '/base/romfs', source: base, entries: [file('/base-only.txt')] },
    { path: '/switch2/updates/327680/exefs', source: update, entries: [file('/main'), file('/main.npdm')] },
    { path: '/switch2/updates/327680/romfs', source: update, entries: [file('/shared.txt')] },
    { path: '/dlc/0100b7c00933b001/0/romfs', source: { ...base, contentTitle: '0100b7c00933b001', contentType: 2, metaType: 0x82 },
      entries: [file('/shared.txt'), file('/System/AoCUpgradeVersion.txt'), file('/aoc/data'), file('/aoc/extra')] },
  ];
  const control = { name: 'Pikmin 4', version: '1.0.0', nacp: Buffer.alloc(0x4000), icon: Buffer.from('base icon') };
  const attachment = {
    s: { base: 0x100000, async write() {} }, root: 99,
    domain: { async send() {
      const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt('0x' + selected.runtimeProgramId));
      if (cancelAfterIdentity) cancelled = true;
      return { result: 0, data };
    } },
  };
  const services = {
    async buildInfo() { return { node: process.version, sourceHashes: { 'yoink.cjs': 'test-build' } }; },
    async listApplicationContent() {
      return [{ id: title, version: 0, type: 0x80, storage: 2 },
        { id: patch.contentTitle, version: patch.version, type: 0x81, storage: 2 }];
    },
    async discoverUpdates() { return [patch]; },
    async resolveProgramContent(options) {
      calls.push({ operation: 'program', ...options });
      if (options.programIndex) throw resultError('GetContentIdByTypeAndIdOffset', 0xa05);
      selected = { ...(options.update ? update : base), attributes: 0, contentPath: '@Gc/program.nca' };
      return selected;
    },
    async readControl(a, id, storages, options) {
      calls.push({ operation: 'control', storages, ...options });
      options.diagnostics.push({ storage: storages[0], ...options,
        diagnostics: undefined, shouldStop: undefined, status: 'error', stage: 'resolve Control NCA' });
      if (controlFailure) throw controlFailure;
      return options.update ? null : control;
    },
    async prepareGame(options) {
      calls.push({ operation: 'prepare', ...options });
      for (const view of views) {
        options.onView(view);
        if (prepareFailure && view.path.endsWith('/exefs')) throw prepareFailure;
      }
      return { views, sources: [], control };
    },
  };
  return { calls, run: (options = {}) => collectDebugReport({ attachment, title, shouldStop: () => cancelled, ...options }, services) };
}

test('debug report identifies program 0 editions and probes shared and separate Control content', async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.programs.length, 4);
  assert.equal(report.programs.find((item) => item.update && item.programIndex === 0).runtimeProgramId, runtimeProgramId);
  assert.equal(report.programs.find((item) => item.programIndex === 1).error.nativeResult.canonicalHex, '0xa05');
  assert.equal(report.controlProbes.length, 8);
  const probes = f.calls.filter((item) => item.operation === 'control' && item.update);
  assert.ok(probes.some((item) => item.programIndex === 1 && !item.controlIndex));
  assert.ok(probes.some((item) => item.controlIndex === 1 && item.controlPrefix === ''));
  assert.ok(probes.some((item) => item.controlPrefix === '/Acd_0'));
  assert.equal(report.edition.metadata, 'base metadata fallback');
  assert.equal(report.edition.primaryRomfs, '/switch2/updates/327680/romfs');
  assert.equal(report.updateControls[0].control, null);
  assert.ok(report.switch2PackagePlan.some((pack) => pack.plannedTitleId === runtimeProgramId && pack.kind === 'base'));
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('Control diagnostics expose the exact add-on and save IDs without replacing them with runtime IDs', async () => {
  const { controlSummary } = require('../engine/diagnostics.cjs');
  const nacp = Buffer.alloc(0x4000);
  nacp.writeBigUInt64LE(BigInt('0x0100b7c00933b000'), 0x3070);
  nacp.writeBigUInt64LE(BigInt('0x' + title), 0x3078);
  const summary = controlSummary({ nacp, source: { runtimeProgramId } });
  assert.equal(summary.nacpIds.addOnContentBaseId, '0100b7c00933b000');
  assert.equal(summary.nacpIds.saveDataOwnerId, title);
  assert.equal(summary.source.runtimeProgramId, runtimeProgramId);
});

test('debug includes small DLC file lists, upgrade markers and primary-path overlap counts', async () => {
  const report = await fixture().run();
  const dlc = report.layers.find((layer) => layer.path.startsWith('/dlc/'));
  assert.equal(dlc.files, 4);
  assert.equal(dlc.fileSample.length, 4);
  assert.equal(dlc.fileSampleTruncated, false);
  assert.equal(dlc.enhancementMarkers[0].path, '/System/AoCUpgradeVersion.txt');
  assert.equal(dlc.filesOverlappingPrimary, 1);
});

test('a later mount failure preserves completed layer details and metadata probes', async () => {
  const error = Object.assign(resultError('Open edition RomFS', 0x7d802), { mountPath: '/switch2/updates/327680/romfs' });
  const report = await fixture({ prepareFailure: error }).run();
  assert.equal(report.prepareStatus, 'failed');
  assert.equal(report.prepareError.mountPath, error.mountPath);
  assert.equal(report.layers.length, 2);
  assert.equal(report.controlProbes.length, 8);
  assert.equal(report.edition.runtimeProgramId, runtimeProgramId);
  assert.equal(report.edition.metadata, 'preparation incomplete');
});

test('a Control transport failure returns partial diagnostics without attempting game mounts', async () => {
  const f = fixture({ controlFailure: new Error('Console response timed out') });
  const report = await f.run();
  assert.match(report.diagnosticError.stage, /Control/);
  assert.equal(report.diagnosticError.message, 'Console response timed out');
  assert.equal(report.programs.length, 4);
  assert.equal(report.controlProbes.length, 1);
  assert.ok(!f.calls.some((item) => item.operation === 'prepare'));
});

test('debug cancellation propagates instead of continuing with further probes', async () => {
  const f = fixture({ cancelAfterIdentity: true });
  await assert.rejects(f.run(), { code: 'FTP_CANCELLED' });
  assert.equal(f.calls.length, 1);
});

test('build fingerprints identify the exact packaged runtime files', async () => {
  const info = await buildInfo();
  assert.equal(info.node, process.version);
  assert.match(info.sourceHashes['engine/content.cjs'], /^[a-f0-9]{64}$/);
  assert.match(info.sourceHashes['engine/debug.cjs'], /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(info.sourceHashes).length, 7);
});

test('debug reports the explicit merge option rather than inheriting the former environment switch', async (t) => {
  const previous = process.env.YOINK_FLATTEN_UNREAL_CHUNKS;
  process.env.YOINK_FLATTEN_UNREAL_CHUNKS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YOINK_FLATTEN_UNREAL_CHUNKS;
    else process.env.YOINK_FLATTEN_UNREAL_CHUNKS = previous;
  });
  assert.equal((await buildInfo()).overrides.YOINK_FLATTEN_UNREAL_CHUNKS, undefined);
  assert.equal((await fixture().run()).packingOptions.mergeEditionDlc, true);
  assert.equal((await fixture().run()).packingOptions.mergeOptionSource, 'game default');
  assert.equal((await fixture().run({ mergeEditionDlc: false })).packingOptions.mergeEditionDlc, false);
  assert.equal((await fixture().run({ mergeEditionDlc: true })).packingOptions.mergeEditionDlc, true);
});

test('debug remains a separate CLI mode that rejects packing options', () => {
  const options = getArgs(['debug', title, '--merge-edition-dlc']);
  assert.equal(options.debug, true);
  assert.equal(options.title, title);
  assert.equal(options.mergeEditionDlc, true);
  for (const args of [['debug', '--nup', 'test.nup'], ['debug', '--probe'], ['debug', '--batch']]) {
    assert.throws(() => getArgs(args), /cannot be combined/);
  }
});
