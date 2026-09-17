import { execFileSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'fs';
import { join } from 'path';
import { readJsonSafe } from '../utils/json-safe.js';
import { createStoragePolicy } from './storage.js';

export const SYNC_CONFIG_VERSION = 1;

export function loadSyncConfig({ policy = createStoragePolicy() } = {}) {
  policy.ensureLayout();
  const path = policy.syncConfigPath;
  if (!existsSync(path)) throw new Error(`Configuração da sincronização ausente: ${path}`);
  let config;
  try {
    config = readJsonSafe(path);
  } catch (error) {
    throw new Error(`Configuração da sincronização inválida: ${path}`, { cause: error });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== SYNC_CONFIG_VERSION) {
    throw new Error(`Configuração da sincronização inválida: ${path}`);
  }
  if (config.remote !== 'origin' || config.branch !== 'main' || typeof config.forkPath !== 'string') {
    throw new Error('A sincronização exige forkPath válido, remote "origin" e branch "main"');
  }
  return { ...config, forkPath: policy.assertOnVolume(config.forkPath) };
}

function externalVolumeEnv(policy) {
  const npmCache = join(policy.cacheDir, 'npm');
  mkdirSync(npmCache, { recursive: true });
  return {
    ...process.env,
    TMPDIR: policy.tmpDir,
    npm_config_cache: npmCache,
  };
}

export function prepareValidatedMain({
  policy = createStoragePolicy(),
  forkPath,
  remote = 'origin',
  branch = 'main',
  run = execFileSync,
} = {}) {
  policy.ensureLayout();
  const physicalFork = policy.assertOnVolume(forkPath);
  if (remote !== 'origin' || branch !== 'main') {
    throw new Error('A fonte permitida é exclusivamente origin/main');
  }

  const stageRoot = mkdtempSync(join(policy.tmpDir, 'fork-main-'));
  const archivePath = `${stageRoot}.tar`;
  const cleanup = () => {
    rmSync(archivePath, { force: true });
    rmSync(stageRoot, { recursive: true, force: true });
  };

  try {
    run('git', ['-C', physicalFork, 'fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { stdio: 'inherit' });
    const commit = String(run('git', ['-C', physicalFork, 'rev-parse', `${remote}/${branch}`], { encoding: 'utf8' })).trim();
    if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error(`SHA inválido para ${remote}/${branch}: ${commit}`);

    run('git', ['-C', physicalFork, 'archive', '--format=tar', `--output=${archivePath}`, `${remote}/${branch}`], { stdio: 'inherit' });
    run('tar', ['-xf', archivePath, '-C', stageRoot], { stdio: 'inherit' });
    rmSync(archivePath, { force: true });

    const env = externalVolumeEnv(policy);
    run('npm', ['ci'], { cwd: stageRoot, env, stdio: 'inherit' });
    run('npm', ['run', 'verify'], { cwd: stageRoot, env, stdio: 'inherit' });
    return { stageRoot, commit, cleanup, env };
  } catch (error) {
    cleanup();
    throw new Error(`Falha ao preparar origin/main do fork: ${error.message}`, { cause: error });
  }
}

export function readPreparedPackage(stageRoot) {
  return JSON.parse(readFileSync(join(stageRoot, 'package.json'), 'utf8'));
}

