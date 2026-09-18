import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.cs', '.cshtml', '.js']);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.reversa',
  '_reversa_sdd',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  'coverage',
  '.cache',
]);

const normalizePath = (value) => value.split(sep).join('/');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function scannerError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function stripTomlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== '\\') {
      quote = quote === character ? null : (quote ?? character);
    } else if (character === '#' && quote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}

function readAnalysisSourceRoot(path) {
  if (!existsSync(path)) return null;
  let section = '';
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== 'analysis' || !/^source_root\s*=/.test(line)) continue;
    const valueMatch = line.match(/^source_root\s*=\s*(["'])(.*?)\1\s*$/);
    if (!valueMatch || !valueMatch[2]) {
      throw scannerError('source_root_config_invalid', path);
    }
    return valueMatch[2];
  }
  return null;
}

export function resolveSourceRoot(projectRoot, sourceOverride) {
  const root = resolve(projectRoot);
  const configured = sourceOverride
    ?? readAnalysisSourceRoot(join(root, '.reversa', 'config.user.toml'))
    ?? readAnalysisSourceRoot(join(root, '.reversa', 'config.toml'))
    ?? '.';
  if (typeof configured !== 'string') {
    throw scannerError('source_root_config_invalid', String(configured));
  }
  if (isAbsolute(configured)) throw scannerError('source_path_absolute', configured);
  const absolute = resolve(root, configured);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw scannerError('source_path_outside_project', configured);
  }
  let sourceStat;
  try {
    sourceStat = statSync(absolute);
  } catch {
    throw scannerError('source_root_invalid', configured);
  }
  if (!sourceStat.isDirectory()) throw scannerError('source_root_invalid', configured);
  return { absolute, relative: normalizePath(relativePath || '.') };
}

function extension(path) {
  const match = path.match(/(\.[^.\/]+)$/);
  return match?.[1].toLowerCase() ?? '';
}

function collectSupportedFiles(sourceRoot) {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extension(entry.name))) {
        files.push(normalizePath(relative(sourceRoot, path)));
      }
    }
  };
  visit(sourceRoot);
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function buildManifest(sourceRoot, files) {
  const lines = files.map((file) => `${file}\t${sha256(readFileSync(join(sourceRoot, file)))}`);
  return sha256(lines.join('\n'));
}

function readReusableArtifact(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value, beforeRename) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    beforeRename?.();
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function scanSurface(projectRoot = process.cwd(), options = {}) {
  const root = resolve(projectRoot);
  const source = resolveSourceRoot(root, options.source);
  const files = collectSupportedFiles(source.absolute);
  const snapshot = { kind: 'manifest_sha256', id: buildManifest(source.absolute, files) };
  const artifactPath = join(root, '.reversa', 'context', 'surface-candidates.json');
  const existing = readReusableArtifact(artifactPath);
  if (existing?.schema_version === 1
      && existing.source_root === source.relative
      && existing.source_snapshot?.id === snapshot.id) {
    return { artifactPath, artifact: existing };
  }
  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_root: source.relative,
    source_snapshot: snapshot,
    summary: { files_scanned: files.length, candidates: 0, exact: 0, unresolved: 0 },
    candidates: [],
    scan_gaps: [],
  };
  writeJsonAtomic(artifactPath, artifact, options.beforeRename);
  return { artifactPath, artifact };
}
