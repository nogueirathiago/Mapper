import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { scanSurface } from '../surface-scanner.js';

const supported = new Set(['.cs', '.cshtml', '.js']);

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: 64 * 1024 * 1024 });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function blob(root, commit, path) {
  return sha256(git(['-C', root, 'show', `${commit}:${path}`], null));
}

export function scanPr(projectRoot, { base, head = 'HEAD', source } = {}) {
  if (!base) throw new Error('base_required: informe --base=<commit>');
  const root = resolve(projectRoot);
  const commit = (ref) => git(['-C', root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const baseCommit = commit(base);
  const headCommit = commit(head);
  if (headCommit !== commit('HEAD')) throw new Error('head_not_checked_out: faça checkout do commit analisado');
  const status = git(['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  for (const line of status.split('\0').filter(Boolean)) {
    if (!line.startsWith('?? ')) throw new Error('tracked_changes: use um worktree limpo');
    const path = line.slice(3);
    if (!path.startsWith('.agents/') && !path.startsWith('.codex/')
        && !path.startsWith('.claude/') && !path.startsWith('.reversa/')
        && !path.startsWith('_reversa_sdd/') && supported.has(extname(path).toLowerCase())) {
      throw new Error(`untracked_source: ${path}`);
    }
  }
  if (spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', baseCommit, headCommit]).status !== 0) {
    throw new Error('base_not_ancestor: informe o commit base real do PR');
  }
  const { artifact } = scanSurface(root, { source });
  const sourcePrefix = artifact.source_root === '.' ? '' : `${artifact.source_root}/`;
  const raw = git(['-C', root, 'diff', '--name-status', '-z', '--find-renames', baseCommit, headCommit]);
  const tokens = raw.split('\0').filter(Boolean);
  const files = [];
  const gaps = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const renamed = status.startsWith('R');
    const previousPath = renamed ? tokens[index++] : null;
    const path = tokens[index++];
    const kind = status[0] === 'A' ? 'addition'
      : status[0] === 'D' ? 'possible_removal'
        : renamed ? 'rename' : 'change';
    const scannedPath = path.startsWith(sourcePrefix) ? path.slice(sourcePrefix.length) : null;
    const candidates = scannedPath === null ? [] : artifact.candidates
      .filter((candidate) => candidate.file === scannedPath
        || candidate.evidence?.some((evidence) => evidence.file === scannedPath))
      .map((candidate) => candidate.id);
    files.push({ kind, path, ...(previousPath && { previous_path: previousPath }),
      before_sha256: status[0] === 'A' ? null : blob(root, baseCommit, previousPath ?? path),
      after_sha256: status[0] === 'D' ? null : blob(root, headCommit, path),
      candidate_ids: candidates });
    if (kind === 'possible_removal' || renamed) {
      gaps.push({ path: previousPath ?? path, reason: 'possible_removal_requires_review' });
    }
    if (scannedPath === null) gaps.push({ path, reason: 'outside_analysis_source' });
    else if (!supported.has(extname(path).toLowerCase())) gaps.push({ path, reason: 'unsupported_surface' });
    else if (!candidates.length && kind !== 'possible_removal') gaps.push({ path, reason: 'no_candidate_detected' });
  }
  return { schema_version: 1, kind: 'reversa-pr-delta', assessment: 'structural_candidates_only', base_commit: baseCommit,
    head_commit: headCommit, source_root: artifact.source_root,
    source_snapshot_id: artifact.source_snapshot.id, files, gaps };
}

export default async function scanPrCommand(args = []) {
  const json = args.includes('--json');
  try {
    const options = {};
    for (const arg of args) {
      if (arg === '--json') continue;
      const option = arg.match(/^--(base|head|source)=(.+)$/);
      if (!option) throw new Error('unknown_option: use --base, --head, --source ou --json');
      if (options[option[1]]) throw new Error(`duplicate_option: --${option[1]}`);
      options[option[1]] = option[2];
    }
    const result = scanPr(process.cwd(), options);
    if (json) console.log(JSON.stringify(result));
    else console.log(`  ${result.files.length} arquivos alterados; ${result.gaps.length} lacunas para revisão`);
  } catch (error) {
    if (json) console.log(JSON.stringify({ error: { message: error.message } }));
    else console.error(`  ✗ ${error.message}`);
    process.exitCode = 1;
  }
}
