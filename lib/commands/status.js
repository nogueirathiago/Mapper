import { existsSync } from 'fs';
import { join } from 'path';
import { readJsonSafe } from '../utils/json-safe.js';
import { validateAnalysis } from '../analysis-validator.js';

export default async function status(args) {
  const { default: chalk } = await import('chalk');

  const statePath = join(process.cwd(), '.reversa', 'state.json');

  if (!existsSync(statePath)) {
    console.log(chalk.yellow('\n  Reversa is not installed in this directory.'));
    console.log('  Run ' + chalk.bold('npx reversa install') + ' to install.\n');
    return;
  }

  const state = readJsonSafe(statePath);

  console.log(chalk.bold('\n  Reversa: Status\n'));
  console.log(`  Project:         ${chalk.cyan(state.project || '(not set)')}`);
  console.log(`  User:            ${chalk.cyan(state.user_name || '(not set)')}`);
  console.log(`  Version:         ${chalk.cyan(state.version || '?')}`);
  console.log(`  Current phase:   ${chalk.cyan(state.phase || 'Not started')}`);
  console.log(`  Chat language:   ${chalk.cyan(state.chat_language || 'pt-br')}`);
  console.log(`  Docs language:   ${chalk.cyan(state.doc_language || 'pt-br')}`);

  if (state.completed?.length > 0) {
    console.log(`\n  Completed: ${state.completed.map(f => chalk.hex('#ffa203')('✓ ' + f)).join(', ')}`);
  }
  if (state.pending?.length > 0) {
    console.log(`  Pending:   ${state.pending.map(f => chalk.gray('○ ' + f)).join(', ')}`);
  }

  const analysis = validateAnalysis(process.cwd());
  const analysisColor = analysis.errors.length ? chalk.red : analysis.warnings.length ? chalk.yellow : chalk.cyan;
  console.log(`\n  Behavioral:      ${analysisColor(analysis.status)}`);
  if (analysis.counts && Object.keys(analysis.counts).length) {
    console.log(`  Operations:      ${analysis.counts.reviewed ?? 0} reviewed, ${analysis.counts.identified ?? 0} identified, ${analysis.counts.analyzing ?? 0} analyzing, ${analysis.counts.blocked ?? 0} blocked`);
  }
  if (analysis.errors.length || analysis.warnings.length) {
    console.log(`  Analysis checks: ${analysis.errors.length} error(s), ${analysis.warnings.length} warning(s)`);
    console.log(`  Details:         ${chalk.gray('npx reversa validate-analysis')}`);
  }

  console.log();
}
