#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installGlobalSyncSkill } from '../lib/sync/global-skill.js';
import { createStoragePolicy } from '../lib/sync/storage.js';

const root = mkdtempSync(join(tmpdir(), 'reversa-global-skill-'));

function createSource(sourceRoot, marker) {
  const skillRoot = join(sourceRoot, 'global-skills', 'reversa-sync-projects');
  mkdirSync(join(skillRoot, 'agents'), { recursive: true });
  writeFileSync(join(skillRoot, 'SKILL.md'), `---\nname: reversa-sync-projects\ndescription: ${marker}\n---\n`, 'utf8');
  writeFileSync(join(skillRoot, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n', 'utf8');
}

try {
  const volumeRoot = join(root, 'volume');
  const dataRoot = join(volumeRoot, '.reversa-global');
  const sourceRoot = join(volumeRoot, 'fork');
  const codexSkillsRoot = join(root, 'fake-home', '.codex', 'skills');
  mkdirSync(sourceRoot, { recursive: true });
  createSource(sourceRoot, 'first');
  const policy = createStoragePolicy({ volumeRoot, dataRoot });

  const first = installGlobalSyncSkill({ sourceRoot, forkPath: sourceRoot, policy, codexSkillsRoot });
  assert.equal(lstatSync(first.discoveryLink).isSymbolicLink(), true);
  assert.equal(resolve(dirname(first.discoveryLink), readlinkSync(first.discoveryLink)), resolve(first.activeSkill));
  assert.equal(readFileSync(join(first.activeSkill, 'SKILL.md'), 'utf8').includes('first'), true);
  assert.deepEqual(JSON.parse(readFileSync(first.configPath, 'utf8')), {
    version: 1, forkPath: sourceRoot, remote: 'origin', branch: 'main',
  });

  createSource(sourceRoot, 'second');
  const second = installGlobalSyncSkill({ sourceRoot, forkPath: sourceRoot, policy, codexSkillsRoot });
  assert.equal(readFileSync(join(second.activeSkill, 'SKILL.md'), 'utf8').includes('second'), true);

  rmSync(second.discoveryLink);
  mkdirSync(second.discoveryLink, { recursive: true });
  writeFileSync(join(second.discoveryLink, 'keep.txt'), 'keep', 'utf8');
  createSource(sourceRoot, 'third');
  assert.throws(
    () => installGlobalSyncSkill({ sourceRoot, forkPath: sourceRoot, policy, codexSkillsRoot }),
    /contém dados reais e foi preservado/,
  );
  assert.equal(readFileSync(join(second.discoveryLink, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(second.activeSkill, 'SKILL.md'), 'utf8').includes('second'), true);
  assert.equal(existsSync(join(root, 'fake-home', '.codex', 'skills', 'other-file')), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('RESULTADO: ✓ skill global instalada por link simbólico seguro');
