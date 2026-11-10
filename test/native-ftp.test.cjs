const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { startupError } = require('../engine/ftp.cjs');

test('native FTP restarts on the same port and drains client threads before returning', async (t) => {
  const compiler = ['cc', 'gcc', 'clang'].find((command) => spawnSync(command, ['--version']).status === 0);
  if (!compiler) { t.skip('A host C compiler is needed for the native-server regression test'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yoink-native-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, process.platform === 'win32' ? 'native-test.exe' : 'native-test');
  const build = spawnSync(compiler, ['-std=c11', '-O0', '-fno-builtin', path.join(__dirname, 'native-ftp-harness.c'), '-o', executable], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.error?.message || build.stderr);
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.match(result.stdout, /21 native FTP restarts/);
});

test('native FTP startup errors identify the failed stage instead of always blaming the port', () => {
  const bind = startupError({ result: 0xd401, phase: 3, nativeResult: 48 }, 2121);
  assert.match(bind.message, /during bind.*errno 48/);
  assert.match(bind.message, /port 2121/);
  const validation = startupError({ result: 0xd401, phase: 1, nativeResult: 0 }, 2121);
  assert.match(validation.message, /configuration\/index validation/);
  assert.doesNotMatch(validation.message, /port|errno/);
  const socket = startupError({ result: 0xd401, phase: 2, nativeResult: 24 }, 2121);
  assert.match(socket.message, /socket creation.*errno 24/);
  assert.doesNotMatch(socket.message, /port 2121/);
});
