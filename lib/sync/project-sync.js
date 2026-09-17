import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ENGINES } from '../installer/detector.js';
import { hashFile, saveManifest } from '../installer/manifest.js';
import { listAllAgents } from '../installer/prompts.js';
import { Writer } from '../installer/writer.js';
import { readJsonSafe } from '../utils/json-safe.js';
import { createStoragePolicy } from './storage.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE = readJsonSafe(join(REPO_ROOT, 'package.json'));

function readInstalledState(projectRoot) {
  const statePath = join(projectRoot, '.reversa', 'state.json');
  if (!existsSync(statePath)) throw new Error(`Projeto sem instalação Reversa reconhecida: ${projectRoot}`);
  try {
    const state = readJsonSafe(statePath);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state inválido');
    if (!Array.isArray(state.engines)) throw new Error('engines ausente');
    return state;
  } catch (error) {
    throw new Error(`Estado Reversa inválido: ${statePath}`, { cause: error });
  }
}

function readStrictManifest(projectRoot) {
  const manifestPath = join(projectRoot, '.reversa', '_config', 'files-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Manifesto Reversa ausente: ${manifestPath}`);
  try {
    const manifest = readJsonSafe(manifestPath);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('objeto esperado');
    for (const [path, hash] of Object.entries(manifest)) {
      if (!path || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
        throw new Error(`entrada inválida: ${path}`);
      }
    }
    return manifest;
  } catch (error) {
    throw new Error(`Manifesto Reversa inválido: ${manifestPath}`, { cause: error });
  }
}

function writeDesiredVersion(snapshotRoot, writer) {
  const versionPath = join(snapshotRoot, '.reversa', 'version');
  mkdirSync(dirname(versionPath), { recursive: true });
  writeFileSync(versionPath, PACKAGE.version, 'utf8');
  const relPath = '.reversa/version';
  if (!writer.manifestPaths.includes(relPath)) writer.manifestPaths.push(relPath);
  if (!writer.createdFiles.includes(relPath)) writer.createdFiles.push(relPath);
}

async function buildDesiredSnapshot(state, policy) {
  policy.ensureLayout();
  const snapshotRoot = mkdtempSync(join(policy.tmpDir, 'project-snapshot-'));
  const writer = new Writer(snapshotRoot);
  const installedEngines = ENGINES.filter(engine => state.engines.includes(engine.id));
  if (installedEngines.length === 0) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw new Error('Projeto sem engine Reversa reconhecida no state.json');
  }

  for (const agent of listAllAgents()) {
    for (const engine of installedEngines) {
      await writer.installSkill(agent, engine.skillsDir);
      if (engine.universalSkillsDir && engine.universalSkillsDir !== engine.skillsDir) {
        await writer.installSkill(agent, engine.universalSkillsDir);
      }
    }
  }

  const seenEntries = new Set();
  for (const engine of installedEngines) {
    if (!engine.entryFile || seenEntries.has(engine.entryFile)) continue;
    seenEntries.add(engine.entryFile);
    await writer.installEntryFile(engine, {
      force: true,
      outputFolder: state.output_folder,
      forwardFolder: state.forward_folder,
    });
  }

  writer.refreshForwardAssets(new Set());
  const createOnlyStart = writer.manifestPaths.length;
  writer.ensureReversaConfig();
  writer.installPolicyHooks();
  const createOnlyPaths = new Set(writer.manifestPaths.slice(createOnlyStart));
  writeDesiredVersion(snapshotRoot, writer);

  return {
    snapshotRoot,
    desiredPaths: [...new Set(writer.manifestPaths)].sort(),
    createdFiles: [...new Set(writer.createdFiles)].sort(),
    createOnlyPaths,
  };
}

function itemFor(projectRoot, snapshotRoot, relPath, manifest) {
  const sourcePath = join(snapshotRoot, relPath);
  const destPath = join(projectRoot, relPath);
  const desiredHash = hashFile(sourcePath);
  const currentHash = hashFile(destPath);
  return {
    relPath,
    sourcePath,
    destPath,
    desiredHash,
    currentHash,
    baselineHash: manifest[relPath] ?? null,
  };
}

