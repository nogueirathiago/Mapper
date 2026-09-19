import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createStoragePolicy } from './storage.js';

const REQUIRED_COMMANDS = ['validate-analysis', 'scan-surface', 'sync-projects'];

function runChecked(run, command, args, options = {}) {
  const result = run(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} falhou${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

export function findExecutableOnPath(name, pathValue = process.env.PATH || '') {
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

export function collectGlobalPrefixes({ activeCli, npmPrefix }) {
  const prefixes = new Set();
  if (activeCli) prefixes.add(dirname(dirname(resolve(activeCli))));
  if (npmPrefix) prefixes.add(resolve(npmPrefix));
  return [...prefixes];
}

export function installGlobalCli({
  sourceRoot,
  policy = createStoragePolicy(),
  env = process.env,
  run = spawnSync,
  output = console,
} = {}) {
  policy.ensureLayout();
  const physicalSourceRoot = policy.assertOnVolume(sourceRoot);
  const npmCache = join(policy.cacheDir, 'npm');
  mkdirSync(npmCache, { recursive: true });
  const runtimeEnv = { ...env, TMPDIR: policy.tmpDir, npm_config_cache: npmCache };

  const activeCli = findExecutableOnPath('reversa', runtimeEnv.PATH || '');
  const npmPrefix = runChecked(run, 'npm', ['prefix', '--global'], { env: runtimeEnv });
  if (!isAbsolute(npmPrefix)) throw new Error(`Prefixo global npm inválido: ${npmPrefix}`);
  const prefixes = collectGlobalPrefixes({ activeCli, npmPrefix });
  if (prefixes.length === 0) throw new Error('Nenhum prefixo global disponível para instalar a CLI Reversa');

  const packageDir = mkdtempSync(join(policy.tmpDir, 'reversa-cli-'));
  try {
    const packed = JSON.parse(runChecked(run, 'npm', [
      'pack', '--json', '--pack-destination', packageDir,
    ], { cwd: physicalSourceRoot, env: runtimeEnv }));
    const filename = packed?.[0]?.filename;
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new Error('npm pack não informou o pacote gerado para a CLI Reversa');
    }
    const packagePath = isAbsolute(filename) ? filename : join(packageDir, filename);
    if (!existsSync(packagePath)) throw new Error(`Pacote da CLI não encontrado: ${packagePath}`);

    const installed = [];
    for (const prefix of prefixes) {
      runChecked(run, 'npm', [
        'install', '--global', '--prefix', prefix, packagePath,
        '--ignore-scripts', '--no-audit', '--no-fund',
      ], { env: runtimeEnv });
      const cliPath = join(prefix, 'bin', 'reversa');
      if (!existsSync(cliPath)) throw new Error(`CLI Reversa não foi instalada em ${cliPath}`);
      const help = runChecked(run, cliPath, ['--help'], { env: runtimeEnv });
      const missing = REQUIRED_COMMANDS.filter(command => !help.includes(command));
      if (missing.length > 0) {
        throw new Error(`CLI Reversa incompatível em ${cliPath}; comandos ausentes: ${missing.join(', ')}`);
      }
      installed.push(cliPath);
    }

    output.log(`\n  CLI Reversa global atualizada a partir da fonte do fork: ${installed.join(', ')}`);
    return { activeCli, npmPrefix, prefixes, installed };
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
}
