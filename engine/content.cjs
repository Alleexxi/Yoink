const { inflateRawSync } = require('node:zlib');
const { parseDlcMetadata } = require('./dlc.cjs');
const { sourceDetails, errorDetails, controlSummary } = require('./diagnostics.cjs');
const { success, idBytes, fixedOutput, pathRequest, resultError, withCleanup, closeHandles, throwIfCancelled } = require('./protocol.cjs');

// read nca content!

const inactive = new Set([0x21005, 0x20a05]);

async function readContentMeta(s, database, key) {
  const size = success(await s.ipc('Get DLC metadata size', database, 10, key), 'Get DLC metadata size').data.readUInt32LE();
  if (size < 8 || size > s.bytes - 0x6000) throw new Error('Invalid DLC metadata size');
  const address = s.base + 0x6000;
  success(await s.ipc('Read DLC metadata', database, 1, key, {
    receive: [{ address, size, mode: 0 }],
  }), 'Read DLC metadata');
  return s.readOwned(address, size);
}

async function discoverInstalled({ s, domain, service, title, metaType, kind }) {
  const label = metaType === 0x80 ? 'application' : metaType === 0x82 ? 'DLC' : metaType === 0x84 ? 'DLC update' : 'update';
  const ncm = await service('ncm');
  const records = [];

  for (const storage of [4, 5, 2]) {
    let database;

    try {
      await withCleanup(async () => {
        database = domain.oneHandle(
          success(
            await s.ipc('Open ' + label + ' metadata database', ncm, 5, Buffer.from([storage])),
            'OpenContentMetaDatabase',
          ),
        );

        const found = new Map();

        async function list(min, max) {
          const input = Buffer.alloc(32);
          input[0] = metaType;
          idBytes(title).copy(input, 8);
          input.writeBigUInt64LE(min, 16);
          input.writeBigUInt64LE(max, 24);

          const address = s.base + 0x6000;
          const capacity = 32;
          const size = capacity * 16;

          const reply = success(
            await s.ipc('List installed game ' + kind, database, 5, input, {
              receive: [{ address, size, mode: 0 }],
            }),
            'List installed game ' + kind,
          );

          const total = reply.data.readInt32LE();
          const count = reply.data.readInt32LE(4);

          const bytes = await s.readOwned(address, size);

          for (let i = 0; i < count; i++) {
            const key = bytes.subarray(i * 16, (i + 1) * 16);
            const id = key.readBigUInt64LE();

            const contentTitle = id.toString(16).padStart(16, '0');
            const version = key.readUInt32LE(8);

            if (!found.has(contentTitle) || version > found.get(contentTitle).version) {
              found.set(contentTitle, { contentTitle, version, storage, metaKey: Buffer.from(key) });
            }
          }

          if (total <= count) return;

          // properly handle a weirdly high amount of packages
          if (min === max) {
            const latest = success(
              await s.ipc(
                'Get latest installed ' + label,
                database,
                6,
                idBytes(min.toString(16).padStart(16, '0')),
              ),
              'GetLatestContentMetaKey',
            );

            const contentTitle = min.toString(16).padStart(16, '0');
            found.set(contentTitle, {
              contentTitle,
              version: latest.data.readUInt32LE(8),
              storage,
              metaKey: Buffer.from(latest.data.subarray(0, 16)),
            });
            return;
          }

          const mid = (min + max) / 2n;
          await list(min, mid);
          await list(mid + 1n, max);
        }

        await list(0n, 0xffffffffffffffffn);

        if (metaType === 0x82 || metaType === 0x84) {
          for (const item of found.values()) {
            const metadata = parseDlcMetadata(await readContentMeta(s, database, item.metaKey), metaType);
            if (metadata.owner !== title) found.delete(item.contentTitle);
            else Object.assign(item, metadata);
          }
        }

        records.push(...found.values());
      }, () => closeHandles(s, database ? [database] : []));
    } catch (error) {
      if (!inactive.has(error.nativeResult?.canonical)) throw error;
    }
  }

  records.sort(
    (a, b) => b.version - a.version || a.contentTitle.localeCompare(b.contentTitle) || a.storage - b.storage,
  );
  return records;
}

const META_TYPES = {
  0x80: 'Application', 0x81: 'Patch', 0x82: 'AddOnContent', 0x83: 'Delta', 0x84: 'DataPatch',
};

