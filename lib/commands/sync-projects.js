import { spawnSync } from 'child_process';
import { join } from 'path';
import { loadProjectRegistry } from '../sync/registry.js';
import {
  applyProjectSync, cleanupProjectSyncPlan, planProjectSync,
} from '../sync/project-sync.js';
import { loadSyncConfig, prepareValidatedMain } from '../sync/source.js';
import { createStoragePolicy } from '../sync/storage.js';
import { installGlobalSyncSkill } from '../sync/global-skill.js';

function printPlan(plans, failures, commit, output = console) {
  output.log(`\n  Fork: origin/main @ ${commit}`);
  for (const plan of plans) {
    output.log(`\n  ${plan.projectRoot}`);
    output.log(`    atualizar: ${plan.updates.length}`);
    output.log(`    restaurar: ${plan.missing.length}`);
    output.log(`    preservar modificados: ${plan.modified.length}`);
    output.log(`    preservar conflitos: ${plan.conflicts.length}`);
    output.log(`    inalterados: ${plan.unchanged.length}`);
  }
  for (const failure of failures) output.error(`\n  indisponível: ${failure.projectRoot}\n    ${failure.error}`);
}

async function defaultConfirm() {
  const { default: inquirer } = await import('inquirer');
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: '\nSincronizar os projetos elegíveis?',
    default: false,
  }]);
  return confirm;
}

export async function runPreparedSync({
  sourceCommit,
  policy = createStoragePolicy(),
  confirm = defaultConfirm,
  output = console,
} = {}) {
  const registry = loadProjectRegistry({ policy });
  const plans = [];
  const failures = [];
  try {
    for (const projectRoot of registry.projects) {
      try {
        plans.push(await planProjectSync(projectRoot, { sourceCommit, policy }));
      } catch (error) {
        failures.push({ projectRoot, error: error.message });
      }
    }

    printPlan(plans, failures, sourceCommit, output);
    if (plans.length === 0) {
      output.log('\n  Nenhum projeto elegível para sincronização.');
      return { cancelled: false, results: [], failures };
    }
    if (!await confirm()) {
      output.log('\n  Sincronização cancelada; nenhum projeto foi alterado.');
      return { cancelled: true, results: [], failures };
    }

    const results = [];
    for (const plan of plans) {
      try {
        results.push(applyProjectSync(plan));
      } catch (error) {
        failures.push({ projectRoot: plan.projectRoot, error: error.message });
      }
    }
    for (const result of results) {
      output.log(`\n  ✓ ${result.projectRoot}: ${result.updated} atualizado(s), ${result.restored} restaurado(s), ${result.preserved} modificado(s) preservado(s), ${result.conflicts} conflito(s) preservado(s)`);
    }
    for (const failure of failures) output.error(`\n  ✗ ${failure.projectRoot}: ${failure.error}`);
    return { cancelled: false, results, failures };
  } finally {
    for (const plan of plans) cleanupProjectSyncPlan(plan);
  }
}

export default async function syncProjects(args = []) {
  const policy = createStoragePolicy().ensureLayout();
  const prepared = process.env.REVERSA_SYNC_PREPARED === '1';
  if (prepared) {
    const commitArg = args.find(arg => arg.startsWith('--source-commit='));
    const sourceCommit = commitArg?.slice('--source-commit='.length);
    const report = await runPreparedSync({ sourceCommit, policy });
    if (report.failures.length > 0) process.exitCode = 1;
    return report;
  }

  const config = loadSyncConfig({ policy });
  const source = prepareValidatedMain({
    policy,
    forkPath: config.forkPath,
    remote: config.remote,
    branch: config.branch,
  });
  try {
    installGlobalSyncSkill({
      sourceRoot: source.stageRoot,
      forkPath: config.forkPath,
      policy,
    });
    const child = spawnSync(process.execPath, [
      join(source.stageRoot, 'bin', 'reversa.js'),
      'sync-projects',
      `--source-commit=${source.commit}`,
    ], {
      cwd: source.stageRoot,
      env: { ...source.env, REVERSA_SYNC_PREPARED: '1' },
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Sincronização encerrada com código ${child.status}`);
  } finally {
    source.cleanup();
  }
}
