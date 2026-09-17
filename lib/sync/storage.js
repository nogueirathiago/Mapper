import { existsSync, mkdirSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export const NEO_MATRIX_ROOT = '/Volumes/NEO MATRIX';
export const DEFAULT_DATA_ROOT = '/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global';

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolvePhysical(path, { mustExist = true } = {}) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  if (mustExist) throw new Error(`Caminho não encontrado: ${absolute}`);

  const missing = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, '..');
    if (parent === cursor) throw new Error(`Não foi possível resolver o caminho: ${absolute}`);
    missing.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

export function createStoragePolicy({
  volumeRoot = NEO_MATRIX_ROOT,
  dataRoot = DEFAULT_DATA_ROOT,
} = {}) {
  const physicalVolumeRoot = resolvePhysical(volumeRoot);
  const physicalDataRoot = resolvePhysical(dataRoot, { mustExist: false });

  if (!isInside(physicalVolumeRoot, physicalDataRoot)) {
    throw new Error(`Diretório operacional fora do volume permitido: ${physicalDataRoot}`);
  }

  const policy = {
    volumeRoot: physicalVolumeRoot,
    dataRoot: physicalDataRoot,
    configDir: join(physicalDataRoot, 'config'),
    skillDir: join(physicalDataRoot, 'skill'),
    tmpDir: join(physicalDataRoot, 'tmp'),
    cacheDir: join(physicalDataRoot, 'cache'),
    get projectsRegistryPath() {
      return join(this.configDir, 'projects.json');
    },
    get syncConfigPath() {
      return join(this.configDir, 'sync.json');
    },
    assertOnVolume(path, options = {}) {
      const physical = resolvePhysical(path, options);
      if (!isInside(physicalVolumeRoot, physical)) {
        throw new Error(`Caminho fora do volume permitido ${physicalVolumeRoot}: ${physical}`);
      }
      return physical;
    },
    ensureLayout() {
      for (const dir of [this.configDir, this.skillDir, this.tmpDir, this.cacheDir]) {
        this.assertOnVolume(dir, { mustExist: false });
        mkdirSync(dir, { recursive: true });
        this.assertOnVolume(dir);
      }
      return this;
    },
  };

  return policy;
}