// every installed content meta key in an application's id group (base, patch, add-ons and their
// data patches, Switch 2 programs), whatever its type. --probe prints this
async function listApplicationContent({ s, domain, service, title }) {
  const ncm = await service('ncm');
  const group = BigInt('0x' + title) & 0x00ffffffffffe000n;
  const out = [];

  for (const storage of [4, 5, 2]) {
    let database;

    try {
      await withCleanup(async () => {
        database = domain.oneHandle(
          success(await s.ipc('Open content metadata database', ncm, 5, Buffer.from([storage])),
            'OpenContentMetaDatabase'),
        );

        async function list(min, max) {
          const input = Buffer.alloc(32);
          input[0] = 0; // ContentMetaType::Unknown matches every type
          input.writeBigUInt64LE(min, 16);
          input.writeBigUInt64LE(max, 24);

          const address = s.base + 0x6000;
          const capacity = 32;
          const reply = success(
            await s.ipc('List installed content', database, 5, input, {
              receive: [{ address, size: capacity * 16, mode: 0 }],
            }),
            'List installed content',
          );
          const total = reply.data.readInt32LE();
          const count = reply.data.readInt32LE(4);
          const bytes = await s.readOwned(address, capacity * 16);

          for (let i = 0; i < count; i++) {
            const key = bytes.subarray(i * 16, (i + 1) * 16);
            out.push({
              id: key.readBigUInt64LE().toString(16).padStart(16, '0'),
              version: key.readUInt32LE(8),
              type: key[12],
              typeName: META_TYPES[key[12]] || 'type 0x' + key[12].toString(16),
              installType: key[13],
              storage,
            });
          }

          if (total <= count || min === max) return;

          const mid = (min + max) / 2n;
          await list(min, mid);
          await list(mid + 1n, max);
        }

        for (const platform of [0x01n, 0x04n]) {
          const low = (platform << 56n) | group;
          await list(low, low | 0x1fffn);
        }
      }, () => closeHandles(s, database ? [database] : []));
    } catch (error) {
      if (!inactive.has(error.nativeResult?.canonical)) throw error;
    }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version || a.storage - b.storage);
}

const discoverDataPatches = (options) => discoverInstalled({ ...options, metaType: 0x84, kind: 'DLC updates' });

const discoverUpdates = (options) => discoverInstalled({ ...options, metaType: 0x81, kind: 'updates' });
const discoverDlc = (options) => discoverInstalled({ ...options, metaType: 0x82, kind: 'dlc' });
const discoverApplications = (options) =>
  discoverInstalled({ ...options, title: '0000000000000000', metaType: 0x80, kind: 'applications' });

// Resolve a pinned Program or DLC Data record without mounting its filesystem.



