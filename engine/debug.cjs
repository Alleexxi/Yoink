const fs = require('node:fs/promises');
const path = require('node:path');
const content = require('./content.cjs');
const mounts = require('./mounts.cjs');
const { planPackages } = require('./nup.cjs');
const { success, pathRequest, throwIfCancelled } = require('./protocol.cjs');
const { storageNames, contentTypes, sha256, sourceDetails, errorDetails, controlSummary } = require('./diagnostics.cjs');

async function buildInfo() {
  const files = ['yoink.cjs', 'engine/content.cjs', 'engine/mounts.cjs', 'engine/nup.cjs',
    'engine/prepare-control.cjs', 'engine/debug.cjs', 'engine/diagnostics.cjs'];
  const sourceHashes = {};
  for (const file of files) sourceHashes[file] = sha256(await fs.readFile(path.join(__dirname, '..', file)));
  const overrides = {};
  for (const prefix of ['YOINK_', 'OZ_']) {
    for (const option of ['NO_SWITCH2', 'ALL_UPDATE_VERSIONS', 'SKIP_UPDATES', 'NO_DATA_PATCHES']) {
      if (process.env[prefix + option] !== undefined) overrides[prefix + option] = process.env[prefix + option];
    }
  }
  if (process.env.YOINK_FLATTEN_UNREAL_CHUNKS !== undefined) {
    overrides.YOINK_FLATTEN_UNREAL_CHUNKS = process.env.YOINK_FLATTEN_UNREAL_CHUNKS;
  }
  return { node: process.version, platform: process.platform, arch: process.arch, sourceHashes, overrides };
}

function layerDetails(view) {
  const files = view.entries.filter((entry) => entry.type === 'file');
  const markers = files.filter((entry) => entry.path === '/System/AoCUpgradeVersion.txt' ||
    entry.path === '/System/RegionLangMask.txt' || entry.path.includes('.Nin_Ounce') || /^\/__chunks(?:_\d+)?$/.test(entry.path));
  return {
    path: view.path, kind: view.kind, size: view.size,
    files: files.length, directories: view.entries.length - files.length,
    source: sourceDetails(view.source),
    fileSample: files.slice(0, 64).map((entry) => ({ path: entry.path, size: entry.size })),
    fileSampleTruncated: files.length > 64,
    enhancementMarkers: markers.slice(0, 64).map((entry) => ({ path: entry.path, size: entry.size })),
  };
}

