import {
  cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { createStoragePolicy } from './storage.js';
import { SYNC_CONFIG_VERSION } from './source.js';

export const GLOBAL_SKILL_NAME = 'reversa-sync-projects';

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

export function installGlobalSyncSkill({
  sourceRoot,
  forkPath,
  policy = createStoragePolicy(),
  codexSkillsRoot = join(homedir(), '.codex', 'skills'),
} = {}) {
  policy.ensureLayout();
  const physicalSourceRoot = policy.assertOnVolume(sourceRoot);
  const physicalFork = policy.assertOnVolume(forkPath);
  const sourceSkill = join(physicalSourceRoot, 'global-skills', GLOBAL_SKILL_NAME);
  if (!existsSync(join(sourceSkill, 'SKILL.md'))) {
    throw new Error(`Fonte da skill global ausente: ${sourceSkill}`);
  }

  const activeSkill = join(policy.skillDir, GLOBAL_SKILL_NAME);
  const stagedSkill = join(policy.skillDir, `.${GLOBAL_SKILL_NAME}-${process.pid}-${Date.now()}`);
  try {
    cpSync(sourceSkill, stagedSkill, { recursive: true });
    if (existsSync(activeSkill)) rmSync(activeSkill, { recursive: true, force: true });
    renameSync(stagedSkill, activeSkill);
  } finally {
    if (existsSync(stagedSkill)) rmSync(stagedSkill, { recursive: true, force: true });
  }

  writeJsonAtomic(policy.syncConfigPath, {
    version: SYNC_CONFIG_VERSION,
    forkPath: physicalFork,
    remote: 'origin',
    branch: 'main',
  });

  mkdirSync(codexSkillsRoot, { recursive: true });
  const discoveryLink = join(resolve(codexSkillsRoot), GLOBAL_SKILL_NAME);
  if (existsSync(discoveryLink) || lstatExists(discoveryLink)) {
    const stat = lstatSync(discoveryLink);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Destino global já contém dados reais e foi preservado: ${discoveryLink}`);
    }
    const currentTarget = resolve(dirname(discoveryLink), readlinkSync(discoveryLink));
    if (currentTarget !== resolve(activeSkill)) {
      throw new Error(`Link global existente aponta para outro destino e foi preservado: ${discoveryLink}`);
    }
  } else {
    symlinkSync(activeSkill, discoveryLink, 'dir');
  }

  return { activeSkill, discoveryLink, configPath: policy.syncConfigPath };
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