async function resolveContent({ s, root, domain, service, title, storage, update, dlc, contentType = 1, programIndex = 0 }) {
  const contentName = { 1: 'Program', 2: 'Data', 3: 'Control' }[contentType];

  const handles = [];
  const own = (reply) => {
    const h = domain.oneHandle(reply);
    handles.push(h);
    return h;
  };

  return withCleanup(async () => {
    const ncm = await service('ncm');
    const database = own(
      success(
        await s.ipc('OpenContentMetaDatabase', ncm, 5, Buffer.from([storage])),
        'OpenContentMetaDatabase',
      ),
    );
    const selected = dlc || update;
    const contentTitle = selected ? selected.contentTitle : title;
    const latest = dlc?.metaKey ? { data: dlc.metaKey } : success(
      await s.ipc('GetLatestContentMetaKey', database, 6, idBytes(contentTitle)),
      'GetLatestContentMetaKey',
    );
    const key = Buffer.from(latest.data.subarray(0, 16));
    if (update && key.readUInt32LE(8) !== update.version) {
      throw new Error('Selected update version changed; restart the dump');
    }

    if (dlc || update) {
      const owner = success(
        await s.ipc('Verify selected ' + (dlc ? 'DLC' : 'update') + ' application', database, 22, key),
        'GetOwnerApplicationId',
      );
      if (owner.data.readBigUInt64LE() !== BigInt('0x' + title)) {
        throw new Error('Selected ' + (dlc ? 'DLC' : 'update') + ' belongs to another application');
      }
    }

    const input = Buffer.alloc(24);
    input[0] = contentType;
    key.copy(input, 8);

    // Switch 2 Editions ship a second Program (id_offset 1, program id 04...) in the same package.
    // GetContentIdByTypeAndIdOffset / GetContentInfoByTypeAndIdOffset (20/25) take id_offset as a u8
    // right after the content type
    if (programIndex) input[1] = programIndex;

    const pinnedContent = dlc?.contents?.find((item) => item.contentType === contentType && item.programIndex === programIndex);
    if (dlc?.contents && !pinnedContent) throw new Error('DLC has no Data content at program index ' + programIndex);
    const content = pinnedContent ? { data: Buffer.from(pinnedContent.contentId, 'hex') } : programIndex
      ? success(await s.ipc('GetContentIdByTypeAndIdOffset', database, 20, input), 'GetContentIdByTypeAndIdOffset')
      : success(await s.ipc('GetContentIdByType', database, 3, input), 'GetContentIdByType');
    const contentId = Buffer.from(content.data.subarray(0, 16));

    const info = pinnedContent ? null : success(
      await s.ipc('Get installed ' + contentName + ' content information', database, programIndex ? 25 : 24, input),
      'Get installed ' + contentName + ' content information',
    ).data;

    const attributes = pinnedContent ? pinnedContent.attributes : info[21] & 15;
    const store = own(
      success(await s.ipc('OpenContentStorage', ncm, 4, Buffer.from([storage])), 'OpenContentStorage'),
    );
    const address = s.base + 0x3000;
    const size = 0x300;

    const resolved = await domain.send(
      s,
      'Resolve installed game path',
      store,
      fixedOutput(8, contentId, address, size),
    );
    success(resolved, 'Resolve installed game path');

    const bytes = await s.readOwned(address, size);
    const end = bytes.indexOf(0);

    const contentPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));

    const source = {
      route: 'ncm',
      storage,
      contentPath,
      attributes,
      contentType,
      contentId: contentId.toString('hex'),
      version: key.readUInt32LE(8),
      metaType: key[12],
    };

    if (update) {
      Object.assign(source, {
        selection: 'update',
        applicationTitle: title,
        contentTitle,
      });
    }

    if (programIndex) source.programIndex = programIndex;

    if (dlc) {
      Object.assign(source, {
        selection: 'dlc',
        applicationTitle: title,
        contentTitle,
        metaKey: key,
        programIndex,
        dataTitle: dlc.dataTitle,
        dataPatchTitle: dlc.dataPatchTitle,
      });
      if (root) {
        const filename = Buffer.alloc(0x301);
        filename.write(contentPath);
        await s.write(s.base + 0x2000, filename);
        const identity = success(await domain.send(s, 'Read DLC data ID', root,
          pathRequest(618, Buffer.from([attributes]), s.base + 0x2000)), 'Read DLC data ID');
        source.runtimeProgramId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');
      }
    }

    return source;
  }, () => closeHandles(s, handles));
}

const resolveProgramContent = (options) => resolveContent({ ...options, dlc: undefined, contentType: 1 });
const resolveControlContent = (options) =>
  resolveContent({ ...options, dlc: undefined, contentType: 3 });
const resolveDlcContent = (options) => {
  const content = options.dlc?.contents?.find((item) => item.contentType === 2 &&
    (options.programIndex === undefined || item.programIndex === options.programIndex));
  return resolveContent({ ...options, contentType: 2, programIndex: content?.programIndex ?? options.programIndex ?? 0 });
};

async function verifyProgramSnapshot({ s, database, latestKey, sources }) {
  const checked = new Map();
  for (const source of sources) {
    if (latestKey.readUInt32LE(8) !== source.version || latestKey[12] !== source.metaType) {
      throw new Error('Selected program version changed; restart the dump');
    }
    const index = source.programIndex || 0;
    const identity = source.contentType + ':' + index;
    if (!checked.has(identity)) {
      const input = Buffer.alloc(24);
      input[0] = source.contentType;
      input[1] = index;
      latestKey.copy(input, 8);
      const reply = success(await s.ipc('FTP verify selected program content', database, index ? 20 : 3, input),
        'FTP verify selected program content');
      checked.set(identity, reply.data.subarray(0, 16).toString('hex'));
    }
    if (checked.get(identity) !== source.contentId) {
      throw new Error('Selected program content changed at index ' + index + '; restart the dump');
    }
  }
}

