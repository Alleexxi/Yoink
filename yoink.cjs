#!/usr/bin/env node
const path = require('node:path');
const { isIPv4 } = require('node:net');
const { createInterface } = require('node:readline');
const { titleId, withCleanup } = require('./engine/protocol.cjs');
const { attachGame } = require('./engine/session.cjs');
const { discoverGames, discoverUpdates, discoverDataPatches, listApplicationContent, readControl } = require('./engine/content.cjs');
const { prepareGame, probeDataPatches } = require('./engine/mounts.cjs');
const { deployFtp, readImage } = require('./engine/ftp.cjs');
const { packNup } = require('./engine/nup.cjs');
const { getConsoleIp } = require('./engine/network.cjs');
const { TerminalUI, supportsTui } = require('./engine/tui.cjs');
const { resolveRun } = require('./engine/runtime.cjs');

const USAGE = 'Usage: node yoink.cjs [run-directory|runs-directory] [title-id] [--port 2121] [--nup <out.nup>] [--ip <switch 2 ip>] [--edition switch2]\n' +
              '       node yoink.cjs debug [run-directory|runs-directory] [title-id]\n' +
              'Enter an ns2jb run path once; Yoink remembers its parent and finds a live run next time\n' +
              'You can also provide a title ID to skip the selection menu and just mount a specific game\n' +
              'With --nup, Yoink downloads everything itself and writes a .nup instead of leaving the FTP up\n' +
              'The console IP is detected through RPC; --ip overrides it for --nup downloads\n' +
              'Interactive terminals open the TUI; --no-tui uses the plain-text interface\n' +
              '--edition picks how a Switch 2 Edition is packed: switch2 (default, one flattened Switch 2 package),\n' +
              '  switch1, both (one file each), or all (every dumped package in one file, as the NUP spec lays it out)\n' +
              '--probe lists every installed content meta of the title (incl. add-on data patches) and exits\n' +
              'debug prints installed content, Control metadata, and the resolved base/update/DLC layers without starting FTP\n';

function getArgs(argv) {
  const args = [];
  let port = 2121;
  let nup;
  let ip;
  let edition = 'switch2';
  let probe = false;
  let debug = false;
  let noTui = false;

  if (argv[0]?.toLowerCase() === 'debug') {
    debug = true;
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help') {
      return { help: true };
    }

    if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Invalid --port value\n' + USAGE);
      }
      continue;
    }

    if (a === '--nup') {
      nup = argv[++i];
      if (!nup || nup.startsWith('--')) throw new Error('--nup needs an output file\n' + USAGE);
      continue;
    }

    if (a === '--ip') {
      ip = argv[++i];
      if (!ip || !isIPv4(ip)) throw new Error('--ip needs an IPv4 address\n' + USAGE);
      continue;
    }

    if (a === '--probe') {
      probe = true;
      continue;
    }

    if (a === '--no-tui') {
      noTui = true;
      continue;
    }

    if (a === '--edition') {
      edition = argv[++i];
      if (!['switch1', 'switch2', 'both', 'all'].includes(edition)) {
        throw new Error('--edition must be switch1, switch2, both, or all\n' + USAGE);
      }
      continue;
    }

    if (a.startsWith('--')) {
      throw new Error('Unknown option: ' + a + '\n' + USAGE);
    }

    args.push(a);
  }

  if (args.length > 2) {
    throw new Error(USAGE);
  }

  if (ip && !nup) {
    throw new Error('--ip is used with --nup\n' + USAGE);
  }

  const [runArg, titleArg] = args.length === 1 && /^(?:0x)?[0-9a-fA-F]{16}$/.test(args[0])
    ? [undefined, args[0]] : args;
  const title = titleArg ? titleId(titleArg) : undefined;
  if (debug && (nup || probe)) throw new Error('debug cannot be combined with --nup or --probe\n' + USAGE);
  return { run: runArg ? path.resolve(runArg) : undefined, title, port, nup: nup && path.resolve(nup), ip, edition, probe, debug, noTui };
}

const storageNames = { 2: 'Game card', 4: 'Internal', 5: 'SD' };
const contentTypes = { 0x80: 'Application', 0x81: 'Patch', 0x82: 'AddOnContent', 0x83: 'Delta', 0x84: 'DataPatch' };

