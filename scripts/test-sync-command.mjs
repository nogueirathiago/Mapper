#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreparedSync } from '../lib/commands/sync-projects.js';
import { saveManifest } from '../lib/installer/manifest.js';
import { saveProjectRegistry } from '../lib/sync/registry.js';
import { prepareValidatedMain } from '../lib/sync/source.js';
import { createStoragePolicy } from '../lib/sync/storage.js';

const root = mkdtempSync(join(tmpdir(), 'reversa-sync-command-'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function run(file, args, options = {}) {
  return execFileSync(file, args, { stdio: 'pipe', ...options });
}

function createGitFixture(volumeRoot) {
  const repo = join(volumeRoot, 'fork');
  const remote = join(volumeRoot, 'remote.git');
  mkdirSync(repo, { recursive: true });
  run('git', ['init', '--initial-branch=main'], { cwd: repo });
  run('git', ['config', 'user.name', 'Reversa Test'], { cwd: repo });
  run('git', ['config', 'user.email', 'reversa@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'reversa-source-fixture', version: '1.0.0', type: 'module', scripts: { verify: 'node verify.mjs' },
  }, null, 2), 'utf8');
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({
    name: 'reversa-source-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'reversa-source-fixture', version: '1.0.0' } },
  }, null, 2), 'utf8');
  writeFileSync(join(repo, 'verify.mjs'), "console.log('fixture verified');\n", 'utf8');
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-m', 'fixture'], { cwd: repo });
  run('git', ['init', '--bare', remote]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: repo });
  return repo;
}

function createInstalledProject(projectRoot) {
  mkdirSync(join(projectRoot, '.reversa', '_config'), { recursive: true });
  writeFileSync(join(projectRoot, '.reversa', 'state.json'), JSON.stringify({
    version: '1.3.3', output_folder: '_reversa_sdd', forward_folder: '_reversa_forward', engines: ['codex'], agents: [], created_files: [],
  }), 'utf8');
  const relPath = '.agents/skills/reversa/SKILL.md';
  const old = 'old\n';
  mkdirSync(join(projectRoot, '.agents', 'skills', 'reversa'), { recursive: true });
  writeFileSync(join(projectRoot, relPath), old, 'utf8');
  saveManifest(projectRoot, { [relPath]: sha256(old) });
}

try {
  const volumeRoot = join(root, 'volume');
  const dataRoot = join(volumeRoot, '.reversa-global');
  mkdirSync(volumeRoot, { recursive: true });
  const policy = createStoragePolicy({ volumeRoot, dataRoot });
  const forkPath = createGitFixture(volumeRoot);
  const prepared = prepareValidatedMain({ policy, forkPath });
  assert.match(prepared.commit, /^[a-f0-9]{40}$/);
  assert.ok(prepared.stageRoot.startsWith(policy.tmpDir));
  assert.ok(existsSync(join(prepared.stageRoot, 'package.json')));
  prepared.cleanup();
  assert.equal(existsSync(prepared.stageRoot), false);

  const goodProject = join(volumeRoot, 'projects', 'good');
  createInstalledProject(goodProject);
  saveProjectRegistry({
    version: 1,
    projects: [goodProject, join(volumeRoot, 'projects', 'unavailable')],
  }, { policy });

  const output = { log() {}, error() {} };
  const cancelled = await runPreparedSync({
    sourceCommit: 'b'.repeat(40), policy, confirm: async () => false, output,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(readFileSync(join(goodProject, '.agents', 'skills', 'reversa', 'SKILL.md'), 'utf8'), 'old\n');

  const applied = await runPreparedSync({
    sourceCommit: 'b'.repeat(40), policy, confirm: async () => true, output,
  });
  assert.equal(applied.results.length, 1);
  assert.equal(applied.failures.length, 1);
  assert.notEqual(readFileSync(join(goodProject, '.agents', 'skills', 'reversa', 'SKILL.md'), 'utf8'), 'old\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('RESULTADO: ✓ comando de sincronização e origem validada');

