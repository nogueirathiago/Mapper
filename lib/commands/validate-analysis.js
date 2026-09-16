import { validateAnalysis } from '../analysis-validator.js';

export default async function validateAnalysisCommand(args) {
  const report = validateAnalysis(process.cwd());
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { default: chalk } = await import('chalk');
    console.log(chalk.bold('\n  Reversa: Behavioral analysis validation\n'));
    console.log(`  Status:   ${report.errors.length ? chalk.red(report.status) : chalk.cyan(report.status)}`);
    if (report.source_snapshot_id) console.log(`  Snapshot: ${chalk.cyan(report.source_snapshot_id)}`);
    if (report.counts && Object.keys(report.counts).length) {
      console.log(`  Operations: ${report.counts.reviewed ?? 0} reviewed, ${report.counts.identified ?? 0} identified, ${report.counts.analyzing ?? 0} analyzing, ${report.counts.blocked ?? 0} blocked`);
    }
    for (const warning of report.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning.code}: ${warning.message}`));
    }
    for (const error of report.errors) {
      console.log(chalk.red(`  ✗ ${error.code}: ${error.message}`));
    }
    console.log();
  }
  if (report.errors.length) process.exitCode = 1;
}
