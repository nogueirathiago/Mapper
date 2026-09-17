import { existsSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { readJsonSafe } from '../utils/json-safe.js';
import { createStoragePolicy } from './storage.js';

export const PROJECTS_REGISTRY_VERSION = 1;

function emptyRegistry() {
  return { version: PROJECTS_REGISTRY_VERSION, projects: [] };
}

function validateRegistry(value, registryPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Registro global inválido: ${registryPath}`);
  }
  if (value.version !== PROJECTS_REGISTRY_VERSION) {
    throw new Error(`Versão desconhecida do registro global: ${value.version ?? 'ausente'}`);
  }
  if (!Array.isArray(value.projects) || value.projects.some(path => typeof path !== 'string')) {
    throw new Error(`Lista de projetos inválida no registro global: ${registryPath}`);
  }
  return {
    version: PROJECTS_REGISTRY_VERSION,
    projects: [...new Set(value.projects)].sort(),
  };
}

export function loadProjectRegistry({ policy = createStoragePolicy(), createIfMissing = false } = {}) {
  policy.ensureLayout();
  const registryPath = policy.projectsRegistryPath;
  if (!existsSync(registryPath)) {
    const registry = emptyRegistry();
    if (createIfMissing) saveProjectRegistry(registry, { policy });
    return registry;
  }

  try {
    return validateRegistry(readJsonSafe(registryPath), registryPath);
  } catch (error) {
    if (error.message?.startsWith('Registro global inválido') || error.message?.startsWith('Versão desconhecida') || error.message?.startsWith('Lista de projetos')) {
      throw error;
    }
    throw new Error(`Registro global inválido: ${registryPath}`, { cause: error });
  }
}

export function saveProjectRegistry(registry, { policy = createStoragePolicy() } = {}) {
  policy.ensureLayout();
  const normalized = validateRegistry(registry, policy.projectsRegistryPath);
  const tempPath = join(dirname(policy.projectsRegistryPath), `.projects-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    renameSync(tempPath, policy.projectsRegistryPath);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
  return normalized;
}

export function registerProject(projectRoot, { policy = createStoragePolicy() } = {}) {
  const physicalRoot = policy.assertOnVolume(projectRoot);
  const statePath = join(physicalRoot, '.reversa', 'state.json');
  if (!existsSync(statePath)) {
    throw new Error(`Projeto sem instalação Reversa reconhecida: ${physicalRoot}`);
  }

  const registry = loadProjectRegistry({ policy, createIfMissing: true });
  if (!registry.projects.includes(physicalRoot)) {
    registry.projects.push(physicalRoot);
    registry.projects.sort();
    return saveProjectRegistry(registry, { policy });
  }
  return registry;
}