async function findOriginalContent(options) {
  for (const storage of [4, 5, 2]) {
    try {
      return await resolveProgramContent({ ...options, storage, update: undefined });
    } catch (error) {
      const absent = new Set([0xe05, 0x21005, 0x20a05]); // collection of error codes for "we don't have this"
      if (!absent.has(error.nativeResult?.canonical)) throw error;
    }
  }

  throw new Error('No installed base Program content was found');
}

async function findOriginalAddOn(options) {
  const { addonTitle, storages = [4, 5, 2] } = options;
  const seen = new Set();

  for (const storage of storages) {
    if (seen.has(storage)) continue;
    seen.add(storage);

    try {
      return await resolveDlcContent({ ...options, storage, dlc: { contentTitle: addonTitle } });
    } catch (error) {
      const absent = new Set([0xe05, 0x21005, 0x20a05]);
      if (!absent.has(error.nativeResult?.canonical)) throw error;
    }
  }

  throw new Error('No installed base AddOnContent was found for ' + addonTitle.toUpperCase());
}

// handling for switch 2 editions, mainly. their switch 2 updates seem to have different title ids from their base apps
function isInstalledUpdate(title, source) {
  return (
    source.selection === 'update' &&
    source.applicationTitle === title &&
    source.metaType === 0x81 &&
    source.contentTitle !== title
  );
}

function programMatchesApplication(title, source, programId) {
  return (
    programId === title ||
    (isInstalledUpdate(title, source) && title.startsWith('01') && programId === '04' + title.slice(2))
  );
}

// display name grabbing for game select
const cleanName = (name) =>
  name
    .replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function applicationName(nacp) {

  const format = nacp[0x3215];
  let titles = nacp.subarray(0, 0x3000);

  if (format === 1) {
    const size = titles.readUInt16LE();
    titles = inflateRawSync(titles.subarray(2, 2 + size), { maxOutputLength: 32 * 0x300 });
  } else {
  }

  // english, then whatever else is on hand
  for (let i = 0; i < titles.length / 0x300; i++) {
    const bytes = titles.subarray(i * 0x300, i * 0x300 + 0x200);
    const end = bytes.indexOf(0);

    if (!end) continue;

    const name = cleanName(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)));

    if (name) return name;
  }

  return null;
}

function optionalName(bytes) {
  try { return applicationName(bytes); } catch { return null; }
}

const decodeString = (bytes) => {
  const end = bytes.indexOf(0);
  const slice = bytes.subarray(0, end < 0 ? bytes.length : end);
  try { return cleanName(new TextDecoder('utf-8', { fatal: true }).decode(slice)) || null; } catch { return null; }
};

// name + publisher from the same language entry, plus the display version (0x3060), out of a NACP
function controlDetails(nacp) {
  let name = null;
  let publisher = null;

  try {
    const format = nacp[0x3215];
    let titles = nacp.subarray(0, 0x3000);
    if (format === 1) {
      const size = titles.readUInt16LE();
      titles = inflateRawSync(titles.subarray(2, 2 + size), { maxOutputLength: 32 * 0x300 });
    }
    for (let i = 0; i < titles.length / 0x300; i++) {
      const candidate = decodeString(titles.subarray(i * 0x300, i * 0x300 + 0x200));
      if (candidate) {
        name = candidate;
        publisher = decodeString(titles.subarray(i * 0x300 + 0x200, i * 0x300 + 0x300));
        break;
      }
    }
  } catch {}

  let version = null;
  try { version = decodeString(nacp.subarray(0x3060, 0x3070)); } catch {}

  return { name, publisher, version };
}

// The run's high-level FS helpers can decode a moved handle before checking the
// result. Open optional Control paths through pathMethod so a missing path keeps
// its native error instead of becoming "Expected one moved session handle".
async function openControlPath({ s, domain, filesystem }, control, filename, directory = false) {
  const mode = Buffer.alloc(4);
  mode.writeUInt32LE(directory ? 3 : 1);
  const label = 'Open Control ' + (directory ? 'directory ' : 'file ') + filename;
  return domain.oneHandle(success(await filesystem.pathMethod(s, control, directory ? 9 : 8, filename, mode), label));
}

