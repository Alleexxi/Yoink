const path = require('node:path');
const fs = require('node:fs/promises');
const { titleId, withCleanup, throwIfCancelled } = require('./protocol.cjs');
const { attachGame } = require('./session.cjs');
const { prepareGame } = require('./mounts.cjs');
const { deployFtp } = require('./ftp.cjs');
const { packNup } = require('./nup.cjs');
const { getConsoleIp } = require('./network.cjs');
const { editionOutputs } = require('./outputs.cjs');

function batchFilename(game) {
  const title = titleId(game.title);
  let stem = (game.name || title).replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '').trim().replace(/[. ]+$/, '');
  // Leave room for the title ID and companion suffix on both filesystems.
  while (Buffer.byteLength(stem) > 180) stem = [...stem].slice(0, -1).join('');
  return (stem || title) + ' [' + title.toUpperCase() + '].nup';
}

function parseBatchSelection(value, games) {
  const text = value.trim();
  if (!/^\d+(?:\s*(?:,|\s)\s*\d+)*$/.test(text)) throw new Error('Enter game numbers separated by commas or spaces.');
  const numbers = [...new Set(text.split(/[\s,]+/).map(Number))];
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1 || n > games.length)) {
    throw new Error('Choose game numbers from 1 to ' + games.length + '.');
  }
  return numbers.map((n) => games[n - 1]);
}

async function checkOutputs(job) {
  for (const output of job.outputs) {
    for (const filename of [output, output + '.part']) {
      try { await fs.lstat(filename); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('Batch output already exists: ' + filename + '. Choose another folder or move the existing file.');
    }
  }
}

async function planBatch({ games, outputDir, edition = 'switch2' }) {
  if (!games.length) throw new Error('Select at least one game for the batch.');
  if (!['switch1', 'switch2', 'both', 'all'].includes(edition)) throw new Error('Invalid batch edition.');
  const seen = new Set();
  const jobs = games.map((game) => {
    const title = titleId(game.title);
    if (seen.has(title)) throw new Error('The same game was selected twice: ' + title);
    seen.add(title);
    const output = path.resolve(outputDir, batchFilename(game));
    const outputs = editionOutputs(output, edition).map((target) => target.output);
    return { game, title, output, outputs };
  });
  await fs.mkdir(outputDir, { recursive: true });
  for (const job of jobs) await checkOutputs(job);
  return jobs;
}

// A separate attachment per game releases mounts and native FTP workers before
// the next game starts. Any dump or cleanup failure stops the queue.
async function dumpBatch({ run, games, outputDir, image, port = 2121, ip, edition = 'switch2',
  shouldStop = () => false, onStage = () => {}, onProgress },
  services = { attachGame, prepareGame, deployFtp, packNup, getConsoleIp }) {
  throwIfCancelled(shouldStop);
  const jobs = await planBatch({ games, outputDir, edition });
  const completed = [];
  for (const [index, job] of jobs.entries()) {
    let attachment;
    let server;
    const details = { game: job.game, outputFile: job.output, transfer: null, ftpUrl: null,
      batch: { index: index + 1, total: jobs.length, completed: completed.length } };
    try {
      throwIfCancelled(shouldStop);
      await checkOutputs(job);
      console.log('Batch ' + (index + 1) + '/' + jobs.length + ': ' + (job.game.name || job.title));
      await withCleanup(async () => {
        onStage('Connecting to your console', details);
        attachment = await services.attachGame(run);
        throwIfCancelled(shouldStop);
        const host = ip || await services.getConsoleIp(attachment);
        onStage('Opening game content', { ...details, host });
        const prepared = await services.prepareGame({ attachment, title: job.title, images: true, edition, shouldStop });
        throwIfCancelled(shouldStop);
        onStage('Starting FTP', { ...details, host });
        server = await services.deployFtp({ attachment, image, ...prepared, port });
        throwIfCancelled(shouldStop);
        onStage('Downloading and packing', { ...details, host });
        await services.packNup({ host, port, views: prepared.views, title: job.title, name: job.game.name,
          output: job.output, edition, control: prepared.control, updateControls: prepared.updateControls, shouldStop, onProgress });
        completed.push(job);
      }, async () => {
        onStage('Cleaning up the console', { batch: { ...details.batch, completed: completed.length } });
        await server?.close();
      }, () => attachment?.close());
    } catch (error) {
      error.batch = { completed: [...completed], total: jobs.length, failed: job };
      error.message = 'Batch stopped at ' + (job.game.name || job.title) +
        ' (' + (index + 1) + '/' + jobs.length + '): ' + error.message;
      throw error;
    }
  }
  return { completed, total: jobs.length };
}

module.exports = { batchFilename, parseBatchSelection, planBatch, dumpBatch };
