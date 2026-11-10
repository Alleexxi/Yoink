const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const { test } = require('node:test');
const { TerminalUI, supportsTui } = require('../engine/tui.cjs');
const { getArgs } = require('../yoink.cjs');

const games = [
  { title: '010016e004796000', name: 'Bridge Constructor Portal', storages: [4] },
  { title: '0400c3f00006e000', name: 'Mario Kart World', storages: [4] },
  { title: '0100f43008c44000', name: 'Pokémon Legends: Z-A', storages: [2], switch2Edition: true },
];

function terminal(t, { columns = 100, rows = 24 } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = new PassThrough();
  Object.assign(output, { isTTY: true, columns, rows });
  let screen = '';
  output.on('data', (chunk) => { screen += chunk; });
  const controller = new AbortController();
  const originalLog = console.log;
  const ui = new TerminalUI({ input, output, signal: controller.signal, onCancel: () => controller.abort() });
  ui.start();
  t.after(() => { ui.close(); input.destroy(); output.destroy(); });
  const key = (name, text, extra) => input.emit('keypress', text, { name, ...extra });
  return { ui, input, output, controller, originalLog, key, screen: () => screen };
}

test('library supports scrolling, title search, edition badges and selection', async (t) => {
  const { ui, key, screen } = terminal(t);
  const choice = ui.chooseGame(games);
  key('down');
  assert.equal(ui.selected, 1);
  key('slash', '/');
  key('p', 'Poké');
  key('return');
  assert.match(stripVTControlCharacters(screen()), /1 of 3 games/);
  assert.match(stripVTControlCharacters(screen()), /S2 Edition/);
  key('return');
  assert.equal(await choice, games[2]);
});

test('setup edits output paths and editions and can choose FTP', async (t) => {
  const { ui, key } = terminal(t);
  const setup = ui.configure({ game: games[2], edition: 'switch2' });
  key('down');
  key('return');
  key('u', undefined, { ctrl: true });
  key('text', path.resolve('test-output.nup'));
  key('return');
  key('down');
  key('right');
  key('down');
  key('return');
  assert.deepEqual(await setup, { nup: path.resolve('test-output.nup'), edition: 'switch1' });

  const ftp = ui.configure({ game: games[0], edition: 'switch2' });
  key('right');
  key('up');
  key('return');
  assert.deepEqual(await ftp, { nup: undefined, edition: 'switch2' });
});

test('setup validates output before starting and escape returns to the library', async (t) => {
  const { ui, key } = terminal(t);
  const setup = ui.configure({ game: games[2], output: 'missing-extension', edition: 'switch2' });
  key('up');
  key('return');
  assert.match(ui.error, /ending in .nup/);
  key('escape');
  assert.equal(await setup, null);
});

test('abort resolves input and restores the terminal and console', async (t) => {
  const { ui, input, output, controller, originalLog, key, screen } = terminal(t);
  const choice = ui.chooseGame(games);
  key('c', undefined, { ctrl: true });
  assert.equal(await choice, null);
  assert.equal(controller.signal.aborted, true);
  ui.close();
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.equal(console.log, originalLog);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  assert.ok(screen().endsWith('\x1b[?25h\x1b[?1049l'));
});

test('progress, resize and scrollback stay within terminal bounds', async (t) => {
  const { ui, output, key, screen } = terminal(t, { columns: 80, rows: 24 });
  ui.setStage('Downloading and packing', { game: games[2] });
  for (let i = 0; i < 35; i++) console.log('Log', i);
  ui.progress({ path: '/base/romfs.img', done: 512, total: 1024, bytesPerSecond: 128 });
  key('pageup');
  assert.match(stripVTControlCharacters(screen()), /scrollback/);
  output.columns = 40;
  output.rows = 17;
  output.emit('resize');
  const frame = stripVTControlCharacters(screen().split('\x1b[H').at(-1));
  assert.ok(frame.split('\r\n').length <= 16);
  assert.match(frame, /stop safely/);
  output.columns = 30;
  output.emit('resize');
  assert.match(stripVTControlCharacters(screen().split('\x1b[H').at(-1)), /Resize the terminal/);
});

test('non-interactive streams use plain mode and --no-tui is accepted', () => {
  assert.equal(supportsTui(new PassThrough(), new PassThrough()), false);
  assert.equal(getArgs(['run', '--no-tui']).noTui, true);
});

test('completion and error screens remain readable until dismissed', async (t) => {
  const { ui, key, screen } = terminal(t);
  const complete = ui.done();
  assert.match(stripVTControlCharacters(screen()), /DUMP COMPLETE/);
  key('return');
  assert.equal(await complete, true);
  console.error('The console connection closed.');
  const failure = ui.done('Could not finish the dump');
  assert.match(stripVTControlCharacters(screen()), /The console connection closed/);
  key('q', 'q');
  assert.equal(await failure, true);
});

test('first-run screen accepts a pasted path and can be cancelled', async (t) => {
  const { ui, key, screen } = terminal(t);
  const prompt = ui.requestRunPath({ reason: 'No live RPC run was found.', parent: '/old/runs' });
  assert.match(stripVTControlCharacters(screen()), /CONNECT TO NS2JB/);
  key('u', undefined, { ctrl: true });
  key('text', '/new/runs/switch2-current');
  key('return');
  assert.equal(await prompt, '/new/runs/switch2-current');
  const retry = ui.requestRunPath({ reason: 'Try again.', parent: '' });
  key('escape');
  assert.equal(await retry, null);
});

test('Space selects several games across filters and Enter returns the marked queue', async (t) => {
  const { ui, key, screen } = terminal(t);
  const choice = ui.chooseGame(games);
  key('space', ' ');
  key('slash', '/');
  key('text', 'Poké');
  key('return');
  key('space', ' ');
  assert.match(stripVTControlCharacters(screen()), /2 selected/);
  key('slash', '/');
  key('escape');
  assert.equal(ui.marked.size, 2);
  key('return');
  assert.deepEqual(await choice, [games[0], games[2]]);
});

test('explicit batch selection requires marks and supports deselecting and restoring them', async (t) => {
  const { ui, key } = terminal(t);
  const choice = ui.chooseGame(games, { multiple: true, selected: [games[0]] });
  key('space', ' ');
  key('return');
  assert.match(ui.error, /at least one/);
  key('down');
  key('space', ' ');
  key('return');
  assert.deepEqual(await choice, [games[1]]);
});

test('batch setup edits a folder, applies an edition and keeps the action on NUP', async (t) => {
  const { ui, key, screen } = terminal(t);
  const setup = ui.configureBatch({ games: [games[0], games[2]], outputDir: path.resolve('dumps'), edition: 'switch2' });
  assert.match(stripVTControlCharacters(screen()), /BATCH DUMP SETUP/);
  key('right');
  assert.equal(ui.action, 'nup');
  key('down');
  key('return');
  key('u', undefined, { ctrl: true });
  key('text', path.resolve('new batch folder'));
  key('return');
  key('down');
  key('right');
  key('down');
  key('return');
  assert.deepEqual(await setup, { outputDir: path.resolve('new batch folder'), edition: 'switch1' });
});

test('batch setup can go back and progress shows queue position', async (t) => {
  const { ui, key, screen } = terminal(t);
  const setup = ui.configureBatch({ games, edition: 'both' });
  key('escape');
  assert.equal(await setup, null);
  ui.setStage('Opening game content', { game: games[1], batch: { index: 2, total: 3, completed: 1 }, transfer: null });
  assert.match(stripVTControlCharacters(screen()), /Batch 2\/3.*1 completed/);
});
