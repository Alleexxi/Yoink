const { createHash } = require('node:crypto');

const storageNames = { 2: 'Game card', 4: 'Internal', 5: 'SD' };
const contentTypes = { 0x80: 'Application', 0x81: 'Patch', 0x82: 'AddOnContent', 0x83: 'Delta', 0x84: 'DataPatch' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceDetails(source) {
  if (!source) return null;
  return {
    contentTitle: source.contentTitle || source.applicationTitle,
    version: source.version, storageId: source.storage,
    storage: storageNames[source.storage] || 'Unknown (' + source.storage + ')',
    metaType: contentTypes[source.metaType] || '0x' + Number(source.metaType || 0).toString(16),
    contentType: source.contentType, programIndex: source.programIndex || 0,
    contentId: source.contentId, contentPath: source.contentPath,
    attributes: '0x' + Number(source.attributes || 0).toString(16),
    selection: source.selection || 'base', runtimeProgramId: source.runtimeProgramId,
    originalSource: source.originalSource ? sourceDetails(source.originalSource) : undefined,
  };
}

function errorDetails(error, depth = 0) {
  if (!error) return undefined;
  return {
    message: error.message, code: error.code, mountPath: error.mountPath,
    nativeResult: error.nativeResult ? { ...error.nativeResult,
      rawHex: '0x' + error.nativeResult.raw.toString(16),
      canonicalHex: '0x' + error.nativeResult.canonical.toString(16) } : undefined,
    source: sourceDetails(error.source),
    cause: depth < 3 ? errorDetails(error.cause, depth + 1) : undefined,
  };
}

function controlSummary(control) {
  if (!control) return null;
  const nacpIds = control.nacp?.length >= 0x3080 ? {
    presenceGroupId: control.nacp.readBigUInt64LE(0x3038).toString(16).padStart(16, '0'),
    addOnContentBaseId: control.nacp.readBigUInt64LE(0x3070).toString(16).padStart(16, '0'),
    saveDataOwnerId: control.nacp.readBigUInt64LE(0x3078).toString(16).padStart(16, '0'),
    addOnContentRegistrationType: control.nacp[0x3027],
  } : undefined;
  return {
    name: control.name, publisher: control.publisher, version: control.version,
    metadataPath: control.metadataPath,
    nacpBytes: control.nacp?.length || 0, iconBytes: control.icon?.length || 0,
    nacpSha256: control.nacp ? sha256(control.nacp) : undefined,
    iconSha256: control.icon ? sha256(control.icon) : undefined,
    nacpIds,
    source: sourceDetails(control.source), iconSource: sourceDetails(control.iconSource),
  };
}

module.exports = { storageNames, contentTypes, sha256, sourceDetails, errorDetails, controlSummary };
