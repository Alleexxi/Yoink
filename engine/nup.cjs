const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { FtpClient } = require('./ftp-client.cjs');
const { editionOutputs } = require('./outputs.cjs');

// writes a .nup (see the NUP spec) straight from our own ftp server
// romfs comes down as one big image per mount (<prefix>/romfs.img) and gets cut up here,
// so we don't pay the per file ftp overhead thousands of times

const NONE = 0xffffffff;
const KIND = { base: 0, update: 1, addon: 2, addonUpdate: 3 };

// an add-on data patch (content meta 0x84) is packed as addon_update (SPEC kind 3)
// under the id of the add-on it updates, the way updates carry their program's id
const isDataPatch = (source) => source.metaType === 0x84;
const patchedAddonId = (source) => {
  if (!source.dataTitle) throw new Error('DLC patch metadata has no original DLC ID');
  return source.dataTitle;
};
const STANDALONE_UPDATE = 1;
const CODEC = { raw: 0, zstd: 1 };
const MEMORY_LIMIT = 64 * 1024 * 1024; // files bigger than this get spilled to disk while they come in
const ZSTD = { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } };
const zstdCompress = promisify(zlib.zstdCompress);

const align16 = (n) => Math.ceil(n / 16) * 16;
const EMPTY_SHA = createHash('sha256').digest();

// spec wants the content size in the frame header
function frameHasSize(frame) {
  if (frame.length < 5 || frame.readUInt32LE(0) !== 0xfd2fb528) return false;
  return frame[4] >> 6 !== 0 || ((frame[4] >> 5) & 1) === 1;
}

async function writeAll(handle, buffer, position) {
  for (let done = 0; done < buffer.length; ) {
    const { bytesWritten } = await handle.write(buffer, done, buffer.length - done, position + done);
    done += bytesWritten;
  }
}

class Content {
  constructor(size, spillDir) {
    this.size = size;
    this.spillDir = spillDir;
    this.hash = createHash('sha256');
    this.chunks = [];
    this.spill = null;
    this.spillHandle = null;
    this.spillAt = 0;
  }

  async add(chunk) {
    this.hash.update(chunk);

    if (this.size <= MEMORY_LIMIT) {
      this.chunks.push(chunk);
      return;
    }

    if (!this.spillHandle) {
      this.spill = path.join(this.spillDir, 'spill-' + process.hrtime.bigint());
      this.spillHandle = await fsp.open(this.spill, 'w');
    }

    await writeAll(this.spillHandle, chunk, this.spillAt);
    this.spillAt += chunk.length;
  }

  async seal() {
    if (this.spillHandle) await this.spillHandle.close();
    this.spillHandle = null;
    this.sha = this.hash.digest();
  }

  async discard() {
    this.chunks = [];
    if (this.spill) await fsp.rm(this.spill, { force: true });
  }
}

class Blob {
  constructor(handle, start) {
    this.handle = handle;
    this.cursor = start;
    this.extents = new Map();
    this.stats = { files: 0, bytes: 0, stored: 0, deduped: 0 };
  }

  async store(content) {
    this.stats.files++;
    this.stats.bytes += content.size;

    if (!content.size) return { offset: 0, extentSize: 0, codec: CODEC.raw, sha: EMPTY_SHA };

    const key = content.sha.toString('hex') + ':' + content.size;
    const known = this.extents.get(key);

    if (known) {
      this.stats.deduped += content.size;
      return known;
    }

    const offset = align16(this.cursor);
    const stored = content.spill ? await this.storeSpilled(content, offset) : await this.storeMemory(content, offset);
    const result = { offset, ...stored, sha: content.sha };

    this.cursor = offset + stored.extentSize;
    this.stats.stored += stored.extentSize;
    this.extents.set(key, result);
    return result;
  }

  async storeMemory(content, offset) {
    const data = content.chunks.length === 1 ? content.chunks[0] : Buffer.concat(content.chunks, content.size);
    let packed = null;

    try {
      packed = await zstdCompress(data, { ...ZSTD, pledgedSrcSize: data.length });
    } catch {}

    if (packed && packed.length < data.length && frameHasSize(packed)) {
      await writeAll(this.handle, packed, offset);
      return { extentSize: packed.length, codec: CODEC.zstd };
    }

    await writeAll(this.handle, data, offset);
    return { extentSize: data.length, codec: CODEC.raw };
  }

