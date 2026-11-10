const path = require('node:path');
const fs = require('node:fs');
const { emitKeypressEvents } = require('node:readline');
const { format, stripVTControlCharacters } = require('node:util');

const storages = { 2: 'Game card', 4: 'Internal', 5: 'SD' };
const editions = ['switch2', 'switch1', 'both', 'all'];
const editionNames = ['Switch 2 Edition', 'Original Switch', 'Both editions, separate files', 'All packages in one file'];
const clean = (value) => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cellWidth = (text) => {
  const c = text.codePointAt(0);
  return /\p{Extended_Pictographic}/u.test(text) || c >= 0x1100 && (
    c <= 0x115f || c >= 0x2e80 && c <= 0xa4cf || c >= 0xac00 && c <= 0xd7a3 ||
    c >= 0xf900 && c <= 0xfaff || c >= 0xfe10 && c <= 0xfe6f ||
    c >= 0xff00 && c <= 0xff60 || c >= 0xffe0 && c <= 0xffe6 || c >= 0x20000
  ) ? 2 : 1;
};

function fit(value, width) {
  let text = '';
  let cells = 0;
  for (const { segment } of segments.segment(clean(value))) {
    const size = cellWidth(segment);
    if (cells + size > width) break;
    text += segment;
    cells += size;
  }
  return text + ' '.repeat(Math.max(0, width - cells));
}

function bytes(value) {
  if (!Number.isFinite(value)) return '--';
  const scale = value >= 1024 ** 3 ? 1024 ** 3 : value >= 1024 ** 2 ? 1024 ** 2 : value >= 1024 ? 1024 : 1;
  return (value / scale).toFixed(scale === 1 ? 0 : 1) + ' ' + ({ 1: 'B', 1024: 'KiB', 1048576: 'MiB', 1073741824: 'GiB' })[scale];
}

