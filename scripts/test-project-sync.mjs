#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveManifest } from '../lib/installer/manifest.js';
import { cleanupProjectSyncPlan, applyProjectSync, planProjectSync } from '../lib/sync/project-sync.js';
import { createStoragePolicy } from '../lib/sync/storage.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'reversa-project-sync-'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function createProject(projectRoot) {
  mkdirSync(join(projectRoot, '.reversa', '_config'), { recursive: true });
  writeFileSync(join(projectRoot, '.reversa', 'state.json'), JSON.stringify({
    version: '1.3.3',
    output_folder: '_reversa_sdd',
    forward_folder: '_reversa_forward',
    engines: ['codex'],
    agents: ['reversa'],
    created_files: [],
  }, null, 2), 'utf8');

  const updateRel = '.agents/skills/reversa/SKILL.md';
  const modifiedRel = '.agents/skills/reversa-reviewer/SKILL.md';
  const conflictRel = '.agents/skills/reversa-new/SKILL.md';
  const oldUpdate = 'old managed reversa\n';
  const oldModified = 'old managed reviewer\n';
  const userPolicy = '{"allowLegacyEdits":true,"allowedPaths":[]}\n';
  write(join(projectRoot, updateRel), oldUpdate);
  write(join(projectRoot, modifiedRel), 'local reviewer customization\n');
  write(join(projectRoot, conflictRel), 'unmanaged local collision\n');
  write(join(projectRoot, '.reversa', 'reversa-config.json'), userPolicy);
  saveManifest(projectRoot, {
    [updateRel]: sha256(oldUpdate),
    [modifiedRel]: sha256(oldModified),
    '.reversa/reversa-config.json': sha256(userPolicy),
  });
  write(join(projectRoot, '_reversa_sdd', 'domain.md'), 'analysis must remain unchanged\n');
  return { updateRel, modifiedRel, conflictRel };
}

try {
  const volumeRoot = join(root, 'volume');
  const dataRoot = join(volumeRoot, '.reversa-global');
  const projectRoot = join(volumeRoot, 'projects', 'alpha');
  mkdirSync(volumeRoot, { recursive: true });
  const rel = createProject(projectRoot);
  const policy = createStoragePolicy({ volumeRoot, dataRoot });
  const artifactPath = join(projectRoot, '_reversa_sdd', 'domain.md');
  const artifactBefore = readFileSync(artifactPath, 'utf8');
  const artifactMtime = statSync(artifactPath).mtimeMs;

  const commit = 'a'.repeat(40);
  const plan = await planProjectSync(projectRoot, { sourceCommit: commit, policy });
  assert.ok(plan.updates.some(item => item.relPath === rel.updateRel));
  assert.ok(plan.modified.some(item => item.relPath === rel.modifiedRel));
  assert.ok(plan.modified.some(item => item.relPath === '.reversa/reversa-config.json'));
  assert.ok(plan.conflicts.some(item => item.relPath === rel.conflictRel));
  assert.ok(plan.missing.some(item => item.relPath === '.agents/skills/reversa-scout/SKILL.md'));

  const result = applyProjectSync(plan);
  assert.equal(result.sourceCommit, commit);
  assert.equal(readFileSync(join(projectRoot, rel.updateRel), 'utf8'), readFileSync(join(REPO_ROOT, 'agents', 'reversa', 'SKILL.md'), 'utf8'));
  assert.equal(readFileSync(join(projectRoot, rel.modifiedRel), 'utf8'), 'local reviewer customization\n');
  assert.equal(readFileSync(join(projectRoot, rel.conflictRel), 'utf8'), 'unmanaged local collision\n');
  assert.equal(readFileSync(join(projectRoot, '.reversa', 'reversa-config.json'), 'utf8'), '{"allowLegacyEdits":true,"allowedPaths":[]}\n');
  assert.ok(existsSync(join(projectRoot, '.agents', 'skills', 'reversa-scout', 'SKILL.md')));
  assert.equal(readFileSync(artifactPath, 'utf8'), artifactBefore);
  assert.equal(statSync(artifactPath).mtimeMs, artifactMtime);

  const state = JSON.parse(readFileSync(join(projectRoot, '.reversa', 'state.json'), 'utf8'));
  assert.equal(state.fork_source.commit, commit);
  const manifest = JSON.parse(readFileSync(join(projectRoot, '.reversa', '_config', 'files-manifest.json'), 'utf8'));
  assert.equal(manifest[rel.modifiedRel], sha256('old managed reviewer\n'));
  assert.equal(manifest[rel.conflictRel], undefined);

  cleanupProjectSyncPlan(plan);
  assert.equal(existsSync(plan.snapshotRoot), false);

  const changedProject = join(volumeRoot, 'projects', 'changed');
  createProject(changedProject);
  const changedPlan = await planProjectSync(changedProject, { sourceCommit: commit, policy });
  const changedStatePath = join(changedProject, '.reversa', 'state.json');
  writeFileSync(changedStatePath, readFileSync(changedStatePath, 'utf8') + '\n', 'utf8');
  assert.throws(() => applyProjectSync(changedPlan), /mudou depois do planejamento/);
  cleanupProjectSyncPlan(changedPlan);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('RESULTADO: ✓ sincronização conservadora por projeto');
