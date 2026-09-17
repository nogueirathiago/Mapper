import { resolve } from 'path';
import { registerProject } from '../sync/registry.js';

export default async function registerProjectCommand(args = []) {
  const requestedPath = args.find(arg => !arg.startsWith('-'));
  const projectRoot = resolve(requestedPath ?? process.cwd());
  const registry = registerProject(projectRoot);
  console.log(`  Projeto Reversa registrado: ${projectRoot}`);
  console.log(`  Total de projetos registrados: ${registry.projects.length}`);
  return registry;
}