async function listControlDirectory(context, control, filename, shouldStop) {
  const { s, filesystem } = context;
  const directory = await openControlPath(context, control, filename, true);
  return withCleanup(async () => {
    const entries = [];
    const capacity = 32;
    for (;;) {
      throwIfCancelled(shouldStop);
      const address = s.base + 0x6000;
      const reply = success(await s.ipc('Read Control directory ' + filename, directory, 0, Buffer.alloc(0), {
        receive: [{ address, size: capacity * 0x310, mode: 0 }],
      }), 'Read Control directory ' + filename);
      const count = Number(reply.data.readBigUInt64LE());
      if (count > capacity) throw new Error('Invalid Control directory entry count: ' + count);
      if (!count) return entries;
      const bytes = await filesystem.verifiedBytes(s, address, count * 0x310, { directory: filename });
      if (bytes.length !== count * 0x310) throw new Error('Control directory read was short');
      for (let i = 0; i < count; i++) {
        const row = bytes.subarray(i * 0x310, (i + 1) * 0x310);
        const end = row.subarray(0, 0x301).indexOf(0);
        if (end < 0) throw new Error('Invalid Control directory filename');
        entries.push({ name: new TextDecoder('utf-8', { fatal: true }).decode(row.subarray(0, end)),
          type: row[0x304], size: Number(row.readBigUInt64LE(0x308)) });
      }
    }
  }, () => s.close(directory));
}