function sourceDetails(source) {
  if (!source) return null;
  return {
    contentTitle: source.contentTitle || source.applicationTitle,
    version: source.version,
    storage: storageNames[source.storage] || 'Unknown (' + source.storage + ')',
    metaType: contentTypes[source.metaType] || '0x' + Number(source.metaType || 0).toString(16),
    contentType: source.contentType,
    programIndex: source.programIndex || 0,
    contentId: source.contentId,
    contentPath: source.contentPath,
    attributes: '0x' + Number(source.attributes || 0).toString(16),
    selection: source.selection || 'base',
    runtimeProgramId: source.runtimeProgramId,
    originalSource: source.originalSource ? sourceDetails(source.originalSource) : undefined,
  };
}

function printDebugReport(title, content, updateControls, prepared, failure) {
  const report = {
    title: title.toUpperCase(),
    installedContent: content.map((item) => ({
      id: item.id.toUpperCase(), version: item.version,
      type: contentTypes[item.type] || '0x' + item.type.toString(16),
      storage: storageNames[item.storage] || 'Unknown (' + item.storage + ')',
      installType: item.installType,
    })),
    updateControls,
  };
  if (prepared) {
    report.control = prepared.control ? {
      name: prepared.control.name, publisher: prepared.control.publisher, version: prepared.control.version,
      nacpBytes: prepared.control.nacp?.length || 0, iconBytes: prepared.control.icon?.length || 0,
      source: sourceDetails(prepared.control.source),
      iconSource: sourceDetails(prepared.control.iconSource),
      switch2: prepared.control.switch2 ? {
        name: prepared.control.switch2.name, publisher: prepared.control.switch2.publisher,
        version: prepared.control.switch2.version,
        nacpBytes: prepared.control.switch2.nacp?.length || 0,
        iconBytes: prepared.control.switch2.icon?.length || 0,
        source: sourceDetails(prepared.control.switch2.source),
        iconSource: sourceDetails(prepared.control.switch2.iconSource),
      } : undefined,
    } : null;
    report.layers = prepared.views.map((view) => ({
      path: view.path, kind: view.kind, size: view.size,
      files: view.entries.filter((entry) => entry.type === 'file').length,
      directories: view.entries.filter((entry) => entry.type === 'directory').length,
      source: sourceDetails(view.source),
    }));
    report.sources = prepared.sources.map((item) => ({
      kind: ['RomFS storage', 'CodeFS', 'deferred DLC'][item.kind] || item.kind,
      size: item.size, source: sourceDetails(item.source),
    }));
  }
  if (failure) report.prepareError = {
    message: failure.message,
    code: failure.code,
    mountPath: failure.mountPath,
    cause: failure.cause ? { message: failure.cause.message,
      nativeResult: failure.cause.nativeResult } : undefined,
    nativeResult: failure.nativeResult ? {
      raw: failure.nativeResult.raw,
      canonical: failure.nativeResult.canonical,
      name: failure.nativeResult.name,
    } : undefined,
    source: sourceDetails(failure.source),
  };
  console.log(JSON.stringify(report, null, 2));
}

function gameMenu(games) {
  const width = String(games.length).length;
  return games
    .map((game, i) => {
      const number = String(i + 1).padStart(width);
      const name = game.name || 'Unknown title';
      const edition = game.switch2Edition ? ' [Switch 2 Edition]' : '';
      const storages = game.storages.map((id) => storageNames[id]).join(', ');
      return number + '. ' + name + edition + '  [' + game.title.toUpperCase() + ']  (' + storages + ')';
    })
    .join('\n');
}

async function pickGame(games, signal) {
  const input = process.stdin;
  const output = process.stdout;

  if (!games.length) {
    throw new Error('No games were found. How did you even run this?');
  }

  output.write(gameMenu(games) + '\n');

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const close = () => rl.close();
  rl.once('SIGINT', close);
  signal.addEventListener('abort', close, { once: true });

  const prompt = () => output.write('Choose a game: ');

  try {
    if (signal.aborted) return null;

    prompt();

    for await (const line of lines) {
      if (signal.aborted) return null;

      const value = line.trim();

      if (/^q(?:uit)?$/i.test(value)) return null;

      if (/^[0-9]+$/.test(value)) {
        const number = Number(value);

        if (Number.isSafeInteger(number) && number >= 1 && number <= games.length) return games[number - 1];
      }

      output.write('Enter a number from 1 to ' + games.length + ', or q.\n');
      prompt();
    }

    return null;
  } finally {
    signal.removeEventListener('abort', close);
    rl.close();
  }
}