  async storeSpilled(content, offset) {
    const compressor = zlib.createZstdCompress({ ...ZSTD, pledgedSrcSize: content.size });
    const feeding = pipeline(fs.createReadStream(content.spill), compressor);
    let written = 0;
    let usable = true;
    let first = null;

    for await (const out of compressor) {
      if (written + out.length >= content.size) {
        usable = false;
        break;
      }

      first ??= out;
      await writeAll(this.handle, out, offset + written);
      written += out.length;
    }

    if (usable) await feeding;
    else await feeding.catch(() => {});

    if (usable && frameHasSize(first || Buffer.alloc(0))) return { extentSize: written, codec: CODEC.zstd };

    // didn't get smaller, store it raw instead (overwrites whatever we wrote)
    let at = 0;
    for await (const chunk of fs.createReadStream(content.spill)) {
      await writeAll(this.handle, chunk, offset + at);
      at += chunk.length;
    }
    return { extentSize: at, codec: CODEC.raw };
  }
}

function directory(name) {
  return { type: 'directory', name, children: new Map() };
}

function child(parent, name, make) {
  let node = parent.children.get(name);

  if (!node) {
    node = make();
    parent.children.set(name, node);
  } else if (node.type !== make().type) {
    throw new Error('NUP tree has a file/directory collision at ' + name);
  }

  return node;
}

// '/a/b/c' -> parent dir of c, created as needed
function parentOf(root, filename) {
  const parts = filename.split('/').filter(Boolean);
  let at = root;

  for (const part of parts.slice(0, -1)) at = child(at, part, () => directory(part));

  return { at, name: parts[parts.length - 1] };
}

function addEntries(root, entries) {
  const files = [];

  for (const entry of entries) {
    const { at, name } = parentOf(root, entry.path);

    if (entry.type === 'directory') {
      child(at, name, () => directory(name));
      continue;
    }

    const record = { type: 'file', name, size: entry.size, result: null };

    if (at.children.has(name)) throw new Error('NUP tree has a duplicate path: ' + entry.path);

    at.children.set(name, record);
    files.push({ ...entry, record });
  }

  return files;
}

function isDummyOnlyRomfs(romfsView) {
  if (!romfsView) return false;
  const files = romfsView.entries.filter((entry) => entry.type !== 'directory');
  return files.length > 0 && files.every((entry) => entry.path === '/dummy' && entry.size === 0);
}

function isEnhancementDlcRomfs(romfsView, baseFilePaths) {
  if (!romfsView || isDummyOnlyRomfs(romfsView)) return false;
  for (const entry of romfsView.entries) {
    if (entry.type === 'directory') continue;
    if (
      entry.path === '/System/AoCUpgradeVersion.txt' ||
      entry.path.includes('.Nin_Ounce') ||
      baseFilePaths.has(entry.path)
    ) {
      return true;
    }
  }
  return false;
}

// Pikmin 4's edition carries chunk 0 in its primary RomFS and chunk 1 in
// AddOnContent. Match the complete marker + pak/ucas/utoc layout and the same
// project/platform before allowing the experimental copy into the base.
function isCompanionUnrealChunk(romfsView, primaryPaths) {
  if (!romfsView || romfsView.source.metaType !== 0x82 || !primaryPaths.has('/__chunks')) return false;
  const files = romfsView.entries.filter((entry) => entry.type !== 'directory');
  if (files.length !== 4) return false;
  const marker = files.find((entry) => /^\/__chunks_[1-9]\d*$/.test(entry.path));
  if (!marker) return false;
  const chunk = marker.path.slice('/__chunks_'.length);
  const paths = new Set(files.map((entry) => entry.path));
  for (const primary of primaryPaths) {
    const match = /^(\/.*\/Content\/Paks\/)pakchunk0-([^/]+)\.pak$/.exec(primary);
    if (!match) continue;
    if (['pak', 'ucas', 'utoc'].every((extension) =>
      primaryPaths.has(match[1] + 'pakchunk0-' + match[2] + '.' + extension) &&
      paths.has(match[1] + 'pakchunk' + chunk + '-' + match[2] + '.' + extension))) return true;
  }
  return false;
}

// overlays multiple RomFS views in low-to-high precedence order into one romfs tree,
// pruning shadowed lower-layer file entries so superseded bytes are never pulled or stored
function addLayeredRomfs(romfsDir, layerSpecs) {
  const ownerByRecord = new Map();
  const layers = [];

  for (const { view, label } of layerSpecs) {
    const activeFiles = new Set();
    let added = 0;
    let replaced = 0;

    for (const entry of view.entries) {
      const { at, name } = parentOf(romfsDir, entry.path);

      if (entry.type === 'directory') {
        child(at, name, () => directory(name));
        continue;
      }

      const existing = at.children.get(name);
      if (existing) {
        if (existing.type === 'directory') {
          throw new Error('NUP tree has a file/directory collision at ' + entry.path);
        }
        const prev = ownerByRecord.get(existing);
        if (prev) {
          prev.activeFiles.delete(prev.fileEntry);
          ownerByRecord.delete(existing);
        }
        replaced++;
      } else {
        added++;
      }

      const record = { type: 'file', name, size: entry.size, result: null };
      const fileEntry = { ...entry, record };
      at.children.set(name, record);
      activeFiles.add(fileEntry);
      ownerByRecord.set(record, { activeFiles, fileEntry });
    }

    console.log(
      '  RomFS layer ' + view.path + ' (' + label + '): +' + added + ' files' +
        (replaced ? ', ' + replaced + ' replaced' : ''),
    );
    layers.push({
      ftpPath: view.path + '.img',
      size: view.size,
      activeFiles,
    });
  }

  return layers
    .map((layer) => ({
      ftpPath: layer.ftpPath,
      size: layer.size,
      files: [...layer.activeFiles],
    }))
    .filter((layer) => layer.files.length > 0);
}

