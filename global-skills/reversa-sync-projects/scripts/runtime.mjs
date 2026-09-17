import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const VOLUME_ROOT = '/Volumes/NEO MATRIX';
const CONFIG_PATH = '/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/config/sync.json';

export function assertOnNeoMatrix(path) {
  const root = realpathSync(VOLUME_ROOT);
  const physical = realpathSync(path);
  const rel = relative(root, physical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Caminho fora do NEO MATRIX: ${physical}`);
  }
  return physical;
}

export function loadRuntime() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`Configuração ausente: ${CONFIG_PATH}`);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (config.version !== 1 || config.remote !== 'origin' || config.branch !== 'main' || typeof config.forkPath !== 'string') {
    throw new Error(`Configuração inválida: ${CONFIG_PATH}`);
  }
  const forkPath = assertOnNeoMatrix(config.forkPath);
  const cli = join(forkPath, 'bin', 'reversa.js');
  if (!existsSync(cli)) throw new Error(`CLI do fork ausente: ${cli}`);
  return { cli, forkPath };
}

export function runForkCommand(args, { cwd }) {
  const { cli } = loadRuntime();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

