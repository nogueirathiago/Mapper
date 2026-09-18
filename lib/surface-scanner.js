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

function candidateId(...parts) {
  const normalized = parts.map((part) => (
    Array.isArray(part) ? [...part].sort() : String(part ?? '').trim()
  ));
  return `CAND-${sha256(JSON.stringify(normalized)).slice(0, 20).toUpperCase()}`;
}

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

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

function findBalancedEnd(content, start, opening, closing) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return content.length - 1;
}

function findControllerClasses(content) {
  const classes = [];
  const pattern = /\bclass\s+([A-Za-z_]\w*Controller)\s*:\s*[^\n{]*\bController\b[^\{]*\{/g;
  for (const match of content.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = findBalancedEnd(content, open, '{', '}');
    classes.push({
      name: match[1],
      body: content.slice(open + 1, close),
      bodyOffset: open + 1,
    });
  }
  return classes;
}

function findPublicMethods(controller, fullContent) {
  const methods = [];
  const pattern = /((?:\s*\[[^\]]+]\s*)*)\bpublic\s+(?:async\s+)?(?:[A-Za-z_]\w*(?:\s*<[^;{}()]+>)?(?:\[\])?[?.]?\s+)+([A-Za-z_]\w*)\s*\([^)]*\)\s*(=>|\{)/g;
  for (const match of controller.body.matchAll(pattern)) {
    const attributes = [...match[1].matchAll(/\[([^\]]+)]/g)].map((item) => item[1].trim());
    const bodyStart = match.index + match[0].length - 1;
    let bodyEnd;
    let body;
    if (match[3] === '{') {
      bodyEnd = findBalancedEnd(controller.body, bodyStart, '{', '}');
      body = controller.body.slice(bodyStart + 1, bodyEnd);
    } else {
      bodyEnd = controller.body.indexOf(';', bodyStart);
      if (bodyEnd < 0) bodyEnd = controller.body.length;
      body = controller.body.slice(bodyStart + 1, bodyEnd);
    }
    const absoluteStart = controller.bodyOffset + match.index + match[0].search(/\bpublic\b/);
    const absoluteEnd = controller.bodyOffset + bodyEnd;
    methods.push({
      name: match[2],
      attributes,
      body,
      line: lineNumberAt(fullContent, absoluteStart),
      endLine: lineNumberAt(fullContent, absoluteEnd),
    });
  }
  return methods;
}

function httpVerb(attributes) {
  for (const verb of ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options']) {
    if (attributes.some((attribute) => new RegExp(`^Http${verb}(?:Attribute)?(?:\\s*\\(|$)`).test(attribute))) {
      return verb.toUpperCase();
    }
  }
  return null;
}

function routeLiteral(attributes) {
  const route = attributes.find((attribute) => /^Route(?:Attribute)?\s*\(/.test(attribute));
  return route?.match(/^[^(]+\(\s*["']([^"']+)["']/)?.[1] ?? null;
}

function mvcReturns(body) {
  const kinds = new Map([
    ['PartialView', 'partial_view'],
    ['View', 'view'],
    ['RedirectToAction', 'redirect_to_action'],
    ['Redirect', 'redirect'],
    ['Json', 'json'],
  ]);
  const returns = [];
  const pattern = /\b(PartialView|View|RedirectToAction|Redirect|Json)\s*\(\s*(?:["']([^"']+)["'])?/g;
  for (const match of body.matchAll(pattern)) {
    const item = { kind: kinds.get(match[1]) };
    if (match[2]) item.target = match[2];
    returns.push(item);
  }
  return returns;
}

function extractMvcActions(file, content) {
  return findControllerClasses(content).flatMap((controller) => (
    findPublicMethods(controller, content)
      .filter((method) => method.name !== controller.name)
      .filter((method) => !method.attributes.some((attribute) => /^NonAction(?:Attribute)?(?:\s*\(|$)/.test(attribute)))
      .map((method) => ({
        id: candidateId('mvc_action', file, controller.name, method.name, method.attributes),
        type: 'mvc_action',
        controller: controller.name.replace(/Controller$/, ''),
        action: method.name,
        method: httpVerb(method.attributes) ?? 'ANY',
        route: routeLiteral(method.attributes),
        file,
        line: method.line,
        confidence: 'exact',
        returns: mvcReturns(method.body),
        evidence: [{ file, line: method.line, end_line: method.endLine }],
      }))
  ));
}

function extractCandidates(sourceRoot, files) {
  return files.flatMap((file) => {
    const content = readFileSync(join(sourceRoot, file), 'utf8');
    return extension(file) === '.cs' ? extractMvcActions(file, content) : [];
  }).sort((left, right) => (
    left.file.localeCompare(right.file, 'en')
    || left.line - right.line
    || left.type.localeCompare(right.type, 'en')
    || left.id.localeCompare(right.id, 'en')
  ));
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
  const candidates = extractCandidates(source.absolute, files);
  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_root: source.relative,
    source_snapshot: snapshot,
    summary: {
      files_scanned: files.length,
      candidates: candidates.length,
      exact: candidates.filter((candidate) => candidate.confidence === 'exact').length,
      unresolved: candidates.filter((candidate) => candidate.confidence === 'unresolved').length,
    },
    candidates,
    scan_gaps: [],
  };
  writeJsonAtomic(artifactPath, artifact, options.beforeRename);
  return { artifactPath, artifact };
}