// a title's control content: the whole NACP (for the nup's TLV 0x0002) plus its name/publisher/
// version and the default icon. tries each storage until one answers
async function readControl({ s, root, domain, service, filesystem }, title, storages = [4, 5, 2],
  { update, programIndex = 0, controlIndex = 0, controlPrefix,
    diagnostics, inspect = false, shouldStop = () => false } = {}) {
  const seen = new Set();
  for (const storage of storages) {
    if (seen.has(storage)) continue;
    seen.add(storage);

    const handles = [];
    const prefix = controlPrefix ?? (programIndex ? '/Acd_' + programIndex : '');
    const attempt = diagnostics ? {
      storage, title, update, programIndex, controlIndex, prefix: prefix || '/', warnings: [],
    } : null;
    if (attempt) diagnostics.push(attempt);
    let stage = 'resolve Control NCA';
    const result = await withCleanup(async () => {
      try {
        throwIfCancelled(shouldStop);
        const source = await resolveControlContent({ s, domain, service, title, storage, update, programIndex: controlIndex });
        if (attempt) attempt.source = sourceDetails(source);
        const filename = Buffer.alloc(0x301);
        filename.write(source.contentPath);
        await s.write(s.base + 0x2000, filename);
        const input = Buffer.alloc(16);
        input[0] = source.attributes;
        input.writeUInt32LE(3, 4);
        idBytes(title).copy(input, 8);
        // The owner remains the 0100... application in NCM, but a program-0
        // edition's Control NCA can carry 0400.... FS checks the NCA identity
        // against this argument, so using the owner causes InvalidNcaId.
        stage = 'read Control NCA ProgramId';
        try {
          const identity = success(await domain.send(s, 'Read Control NCA ProgramId', root,
            pathRequest(618, Buffer.from([source.attributes]), s.base + 0x2000)), 'Read Control NCA ProgramId');
          source.runtimeProgramId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');
          idBytes(source.runtimeProgramId).copy(input, 8);
          if (attempt) attempt.runtimeProgramId = source.runtimeProgramId;
        } catch (error) {
          if (attempt) attempt.warnings.push({ stage, error: errorDetails(error) });
          if (!error.nativeResult) throw error;
          // Preserve the existing owner-ID route if this FS cannot read an NCA
          // identity. Debug keeps the identity failure as well as the open error.
        }
        if (attempt) { attempt.source = sourceDetails(source); attempt.openProgramId = input.readBigUInt64LE(8).toString(16).padStart(16, '0'); }
        stage = 'open Control filesystem';
        const opened = success(await domain.send(
          s, 'Open installed game control metadata', root, pathRequest(10, input, s.base + 0x2000),
        ), 'Open installed game control metadata');
        const control = domain.oneHandle(opened);
        handles.push(control);

        if (inspect && attempt) {
          stage = 'inspect Control directories';
          attempt.directories = [];
          const pending = ['/'];
          const seenDirectories = new Set();
          while (pending.length && seenDirectories.size < 12) {
            throwIfCancelled(shouldStop);
            const directory = pending.shift();
            if (seenDirectories.has(directory)) continue;
            seenDirectories.add(directory);
            const listing = { path: directory };
            attempt.directories.push(listing);
            try {
              const entries = await listControlDirectory({ s, domain, filesystem }, control, directory, shouldStop);
              listing.total = entries.length;
              listing.entries = entries.slice(0, 128).map((entry) => ({
                name: entry.name, type: entry.type, size: Number(entry.size || 0),
              }));
              listing.truncated = entries.length > 128;
              if (directory === '/') {
                for (const entry of entries) {
                  if (/^Acd_\d+$/.test(entry.name)) pending.push('/' + entry.name);
                }
              }
            } catch (error) {
              listing.error = errorDetails(error);
              if (!error.nativeResult) throw error;
            }
          }
        }

        // Edition metadata is inside the update's shared Control NCA, under /Acd_<program index>.
        stage = 'open ' + prefix + '/control.nacp';
        const nacpFile = await openControlPath({ s, domain, filesystem }, control, prefix + '/control.nacp');
        handles.push(nacpFile);
        stage = 'read ' + prefix + '/control.nacp';
        const nacpSize = Number(await filesystem.fileSize(s, nacpFile));
        if (attempt) attempt.nacpSize = nacpSize;
        if (nacpSize < 0x4000) {
          if (attempt) { attempt.status = 'invalid-nacp-size'; attempt.stage = stage; }
          return null;
        }
        const nacp = await filesystem.readFile(s, nacpFile, 0, 0x4000);
        if (nacp.length !== 0x4000) throw new Error('Control NACP read was short: ' + nacp.length + ' of 16384 bytes');
        if (attempt) {
          attempt.nacpHeaderHex = nacp.subarray(0, 0x40).toString('hex');
          attempt.titleFormat = nacp[0x3215];
        }

        let icon = null;
        try {
          stage = 'list icons in ' + (prefix || '/');
          const entries = await listControlDirectory({ s, domain, filesystem }, control, prefix || '/', shouldStop);
          if (attempt) attempt.icons = entries.filter((entry) => /^icon_.*\.dat$/i.test(entry.name))
            .slice(0, 128).map((entry) => ({ name: entry.name, size: Number(entry.size) }));
          const found = entries.find((entry) => /^icon_.*\.dat$/i.test(entry.name) && Number(entry.size) > 0);
          if (found) {
            const size = Number(found.size);
            if (size > 0 && size <= 4 * 1024 * 1024) {
              stage = 'read ' + prefix + '/' + found.name;
              if (attempt) attempt.iconPath = prefix + '/' + found.name;
              const iconFile = await openControlPath({ s, domain, filesystem }, control, prefix + '/' + found.name);
              handles.push(iconFile);
              const chunks = [];
              for (let at = 0; at < size; at += 0x40000) {
                chunks.push(await filesystem.readFile(s, iconFile, at, Math.min(0x40000, size - at)));
              }
              icon = Buffer.concat(chunks, size);
            }
          }
        } catch (error) {
          if (attempt) attempt.warnings.push({ stage, error: errorDetails(error) });
          if (!error.nativeResult) throw error;
        }

        const result = { nacp, icon, source, iconSource: icon ? source : null,
          metadataPath: prefix + '/control.nacp', ...controlDetails(nacp) };
        if (attempt) { attempt.status = 'read'; attempt.control = controlSummary(result); }
        return result;
      } catch (error) {
        if (attempt) { attempt.status = 'error'; attempt.stage = stage; attempt.error = errorDetails(error); }
        if (!error.nativeResult) throw error;
        return null;
      }
    }, () => closeHandles(s, handles));

    if (result) return result;
  }
  return null;
}

async function controlName(context, game) {
  const control = await readControl(context, game.title, game.storages);
  return control?.name || null;
}