function defaultOutput(game) {
  const stem = (game.name || game.title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
  return path.resolve((stem || game.title) + '.nup');
}

class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout, signal, onCancel }) {
    Object.assign(this, { input, output, signal, onCancel });
    this.logs = [];
    this.mode = 'busy';
    this.stage = 'Connecting to your console';
    this.logOffset = 0;
    this.keypress = (text, key = {}) => this.key(text, key);
    this.resize = () => this.render();
    this.abort = () => { this.mode = 'busy'; this.stage = 'Stopping and cleaning up the console'; this.resolve(null); this.render(); };
    this.end = () => this.onCancel();
  }

  start() {
    this.wasRaw = Boolean(this.input.isRaw);
    this.wasFlowing = this.input.readableFlowing === true;
    this.savedConsole = Object.fromEntries(['log', 'warn', 'error'].map((key) => [key, console[key]]));
    for (const key of Object.keys(this.savedConsole)) console[key] = (...args) => this.log(format(...args));
    this.output.write('\x1b[?1049h\x1b[?25l');
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', this.keypress);
    this.input.on('end', this.end);
    this.output.on('resize', this.resize);
    this.signal.addEventListener('abort', this.abort, { once: true });
    this.render();
  }

  close() {
    if (!this.savedConsole) return;
    Object.assign(console, this.savedConsole);
    this.savedConsole = null;
    this.resolve(null);
    this.input.removeListener('keypress', this.keypress);
    this.input.removeListener('end', this.end);
    this.output.removeListener('resize', this.resize);
    this.signal.removeEventListener('abort', this.abort);
    this.input.setRawMode(this.wasRaw);
    if (!this.wasFlowing) this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l');
  }

  log(message) {
    this.logs.push(...String(message).split(/\r?\n/).map(clean));
    this.logs = this.logs.slice(-200);
    this.render();
  }

  setStage(stage, details = {}) {
    this.mode = 'busy';
    this.stage = stage;
    Object.assign(this, details);
    this.render();
  }

  progress(progress) {
    this.transfer = progress;
    this.render();
  }

  wait() {
    if (this.signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => { this.pending = resolve; this.render(); });
  }

  resolve(value) {
    const pending = this.pending;
    this.pending = null;
    pending?.(value);
  }

  chooseGame(games, { multiple = false, selected = [] } = {}) {
    this.games = games;
    this.multiple = multiple;
    this.marked = new Set(selected.map((game) => game.title));
    this.error = '';
    this.query = '';
    this.searching = false;
    this.selected = 0;
    this.mode = 'games';
    return this.wait();
  }

  requestRunPath({ reason, parent }) {
    this.mode = 'runtime';
    this.runPath = parent || '';
    this.runReason = reason;
    return this.wait();
  }

  configure({ game, output, edition, games = null }) {
    this.game = game;
    this.batchGames = games;
    this.outputFile = output || (games ? path.resolve('dumps') : defaultOutput(game));
    this.action = 'nup';
    this.edition = edition;
    this.field = 0;
    this.editing = false;
    this.error = '';
    this.mode = 'options';
    return this.wait();
  }

  configureBatch({ games, outputDir, edition }) {
    return this.configure({ games, output: outputDir, edition,
      game: { ...games[0], name: games.length + ' selected games',
        switch2Edition: games.some((game) => game.switch2Edition) } });
  }

  done(stage = 'Dump complete') {
    this.mode = 'done';
    this.stage = stage;
    return this.wait();
  }

  filtered() {
    const query = this.query.toLocaleLowerCase();
    return this.games.filter((game) => (game.name || '').toLocaleLowerCase().includes(query) || game.title.includes(query));
  }

  key(text, key) {
    if (key.ctrl && key.name === 'c') { this.onCancel(); return; }
    if (this.signal.aborted) return;
    if (this.mode === 'runtime') {
      if (key.name === 'escape') { this.resolve(null); return; }
      if (key.name === 'return') { this.resolve(this.runPath); return; }
      if (key.ctrl && key.name === 'u') this.runPath = '';
      else if (key.name === 'backspace') this.runPath = [...this.runPath].slice(0, -1).join('');
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) this.runPath += text;
    } else if (this.mode === 'games') {
      if (this.searching) {
        if (key.name === 'escape') { this.searching = false; this.query = ''; }
        else if (key.name === 'return') this.searching = false;
        else if (key.name === 'backspace') this.query = [...this.query].slice(0, -1).join('');
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) this.query += text;
        this.selected = 0;
      } else {
        const games = this.filtered();
        if (key.name === 'escape' || text === 'q') { this.resolve(null); return; }
        if (text === '/') this.searching = true;
        if (key.name === 'up') this.selected--;
        if (key.name === 'down') this.selected++;
        if (key.name === 'pageup') this.selected -= this.pageSize || 5;
        if (key.name === 'pagedown') this.selected += this.pageSize || 5;
        if (key.name === 'home') this.selected = 0;
        if (key.name === 'end') this.selected = games.length - 1;
        this.selected = Math.max(0, Math.min(this.selected, games.length - 1));
        if (key.name === 'space' && games[this.selected]) {
          const title = games[this.selected].title;
          if (this.marked.has(title)) this.marked.delete(title);
          else this.marked.add(title);
          this.error = '';
        }
        if (key.name === 'return') {
          if (this.marked.size) { this.resolve(this.games.filter((game) => this.marked.has(game.title))); return; }
          if (this.multiple) this.error = 'Press Space to select at least one game.';
          else if (games[this.selected]) { this.game = games[this.selected]; this.resolve(this.game); return; }
        }
      }
    } else if (this.mode === 'options') {
      if (this.editing) {
        if (key.name === 'escape') { this.outputFile = this.beforeEdit; this.editing = false; }
        else if (key.name === 'return') this.editing = false;
        else if (key.ctrl && key.name === 'u') this.outputFile = '';
        else if (key.name === 'backspace') this.outputFile = [...this.outputFile].slice(0, -1).join('');
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) this.outputFile += text;
      } else {
        if (key.name === 'escape' || text === 'q') { this.resolve(null); return; }
        if (key.name === 'down' || key.name === 'tab' && !key.shift) this.field = (this.field + 1) % 4;
        if (key.name === 'up' || key.name === 'tab' && key.shift) this.field = (this.field + 3) % 4;
        if (['left', 'right', 'return', 'space'].includes(key.name)) {
          const direction = key.name === 'left' ? -1 : 1;
          if (this.field === 0 && !this.batchGames) this.action = this.action === 'nup' ? 'ftp' : 'nup';
          else if (this.field === 1 && key.name === 'return' && this.action === 'nup') {
            this.beforeEdit = this.outputFile; this.editing = true;
          } else if (this.field === 2 && this.game.switch2Edition) {
            this.edition = editions[(editions.indexOf(this.edition) + direction + editions.length) % editions.length];
          } else if (this.field === 3 && key.name === 'return') {
            const output = path.resolve(this.outputFile.trim() || '.');
            if (this.batchGames) {
              if (!this.outputFile.trim()) this.error = 'Choose an output folder.';
              else {
                try {
                  if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) this.error = 'The output path is not a folder.';
                  else { this.resolve({ outputDir: output, edition: this.edition }); return; }
                } catch (error) { this.error = error.message; }
              }
            } else if (this.action === 'nup' && (!this.outputFile.trim() || !/\.nup$/i.test(output))) this.error = 'Choose an output filename ending in .nup.';
            else if (this.action === 'nup' && !fs.existsSync(path.dirname(output))) this.error = 'The output folder does not exist.';
            else { this.resolve({ nup: this.action === 'nup' ? output : undefined, edition: this.edition }); return; }
          }
        }
      }
    } else if (this.mode === 'done') {
      if (key.name === 'return' || key.name === 'escape' || text === 'q') { this.resolve(true); return; }
    } else if (key.name === 'escape' || text === 'q') { this.onCancel(); return; }
    if (this.mode === 'busy' || this.mode === 'done') {
      if (key.name === 'pageup') this.logOffset = Math.min(Math.max(0, this.logs.length - 1), this.logOffset + 5);
      if (key.name === 'pagedown') this.logOffset = Math.max(0, this.logOffset - 5);
    }
    this.render();
  }

  render() {
    if (!this.savedConsole) return;
    const width = Math.max(1, Math.min(this.output.columns || 80, 120) - 1);
    const height = Math.max(1, (this.output.rows || 24) - 1);
    const rows = [];
    const color = (text, code) => process.env.NO_COLOR === undefined ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
    const add = (text = '', code) => rows.push(code ? color(fit(text, width), code) : fit(text, width));
    add(' YOINK  /  Your games, packed to go', '1;36');
    add('─'.repeat(width), '90');
    let footer;
    if (width < 38 || height < 16) {
      add(' Resize the terminal to at least 40 × 17.');
      add(' Ctrl+C to exit safely.');
      this.output.write('\x1b[H' + rows.slice(0, height).join('\r\n') + '\x1b[J');
      return;
    }
    if (this.mode === 'runtime') {
      add(' CONNECT TO NS2JB', '1');
      add();
      add(' Enter the run folder, or its parent runs folder.');
      add(' Yoink will remember the parent and find a live run next time.', '90');
      add();
      add(' Path  ' + this.runPath + '▏', '30;46');
      add();
      // Split long validation errors so the useful part remains visible on small terminals.
      const message = clean(this.runReason);
      for (let at = 0; at < message.length && rows.length < height - 3; at += width - 2) add(' ' + message.slice(at, at + width - 2), '33');
      footer = ' Type or paste path  ·  Ctrl+U clear  ·  Enter connect  ·  Esc quit';
    } else if (this.mode === 'games') {
      const games = this.filtered();
      add(' LIBRARY  /  ' + games.length + ' of ' + this.games.length + ' games');
      add(this.multiple || this.marked.size ? ' BATCH  /  ' + this.marked.size + ' selected' : ' Space marks games for a batch', '36');
      add(' Search: ' + (this.query || (this.searching ? '' : 'press / to filter')) + (this.searching ? '▏' : ''), this.searching ? '36' : '90');
      add();
      this.pageSize = Math.max(1, height - 13);
      const start = Math.max(0, Math.min(this.selected - Math.floor(this.pageSize / 2), games.length - this.pageSize));
      for (let i = start; i < Math.min(games.length, start + this.pageSize); i++) {
        const game = games[i];
        add(' ' + (i === this.selected ? '› ' : '  ') + (this.marked.has(game.title) ? '[x] ' : '[ ] ') + (game.switch2Edition ? '[S2 Edition] ' : game.title.startsWith('04') ? '[Switch 2] ' : '[Switch] ') + (game.name || game.title), i === this.selected ? '30;46' : undefined);
      }
      if (!games.length) add(' No games match your search.', '90');
      while (rows.length < height - 6) add();
      const selected = games[this.selected];
      add(selected ? ' ' + selected.title.toUpperCase() + '  ·  ' + selected.storages.map((id) => storages[id]).join(', ') : '');
      add(this.error || (selected?.switch2Edition ? ' Switch 2 Edition program installed' : ''), this.error ? '33' : undefined);
      footer = this.searching ? ' Type to filter  ·  Enter apply  ·  Esc clear' : ' ↑↓ · Space mark · Enter next · / search · q quit';
    } else if (this.mode === 'options') {
      add(this.batchGames ? ' BATCH DUMP SETUP' : ' DUMP SETUP', '1');
      add(' ' + (this.game.name || this.game.title), '36');
      add();
      const field = (index, label, value) => add(' ' + (this.field === index ? '› ' : '  ') + label + '  ' + value, this.field === index ? '30;46' : undefined);
      field(0, 'Action ', this.batchGames ? 'Save a NUP per game' : this.action === 'nup' ? '‹ Save NUP ›' : '‹ Serve FTP ›');
      field(1, this.batchGames ? 'Folder ' : 'Output ', this.action === 'nup' ? this.outputFile + (this.editing ? '▏' : '') : 'Connect using your own FTP client');
      field(2, 'Edition', this.game.switch2Edition ? '‹ ' + editionNames[editions.indexOf(this.edition)] + ' ›' : 'Standard game');
      add();
      field(3, '', this.batchGames ? 'Start batch →' : this.action === 'nup' ? 'Start dump →' : 'Start FTP →');
      add(this.error ? ' ' + this.error : '', '33');
      footer = this.editing ? ' Type path  ·  Ctrl+U clear  ·  Enter save  ·  Esc undo' : ' ↑↓ fields  ·  ←→ change  ·  Enter edit/start  ·  Esc back';
    } else {
      add(' ' + this.stage.toUpperCase(), '1;36');
      if (this.batch) add(' Batch ' + this.batch.index + '/' + this.batch.total + '  ·  ' + this.batch.completed + ' completed', '36');
      add(' ' + (this.game?.name || this.game?.title || 'Keep SmileBASIC and the RPC connection open.'));
      if (this.host) add(' Console  ' + this.host);
      if (this.outputFile) add(' Output   ' + this.outputFile);
      if (this.ftpUrl) add(' FTP      ' + this.ftpUrl, '32');
      add();
      const transfer = this.transfer;
      if (transfer) {
        const ratio = transfer.total ? Math.min(1, transfer.done / transfer.total) : 1;
        const bar = Math.max(1, width - 13);
        const count = Math.floor(ratio * bar);
        add(' [' + '━'.repeat(count) + '─'.repeat(bar - count) + '] ' + Math.floor(ratio * 100) + '%', '36');
        const remaining = transfer.bytesPerSecond > 0 ? Math.ceil(Math.max(0, transfer.total - transfer.done) / transfer.bytesPerSecond) : null;
        const eta = remaining === null ? '' : '  ·  ETA ' + Math.floor(remaining / 60) + 'm ' + remaining % 60 + 's';
        add(' ' + bytes(transfer.done) + ' / ' + bytes(transfer.total) + '  ·  ' + bytes(transfer.bytesPerSecond) + '/s' + eta);
        add(' ' + transfer.path, '90');
      }
      add();
      add(' ACTIVITY' + (this.logOffset ? '  /  scrollback' : ''), '90');
      const capacity = Math.max(1, height - rows.length - 3);
      const end = Math.max(0, this.logs.length - this.logOffset);
      for (const log of this.logs.slice(Math.max(0, end - capacity), end)) add(' ' + log);
      footer = this.mode === 'done' ? ' Enter close  ·  PgUp/PgDn activity' : ' q / Ctrl+C stop safely  ·  PgUp/PgDn activity';
    }
    rows.splice(height - 2);
    while (rows.length < height - 2) add();
    add('─'.repeat(width), '90');
    add(footer, '90');
    this.output.write('\x1b[H' + rows.slice(0, height).join('\r\n') + '\x1b[J');
  }
}

function supportsTui(input = process.stdin, output = process.stdout) {
  return Boolean(input.isTTY && output.isTTY && input.setRawMode && process.env.TERM !== 'dumb');
}

module.exports = { TerminalUI, supportsTui };
