import { scanSurface } from '../surface-scanner.js';

function cliError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function printHumanSummary(summary) {
  console.log('  Descoberta de superficie concluida');
  console.log(`  Raiz: ${summary.source_root}`);
  console.log(`  Arquivos: ${summary.files_scanned}`);
  console.log(`  Candidatos: ${summary.candidates} (${summary.exact} exatos, ${summary.unresolved} nao resolvidos)`);
  console.log(`  Snapshot: ${summary.source_snapshot_id}`);
}

export default async function scanSurfaceCommand(args = []) {
  const json = args.includes('--json');
  const sourceArguments = args.filter((argument) => argument.startsWith('--source='));
  const unknown = args.filter((argument) => argument !== '--json' && !argument.startsWith('--source='));
  try {
    if (unknown.length) throw cliError('unknown_option', unknown[0]);
    if (sourceArguments.length > 1) throw cliError('duplicate_option', '--source');
    const { artifact } = scanSurface(process.cwd(), {
      source: sourceArguments[0]?.slice('--source='.length),
    });
    const summary = {
      source_root: artifact.source_root,
      source_snapshot_id: artifact.source_snapshot.id,
      ...artifact.summary,
    };
    if (json) console.log(JSON.stringify(summary));
    else printHumanSummary(summary);
  } catch (error) {
    const code = error.code ?? 'scan_failed';
    if (json) console.log(JSON.stringify({ error: { code, message: error.message } }));
    else console.error(`  ✗ ${code}: ${error.message}`);
    process.exitCode = 1;
  }
}