// Check installed Program[1] by its NCA identity, without mounting any game filesystems.
// A second program alone is not enough: ordinary Switch games can also be multi-program.
// A Switch 2 Edition card may instead publish the Switch 2 program as program 0 of
// its card update, so check that too.
async function hasSwitch2Edition(context, game, updates) {
  if (!game.title.startsWith('01')) return false;

  const { s, root, domain, shouldStop = () => false } = context;
  const patchTitle = (BigInt('0x' + game.title) + 0x800n).toString(16).padStart(16, '0');
  const absent = (error) => [0xa05, 0xe05, ...inactive].includes(error.nativeResult?.canonical);
  const programId = async (candidate, programIndex) => {
    const source = await resolveProgramContent({ ...context, title: game.title, ...candidate, programIndex });
    const filename = Buffer.alloc(0x301);
    filename.write(source.contentPath);
    await s.write(s.base + 0x2000, filename);
    const identity = success(await domain.send(
      s, 'Check installed Switch 2 Edition', root,
      pathRequest(618, Buffer.from([source.attributes]), s.base + 0x2000),
    ), 'Check installed Switch 2 Edition');
    return identity.data.readBigUInt64LE().toString(16).padStart(16, '0');
  };

  const candidates = updates
    .filter((update) => update.contentTitle === patchTitle)
    .map((update) => ({ storage: update.storage, update }));
  candidates.push(...game.storages.map((storage) => ({ storage })));

  for (const candidate of candidates) {
    throwIfCancelled(shouldStop);
    try {
      if ((await programId(candidate, 1)).startsWith('04')) return true;
    } catch (error) {
      // ContentNotFound / ContentMetaNotFound, or an unavailable removable storage.
      if (absent(error)) continue;
      throw error;
    }
  }

  for (const update of updates) {
    if (update.contentTitle !== patchTitle || update.storage !== 2) continue;
    throwIfCancelled(shouldStop);
    try {
      if ((await programId({ storage: update.storage, update }, 0)).startsWith('04')) return true;
    } catch (error) {
      if (absent(error)) continue;
      throw error;
    }
  }

  return false;
}

async function discoverGames({ s, root, domain, service, filesystem, shouldStop = () => false }) {
  console.log("Getting games list..");
  const cancelled = () => throwIfCancelled(shouldStop);
  cancelled();

  const inventory = await discoverApplications({ s, domain, service });
  const byTitle = new Map();

  for (const item of inventory) {
    const title = item.contentTitle;

    if (!byTitle.has(title)) byTitle.set(title, { title, name: null, storages: [] });

    const game = byTitle.get(title);

    if (!game.storages.includes(item.storage)) game.storages.push(item.storage);
  }

  if (!byTitle.size) return [];

  cancelled();

  let control;

  await withCleanup(async () => {
    let ns;

    try {
      ns = await service('ns:ro');
    } catch (error) {
      if (!/0x615|service unavailable|service not found/i.test(error.message)) {
        throw error;
      }

      ns = await service('ns:am2');
    }

    const opened = await s.ipc('Open read-only application names', ns, 7989);

    if (opened.result) throw resultError('Open read-only application names', opened.result);

    control = domain.oneHandle(opened);

    const address = s.base + 0x10000;
    const size = 0x24000;

    for (const game of byTitle.values()) {
      cancelled();

      const input = Buffer.alloc(16);
      input[0] = 1;
      idBytes(game.title).copy(input, 8);

      const reply = await s.ipc('Read installed game name', control, 0, input, {
        receive: [{ address, size, mode: 0 }],
      });

      if (reply.result) continue;


      const nacp = await s.readOwned(address, 0x4000);

      game.name = optionalName(nacp);
    }
  }, () => closeHandles(s, control ? [control] : []));

  const games = [...byTitle.values()];
  cancelled();
  const updates = games.some((game) => game.title.startsWith('01'))
    ? await discoverUpdates({ s, domain, service, title: '0000000000000000' })
    : [];
  for (const game of games) {
    cancelled();
    game.switch2Edition = await hasSwitch2Edition({ s, root, domain, service, shouldStop }, game, updates);
    if (!game.name) {
      cancelled();
      game.name = await controlName({ s, root, domain, service, filesystem }, game);
    }
    game.storages.sort((a, b) => a - b);
  }

  games.sort(
    (a, b) =>
      Number(!a.name) - Number(!b.name) ||
      (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }) ||
      a.title.localeCompare(b.title),
  );
  return games;
}

module.exports = {
  discoverGames, discoverUpdates, discoverDlc, discoverDataPatches, listApplicationContent,
  resolveProgramContent, resolveDlcContent, findOriginalContent, findOriginalAddOn,
  isInstalledUpdate, programMatchesApplication, readControl, verifyProgramSnapshot,
};