// edition: 'switch2' (default) packs a self-contained Switch 2 Edition base package (flattening
// the primary program RomFS + Switch 2 Upgrade Pack DLC + any program[1] RomFS, with Switch 2 ExeFS),
// 'switch1' packs the Switch 1 program, 'both' writes one file for each edition, and 'all' keeps every
// dumped package (base, updates incl. the Switch 2 program, add-ons, add-on data patches) in one file
function planPackages(views, title, edition = 'switch2',
  { flattenUnrealChunks = process.env.YOINK_FLATTEN_UNREAL_CHUNKS === '1' } = {}) {
  const groups = new Map();

  for (const view of views) {
    const switch2 = view.path.startsWith('/switch2/');
    const prefix = path.posix.dirname(view.path);
    if (!groups.has(prefix)) groups.set(prefix, { prefix, switch2 });
    groups.get(prefix)[path.posix.basename(view.path)] = view;
  }

  const allGroups = [...groups.values()];
  const switch2Updates = allGroups
    .filter((group) => group.switch2 && (group.exefs || group.romfs))
    .sort((a, b) => ((b.romfs || b.exefs).source.version >>> 0) - ((a.romfs || a.exefs).source.version >>> 0));

  if (edition !== 'switch1') {
    for (const group of switch2Updates) {
      for (const filename of ['/main', '/main.npdm']) {
        if (!group.exefs?.entries.some((entry) => entry.path === filename && entry.type === 'file' && entry.size > 0)) {
          throw new Error('Cannot pack ' + group.prefix + ': missing Switch 2 ExeFS ' + filename);
        }
      }
    }
  }

  if (edition === 'switch2' && switch2Updates.length > 0) {
    const s2Group = switch2Updates[0];
    const s2Source = (s2Group.exefs || s2Group.romfs).source;
    const s2Version = s2Source.version >>> 0;
    // A Switch 2 Edition card can expose the Switch 2 program as program 0 of the
    // update; that group's own RomFS is then the primary, not a program-1 layer.
    const s2ProgramIsUpdate = s2Source.metaType === 0x81 && !s2Source.programIndex;
    if (s2ProgramIsUpdate && !s2Group.romfs) {
      throw new Error('Cannot pack ' + s2Group.prefix + ': missing Switch 2 program 0 RomFS');
    }

    const p0Update = s2ProgramIsUpdate
      ? s2Group
      : groups.get('/updates/' + s2Version) ||
        allGroups
          .filter((group) => !group.switch2 && group.prefix.startsWith('/updates/') && group.romfs)
          .sort((a, b) => (b.romfs.source.version >>> 0) - (a.romfs.source.version >>> 0))[0] ||
        null;
    const baseGroup = groups.get('/base') || null;
    const primaryRomfsGroup = (p0Update && p0Update.romfs ? p0Update : null) || (baseGroup && baseGroup.romfs ? baseGroup : null);

    const baseFilePaths = new Set();
    if (primaryRomfsGroup?.romfs) {
      for (const entry of primaryRomfsGroup.romfs.entries) {
        if (entry.type !== 'directory') baseFilePaths.add(entry.path);
      }
    }

    const layerSpecs = [];
    if (primaryRomfsGroup?.romfs) {
      const label = primaryRomfsGroup === p0Update ? 'updated program 0' : 'base program 0';
      layerSpecs.push({ view: primaryRomfsGroup.romfs, label });
    }

    const addonGroups = [];
    const dlcGroups = allGroups
      .filter((group) => group.prefix.startsWith('/dlc/'))
      .sort((a, b) => {
        const first = (a.romfs || a.exefs).source;
        const second = (b.romfs || b.exefs).source;
        const firstId = isDataPatch(first) ? patchedAddonId(first) : first.contentTitle;
        const secondId = isDataPatch(second) ? patchedAddonId(second) : second.contentTitle;
        return firstId.localeCompare(secondId) || Number(isDataPatch(first)) - Number(isDataPatch(second)) ||
          first.version - second.version || a.prefix.localeCompare(b.prefix);
      });

    for (const dlcGroup of dlcGroups) {
      if (!dlcGroup.exefs && isDummyOnlyRomfs(dlcGroup.romfs)) {
        console.log('  Skipping dummy unlock DLC ' + dlcGroup.prefix);
        continue;
      }
      if (!dlcGroup.exefs && isEnhancementDlcRomfs(dlcGroup.romfs, baseFilePaths)) {
        layerSpecs.push({ view: dlcGroup.romfs, label: 'enhanced dlc' });
        continue;
      }
      if (flattenUnrealChunks && s2ProgramIsUpdate && !dlcGroup.exefs &&
          isCompanionUnrealChunk(dlcGroup.romfs, baseFilePaths)) {
        layerSpecs.push({ view: dlcGroup.romfs, label: 'companion Unreal chunk; also retained as DLC' });
      }
      addonGroups.push(dlcGroup);
    }

    if (s2Group.romfs && !s2ProgramIsUpdate) {
      layerSpecs.push({ view: s2Group.romfs, label: 'program 1' });
    }

    const root = directory('');
    const basePack = {
      prefix: s2Group.prefix,
      switch2: true,
      kind: KIND.base,
      titleId: s2Source.runtimeProgramId || s2Source.contentTitle || title,
      version: s2Version,
      editionControlKey: s2ProgramIsUpdate ? s2Source.contentTitle + ':' + s2Version : undefined,
      flags: 0,
      root,
      exefsDir: null,
      romfsDir: null,
      exefsFiles: [],
      romfs: null,
      romfsLayers: [],
      meta: [],
    };

    if (s2Group.exefs) {
      basePack.exefsDir = child(root, 'exefs', () => directory('exefs'));
      basePack.exefsFiles = addEntries(basePack.exefsDir, s2Group.exefs.entries).map((file) => ({
        ...file,
        ftpPath: s2Group.exefs.path + file.path,
      }));
    }

    if (layerSpecs.length > 0) {
      basePack.romfsDir = child(root, 'romfs', () => directory('romfs'));
      basePack.romfsLayers = addLayeredRomfs(basePack.romfsDir, layerSpecs);
      basePack.romfs = basePack.romfsLayers[0] || null;
    }

    const packages = [basePack];

    for (const group of addonGroups) {
      const source = (group.romfs || group.exefs).source;
      const addonRoot = directory('');
      const addonPack = {
        prefix: group.prefix,
        switch2: false,
        kind: isDataPatch(source) ? KIND.addonUpdate : KIND.addon,
        titleId: isDataPatch(source) ? patchedAddonId(source) : source.contentTitle || title,
        version: source.version >>> 0,
        flags: 0,
        root: addonRoot,
        exefsDir: null,
        romfsDir: null,
        exefsFiles: [],
        romfs: null,
        romfsLayers: [],
        meta: [],
      };

      if (group.exefs) {
        addonPack.exefsDir = child(addonRoot, 'exefs', () => directory('exefs'));
        addonPack.exefsFiles = addEntries(addonPack.exefsDir, group.exefs.entries).map((file) => ({
          ...file,
          ftpPath: group.exefs.path + file.path,
        }));
      }

      if (group.romfs) {
        addonPack.romfsDir = child(addonRoot, 'romfs', () => directory('romfs'));
        const layer = {
          ftpPath: group.romfs.path + '.img',
          size: group.romfs.size,
          files: addEntries(addonPack.romfsDir, group.romfs.entries),
        };
        addonPack.romfs = layer;
        addonPack.romfsLayers = [layer];
      }

      packages.push(addonPack);
    }

    return packages;
  }

  const planned = allGroups.map((group) => {
    const source = (group.romfs || group.exefs).source;
    const kind =
      group.prefix === '/base'
        ? KIND.base
        : group.prefix.startsWith('/dlc/')
          ? isDataPatch(source) ? KIND.addonUpdate : KIND.addon
          : KIND.update;

    const root = directory('');
    const pack = {
      prefix: group.prefix,
      switch2: Boolean(group.switch2),
      kind,
      titleId:
        kind === KIND.base
          ? title
          : kind === KIND.addonUpdate
            ? patchedAddonId(source)
            : group.switch2 && source.runtimeProgramId
              ? source.runtimeProgramId
              : source.contentTitle || title,
      version: source.version >>> 0,
      controlKey: source.contentTitle + ':' + source.version,
      editionControlKey: group.switch2 && source.metaType === 0x81 && !source.programIndex
        ? source.contentTitle + ':' + source.version : undefined,
      flags: 0,
      root,
      exefsDir: null,
      romfsDir: null,
      exefsFiles: [],
      romfs: null,
      romfsLayers: [],
      meta: [],
    };

    if (group.exefs) {
      pack.exefsDir = child(root, 'exefs', () => directory('exefs'));
      pack.exefsFiles = addEntries(pack.exefsDir, group.exefs.entries).map((file) => ({
        ...file,
        ftpPath: group.exefs.path + file.path,
      }));
    }

    if (group.romfs) {
      pack.romfsDir = child(root, 'romfs', () => directory('romfs'));
      const layer = {
        ftpPath: group.romfs.path + '.img',
        size: group.romfs.size,
        files: addEntries(pack.romfsDir, group.romfs.entries),
      };
      pack.romfs = layer;
      pack.romfsLayers = [layer];
    }

    return pack;
  });

  const packages = planned.filter((pack) => {
    if (pack.kind !== KIND.update) return true;

    if (edition === 'switch1') {
      if (pack.switch2) console.log('  Leaving the Switch 2 Edition program out of update ' + pack.version);
      return !pack.switch2;
    }

    return true; // 'both' or non-Switch-2-Edition title
  });

  packages.sort((a, b) => a.kind - b.kind || a.titleId.localeCompare(b.titleId) || a.version - b.version);

  if (!packages.some((pack) => pack.kind === KIND.base)) {
    for (const pack of packages) if (pack.kind === KIND.update) pack.flags |= STANDALONE_UPDATE;
  }

  return packages;
}

