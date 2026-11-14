const content = require('./content.cjs');
const { throwIfCancelled } = require('./protocol.cjs');

function logControl(label, control, missing = 'none found') {
  const details = control
    ? (control.name || '(no name)') + (control.icon ? ', icon ' + control.icon.length + ' bytes' : ', no icon')
    : missing;
  console.log(label + ': ' + details);
}

function fallbackGroup(title, updateGroups, composedUpdate) {
  const patchTitle = (BigInt('0x' + title) + 0x800n).toString(16).padStart(16, '0');
  if (composedUpdate?.contentTitle === patchTitle) {
    return updateGroups.find(([update]) => update.contentTitle === patchTitle &&
      update.version === composedUpdate.version);
  }
  return updateGroups.filter(([update]) => update.contentTitle === patchTitle)
    .sort(([left], [right]) => right.version - left.version)[0];
}

// Keep the base fallback and each update's own metadata together. This cache also
// avoids reopening the update Control NCA after it has supplied the base fallback.
async function prepareControl({ attachment, title, base, updateGroups, baseUpdateGroups = updateGroups,
  editionUpdateGroups = [], composedUpdate, shouldStop }) {
  let control = null;
  const updateControls = {};
  const editionUpdates = new Set(editionUpdateGroups.map(([update]) => update.contentTitle + ':' + update.version));

  async function readUpdate(group) {
    const update = group[0];
    const key = update.contentTitle + ':' + update.version;
    if (!Object.hasOwn(updateControls, key)) {
      throwIfCancelled(shouldStop);
      const options = { update: { contentTitle: update.contentTitle, version: update.version }, shouldStop };
      const storages = group.map((item) => item.storage);
      // Executable index and Control directory are independent: Pikmin 4's
      // edition executes Program[0], but its edition NACP/icon are in /Acd_1.
      let selected = null;
      if (editionUpdates.has(key)) {
        selected = await content.readControl(attachment, title, storages, { ...options, programIndex: 1 });
      }
      if (!selected) {
        throwIfCancelled(shouldStop);
        selected = await content.readControl(attachment, title, storages, options);
      }
      updateControls[key] = selected;
    }
    return updateControls[key];
  }

  throwIfCancelled(shouldStop);
  try {
    control = await content.readControl(attachment, title, [base.source.storage, 4, 5, 2]);
    logControl('Base Control', control);

    if (!control?.icon) {
      const group = fallbackGroup(title, baseUpdateGroups, composedUpdate);
      if (group) {
        const updateControl = await readUpdate(group);
        // NACP, name, version and publisher come from the same control as the icon.
        if (updateControl && (!control || updateControl.icon)) control = updateControl;
        if (updateControl?.icon && control?.iconSource?.selection === 'update') {
          console.log('Control icon fallback: update v' + group[0].version + ', ' + control.icon.length + ' bytes');
        }
      }
    }
    logControl('Control', control, 'none found (the nup will have no name or icon)');
  } catch (error) {
    if (!error.nativeResult) throw error;
    console.log('Could not read control content: ' + error.message);
  }

  for (const group of updateGroups) {
    try {
      await readUpdate(group);
    } catch (error) {
      if (!error.nativeResult) throw error;
      console.log('Could not read update control v' + group[0].version + ': ' + error.message);
    }
  }
  return { control, updateControls };
}

module.exports = { prepareControl };
