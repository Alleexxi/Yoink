const path = require('node:path');
const { TextDecoder } = require('node:util');
const { success, pathRequest, idBytes, resultError, cleanup, withCleanup, closeHandles, throwIfCancelled } = require('./protocol.cjs');
const { discoverUpdates, discoverDlc, discoverDataPatches, resolveProgramContent, resolveDlcContent, programMatchesApplication, readControl, verifyProgramSnapshot } = require('./content.cjs');
const { createProgramMounts, prepareInstalledLicense } = require('./program.cjs');
const { matchingDlc, verifyDlcSnapshot } = require('./dlc.cjs');
const { prepareBaseProgram, validateProgramEntries } = require('./base-program.cjs');

// ncm mounts + metadata used for getting the ftp server ready

const MAX_CHUNK = 0x40000;
const safeSize = (n) => { // lol, ai put this in. in what situation would this ever happen
  return Number(n);
};

function createGameFiles(attachment) {
  const { openCode, openUpdate, openDataPatch } = createProgramMounts(attachment);
  let originalSource;
  const { s, root, domain, filesystem, service } = attachment;

  const send = async (label, handle, bytes) => success(await domain.send(s, label, handle, bytes), label);

  async function open({ title, storage, section = 'romfs', update, dlc, originalDlc, programIndex }) {
    let source;
    let mounted;

    try {
      source = await (dlc ? resolveDlcContent : resolveProgramContent)({
        s,
        root,
        domain,
        service,
        title,
        storage,
        update,
        dlc,
        programIndex,
      });

      const { contentPath, attributes } = source;
      const filename = Buffer.alloc(0x301);
      filename.write(contentPath);

      if (!dlc && (update || section === 'exefs')) {
        await s.write(s.base + 0x2000, filename);

        const identity = await send(
          'Read selected NCA ProgramId',
          root,
          pathRequest(618, Buffer.from([attributes]), s.base + 0x2000),
        );

        const runtimeId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');

        source.runtimeProgramId = runtimeId;
      }

      let handle;

      // Program[1] has its own RomFS NCA; only Program[0] needs the base + patch composition.
      if (update && !programIndex) {
        handle = await openUpdate({ title, storage, attributes, source, section, originalSource, programIndex });
      } else if (section === 'exefs' && programIndex) {
        // Program[1] has no base location in LR, so the loader can't see it (0x408) and FS refuses
        // to hand out a Code filesystem by path (2-6001). Register it through the same patch path the
        // update code uses, but mapped at program index 1, so the loader can resolve and open its code.
        handle = await openUpdate({ title, storage, attributes, source, section, originalSource, programIndex });
      } else if (section === 'exefs') {
        handle = await openCode({ title: source.runtimeProgramId, storage, attributes, source });
      } else if (source.metaType === 0x84) {
        if (originalDlc) {
          source.originalSource = await resolveDlcContent({ s, root, domain, service, title,
            storage: originalDlc.storage, dlc: originalDlc, programIndex: source.programIndex });
        }
        // add-on data patches (0x84) only store BKTR deltas over their add-on; combine them via lr + FS 202
        handle = await openDataPatch({ title, source });
      } else {
        // use type 1 for base romfs, type 6 for dlc
        await s.write(s.base + 0x2000, filename);

        const input = Buffer.alloc(8);
        input[0] = attributes;
        input.writeUInt32LE(dlc ? 6 : 1, 4);

        try {
          handle = domain.oneHandle(
            await send('OpenDataStorageByPath', root, pathRequest(206, input, s.base + 0x2000)),
          );
        } catch (error) {
          if (!dlc && error.nativeResult?.canonical === 0x7d202) error.code = 'GAME_ROMFS_ABSENT';

          throw error;
        }
      }

      mounted = {
        handle,
        kind: section === 'exefs' ? 'filesystem' : 'storage',
        source,
        title,
      };

      if (mounted.kind === 'storage') {
        const reply = success(await s.ipc('Game storage size', handle, 4), 'Game storage size');
        mounted.size = safeSize(reply.data.readBigUInt64LE());
      }

      if (!update && !dlc) originalSource = source;
      return mounted;
    } catch (error) {
      if (source) error.source = source;

      await cleanup([() => closeHandles(s, mounted ? [mounted.handle] : [])], error);
    }
  }

  async function list(mount, path, shouldStop) {

    const mode = Buffer.alloc(4);
    mode.writeUInt32LE(3);

    const handle = domain.oneHandle(
      success(await filesystem.pathMethod(s, mount.handle, 9, path, mode), 'Open game directory'),
    );
    const entries = [];

    try {
      for (;;) {
        if (shouldStop()) {
          throw Object.assign(new Error('FTP preparation cancelled'), { code: 'FTP_CANCELLED' });
        }

        const reply = success(
          await s.ipc('Read game directory', handle, 0, Buffer.alloc(0), {
            receive: [{ address: s.base + 0x6000, size: 32 * 0x310, mode: 0 }],
          }),
          'Read game directory',
        );
        const count = safeSize(reply.data.readBigUInt64LE());

        if (!count) return entries;

        const bytes = await filesystem.verifiedBytes(s, s.base + 0x6000, count * 0x310, { directory: path });

        for (let i = 0; i < count; i++) {
          const row = bytes.subarray(i * 0x310, (i + 1) * 0x310);
          const end = row.subarray(0, 0x301).indexOf(0);

          const name = row.subarray(0, end).toString('utf8');
          const type = row[0x304];
          entries.push({
            name,
            type: type === 1 ? 'file' : 'directory',
            size: safeSize(row.readBigUInt64LE(0x308)),
          });
        }
      }
    } finally {
      await s.close(handle);
    }
  }

  async function read(mount, offset, length) {

    const bytes = length ? await filesystem.readStorage(s, mount.handle, offset, length) : Buffer.alloc(0);
    return bytes;
  }

  async function close(mount) {
    await s.close(mount.handle);
  }

  return {
    open,
    list,
    read,
    close,
  };
}