async function promptRunPath({ reason, parent }, signal) {
  console.log(reason);
  if (parent) console.log('Saved runs folder: ' + parent);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const close = () => rl.close();
  signal.addEventListener('abort', close, { once: true });
  rl.once('SIGINT', close);
  try {
    if (signal.aborted) return null;
    process.stdout.write('ns2jb run or runs folder (q to quit): ');
    for await (const line of rl) return /^q(?:uit)?$/i.test(line.trim()) ? null : line;
    return null;
  } finally {
    signal.removeEventListener('abort', close);
    rl.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = getArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const image = await readImage();
  const { port, ip, probe } = options;
  let { run, nup, edition } = options;
  let { title } = options;
  let name;
  const cancellation = new AbortController();
  let ui;
  // a second ctrl-c used to kill node mid cleanup, leaving the server thread running on the console
  // and the game's fs mounts held open. only a third one gives up on cleanup now
  let interrupts = 0;
  const stop = () => {
    interrupts++;
    if (interrupts === 1) {
      console.log('\nStopping, cleaning up the console side. This takes a few seconds');
    } else if (interrupts === 2) {
      console.log('Still cleaning up. Press Ctrl-C again to quit anyway (the console will need a restart)');
    } else {
      process.exit(130);
    }
    cancellation.abort();
  };
  ui = !options.noTui && !probe && !options.debug && supportsTui()
    ? new TerminalUI({ signal: cancellation.signal, onCancel: stop })
    : null;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let attachment;
  let server;
  let completed = false;
  try {
    ui?.start();
    await withCleanup(async () => {
      run = await resolveRun({ provided: run, signal: cancellation.signal,
        prompt: ui ? (details) => ui.requestRunPath(details)
          : process.stdin.isTTY ? (details) => promptRunPath(details, cancellation.signal) : undefined,
        onStatus: (status) => { ui?.setStage(status); console.log(status); },
      });
      if (!run || cancellation.signal.aborted) return;
      console.log('Using RPC run: ' + run);
      ui?.setStage('Connecting to your console');
      attachment = await attachGame(run);
      const shouldStop = () => cancellation.signal.aborted;
      let selectedGame;
      if (!title) {
        ui?.setStage('Reading your game library');
        const games = await discoverGames({ ...attachment, shouldStop });
        if (!games.length) throw new Error('No installed games were found.');
        let selected;
        do {
          selected = ui ? await ui.chooseGame(games) : await pickGame(games, cancellation.signal);
          if (!selected || shouldStop()) return;
          if (ui) {
            const setup = await ui.configure({ game: selected, output: nup, edition });
            if (shouldStop()) return;
            if (!setup) continue;
            ({ nup, edition } = setup);
          }
          break;
        } while (true);
        if (!selected || shouldStop()) return;
        title = selected.title;
        name = selected.name;
        selectedGame = selected;
      } else if (ui) {
        // A supplied title still gets names and edition options in the setup screen.
        const games = await discoverGames({ ...attachment, shouldStop });
        selectedGame = games.find((game) => game.title === title) || { title, name: title, storages: [] };
        name = selectedGame.name;
        const setup = await ui.configure({ game: selectedGame, output: nup, edition });
        if (!setup || shouldStop()) return;
        ({ nup, edition } = setup);
      }
      if (probe) {
        const content = await listApplicationContent({ ...attachment, title });
        console.log('Installed content for ' + title.toUpperCase() + ':');
        for (const c of content) {
          console.log('  ' + c.id.toUpperCase() + '  v' + c.version + '  ' + c.typeName + '  ' + storageNames[c.storage] +
            (c.installType ? '  install type ' + c.installType : ''));
        }
        const patches = await discoverDataPatches({ ...attachment, title });
        if (!patches.length) console.log('  (no add-on data patches)');
        for (const r of await probeDataPatches({ attachment, title, patches })) {
          console.log('Data patch ' + r.contentTitle.toUpperCase() + ' v' + r.version + ':');
          if (r.contentPath) console.log('  content ' + r.contentPath);
          if (r.error) {
            console.log('  could not read it as a RomFS: ' + r.error);
            continue;
          }
          console.log('  RomFS ' + r.size + ' bytes, ' + r.files + ' files');
          if (r.regionLangMask) console.log('  RegionLangMask: ' + r.regionLangMask);
          for (const t of r.tables) console.log('  ' + t);
        }
        return;
      }
      if (options.debug) {
        const content = await listApplicationContent({ ...attachment, title });
        const updateRecords = await discoverUpdates({ ...attachment, title });
        const updateGroups = new Map();
        for (const update of updateRecords) {
          const key = update.contentTitle + ':' + update.version;
          if (!updateGroups.has(key)) updateGroups.set(key, { ...update, storages: [] });
          const group = updateGroups.get(key);
          if (!group.storages.includes(update.storage)) group.storages.push(update.storage);
        }
        const updateControls = [];
        for (const update of updateGroups.values()) {
          let control = null;
          let error;
          try {
            control = await readControl(attachment, title, update.storages, {
              update: { contentTitle: update.contentTitle, version: update.version },
            });
          } catch (caught) {
            error = caught.message;
          }
          updateControls.push({
            contentTitle: update.contentTitle.toUpperCase(), version: update.version,
            storages: update.storages.map((storage) => storageNames[storage] || storage),
            control: control ? {
              name: control.name, publisher: control.publisher, version: control.version,
              nacpBytes: control.nacp?.length || 0, iconBytes: control.icon?.length || 0,
              source: sourceDetails(control.source),
              iconSource: sourceDetails(control.iconSource),
            } : null,
            error,
          });
        }
        let prepared;
        let failure;
        try {
          prepared = await prepareGame({ attachment, title, images: true, edition: 'all', shouldStop });
        } catch (error) {
          failure = error;
        }
        printDebugReport(title, content, updateControls, prepared, failure);
        return;
      }
      let host = ip;
      ui?.setStage('Detecting the console IP', { game: selectedGame, outputFile: nup });
      if (!host) {
        try {
          host = await getConsoleIp(attachment);
        } catch (error) {
          if (nup) throw new Error('Could not detect the console IP: ' + error.message + '\nRun again with --ip <switch 2 ip>.', { cause: error });
          console.warn('Could not detect the console IP; use the address from its network settings.');
        }
      }
      if (shouldStop()) return;
      ui?.setStage('Opening game content', { host });
      const prepared = await prepareGame({ attachment, title, images: Boolean(nup), edition, shouldStop });
      if (shouldStop()) return;
      ui?.setStage('Starting FTP');
      server = await deployFtp({ attachment, image, ...prepared, port });

      if (nup) {
        ui?.setStage('Downloading and packing');
        console.log('FTP up at ' + host + ':' + port + ', downloading into ' + nup);
        await packNup({ host, port, views: prepared.views, title, name, output: nup, edition, control: prepared.control, updateControls: prepared.updateControls, shouldStop,
          onProgress: ui ? (progress) => ui.progress(progress) : undefined });
        completed = true;
        ui?.setStage('Cleaning up the console');
        return;
      }

      ui?.setStage('FTP is ready', { ftpUrl: 'ftp://' + (host || '<switch 2 ip>') + ':' + port });
      console.log('FTP up! ftp://' + (host || '<switch 2 ip>') + ':' + port);
      console.log('Ctrl-C to stop the server');

      while (!shouldStop()) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }, () => server?.close(), () => attachment?.close());
    if (completed && ui) await ui.done();
  } catch (error) {
    if (ui && !cancellation.signal.aborted) {
      ui.log(error.message);
      await ui.done('Could not finish the dump');
    }
    throw error;
  } finally {
    ui?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  if (completed && ui) console.log('Wrote ' + nup + (edition === 'both' ? ' and its -switch2 companion.' : ''));
  else if (ui && cancellation.signal.aborted) console.log('Stopped. Console cleanup finished.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getArgs, pickGame, main };