// Collect independent metadata probes before game mounts, so an ExeFS/RomFS
// failure cannot hide the reason an edition's name or icon was unavailable.
async function collectDebugReport({ attachment: a, title, shouldStop = () => false, onStage = () => {} },
  services = { ...content, prepareGame: mounts.prepareGame, buildInfo }) {
  const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), title: title.toUpperCase(), build: await services.buildInfo(),
    installedContent: [], programs: [], controlProbes: [], updateControls: [], layers: [] };
  const partialViews = [];
  let stage;
  const enter = (value) => { throwIfCancelled(shouldStop); stage = value; onStage(value); };
  try {
    enter('Reading installed content');
    const installed = await services.listApplicationContent({ ...a, title });
    report.installedContent = installed.map((item) => ({
      id: item.id.toUpperCase(), version: item.version, type: contentTypes[item.type] || item.type,
      storageId: item.storage, storage: storageNames[item.storage] || item.storage, installType: item.installType,
    }));
    const updates = await services.discoverUpdates({ ...a, title });
    const candidates = installed.filter((item) => item.type === 0x80 && item.id.toLowerCase() === title)
      .map((item) => ({ storage: item.storage }));
    candidates.push(...updates.map((item) => ({ storage: item.storage,
      update: { contentTitle: item.contentTitle, version: item.version } })));
    // The resolver pins the latest key. Do not mislabel a latest resolution as a
    // historical version just because --probe listed an older installed key.
    const unique = [...new Map(candidates.map((candidate) => [
      candidate.storage + ':' + (candidate.update?.contentTitle || title) + ':' + (candidate.update?.version ?? 'base'), candidate,
    ])).values()];

    enter('Checking program 0 and program 1 identities');
    for (const candidate of unique) {
      for (const programIndex of [0, 1]) {
        throwIfCancelled(shouldStop);
        const probe = { ...candidate, programIndex };
        report.programs.push(probe);
        try {
          probe.stage = 'resolve Program NCA';
          const source = await services.resolveProgramContent({ ...a, title, ...candidate, programIndex });
          probe.source = sourceDetails(source);
          probe.stage = 'read NCA ProgramId';
          const filename = Buffer.alloc(0x301); filename.write(source.contentPath);
          await a.s.write(a.s.base + 0x2000, filename);
          const identity = success(await a.domain.send(a.s, 'Debug NCA ProgramId', a.root,
            pathRequest(618, Buffer.from([source.attributes]), a.s.base + 0x2000)), 'Debug NCA ProgramId');
          probe.runtimeProgramId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');
          probe.switch2 = probe.runtimeProgramId.startsWith('04');
          probe.status = 'read';
        } catch (error) {
          probe.status = 'error'; probe.error = errorDetails(error);
          if (!error.nativeResult) throw error;
        }
      }
    }

    enter('Inspecting Control content and edition metadata paths');
    for (const candidate of unique) {
      // Shared Control: root, /Acd_0 and /Acd_1. Also look for a separate
      // id_offset=1 Control NCA, without changing normal dump selection.
      for (const options of [
        { programIndex: 0, inspect: true },
        { programIndex: 0, controlPrefix: '/Acd_0' },
        { programIndex: 1 },
        { programIndex: 1, controlIndex: 1, controlPrefix: '', inspect: true },
      ]) {
        throwIfCancelled(shouldStop);
        const control = await services.readControl(a, title, [candidate.storage], {
          update: candidate.update, ...options, diagnostics: report.controlProbes, shouldStop,
        });
        if (candidate.update && options.programIndex === 0 && !options.controlPrefix) {
          report.updateControls.push({ contentTitle: candidate.update.contentTitle.toUpperCase(),
            version: candidate.update.version, storages: [storageNames[candidate.storage] || candidate.storage],
            control: controlSummary(control) });
        }
      }
    }

    enter('Preparing base, updates, editions and DLC');
    let prepared;
    try {
      prepared = await services.prepareGame({ attachment: a, title, images: true, edition: 'all', shouldStop,
        onView: (view) => { partialViews.push(view); } });
      report.prepareStatus = 'complete';
    } catch (error) {
      if (error.code === 'FTP_CANCELLED') throw error;
      report.prepareStatus = 'failed'; report.prepareError = errorDetails(error);
    }
    const views = prepared?.views || partialViews;
    report.layers = views.map(layerDetails);
    if (prepared) {
      report.control = controlSummary(prepared.control);
      if (report.control) report.control.switch2 = controlSummary(prepared.control.switch2);
      report.sources = prepared.sources.map((item) => ({
        kind: ['RomFS storage', 'CodeFS', 'deferred DLC'][item.kind] || item.kind,
        size: item.size, source: sourceDetails(item.source),
      }));
      try {
        report.switch2PackagePlan = planPackages(views, title, 'switch2').map((pack) => ({
          kind: ['base', 'update', 'addon', 'addon_update'][pack.kind] || pack.kind,
          plannedTitleId: pack.titleId, version: pack.version,
          exefsFiles: pack.exefsFiles.length,
          romfsLayers: pack.romfsLayers.map((layer) => ({ path: layer.ftpPath, files: layer.files.length })),
        }));
      } catch (error) {
        report.packagePlanError = errorDetails(error);
      }
    }
    const edition = views.filter((view) => view.path.startsWith('/switch2/') && view.path.endsWith('/exefs'))
      .sort((left, right) => right.source.version - left.source.version)[0];
    if (edition) {
      report.edition = { runtimeProgramId: edition.source.runtimeProgramId,
        programIndex: edition.source.programIndex || 0, source: sourceDetails(edition.source),
        metadata: !prepared ? 'preparation incomplete'
          : prepared.control?.switch2 ? 'edition Control' : prepared.control ? 'base metadata fallback' : 'unavailable' };
      const romfs = views.filter((view) => view.path.endsWith('/romfs'));
      const primary = edition.source.metaType === 0x81 && !edition.source.programIndex
        ? romfs.find((view) => view.path === path.posix.dirname(edition.path) + '/romfs')
        : romfs.find((view) => view.path === '/updates/' + edition.source.version + '/romfs') ||
          romfs.filter((view) => view.path.startsWith('/updates/')).sort((a, b) => b.source.version - a.source.version)[0] ||
          romfs.find((view) => view.path === '/base/romfs');
      if (primary) {
        const paths = new Set(primary.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path));
        report.edition.primaryRomfs = primary.path;
        for (const layer of report.layers.filter((item) => item.path.startsWith('/dlc/'))) {
          const view = views.find((item) => item.path === layer.path);
          layer.filesOverlappingPrimary = view.entries.filter((entry) => entry.type === 'file' && paths.has(entry.path)).length;
        }
      }
    }
  } catch (error) {
    if (error.code === 'FTP_CANCELLED') throw error;
    report.diagnosticError = { stage, ...errorDetails(error) };
    report.layers = partialViews.map(layerDetails);
  }
  return report;
}

module.exports = { collectDebugReport, buildInfo };
