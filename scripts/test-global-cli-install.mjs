#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGlobalCli } from '../lib/sync/global-cli.js';
import { createStoragePolicy } from '../lib/sync/storage.js';

const root = mkdtempSync(join(tmpdir(), 'reversa-global-cli-'));

try {
  const volumeRoot = join(root, 'volume');
  const sourceRoot = join(volumeRoot, 'fork');
  const dataRoot = join(volumeRoot, '.reversa-global');
  const activePrefix = join(root, 'active-prefix');
  const npmPrefix = join(root, 'npm-prefix');
  mkdirSync(join(sourceRoot, 'bin'), { recursive: true });
  mkdirSync(join(activePrefix, 'bin'), { recursive: true });
  writeFileSync(join(sourceRoot, 'bin', 'reversa.js'), 'canonical fork cli\n', 'utf8');
  writeFileSync(join(activePrefix, 'bin', 'reversa'), 'old cli\n', 'utf8');
  const policy = createStoragePolicy({ volumeRoot, dataRoot });

  const run = (command, args) => {
    if (command === 'npm' && args[0] === 'prefix') {
      return { status: 0, stdout: `${npmPrefix}\n`, stderr: '' };
    }
    if (command === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'reversa-1.3.3.tgz'), 'fixture package', 'utf8');
      return { status: 0, stdout: JSON.stringify([{ filename: 'reversa-1.3.3.tgz' }]), stderr: '' };
    }
    if (command === 'npm' && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const bin = join(prefix, 'bin', 'reversa');
      const installedSource = join(prefix, 'lib', 'node_modules', 'reversa', 'bin', 'reversa.js');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(installedSource, '..'), { recursive: true });
      writeFileSync(bin, 'installed fork cli\n', 'utf8');
      writeFileSync(installedSource, readFileSync(join(sourceRoot, 'bin', 'reversa.js')), 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.length === 1 && args[0] === '--help' && existsSync(command)) {
      return { status: 0, stdout: 'validate-analysis\nscan-surface\nsync-projects\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected command: ${command} ${args.join(' ')}` };
  };

  const report = installGlobalCli({
    sourceRoot,
    policy,
    env: { PATH: join(activePrefix, 'bin') },
    run,
    output: { log() {} },
  });
  assert.deepEqual(report.prefixes.sort(), [activePrefix, npmPrefix].sort());
  for (const prefix of report.prefixes) {
    assert.equal(readFileSync(join(prefix, 'lib', 'node_modules', 'reversa', 'bin', 'reversa.js'), 'utf8'), 'canonical fork cli\n');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('RESULTADO: ✓ CLI global instalada nos prefixos ativo e npm');
