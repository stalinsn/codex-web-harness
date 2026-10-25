import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findProjectForCwd } from '../src/projects.mjs';
import { cleanupTurnUploads, saveFiles, validateAttachments } from '../src/uploads.mjs';

test('saved files get server-chosen names and sanitized metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-uploads-'));
  const [part] = await saveFiles(root, 'thread-1', [{ name: '../../etc/passwd\u0007.txt', data: Buffer.from('hi').toString('base64') }]);
  const metadata = JSON.parse(/\n(.*)\n/.exec(part.text)[1]);
  assert.equal(metadata.name, 'passwd.txt');
  assert.ok(metadata.path.startsWith(join(root, 'thread-1')));
  await assert.rejects(saveFiles(root, '../x', []), /Conversa inválida/);
  await assert.rejects(saveFiles(root, 't', [{ name: 'a', data: '***' }]), /inválido/);
});

test('cleanup never deletes outside the thread folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-uploads-'));
  const outside = join(root, 'keep.txt');
  await writeFile(outside, 'x');
  await cleanupTurnUploads(root, 'thread-1', [{ path: outside }], []);
  assert.deepEqual(await readdir(root), ['keep.txt']);
});

test('attachment limits', () => {
  assert.throws(() => validateAttachments({ files: Array(9).fill({ data: '' }) }), /8 anexos/);
  assert.throws(() => validateAttachments({ files: [{ data: 'A'.repeat(33 * 1024 * 1024) }] }), /24 MB/);
});

test('project lookup prefers the most specific folder and respects path boundaries', () => {
  const projects = [{ id: 'a', cwd: '/srv/app' }, { id: 'b', cwd: '/srv/app/api' }];
  assert.equal(findProjectForCwd(projects, '/srv/app/api/src').id, 'b');
  assert.equal(findProjectForCwd(projects, '/srv/app').id, 'a');
  assert.equal(findProjectForCwd(projects, '/srv/application'), null);
  assert.equal(findProjectForCwd(projects, 'relative'), null);
});