// pc side romfs metadata reader. used for getting the file list together

const utf8 = new TextDecoder('utf-8', { fatal: true });
const NONE = 0xffffffff;
const MAX_METADATA = 64 * 1024 * 1024;

function checkRomfs(ok, why) {
  if (!ok) throw new Error('Invalid RomFS: ' + why);
}

function integer(value) {
  checkRomfs(value <= BigInt(Number.MAX_SAFE_INTEGER), 'offset exceeds numeric precision');
  return Number(value);
}

function name(bytes, root = false) {
  const value = utf8.decode(bytes);
  checkRomfs((root || value.length > 0) && !/[\/\\\0]/.test(value) && !['.', '..'].includes(value), 'entry name');
  return value;
}

async function readRomfs(read, storageSize) {
  checkRomfs(Number.isSafeInteger(storageSize) && storageSize >= 0x50, 'storage size');

  async function exact(offset, length) {
    checkRomfs(
      Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= storageSize,
      'range',
    );

    const parts = [];

    for (let at = 0; at < length; at += 0x40000) {
      const n = Math.min(0x40000, length - at);
      const part = await read(offset + at, n);
      parts.push(part);
    }

    return Buffer.concat(parts);
  }

  const header = await exact(0, 0x50);
  const first = header.readBigUInt64LE();
  if (first !== 0x50n) {
    const details = 'storageSize=' + storageSize + ' firstU64=0x' + first.toString(16) +
      ' first16hex=' + header.subarray(0, 16).toString('hex');
    // The diagnostic from affected cards only established a zero-filled prefix,
    // not a zero-filled 0x50-byte header. Later bytes can belong to another layer.
    const zeroPrefix = header.subarray(0, 16).every((byte) => byte === 0);
    throw Object.assign(new Error('Invalid RomFS: header size (' + details + ')'), {
      code: zeroPrefix ? 'GAME_ROMFS_ZERO_HEADER' : 'GAME_ROMFS_INVALID_HEADER',
    });
  }
  const h = Array.from({ length: 10 }, (_, i) => integer(header.readBigUInt64LE(i * 8)));

  const ranges = [];

  for (let i = 1; i < 9; i += 2) {
    checkRomfs(
      h[i] >= 0x50 &&
        h[i + 1] <= MAX_METADATA &&
        Number.isSafeInteger(h[i] + h[i + 1]) &&
        h[i] + h[i + 1] <= storageSize,
      'metadata extent',
    );
    ranges.push([h[i], h[i] + h[i + 1]]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  checkRomfs(
    ranges.every((r, i) => !i || r[0] >= ranges[i - 1][1]),
    'overlapping metadata',
  );
  checkRomfs(h[4] >= 24 && h[4] + h[8] <= MAX_METADATA && h[9] >= 0x50 && h[9] <= storageSize, 'metadata budget');

  const dirs = await exact(h[3], h[4]);
  const files = await exact(h[7], h[8]);

  const dirSlots = new Uint8Array(Math.ceil(dirs.length / 4));
  const fileSlots = new Uint8Array(Math.ceil(files.length / 4));

  function entry(table, offset, fixed, root = false) {
    checkRomfs(offset % 4 === 0 && offset + fixed <= table.length, 'entry offset');

    const n = table.readUInt32LE(offset + fixed - 4);
    checkRomfs(n <= 0x300 && offset + fixed + n <= table.length, 'entry length');

    // make sure our offsets for reading point to the *start* of each entry and not somewhere inside one
    const slots = table === dirs ? dirSlots : fileSlots;
    const first = offset / 4;
    const end = Math.ceil((offset + fixed + n) / 4);
    checkRomfs(slots[first] !== 2, 'overlapping entries');

    if (slots[first] !== 1) {
      for (let i = first; i < end; i++) {
        checkRomfs(!slots[i], 'overlapping entries');
      }

      slots.fill(2, first, end);
      slots[first] = 1;
    }

    return {
      name: name(table.subarray(offset + fixed, offset + fixed + n), root),
      bytes: table.subarray(offset, offset + fixed),
    };
  }

  const output = [];
  const stack = [{ offset: 0, path: '/', parent: 0 }];
  const seenDirs = new Set([0]);
  const seenFiles = new Set();

  while (stack.length) {
    const dir = stack.pop();
    const current = entry(dirs, dir.offset, 24, dir.offset === 0);

    if (dir.offset) checkRomfs(current.bytes.readUInt32LE() === dir.parent, 'directory parent');

    let child = current.bytes.readUInt32LE(8);
    let file = current.bytes.readUInt32LE(12);

    while (child !== NONE) {
      checkRomfs(!seenDirs.has(child), 'directory cycle or duplicate');
      seenDirs.add(child);

      const e = entry(dirs, child, 24);
      const childPath = dir.path.replace(/\/$/, '') + '/' + e.name;
      output.push({ path: childPath, type: 'directory', size: 0 });
      stack.push({ offset: child, path: childPath, parent: dir.offset });
      child = e.bytes.readUInt32LE(4);
    }

    while (file !== NONE) {
      checkRomfs(!seenFiles.has(file), 'file cycle or duplicate');
      seenFiles.add(file);

      const e = entry(files, file, 32);
      checkRomfs(e.bytes.readUInt32LE() === dir.offset, 'file parent');

      const relative = integer(e.bytes.readBigUInt64LE(8));
      const size = integer(e.bytes.readBigUInt64LE(16));
      const offset = h[9] + relative;
      checkRomfs(Number.isSafeInteger(offset + size) && offset + size <= storageSize, 'file extent');
      checkRomfs(
        !size || ranges.every(([start, end]) => offset + size <= start || offset >= end),
        'file overlaps metadata',
      );
      output.push({ path: dir.path.replace(/\/$/, '') + '/' + e.name, type: 'file', size, offset });
      file = e.bytes.readUInt32LE(4);
    }
  }

  return output;
}

const MAGIC = Buffer.from('NS2FTPIX');
const HEADER = 64;
const STRIDE = 48;
const checkIndex = (ok, why) => {
  if (!ok) throw new Error('Invalid FTP index: ' + why);
};

// images: also expose every romfs as one big file (<prefix>/romfs.img) so it can be pulled in one go
function buildIndex(views, { images = false } = {}) {
  const nodes = [{ path: '/', name: '', parent: 0, type: 'directory', children: [] }];
  const byPath = new Map([['/', 0]]);
  const entries = new Set();

  function addDirectory(filename) {
    if (byPath.has(filename)) {
      checkIndex(nodes[byPath.get(filename)].type === 'directory', 'file/directory collision');
      return byPath.get(filename);
    }

    const parent = addDirectory(path.posix.dirname(filename));
    const id = nodes.length;
    const node = {
      path: filename,
      name: path.posix.basename(filename),
      parent,
      type: 'directory',
      children: [],
    };
    nodes.push(node);
    byPath.set(filename, id);
    nodes[parent].children.push(id);
    return id;
  }

  const strings = [];
  const stringsByValue = new Map();
  let stringBytes = 0;

  function string(value) {
    checkIndex(!/[\0\r\n]/.test(value), 'control character in a name');

    if (stringsByValue.has(value)) return stringsByValue.get(value);

    const bytes = Buffer.from(value + '\0');
    const offset = stringBytes;
    stringBytes += bytes.length;
    strings.push(bytes);
    stringsByValue.set(value, offset);
    return offset;
  }

  for (const view of views) {
    const prefix = view.path;

    if (view.kind === 'deferred-storage') {
      checkIndex(view.source.contentPath.startsWith('@'), 'deferred Data content path');
    }

    addDirectory(prefix);

    for (const item of view.entries) {
      const filename = prefix + item.path;
      checkIndex(!entries.has(filename), 'duplicate path');
      entries.add(filename);

      if (view.kind === 'filesystem') checkIndex(Buffer.byteLength(item.path) <= 0x300, 'CodeFS path is too long');

      checkIndex(Buffer.byteLength(filename) <= 1023 && !/[\r\n]/.test(filename), 'FTP path length or character');

      if (item.type === 'directory') {
        addDirectory(filename);
        continue;
      }

      checkIndex(!byPath.has(filename), 'file/directory collision');

      const parent = addDirectory(path.posix.dirname(filename));
      const id = nodes.length;
      nodes.push({
        path: filename,
        name: path.posix.basename(filename),
        parent,
        type: 'file',
        mount: view.mount,
        offset: item.offset || 0,
        size: item.size,
        sourcePath:
          view.kind === 'filesystem'
            ? item.path
            : view.kind === 'deferred-storage'
              ? view.source.contentPath
              : '',
      });
      byPath.set(filename, id);
      nodes[parent].children.push(id);
    }

    if (images && view.kind !== 'filesystem') {
      const filename = prefix + '.img';
      checkIndex(!byPath.has(filename), 'image path collision');
      const parent = byPath.get(path.posix.dirname(filename));
      const id = nodes.length;
      nodes.push({
        path: filename,
        name: path.posix.basename(filename),
        parent,
        type: 'file',
        mount: view.mount,
        offset: 0,
        size: view.size,
        sourcePath: view.kind === 'deferred-storage' ? view.source.contentPath : '',
      });
      byPath.set(filename, id);
      nodes[parent].children.push(id);
    }
  }

  for (const node of nodes) {
    node.nameOffset = string(node.name);
    node.sourceOffset = string(node.sourcePath || '');
    node.children?.forEach((id, index) => {
      nodes[id].next = node.children[index + 1] ?? NONE;
    });
  }

  const stringOffset = HEADER + nodes.length * STRIDE;
  const length = stringOffset + stringBytes;
  checkIndex(length <= 0xffffffff, 'index exceeds format precision');

  const bytes = Buffer.alloc(length);
  MAGIC.copy(bytes);
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(STRIDE, 12);

  for (const [at, value] of [
    [16, nodes.length],
    [24, HEADER],
    [32, stringOffset],
    [40, stringBytes],
    [48, length],
  ]) {
    bytes.writeBigUInt64LE(BigInt(value), at);
  }

  nodes.forEach((node, id) => {
    const at = HEADER + id * STRIDE;
    bytes.writeUInt32LE(node.parent, at);
    bytes.writeUInt32LE(node.children?.[0] ?? NONE, at + 4);
    bytes.writeUInt32LE(node.next ?? NONE, at + 8);
    bytes.writeUInt32LE(node.type === 'file' ? 1 : 0, at + 12);
    bytes.writeUInt32LE(node.nameOffset, at + 16);
    bytes.writeUInt32LE(Buffer.byteLength(node.name), at + 20);
    bytes.writeUInt32LE(node.mount || 0, at + 24);
    bytes.writeUInt32LE(node.sourceOffset, at + 28);
    bytes.writeBigUInt64LE(BigInt(node.offset || 0), at + 32);
    bytes.writeBigUInt64LE(BigInt(node.size || 0), at + 40);
  });
  Buffer.concat(strings, stringBytes).copy(bytes, stringOffset);
  return bytes;
}

async function prepareGame({ attachment: a, title, images = false, edition = 'all', shouldStop = () => false }) {
  const views = [];
  const sources = [];
  const absentSources = [];
  const prepared = new Set();
  const files = createGameFiles(a);
  const cancelled = () => throwIfCancelled(shouldStop);
  const readCodeHeader = async (mount, filename, length) => {
    cancelled();
    const opened = success(await a.filesystem.openFile(a.s, mount.handle, filename), 'Read composed program header');
    return withCleanup(() => a.filesystem.readFile(a.s, opened.handle, 0, length), () => a.s.close(opened.handle));
  };

  async function open(options) {
    cancelled();

    try {
      return await files.open({ title, ...options });
    } catch (error) {
      if (
        error.nativeResult?.canonical !== 0x7d802 ||
        prepared.has(error.source?.contentPath)
      )
        throw error;

      prepared.add(error.source.contentPath);
      try {
        await prepareInstalledLicense({ ...a, title, source: error.source });
      } catch (licenseError) {
        licenseError.source ||= error.source;
        licenseError.cause ||= error;
        throw licenseError;
      }
      cancelled();
      return files.open({ title, ...options });
    }
  }

  async function filesystemEntries(mount) {
    const pending = ['/'];
    const entries = [];

    while (pending.length) {
      const filename = pending.pop();
      cancelled();

      for (const item of await files.list(mount, filename, shouldStop)) {
        const entry = {
          path: filename.replace(/\/$/, '') + '/' + item.name,
          type: item.type,
          size: item.size,
        };
        entries.push(entry);

        if (entry.type === 'directory') pending.push(entry.path);
      }
    }

    return entries;
  }

  async function mountView(prefix, section, candidates, allowAbsent = false) {
    const started = Date.now();
    if (process.env.YOINK_TRACE || process.env.OZ_TRACE) {
      console.log('  [trace] Before ' + prefix + '/' + section + ': ' +
        sources.filter((source) => source.kind === 0).length + ' retained storages, ' +
        sources.filter((source) => source.kind === 1).length + ' retained CodeFS, ' +
        sources.filter((source) => source.kind === 2).length + ' deferred DLC, ' +
        a.s.handles.size + ' tracked handles');
    }
    try {
      return await mountViewTimed(prefix, section, candidates, allowAbsent);
    } catch (error) {
      error.mountPath ||= prefix + '/' + section;
      throw error;
    } finally {
      if (process.env.YOINK_TRACE || process.env.OZ_TRACE) console.log('  [trace] ' + prefix + '/' + section + ' took ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
    }
  }

  async function mountViewTimed(prefix, section, candidates, allowAbsent) {
    if (prefix.startsWith('/updates/')) {
      console.log('Opening ' + prefix + '/' + section, ' (This takes a LOT of time! Don\'t assume we crashed!)');
    } else {
      console.log('Opening ' + prefix + '/' + section);
    }
    let mounted;
    let lastError;

    for (const candidate of candidates) {
      try {
        mounted = await open({ section, ...candidate });
        break;
      } catch (error) {
        if (!error.nativeResult || error.code === 'FTP_CANCELLED') throw error;

        if (
          allowAbsent &&
          error.code === 'GAME_ROMFS_ABSENT' &&
          error.source.metaType === 0x80 &&
          !error.source.selection
        ) {
          absentSources.push(error.source);
          return { source: error.source };
        }

        if (!lastError || error.source || !lastError.source) lastError = error;
      }
    }

    if (!mounted)
      throw Object.assign(new Error(
        'Could not prepare ' + prefix + '/' + section + ': ' + (lastError?.message || 'No installed content'),
        { cause: lastError },
      ), { nativeResult: lastError?.nativeResult, source: lastError?.source });

    let entries;
    try {
      entries =
        mounted.kind === 'storage'
          ? await readRomfs((offset, length) => {
              cancelled();
              return files.read(mounted, offset, length);
            }, mounted.size)
          : await filesystemEntries(mounted);
    } catch (error) {
      error.source = mounted.source;
      if (error.code === 'GAME_ROMFS_ZERO_HEADER' || error.code === 'GAME_ROMFS_INVALID_HEADER') {
        error.message += ' [title=' + title + ' storage=' + mounted.source.storage +
          ' version=' + mounted.source.version + ' NCA=' + mounted.source.contentPath + ']';
      }
      await cleanup([() => files.close(mounted)], error);
    }
    const mount = sources.length;
    // data patches stay open as a composed storage handle; native FTP can't reopen BKTR patches by single path
    const deferred = mounted.source.selection === 'dlc' && mounted.source.metaType !== 0x84;

    if (deferred) await files.close(mounted);

    sources.push({
      handle: deferred ? a.root : mounted.handle,
      kind: deferred ? 2 : mounted.kind === 'storage' ? 0 : 1,
      attributes: deferred ? mounted.source.attributes : undefined,
      size: mounted.size || 0,
      source: mounted.source,
    });
    views.push({
      path: prefix + '/' + section,
      mount,
      kind: deferred ? 'deferred-storage' : mounted.kind,
      entries,
      size: mounted.size || 0,
      source: mounted.source,
    });
    return { ...mounted, entries };
  }

  function groups(records) {
    const grouped = new Map();

    for (const record of records) {
      const key = record.contentTitle + ':' + record.version;

      if (!grouped.has(key)) grouped.set(key, []);

      grouped.get(key).push(record);
    }

    return grouped.values();
  }

  cancelled();

  const updates = await discoverUpdates({ ...a, title });
  cancelled();

  const dlc = await discoverDlc({ ...a, title });
  const installed = [4, 5, 2].map((storage) => ({ storage }));

  // only the newest version of each update title is kept: older ones are fully superseded and just bloat
  // the dump (and the stale game-card update is the one that tends to stall). YOINK_ALL_UPDATE_VERSIONS=1
  // packs every version; YOINK_SKIP_UPDATES=65536,131072 still drops specific versions by hand
  const allUpdates = [...groups(updates)];
  const newestVersion = new Map();
  for (const group of allUpdates) {
    const { contentTitle, version } = group[0];
    newestVersion.set(contentTitle, Math.max(newestVersion.get(contentTitle) ?? -1, version));
  }

  const skipped = new Set((process.env.YOINK_SKIP_UPDATES ?? process.env.OZ_SKIP_UPDATES ?? '').split(',').filter(Boolean).map(Number));
  const keepAll = Boolean(process.env.YOINK_ALL_UPDATE_VERSIONS || process.env.OZ_ALL_UPDATE_VERSIONS);
  const updateGroups = allUpdates.filter((group) => {
    const { contentTitle, version, storage } = group[0];
    const stale = !keepAll && version !== newestVersion.get(contentTitle);
    const why = skipped.has(version)
      ? ' (skipped)'
      : stale
        ? ' (superseded by ' + newestVersion.get(contentTitle) + ')'
        : '';
    console.log('Update ' + version + ': title ' + contentTitle.toUpperCase() + ', storage ' + storage + why);
    return !skipped.has(version) && !stale;
  });

  const { base, composedUpdate } = await prepareBaseProgram({
    title, mountView, installed, updateGroups, readCodeHeader,
  });

  // the control content (NACP + icon) names the title and lets a loader register it
  let control = null;
  const updateControls = {};
  if (images) {
    cancelled();
    try {
      control = await readControl(a, title, [base.source.storage, 4, 5, 2]);
      if (control) console.log('Base Control: ' + (control.name || '(no name)') + (control.icon ? ', icon ' + control.icon.length + ' bytes' : ', no icon'));
      else console.log('Base Control: none found');

      if (!control?.icon) {
        const patchTitle = (BigInt('0x' + title) + 0x800n).toString(16).padStart(16, '0');
        const patchGroup = (composedUpdate && composedUpdate.contentTitle === patchTitle
          ? updateGroups.find((group) => group[0].contentTitle === composedUpdate.contentTitle &&
            group[0].version === composedUpdate.version)
          : updateGroups.filter((group) => group[0].contentTitle === patchTitle)
            .sort((left, right) => right[0].version - left[0].version)[0]);
        if (patchGroup) {
          const update = patchGroup[0];
          const updateControl = await readControl(a, title, patchGroup.map((item) => item.storage), {
            update: { contentTitle: update.contentTitle, version: update.version },
          });
          updateControls[update.contentTitle + ':' + update.version] = updateControl;
          // the update's whole control (NACP, name, version, publisher) goes with its icon
          if (updateControl && (!control || updateControl.icon)) control = updateControl;
          if (updateControl?.icon && control?.iconSource?.selection === 'update') {
            console.log('Control icon fallback: update v' + update.version + ', ' + control.icon.length + ' bytes');
          }
        }
      }
      if (control) console.log('Control: ' + (control.name || '(no name)') + (control.icon ? ', icon ' + control.icon.length + ' bytes' : ', no icon'));
      else console.log('Control: none found (the nup will have no name or icon)');
    } catch (error) {
      if (!error.nativeResult) throw error;
      console.log('Could not read control content: ' + error.message);
    }
    for (const group of updateGroups) {
      const update = group[0];
      const key = update.contentTitle + ':' + update.version;
      if (Object.hasOwn(updateControls, key)) continue;
      cancelled();
      try {
        updateControls[key] = await readControl(a, title, group.map((item) => item.storage), {
          update: { contentTitle: update.contentTitle, version: update.version },
        });
      } catch (error) {
        if (!error.nativeResult) throw error;
        console.log('Could not read update control v' + update.version + ': ' + error.message);
      }
    }
  }

  for (const group of updateGroups) {
    if (composedUpdate && group[0].contentTitle === composedUpdate.contentTitle && group[0].version === composedUpdate.version) continue;
    const prefix = '/updates/' + group[0].version;

    const candidates = group.map((item) => ({
      storage: item.storage,
      update: { contentTitle: item.contentTitle, version: item.version },
    }));
    const update = await mountView(prefix, 'romfs', candidates);
    await mountView(
      prefix,
      'exefs',
      candidates.filter((candidate) => candidate.storage === update.source.storage),
    );
  }

  // Open the edition's code before DLC/data-patch storage consumes more FS resources.
  // A missing Program[1] is optional; a failure opening an installed one is fatal.
  let editionControlVersion = -1;
  // Program[1] is the Switch 2 counterpart only for Switch 1 titles. Native
  // Switch 2 titles can also contain a second program, with separate rights.
  for (const group of (!title.startsWith('01') || process.env.YOINK_NO_SWITCH2 || process.env.OZ_NO_SWITCH2 ||
    (images && edition === 'switch1')) ? [] : updateGroups) {
    const prefix = '/switch2/updates/' + group[0].version;
    const candidates = group.map((item) => ({
      storage: item.storage,
      update: { contentTitle: item.contentTitle, version: item.version },
      programIndex: 1,
    }));

    let program;

    try {
      program = await mountView(prefix, 'exefs', candidates);
    } catch (error) {
      // Only NCM reporting no Program[1] establishes that this is not an edition.
      if (error.source || ![0xa05, 0xe05].includes(error.nativeResult?.canonical)) throw error;
      console.log('No Switch 2 Edition program at ' + prefix + ': ' + error.message);
      continue;
    }

    await validateProgramEntries(program.entries, (filename, size) => readCodeHeader(program, filename, size));
    await mountView(
      prefix,
      'romfs',
      candidates.filter((candidate) => candidate.storage === program.source.storage),
    );

    if (images && group[0].version > editionControlVersion) {
      cancelled();
      const editionControl = await readControl(a, title, [program.source.storage], {
        update: { contentTitle: group[0].contentTitle, version: group[0].version },
        programIndex: 1,
      });
      if (editionControl) {
        control = { ...control, switch2: editionControl };
        editionControlVersion = group[0].version;
        console.log('Switch 2 Control: ' + (editionControl.name || '(no name)'));
      }
    }
  }

  for (const group of groups(dlc)) {
    const first = group[0];
    const prefix = '/dlc/' + first.contentTitle + '/' + first.version;
    const candidates = group.map((item) => ({
      storage: item.storage,
      dlc: item,
    }));
    await mountView(prefix, 'romfs', candidates);
  }

  // add-on data patches (content meta 0x84) carry newer data for an add-on, e.g. a Switch 2 Upgrade Pack
  // built for the current program. Match them to their DLC using the metadata's explicit IDs. One
  // that FS won't open as a complete RomFS is logged and skipped. YOINK_NO_DATA_PATCHES=1 skips them all
  const dataPatches = (process.env.YOINK_NO_DATA_PATCHES || process.env.OZ_NO_DATA_PATCHES) ? [] : await discoverDataPatches({ ...a, title });
  for (const group of groups(dataPatches)) {
    const patch = group[0];
    const prefix = '/dlc/' + patch.contentTitle + '/' + patch.version;
    const originals = matchingDlc(patch, dlc);
    if (!originals.length) throw new Error('No matching original DLC found for patch ' + patch.contentTitle);
    try {
      await mountView(prefix, 'romfs', group.flatMap((record) => originals.map((originalDlc) => ({
        storage: record.storage, dlc: record, originalDlc,
      }))));
    } catch (error) {
      if (!error.nativeResult || error.code === 'FTP_CANCELLED') throw error;
      console.log('Could not open data patch ' + prefix + ': ' + error.message);
    }
  }

  const ncm = await a.service('ncm');
  const pinned = new Set();
  const selectedSources = [
    ...sources.flatMap((item) => [item.source, item.source.originalSource].filter(Boolean)),
    ...absentSources,
  ];

  for (const source of selectedSources) {
    cancelled();

    const contentTitle = source.contentTitle || title;
    const id = source.storage + ':' + contentTitle;

    if (pinned.has(id)) continue;

    pinned.add(id);

    const opened = await a.s.ipc('FTP pin source database', ncm, 5, Buffer.from([source.storage]));

    if (opened.result) throw resultError('FTP pin source database', opened.result);

    const database = a.domain.oneHandle(opened);

    try {
      const latest = await a.s.ipc('FTP pin source version', database, 6, idBytes(contentTitle));

      if (latest.result) throw resultError('FTP pin source version', latest.result);

      const key = latest.data.subarray(0, 16);

      // Deferred DLC paths must still identify the exact metadata/content we enumerated.
      if (source.metaKey && [0x82, 0x84].includes(source.metaType)) {
        await verifyDlcSnapshot({ s: a.s, database, latestKey: key,
          sources: selectedSources.filter((item) => item.storage === source.storage && item.contentTitle === contentTitle),
        });
        continue;
      }

      await verifyProgramSnapshot({ s: a.s, database, latestKey: key,
        sources: selectedSources.filter((item) => item.storage === source.storage &&
          (item.contentTitle || title) === contentTitle),
      });

    } finally {
      await a.s.close(database);
    }
  }

  return { index: buildIndex(views, { images }), sources, views, control, updateControls };
}

// --probe: open each add-on data patch the way prepareGame does and summarize what FS hands back
async function probeDataPatches({ attachment: a, title, patches }) {
  const files = createGameFiles(a);
  const results = [];
  const dlc = await discoverDlc({ ...a, title });

  for (const patch of patches) {
    const result = { ...patch };
    let mounted;

    try {
      const originalDlc = matchingDlc(patch, dlc)[0];
      if (!originalDlc) throw new Error('No matching original DLC found for patch ' + patch.contentTitle);
      const options = {
        title,
        storage: patch.storage,
        section: 'romfs',
        dlc: patch,
        originalDlc,
      };

      try {
        mounted = await files.open(options);
      } catch (error) {
        if (error.nativeResult?.canonical !== 0x7d802) throw error;
        await prepareInstalledLicense({ ...a, title, source: error.source });
        mounted = await files.open(options);
      }

      result.contentPath = mounted.source.contentPath;
      result.size = mounted.size;
      const read = (offset, length) => files.read(mounted, offset, length);
      const entries = await readRomfs(read, mounted.size);
      result.files = entries.filter((e) => e.type === 'file').length;
      result.tables = entries
        .filter((e) => /^\/System\/(Resource\/ResourceSizeTable|AddressTable\/|AoCUpgradeVersion)/.test(e.path))
        .map((e) => e.path + ' (' + e.size + ' bytes)');

      const mask = entries.find((e) => e.path === '/System/RegionLangMask.txt');
      if (mask && mask.size < 0x1000) {
        result.regionLangMask = (await read(mask.offset, mask.size)).toString('utf8').split(/\r?\n/).slice(1).join(' | ');
      }
    } catch (error) {
      result.error = error.message;
      if (!result.contentPath && error.source?.contentPath) result.contentPath = error.source.contentPath;
    } finally {
      if (mounted) await files.close(mounted).catch(() => {});
    }

    results.push(result);
  }

  return results;
}

module.exports = { prepareGame, readRomfs, buildIndex, probeDataPatches, createGameFiles };