function tlv(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(type, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// same records (sorted by type) as the reference packer (a55uka/nup), so `nup edit` etc. treat them the same
function buildMeta(pack, { npdm, mainHead, name, control, updateControls }) {
  const records = [];
  if (pack.switch2) control = updateControls?.[pack.editionControlKey] || control?.switch2 || control;
  else if (pack.kind === KIND.update) control = updateControls?.[pack.controlKey] || null;
  else if (pack.kind !== KIND.base) control = null;

  if (npdm) records.push(tlv(0x0001, npdm));

  // A separate edition program carries its own Control data; flattened editions are base packages.
  if (pack.kind === KIND.base || pack.switch2 || (pack.kind === KIND.update && control)) {
    if (control?.nacp) records.push(tlv(0x0002, control.nacp));
    if (control?.icon) records.push(tlv(0x0003, control.icon));
    if (control?.version) records.push(tlv(0x0004, Buffer.from(control.version)));
    const displayName = control?.name || name;
    if (displayName) records.push(tlv(0x0005, Buffer.from(displayName)));
    if (control?.publisher) records.push(tlv(0x0006, Buffer.from(control.publisher)));
  }

  if (mainHead && mainHead.length >= 0x60) {
    const magic = mainHead.toString('latin1', 0, 4);
    const nro = mainHead.toString('latin1', 0x10, 0x14);
    if (magic === 'NSO0' || nro === 'NRO0') records.push(tlv(0x0007, mainHead.subarray(0x40, 0x60)));
  }

  records.push(tlv(0x0008, Buffer.from('Yoink')));
  return Buffer.concat(records);
}

// program id out of the npdm's ACI0, which is what the reference packer uses as title_id
function npdmProgramId(npdm) {
  const at = npdm ? npdm.indexOf('ACI0') : -1;
  if (at < 0 || at + 0x18 > npdm.length) return null;
  const id = npdm.readBigUInt64LE(at + 0x10);
  return id ? id.toString(16).padStart(16, '0') : null;
}

// assigns dir/file indices and children slots, breadth first so every dir's children are contiguous
function layout(packages) {
  const dirs = [];
  const files = [];
  const children = [];
  const strings = new Map();
  const pool = [];
  let poolBytes = 0;

  const string = (value) => {
    if (!strings.has(value)) {
      const bytes = Buffer.from(value);
      strings.set(value, { offset: poolBytes, length: bytes.length });
      pool.push(bytes);
      poolBytes += bytes.length;
    }

    return strings.get(value);
  };

  const queue = [];
  const enqueue = (dir) => {
    dir.index = dirs.length;
    dirs.push(dir);
    queue.push(dir);
  };

  for (const pack of packages) enqueue(pack.root);

  for (let at = 0; at < queue.length; at++) {
    const dir = queue[at];
    const sorted = [...dir.children.values()].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));

    dir.firstChild = children.length;
    dir.childCount = sorted.length;

    for (const node of sorted) {
      if (node.type === 'directory') enqueue(node);
      else {
        node.index = files.length;
        files.push(node);
      }

      children.push(node);
    }
  }

  for (const node of [...dirs, ...files]) node.string = string(node.name);

  const offsets = {};
  offsets.packages = 0x30;
  offsets.dirs = offsets.packages + packages.length * 0x40;
  offsets.files = offsets.dirs + dirs.length * 0x18;
  offsets.children = offsets.files + files.length * 0x50;
  offsets.pool = offsets.children + children.length * 4;
  const size = align16(offsets.pool + poolBytes);

  return { dirs, files, children, pool: Buffer.concat(pool, poolBytes), offsets, size };
}

