const path = require('node:path');

// Both editions use one transfer session and produce a separate file per program.
function editionOutputs(output, edition) {
  if (edition !== 'both') return [{ output, edition }];
  const ext = path.extname(output);
  const stem = path.join(path.dirname(output), path.basename(output, ext));
  return [
    { output, edition: 'switch1' },
    { output: stem + '-switch2' + ext, edition: 'switch2' },
  ];
}

module.exports = { editionOutputs };