export async function planProjectSync(projectRoot, {
  sourceCommit,
  policy = createStoragePolicy(),
} = {}) {
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit ?? '')) {
    throw new Error(`Commit de origem inválido: ${sourceCommit ?? 'ausente'}`);
  }

  const physicalRoot = policy.assertOnVolume(projectRoot);
  const state = readInstalledState(physicalRoot);
  const manifest = readStrictManifest(physicalRoot);
  const snapshot = await buildDesiredSnapshot(state, policy);
  const plan = {
    projectRoot: physicalRoot,
    sourceCommit,
    state,
    stateHash: hashFile(join(physicalRoot, '.reversa', 'state.json')),
    manifest,
    snapshotRoot: snapshot.snapshotRoot,
    createdFiles: snapshot.createdFiles,
    updates: [],
    missing: [],
    modified: [],
    conflicts: [],
    unchanged: [],
    obsolete: [],
  };

  for (const relPath of snapshot.desiredPaths) {
    const item = itemFor(physicalRoot, snapshot.snapshotRoot, relPath, manifest);
    if (!item.currentHash) {
      plan.missing.push(item);
    } else if (snapshot.createOnlyPaths.has(relPath)) {
      if (item.currentHash === item.desiredHash) plan.unchanged.push(item);
      else plan.modified.push(item);
    } else if (item.baselineHash) {
      if (item.currentHash !== item.baselineHash) plan.modified.push(item);
      else if (item.currentHash === item.desiredHash) plan.unchanged.push(item);
      else plan.updates.push(item);
    } else if (item.currentHash === item.desiredHash) {
      plan.unchanged.push(item);
    } else {
      plan.conflicts.push(item);
    }
  }

  const desiredSet = new Set(snapshot.desiredPaths);
  for (const relPath of Object.keys(manifest)) {
    if (!desiredSet.has(relPath)) plan.obsolete.push({ relPath, baselineHash: manifest[relPath] });
  }
  return plan;
}

function assertPlanStillCurrent(plan) {
  const statePath = join(plan.projectRoot, '.reversa', 'state.json');
  if (hashFile(statePath) !== plan.stateHash) {
    throw new Error(`Projeto mudou depois do planejamento: ${plan.projectRoot}`);
  }
  for (const item of plan.updates) {
    if (hashFile(item.destPath) !== item.currentHash) {
      throw new Error(`Arquivo mudou depois do planejamento: ${item.relPath}`);
    }
  }
  for (const item of plan.missing) {
    if (existsSync(item.destPath)) {
      throw new Error(`Arquivo surgiu depois do planejamento: ${item.relPath}`);
    }
  }
}

export function applyProjectSync(plan) {
  assertPlanStillCurrent(plan);
  const installed = [...plan.updates, ...plan.missing];
  for (const item of installed) {
    mkdirSync(dirname(item.destPath), { recursive: true });
    cpSync(item.sourcePath, item.destPath);
  }

  const nextManifest = { ...plan.manifest };
  for (const item of [...installed, ...plan.unchanged]) {
    nextManifest[item.relPath] = item.desiredHash;
  }

  const statePath = join(plan.projectRoot, '.reversa', 'state.json');
  const state = readInstalledState(plan.projectRoot);
  state.version = PACKAGE.version;
  state.agents = listAllAgents();
  state.created_files = [...new Set([...(state.created_files ?? []), ...plan.createdFiles])].sort();
  state.fork_source = {
    remote: 'origin',
    branch: 'main',
    commit: plan.sourceCommit,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  if (nextManifest['.reversa/state.json']) nextManifest['.reversa/state.json'] = hashFile(statePath);
  saveManifest(plan.projectRoot, nextManifest);

  return {
    projectRoot: plan.projectRoot,
    sourceCommit: plan.sourceCommit,
    updated: plan.updates.length,
    restored: plan.missing.length,
    preserved: plan.modified.length,
    conflicts: plan.conflicts.length,
    unchanged: plan.unchanged.length,
    obsolete: plan.obsolete.length,
  };
}

export function cleanupProjectSyncPlan(plan) {
  if (!plan?.snapshotRoot) return;
  rmSync(plan.snapshotRoot, { recursive: true, force: true });
}