function encodeToc(packages, plan) {
  const { dirs, files, children, pool, offsets } = plan;
  const toc = Buffer.alloc(plan.size);
  const id = (node) => (node.type === 'directory' ? node.index : dirs.length + node.index);

  toc.write('TOC\x01', 0, 'latin1');
  toc.writeUInt32LE(packages.length, 4);
  toc.writeBigUInt64LE(BigInt(dirs.length), 0x08);
  toc.writeBigUInt64LE(BigInt(files.length), 0x10);
  toc.writeBigUInt64LE(BigInt(offsets.pool), 0x18);
  toc.writeBigUInt64LE(BigInt(pool.length), 0x20);

  packages.forEach((pack, i) => {
    const at = offsets.packages + i * 0x40;
    toc.writeBigUInt64LE(BigInt('0x' + pack.titleId), at);
    toc.writeUInt32LE(pack.root.index, at + 0x08);
    toc.writeUInt32LE(pack.exefsDir ? pack.exefsDir.index : NONE, at + 0x0c);
    toc.writeUInt32LE(pack.romfsDir ? pack.romfsDir.index : NONE, at + 0x10);
    toc.writeUInt32LE(pack.version, at + 0x14);
    toc[at + 0x18] = pack.kind;
    toc[at + 0x19] = pack.flags;
    toc.writeBigUInt64LE(BigInt(pack.metaOffset || 0), at + 0x20);
    toc.writeUInt32LE(pack.metaSize || 0, at + 0x28);
  });

  dirs.forEach((dir, i) => {
    const at = offsets.dirs + i * 0x18;
    toc.writeUInt32LE(dir.string.offset, at);
    toc.writeUInt32LE(dir.string.length, at + 4);
    toc.writeUInt32LE(dir.firstChild, at + 8);
    toc.writeUInt32LE(dir.childCount, at + 12);
  });

  files.forEach((file, i) => {
    const at = offsets.files + i * 0x50;
    if (!file.result) throw new Error('NUP file was never written: ' + file.name);
    toc.writeUInt32LE(file.string.offset, at);
    toc.writeUInt32LE(file.string.length, at + 4);
    toc.writeBigUInt64LE(BigInt(file.size), at + 0x08);
    toc.writeBigUInt64LE(BigInt(file.result.offset), at + 0x10);
    toc.writeBigUInt64LE(BigInt(file.result.extentSize), at + 0x18);
    file.result.sha.copy(toc, at + 0x20);
    toc[at + 0x40] = file.result.codec;
  });

  children.forEach((node, i) => toc.writeUInt32LE(id(node), offsets.children + i * 4));
  pool.copy(toc, offsets.pool);
  return toc;
}

