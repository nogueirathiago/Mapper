#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoragePolicy } from '../lib/sync/storage.js';
import {
  loadProjectRegistry, PROJECTS_REGISTRY_VERSION, registerProject,
} from '../lib/sync/registry.js';

const root = mkdtempSync(join(tmpdir(), 'reversa-registry-'));

function createInstalledProject(path) {
  mkdirSync(join(path, '.reversa'), { recursive: true });
  writeFileSync(join(path, '.reversa', 'state.json'), '{}\n', 'utf8');
}

try {
  const volumeRoot = join(root, 'volume');
  const dataRoot = join(volumeRoot, '.reversa-global');
  const outside = join(root, 'outside');
  const project = join(volumeRoot, 'projects', 'alpha');
  mkdirSync(volumeRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  createInstalledProject(project);

  const policy = createStoragePolicy({ volumeRoot, dataRoot });
  assert.equal(policy.assertOnVolume(project), project);
  assert.throws(() => policy.assertOnVolume(outside), /fora do volume permitido/);

  const escapingLink = join(volumeRoot, 'escaping-link');
  symlinkSync(outside, escapingLink);
  assert.throws(() => policy.assertOnVolume(escapingLink), /fora do volume permitido/);

  assert.deepEqual(loadProjectRegistry({ policy }), {
    version: PROJECTS_REGISTRY_VERSION,
    projects: [],
  });
  assert.deepEqual(registerProject(project, { policy }).projects, [project]);
  assert.deepEqual(registerProject(project, { policy }).projects, [project]);

  const persisted = JSON.parse(readFileSync(policy.projectsRegistryPath, 'utf8'));
  assert.deepEqual(persisted.projects, [project]);

  persisted.projects.push(join(volumeRoot, 'temporarily-unavailable'));
  writeFileSync(policy.projectsRegistryPath, JSON.stringify(persisted), 'utf8');
  assert.equal(loadProjectRegistry({ policy }).projects.length, 2);

  writeFileSync(policy.projectsRegistryPath, '{broken', 'utf8');
  assert.throws(() => loadProjectRegistry({ policy }), /Registro global inválido/);

  writeFileSync(policy.projectsRegistryPath, JSON.stringify({ version: 2, projects: [] }), 'utf8');
  assert.throws(() => loadProjectRegistry({ policy }), /Versão desconhecida/);

  const notInstalled = join(volumeRoot, 'projects', 'not-installed');
  mkdirSync(notInstalled, { recursive: true });
  writeFileSync(policy.projectsRegistryPath, JSON.stringify({ version: 1, projects: [] }), 'utf8');
  assert.throws(() => registerProject(notInstalled, { policy }), /sem instalação Reversa/);

  assert.throws(
    () => createStoragePolicy({ volumeRoot: join(root, 'missing-volume'), dataRoot }),
    /Caminho não encontrado/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('RESULTADO: ✓ registro global restrito ao volume permitido');

