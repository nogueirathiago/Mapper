#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';

const VOLUME_ROOT = '/Volumes/NEO MATRIX';
const CONFIG_PATH = '/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/config/sync.json';

function assertOnNeoMatrix(path) {
  const root = realpathSync(VOLUME_ROOT);
  const physical = realpathSync(path);
  const rel = relative(root, physical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Caminho fora do NEO MATRIX: ${physical}`);
  }
  return physical;
}

if (!existsSync(CONFIG_PATH)) throw new Error(`Configuração ausente: ${CONFIG_PATH}`);
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const forkPath = assertOnNeoMatrix(config.forkPath);
const projectRoot = assertOnNeoMatrix(process.cwd());
const result = spawnSync(process.execPath, [join(forkPath, 'bin', 'reversa.js'), 'register-project', projectRoot], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