function encodeSuperblock(packages, { toc, blobOffset, fileSize }) {
  const block = Buffer.alloc(0x80);
  Buffer.from([0x4e, 0x55, 0x50, 0x01]).copy(block, 0);
  block.writeUInt16LE(0x80, 0x04);
  block.writeUInt16LE(1, 0x06);
  block.writeBigUInt64LE(0x80n, 0x08);
  block.writeBigUInt64LE(BigInt(toc.length), 0x10);
  createHash('sha256').update(toc).digest().copy(block, 0x18);
  block.writeBigUInt64LE(BigInt(blobOffset), 0x38);
  block.writeBigUInt64LE(BigInt(fileSize), 0x40);
  block.writeUInt32LE(packages.length, 0x48);

  const uuid = createHash('sha256');
  for (const pack of packages) {
    const key = Buffer.alloc(13);
    key.writeBigUInt64LE(BigInt('0x' + pack.titleId), 0);
    key.writeUInt32LE(pack.version, 8);
    key[12] = pack.kind;
    uuid.update(key);
  }
  uuid.digest().copy(block, 0x50, 0, 16);
  return block;
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

function progress(label, total, onProgress) {
  const started = Date.now();
  let done = 0;
  let shown = 0;
  let window = { at: started, done: 0, rate: 0 }; // speed over the last few seconds, the average hides slow/fast stretches
  const tty = process.stdout.isTTY;
  const [scale, unit] = total < 1024 ? [1, 'B'] : total < 1048576 ? [1024, 'KB'] : [1048576, 'MB'];
  const amount = (bytes) => (bytes / scale).toFixed(scale === 1 ? 0 : 1);

  const show = (final) => {
    const now = Date.now();
    const seconds = Math.max((now - started) / 1000, 0.001);
    if (now - window.at >= 3000) window = { at: now, done, rate: ((done - window.done) * 1000) / (now - window.at) };
    const rate = final || !window.rate ? '' : amount(window.rate) + ' ' + unit + '/s now, ';
    if (onProgress) {
      onProgress({ path: label, done, total, bytesPerSecond: window.rate || done / seconds, finished: final });
      return;
    }
    const line = '  ' + label + '  ' + amount(done) + '/' + amount(total) + ' ' + unit + '  ' + rate + amount(done / seconds) + ' ' + unit + '/s avg';
    if (tty) process.stdout.write('\r' + line + '\x1b[K' + (final ? '\n' : ''));
    else if (final) console.log(line);
  };

  if (onProgress) show(false);

  return {
    add(bytes) {
      done += bytes;
      if (Date.now() - shown > 500) {
        shown = Date.now();
        show(false);
      }
    },
    end: () => show(true),
  };
}

// one romfs image cut into its files as the bytes go past; one consumer per output file, so a single
// retrieve can feed the same image into several nups at once (shared base/dlc downloaded only once)
function makeImageConsumer(romfs, blob, spillDir) {
  const groups = new Map();
  const zero = [];

  for (const file of romfs.files) {
    if (!file.size) {
      zero.push(file);
      continue;
    }

    const key = file.offset + ':' + file.size;
    if (!groups.has(key)) groups.set(key, { offset: file.offset, size: file.size, records: [] });
    groups.get(key).records.push(file.record);
  }

  const pending = [...groups.values()].sort((a, b) => a.offset - b.offset || a.size - b.size);
  const active = [];
  let next = 0;

  return {
    async begin() {
      for (const file of zero) file.record.result = await blob.store({ size: 0 });
    },
    async onChunk(chunk, start, end) {
      while (next < pending.length && pending[next].offset < end) {
        const group = pending[next++];
        group.content = new Content(group.size, spillDir);
        active.push(group);
      }

      for (const group of active) {
        const from = Math.max(start, group.offset);
        const to = Math.min(end, group.offset + group.size);
        if (to > from) await group.content.add(chunk.subarray(from - start, to - start));
      }

      for (let i = 0; i < active.length; ) {
        const group = active[i];

        if (group.offset + group.size > end) {
          i++;
          continue;
        }

        active.splice(i, 1);
        await group.content.seal();
        const result = await blob.store(group.content);
        await group.content.discard();
        group.content = null;
        for (const record of group.records) record.result = result;
      }
    },
    finish(ftpPath) {
      if (active.length || next < pending.length) throw new Error(ftpPath + ' ended before all of its files');
    },
  };
}

// retrieve one image once and fan every chunk out to each output file that wants it
async function pullImage(client, ftpPath, size, consumers, shouldStop, onProgress) {
  const meter = progress(ftpPath, size, onProgress);
  let position = 0;

  for (const consumer of consumers) await consumer.begin();

  await client.retrieve(ftpPath, size, async (chunk) => {
    if (shouldStop()) throw Object.assign(new Error('Cancelled'), { code: 'FTP_CANCELLED' });

    const start = position;
    const end = position + chunk.length;
    position = end;

    for (const consumer of consumers) await consumer.onChunk(chunk, start, end);

    meter.add(chunk.length);
  });

  meter.end();

  for (const consumer of consumers) consumer.finish(ftpPath);
}

async function packNup({ host, port, views, title, name, output, edition = 'switch2', control = null, updateControls = {},
  flattenUnrealChunks = process.env.YOINK_FLATTEN_UNREAL_CHUNKS === '1', shouldStop = () => false, onProgress }) {
  const targets = editionOutputs(output, edition).map((target) => {
    const packages = planPackages(views, title, target.edition, { flattenUnrealChunks });
    const plan = layout(packages);
    return {
      ...target,
      packages,
      plan,
      blobOffset: align16(0x80 + plan.size),
      partial: target.output + '.part',
      handle: null,
      partialCreated: false,
      blob: null,
    };
  });

  const stop = () => {
    if (shouldStop()) throw Object.assign(new Error('Cancelled'), { code: 'FTP_CANCELLED' });
  };

  const spillDir = await fsp.mkdtemp(path.join(path.dirname(output), '.yoink-'));
  let client;
  try {
    stop();
    client = await FtpClient.open(host, port);
    for (const target of targets) {
      target.handle = await fsp.open(target.partial, 'w');
      target.partialCreated = true;
      target.blob = new Blob(target.handle, target.blobOffset);
    }

    // exefs: download each unique file once, feeding its bytes into every output that holds it
    const exefsJobs = new Map();
    for (const target of targets)
      for (const pack of target.packages)
        for (const file of pack.exefsFiles) {
          let job = exefsJobs.get(file.ftpPath);
          if (!job) {
            job = { ftpPath: file.ftpPath, size: file.size, path: file.path, consumers: [] };
            exefsJobs.set(file.ftpPath, job);
          }
          job.consumers.push({ pack, file, blob: target.blob });
        }

    for (const job of exefsJobs.values()) {
      stop();

      const contents = job.consumers.map(() => new Content(job.size, spillDir));
      const head = [];
      const meter = onProgress ? progress(job.ftpPath, job.size, onProgress) : null;
      await client.retrieve(job.ftpPath, job.size, async (chunk) => {
        stop();
        if (job.path === '/main.npdm') head.push(chunk);
        else if (job.path === '/main' && Buffer.concat(head).length < 0x60) head.push(chunk);
        for (const content of contents) await content.add(chunk);
        meter?.add(chunk.length);
      });
      meter?.end();

      const full = Buffer.concat(head);
      for (let i = 0; i < job.consumers.length; i++) {
        const { pack, file, blob } = job.consumers[i];
        await contents[i].seal();
        file.record.result = await blob.store(contents[i]);
        await contents[i].discard();
        if (job.path === '/main.npdm') pack.npdm = full;
        if (job.path === '/main') pack.mainHead = full.subarray(0, 0x60);
      }
    }

    for (const target of targets) {
      for (const pack of target.packages) {
        if (pack.exefsFiles.length) console.log('  ' + pack.prefix + '/exefs  ' + pack.exefsFiles.length + ' files');
        if (pack.kind === KIND.base || pack.kind === KIND.update) {
          pack.titleId = npdmProgramId(pack.npdm) || pack.titleId;
        }
        pack.metaBlock = buildMeta(pack, { npdm: pack.npdm || null, mainHead: pack.mainHead || null, name, control, updateControls });
      }

      // a nup keys packages by (title id, version, kind); two in one file that share all three would
      // clash. --edition both avoids this by writing a file per program, so this is just a safety net
      const seen = new Map();
      for (const pack of target.packages) {
        const key = pack.titleId + ':' + pack.version + ':' + pack.kind;
        if (seen.has(key)) {
          throw new Error(
            'Two packages share title ' + pack.titleId.toUpperCase() + ' version ' + pack.version +
              ' kind ' + pack.kind + ', which one nup cannot hold',
          );
        }
        seen.set(key, pack);
      }
    }

    // romfs: one retrieve per unique image, fanned out to every output's files
    const imageJobs = new Map();
    for (const target of targets)
      for (const pack of target.packages) {
        const layers = pack.romfsLayers || (pack.romfs ? [pack.romfs] : []);
        for (const layer of layers) {
          let job = imageJobs.get(layer.ftpPath);
          if (!job) {
            job = { ftpPath: layer.ftpPath, size: layer.size, consumers: [] };
            imageJobs.set(layer.ftpPath, job);
          }
          job.consumers.push(makeImageConsumer(layer, target.blob, spillDir));
        }
      }

    for (const job of imageJobs.values()) {
      await pullImage(client, job.ftpPath, job.size, job.consumers, shouldStop, onProgress);
    }

    for (const target of targets) {
      const { packages, plan, blobOffset, handle, blob } = target;

      // meta blocks are the tail of the file, after every extent (`nup edit` relies on that)
      let fileSize = Math.max(blob.cursor, blobOffset);
      for (const pack of packages) {
        pack.metaOffset = fileSize;
        pack.metaSize = pack.metaBlock.length;
        await writeAll(handle, pack.metaBlock, fileSize);
        fileSize += pack.metaSize;
      }

      const toc = encodeToc(packages, plan);
      await writeAll(handle, toc, 0x80);
      await writeAll(handle, encodeSuperblock(packages, { toc, blobOffset, fileSize }), 0);
      await handle.truncate(fileSize);
      await handle.close();
      target.handle = null;
      await fsp.rename(target.partial, target.output);

      const { files, bytes, deduped } = blob.stats;
      console.log(
        'Wrote ' + target.output + ': ' + packages.length + ' packages, ' + files + ' files, ' +
          mb(bytes) + ' MB of content -> ' + mb(fileSize) + ' MB (' + mb(deduped) + ' MB deduped)',
      );
    }
  } catch (error) {
    for (const target of targets) {
      if (target.handle) await target.handle.close().catch(() => {});
      if (target.partialCreated) await fsp.rm(target.partial, { force: true });
    }
    throw error;
  } finally {
    try {
      await client?.close();
    } finally {
      await fsp.rm(spillDir, { recursive: true, force: true });
    }
  }
}

module.exports = { packNup, planPackages, layout, encodeToc, encodeSuperblock };
