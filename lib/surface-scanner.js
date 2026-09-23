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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.cs', '.cshtml', '.js']);
const SURFACE_SCANNER_REVISION = 9;
const DOM_EVENTS = [
  'click',
  'change',
  'submit',
  'input',
  'blur',
  'focus',
  'focusin',
  'focusout',
  'keyup',
  'keydown',
  'keypress',
  'dblclick',
];
const DOM_EVENT_PATTERN = DOM_EVENTS.join('|');
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.agents',
  '.codex',
  '.claude',
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

function readSourceFiles(sourceRoot, files) {
  const sources = new Map();
  const scanGaps = [];
  const manifestLines = [];
  for (const file of files) {
    try {
      const bytes = readFileSync(join(sourceRoot, file));
      sources.set(file, bytes.toString('utf8'));
      manifestLines.push(`${file}\t${sha256(bytes)}`);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'read_failed';
      manifestLines.push(`${file}\tunreadable:${code}`);
      scanGaps.push({ file, error: code });
    }
  }
  return { sources, scanGaps, snapshotId: sha256(manifestLines.join('\n')) };
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
  const pattern = /\bclass\s+([A-Za-z_]\w*Controller)\s*:\s*[^{};]+\{/g;
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
      isStatic: /\bstatic\b/.test(match[0].slice(0, match[0].lastIndexOf(match[2]))),
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
  const candidates = findControllerClasses(content).flatMap((controller) => (
    findPublicMethods(controller, content)
      .filter((method) => method.name !== controller.name)
      .filter((method) => !method.isStatic)
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
  const identityCounts = new Map();
  for (const candidate of candidates) {
    const identity = candidate.id;
    const ordinal = (identityCounts.get(identity) ?? 0) + 1;
    identityCounts.set(identity, ordinal);
    if (ordinal > 1) candidate.id = candidateId(identity, ordinal);
  }
  return candidates;
}

function quotedValues(value) {
  return [...value.matchAll(/["']([^"']*)["']/g)].map((match) => match[1]);
}

function htmlAttribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] ?? null;
}

function controlSelectors(attributes) {
  const selectors = [];
  const id = htmlAttribute(attributes, 'id');
  if (id) selectors.push(`#${id}`);
  const classes = (htmlAttribute(attributes, 'class') ?? '').split(/\s+/).filter(Boolean);
  selectors.push(...classes.map((value) => `.${value}`));
  const name = htmlAttribute(attributes, 'name');
  if (name) selectors.push(`[name="${name}"]`);
  for (const match of attributes.matchAll(/\b(data-[A-Za-z0-9_-]+)\s*=\s*(["'])(.*?)\2/gi)) {
    selectors.push(`[${match[1]}="${match[3]}"]`);
  }
  return [...new Set(selectors)];
}

function visibleText(value) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function razorActionTarget(value) {
  const match = value.match(
    /@?Url\.Action\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']([^)]*)\)/i,
  );
  if (!match) return null;
  const area = match[3].match(/\bArea\s*=\s*["']([^"']+)["']/i)?.[1];
  return `/${[area, match[2], match[1]].filter(Boolean).join('/')}`;
}

function targetDetails(value) {
  if (typeof value !== 'string' || !value.trim()) return { target: null };
  const expression = value.trim();
  const urlAction = razorActionTarget(expression);
  if (urlAction) return { target: urlAction };
  const urlContent = expression.match(/^@?Url\.Content\s*\(\s*(["'])(.*?)\1\s*\)$/i)?.[2];
  if (urlContent) return { target: urlContent.replace(/^~\//, '/') };
  if (/^(?:https?:)?\/\//i.test(expression) || expression.startsWith('/')) {
    return { target: expression };
  }
  if (expression.startsWith('~/')) return { target: expression.slice(1) };
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_/?#=&.-]+$/.test(expression)) {
    return { target: `/${expression}` };
  }
  return { target: null, target_expression: expression };
}

function endpointStep(kind, method, target) {
  return { kind, method, ...targetDetails(target) };
}

function makeUiControl({
  file,
  line,
  endLine = line,
  kind,
  selector,
  selectors = selector ? [selector] : [],
  label,
  guards = [],
  steps = [],
  evidence,
  events = [],
}) {
  return {
    type: 'ui_action',
    control_kind: kind,
    label,
    selector,
    selectors,
    file,
    line,
    guards,
    confidence: steps.length > 0 && steps.every((step) => step.target) ? 'exact' : 'unresolved',
    steps,
    evidence: evidence ?? [{ file, line, end_line: endLine }],
    ...(events.length ? { events: [...new Set(events)] } : {}),
  };
}

function extractRazorControls(file, content) {
  const controls = [];
  const guards = [];
  const blockForms = [];
  let htmlForm = null;
  let depth = 0;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    if (/^}/.test(trimmed)) {
      depth = Math.max(0, depth - 1);
      while (guards.at(-1)?.depth > depth) guards.pop();
      while (blockForms.at(-1)?.depth > depth) blockForms.pop();
    }

    const ifMatch = line.match(/@if\s*\((.+)\)\s*\{/);
    if (ifMatch) {
      depth += 1;
      guards.push({ depth, expression: ifMatch[1].trim() });
    }

    const beginForm = line.match(/Html\.BeginForm\s*\((.*)\)\s*\)\s*\{/);
    if (beginForm) {
      const values = quotedValues(beginForm[1]);
      const id = beginForm[1].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
      const method = /FormMethod\.Post\b/.test(beginForm[1]) ? 'POST' : 'GET';
      const target = values.length >= 2 ? `/${values[1]}/${values[0]}` : null;
      depth += 1;
      const form = { depth, method, target };
      blockForms.push(form);
      controls.push(makeUiControl({
        file,
        line: lineNumber,
        kind: 'form',
        selector: id ? `#${id}` : null,
        selectors: controlSelectors(beginForm[1]),
        label: id,
        guards: guards.map((item) => item.expression),
        steps: [endpointStep('http', method, target)],
      }));
    }

    for (const match of line.matchAll(/<form\b([^>]*)>/gi)) {
      const attributes = match[1];
      const id = htmlAttribute(attributes, 'id');
      const method = (htmlAttribute(attributes, 'method') ?? 'GET').toUpperCase();
      const rawTarget = htmlAttribute(attributes, 'action');
      const target = targetDetails(rawTarget);
      htmlForm = { method, ...target };
      controls.push(makeUiControl({
        file,
        line: lineNumber,
        kind: 'form',
        selector: id ? `#${id}` : null,
        selectors: controlSelectors(attributes),
        label: id,
        guards: guards.map((item) => item.expression),
        steps: [{ kind: 'http', method, ...target }],
      }));
    }

    let buttonSource = line;
    let buttonEndIndex = index;
    if (/<button\b/i.test(line) && !/<\/button>/i.test(line)) {
      while (buttonEndIndex + 1 < lines.length && !/<\/button>/i.test(buttonSource)) {
        buttonEndIndex += 1;
        buttonSource += `\n${lines[buttonEndIndex]}`;
      }
    }
    for (const match of buttonSource.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attributes = match[1];
      const id = htmlAttribute(attributes, 'id');
      const disabled = htmlAttribute(attributes, 'disabled')?.match(/^@\((.*)\)$/)?.[1]?.trim();
      const activeForm = htmlForm ?? blockForms.at(-1);
      const isSubmit = (htmlAttribute(attributes, 'type') ?? '').toLowerCase() === 'submit';
      const steps = isSubmit && activeForm
        ? [{
          kind: 'submit',
          method: activeForm.method,
          target: activeForm.target,
          ...(activeForm.target_expression ? { target_expression: activeForm.target_expression } : {}),
        }]
        : [];
      controls.push(makeUiControl({
        file,
        line: lineNumber,
        endLine: buttonEndIndex + 1,
        kind: 'button',
        selector: id ? `#${id}` : null,
        selectors: controlSelectors(attributes),
        label: visibleText(match[2]),
        guards: [...guards.map((item) => item.expression), ...(disabled ? [disabled] : [])],
        steps,
      }));
    }
    if (buttonEndIndex > index) index = buttonEndIndex;

    for (const match of line.matchAll(/<input\b([^>]*)>/gi)) {
      const attributes = match[1];
      const type = (htmlAttribute(attributes, 'type') ?? 'text').toLowerCase();
      if (!['button', 'submit', 'reset', 'image'].includes(type)) continue;
      const id = htmlAttribute(attributes, 'id');
      const activeForm = htmlForm ?? blockForms.at(-1);
      const steps = type === 'submit' && activeForm
        ? [{
          kind: 'submit',
          method: activeForm.method,
          target: activeForm.target,
          ...(activeForm.target_expression ? { target_expression: activeForm.target_expression } : {}),
        }]
        : [];
      controls.push(makeUiControl({
        file,
        line: lineNumber,
        kind: 'input_button',
        selector: id ? `#${id}` : null,
        selectors: controlSelectors(attributes),
        label: htmlAttribute(attributes, 'value') ?? id,
        guards: guards.map((item) => item.expression),
        steps,
      }));
    }

    const actionLink = line.match(/Html\.ActionLink\s*\((.*)\)/);
    if (actionLink) {
      const values = quotedValues(actionLink[1]);
      const id = actionLink[1].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
      controls.push(makeUiControl({
        file,
        line: lineNumber,
        kind: 'link',
        selector: id ? `#${id}` : null,
        selectors: controlSelectors(actionLink[1]),
        label: values[0] ?? null,
        guards: guards.map((item) => item.expression),
        steps: [endpointStep(
          'navigation',
          'GET',
          values.length >= 3 ? `/${values[2]}/${values[1]}` : null,
        )],
      }));
    }

    for (const match of line.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attributes = match[1];
      const id = htmlAttribute(attributes, 'id');
      const urlAction = line.match(/Url\.Action\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/);
      const literalHref = htmlAttribute(attributes, 'href');
      const target = urlAction ? `/${urlAction[2]}/${urlAction[1]}` : literalHref;
      controls.push(makeUiControl({
        file,
        line: lineNumber,
        kind: 'link',
        selector: id ? `#${id}` : null,
        selectors: controlSelectors(attributes),
        label: visibleText(match[2]),
        guards: guards.map((item) => item.expression),
        steps: [endpointStep('navigation', 'GET', target)],
      }));
    }

    if (/<\/form\s*>/i.test(line)) htmlForm = null;
  }
  return controls;
}

function extractNamedFunctions(content) {
  const functions = new Map();
  const pattern = /\bfunction\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g;
  for (const match of content.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = findBalancedEnd(content, open, '{', '}');
    functions.set(match[1], content.slice(open + 1, close));
  }
  return functions;
}

function literalProperty(value, property) {
  return value.match(new RegExp(`\\b${property}\\s*:\\s*(["'])(.*?)\\1`, 'i'))?.[2] ?? null;
}

function routeFromExpression(expression, variables = new Map(), visited = new Set()) {
  const trimmed = expression.trim();
  const razorTarget = razorActionTarget(trimmed);
  if (razorTarget) return razorTarget;
  const identifier = trimmed.match(/^([A-Za-z_]\w*)$/)?.[1];
  if (identifier && variables.has(identifier) && !visited.has(identifier)) {
    return routeFromExpression(variables.get(identifier), variables, new Set(visited).add(identifier));
  }
  const direct = trimmed.match(/^(["'])(.*?)\1$/)?.[2];
  if (direct) return direct;
  const literals = [...trimmed.matchAll(/(["'])(.*?)\1/g)]
    .map((match) => match[2])
    .filter((value) => /[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.test(value) && !value.startsWith('//'))
    .sort((left, right) => right.length - left.length);
  if (!literals.length) return null;
  return literals[0].startsWith('/') ? literals[0] : `/${literals[0]}`;
}

function variableExpressions(content) {
  const variables = new Map();
  for (const match of content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*([^;\r\n]+)/g)) {
    variables.set(match[1], match[2]);
  }
  return variables;
}

function routeProperty(value, property, variables) {
  const propertyTail = value.match(new RegExp(`\\b${property}\\s*:\\s*([\\s\\S]+)`, 'i'))?.[1];
  const razorTarget = propertyTail ? razorActionTarget(propertyTail) : null;
  if (razorTarget) return razorTarget;
  const literal = literalProperty(value, property);
  if (literal) return literal;
  const expression = value.match(new RegExp(`\\b${property}\\s*:\\s*([^,\\r\\n}]+)`, 'i'))?.[1];
  return expression ? routeFromExpression(expression, variables) : null;
}

function literalArguments(value) {
  const object = value.match(/JSON\.stringify\s*\(\s*\{([^}]*)}/)?.[1]
    ?? value.match(/\bdata\s*:\s*\{([^}]*)}/)?.[1];
  if (!object) return undefined;
  const result = {};
  for (const match of object.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*:\s*(["'])(.*?)\2/g)) {
    result[match[1]] = match[3];
  }
  return Object.keys(result).length ? result : undefined;
}

function positionalTarget(value) {
  return razorActionTarget(value) ?? value.match(/^\s*(["'])(.*?)\1/)?.[2] ?? null;
}

function firstArgumentExpression(value) {
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets = Math.max(0, brackets - 1);
    else if (character === '{') braces += 1;
    else if (character === '}') braces = Math.max(0, braces - 1);
    else if (character === ',' && parentheses === 0 && brackets === 0 && braces === 0) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function expressionStep(kind, method, expression, variables) {
  const targetExpression = expression.trim();
  const target = routeFromExpression(targetExpression, variables);
  return {
    kind,
    method,
    target,
    ...(!target && targetExpression ? { target_expression: targetExpression } : {}),
  };
}

function isCommentedAt(content, offset) {
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let razorComment = false;
  for (let index = 0; index < offset; index += 1) {
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
    if (razorComment) {
      if (character === '*' && next === '@') {
        razorComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (character === '@' && next === '*') {
      razorComment = true;
      index += 1;
    }
  }
  return lineComment || blockComment || razorComment;
}

function traceHttpSteps(content, functions, visited = new Set(), stepKind = 'http') {
  const steps = [];
  const variables = variableExpressions(content);
  const token = /\$\.ajax\s*\(|\$\.(get|post)\s*\(|\bfetch\s*\(|\.load\s*\(|\b([A-Za-z_]\w*)\s*\(/g;
  let match;
  while ((match = token.exec(content))) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = findBalancedEnd(content, open, '(', ')');
    const call = content.slice(open + 1, close);
    if (match[0].startsWith('$.ajax')) {
      const target = routeProperty(call, 'url', variables);
      const method = (literalProperty(call, 'method') ?? literalProperty(call, 'type') ?? 'GET').toUpperCase();
      const step = endpointStep(stepKind, method, target);
      const args = literalArguments(call);
      if (args) step.arguments = args;
      steps.push(step);

      const success = call.match(/\bsuccess\s*:\s*function\s*\([^)]*\)\s*\{/);
      if (success) {
        const successOpen = success.index + success[0].lastIndexOf('{');
        const successClose = findBalancedEnd(call, successOpen, '{', '}');
        steps.push(...traceHttpSteps(
          call.slice(successOpen + 1, successClose),
          functions,
          new Set(visited),
          'http_on_success',
        ));
      }
    } else if (match[1]) {
      steps.push(endpointStep(
        stepKind,
        match[1].toUpperCase(),
        positionalTarget(call),
      ));
    } else if (match[0].startsWith('fetch')) {
      const step = endpointStep(
        stepKind,
        (literalProperty(call, 'method') ?? 'GET').toUpperCase(),
        positionalTarget(call),
      );
      const args = literalArguments(call);
      if (args) step.arguments = args;
      steps.push(step);
    } else if (match[0].startsWith('.load')) {
      const receiver = content.slice(0, match.index).trimEnd();
      if (receiver.endsWith(')') && !isCommentedAt(content, match.index)) {
        steps.push(expressionStep(
          stepKind,
          'GET',
          firstArgumentExpression(call),
          variables,
        ));
      }
    } else if (match[2] && functions.has(match[2]) && !visited.has(match[2])) {
      const nextVisited = new Set(visited).add(match[2]);
      steps.push(...traceHttpSteps(functions.get(match[2]), functions, nextVisited, stepKind));
    } else if (match[2]) {
      steps.push(...traceHttpSteps(call, functions, new Set(visited), stepKind));
    }
    token.lastIndex = Math.max(token.lastIndex, close + 1);
  }
  return steps;
}

function extractClientBindings(file, content, availableFunctions = extractNamedFunctions(content)) {
  const bindings = [];
  const addBinding = ({ offset, close, selector, event, body }) => {
    const steps = traceHttpSteps(body, availableFunctions);
    bindings.push({
      file,
      selector,
      event,
      steps,
      visualOnly: steps.length === 0 && /\.(?:hide|toggle|slideUp|slideDown)\s*\(|classList\.toggle\s*\(/.test(body),
      evidence: { file, line: lineNumberAt(content, offset), end_line: lineNumberAt(content, close) },
      offset,
    });
  };
  const patterns = [
    {
      pattern: new RegExp(`\\$\\(\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)\\s*\\.(${DOM_EVENT_PATTERN})\\s*\\(\\s*(?:function\\s*\\([^)]*\\)|(?:\\([^)]*\\)|[A-Za-z_$]\\w*)\\s*=>)\\s*\\{`, 'g'),
      values: (match) => ({ selector: match[1] ?? match[2], event: match[3] }),
    },
    {
      pattern: new RegExp(`\\$\\(\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)\\s*\\.on\\s*\\(\\s*(["'])(${DOM_EVENT_PATTERN})(?:\\.[^"']+)?\\3\\s*,\\s*(?:function\\s*\\([^)]*\\)|(?:\\([^)]*\\)|[A-Za-z_$]\\w*)\\s*=>)\\s*\\{`, 'g'),
      values: (match) => ({ selector: match[1] ?? match[2], event: match[4] }),
    },
    {
      pattern: new RegExp(`\\$\\([^)]*\\)\\s*\\.on\\s*\\(\\s*(["'])(${DOM_EVENT_PATTERN})(?:\\.[^"']+)?\\1\\s*,\\s*(?:"([^"]*)"|'([^']*)')\\s*,\\s*(?:function\\s*\\([^)]*\\)|(?:\\([^)]*\\)|[A-Za-z_$]\\w*)\\s*=>)\\s*\\{`, 'g'),
      values: (match) => ({ selector: match[3] ?? match[4], event: match[2] }),
    },
    {
      pattern: new RegExp(`document\\.(getElementById|querySelector)\\s*\\(\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)\\s*\\.addEventListener\\s*\\(\\s*(["'])(${DOM_EVENT_PATTERN})\\4\\s*,\\s*(?:function\\s*\\([^)]*\\)|(?:\\([^)]*\\)|[A-Za-z_$]\\w*)\\s*=>)\\s*\\{`, 'g'),
      values: (match) => ({
        selector: match[1] === 'getElementById' ? `#${match[2] ?? match[3]}` : (match[2] ?? match[3]),
        event: match[5],
      }),
    },
  ];
  for (const { pattern, values } of patterns) {
    for (const match of content.matchAll(pattern)) {
      const open = match.index + match[0].lastIndexOf('{');
      const close = findBalancedEnd(content, open, '{', '}');
      const { selector, event } = values(match);
      const body = content.slice(open + 1, close);
      addBinding({ offset: match.index, close, selector, event, body });
    }
  }

  const namedPatterns = [
    {
      pattern: new RegExp(`\\$\\(\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)\\s*\\.on\\s*\\(\\s*(["'])([^"']+)\\3\\s*,\\s*([A-Za-z_$]\\w*)\\s*\\)`, 'g'),
      values: (match) => ({ selector: match[1] ?? match[2], events: match[4], handler: match[5] }),
    },
    {
      pattern: new RegExp(`\\$\\([^)]*\\)\\s*\\.on\\s*\\(\\s*(["'])([^"']+)\\1\\s*,\\s*(?:"([^"]*)"|'([^']*)')\\s*,\\s*([A-Za-z_$]\\w*)\\s*\\)`, 'g'),
      values: (match) => ({ selector: match[3] ?? match[4], events: match[2], handler: match[5] }),
    },
    {
      pattern: new RegExp(`\\b[A-Za-z_$]\\w*\\.on\\s*\\(\\s*(["'])([^"']+)\\1\\s*,\\s*([A-Za-z_$]\\w*)\\s*\\)`, 'g'),
      values: (match) => ({ selector: null, events: match[2], handler: match[3] }),
    },
    {
      pattern: new RegExp(`document\\.(getElementById|querySelector)\\s*\\(\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)\\s*\\.addEventListener\\s*\\(\\s*(["'])([^"']+)\\4\\s*,\\s*([A-Za-z_$]\\w*)\\s*\\)`, 'g'),
      values: (match) => ({
        selector: match[1] === 'getElementById' ? `#${match[2] ?? match[3]}` : (match[2] ?? match[3]),
        events: match[5],
        handler: match[6],
      }),
    },
  ];
  for (const { pattern, values } of namedPatterns) {
    for (const match of content.matchAll(pattern)) {
      const { selector, events, handler } = values(match);
      const recognizedEvents = events.split(/\s+/)
        .map((value) => value.split('.', 1)[0])
        .filter((value) => DOM_EVENTS.includes(value));
      for (const event of recognizedEvents) {
        const body = availableFunctions.get(handler) ?? '';
        addBinding({ offset: match.index, close: match.index + match[0].length, selector, event, body });
      }
    }
  }

  if (extension(file) === '.cshtml') {
    const elementPattern = /<([A-Za-z][\w:-]*)\b([^>]*)>/g;
    for (const element of content.matchAll(elementPattern)) {
      const attributes = element[2];
      const selectors = controlSelectors(attributes);
      const inlinePattern = new RegExp(`\\bon(${DOM_EVENT_PATTERN})\\s*=\\s*(["'])(.*?)\\2`, 'gi');
      for (const handler of attributes.matchAll(inlinePattern)) {
        const body = handler[3];
        const steps = traceHttpSteps(body, availableFunctions);
        const line = lineNumberAt(content, element.index);
        bindings.push({
          file,
          selector: selectors[0] ?? null,
          event: handler[1].toLowerCase(),
          steps,
          visualOnly: steps.length === 0 && /(?:\.hide|\.toggle|\.dialog\s*\(\s*["']close|return\s+false)/.test(body),
          evidence: { file, line, end_line: line },
          offset: element.index,
        });
      }
    }
  }
  return bindings
    .filter((binding, index, items) => items.findIndex((item) => (
      item.offset === binding.offset
      && item.selector === binding.selector
      && item.event === binding.event
    )) === index)
    .sort((left, right) => left.offset - right.offset);
}

function linkUiActions(controls, bindings, mvcActions, viewScripts) {
  for (const control of controls) {
    const matches = bindings.filter((binding) => (
      control.selectors.includes(binding.selector)
      && (binding.file === control.file || viewScripts.get(control.file)?.has(binding.file))
    ));
    if (matches.length) {
      for (const match of matches) match.matched = true;
      if (!control.selector) control.selector = matches[0].selector;
      control.events = [...new Set(matches.map((binding) => binding.event))];
      control.steps.push(...matches.flatMap((binding) => binding.steps));
      control.evidence.push(...matches.map((binding) => binding.evidence));
      if (matches.every((binding) => binding.visualOnly)) control.disposition_hint = 'auxiliary';
    }
    control.confidence = control.disposition_hint === 'auxiliary'
      || (control.steps.length > 0 && control.steps.every((step) => step.target))
      ? 'exact'
      : 'unresolved';
  }

  controls.push(...bindings.filter((binding) => !binding.matched).map((binding) => {
    const control = makeUiControl({
      file: binding.file,
      line: binding.evidence.line,
      endLine: binding.evidence.end_line,
      kind: 'client_binding',
      selector: binding.selector,
      label: binding.event,
      steps: binding.steps,
      evidence: [binding.evidence],
      events: [binding.event],
    });
    if (binding.visualOnly) control.disposition_hint = 'auxiliary';
    control.confidence = binding.visualOnly
      || (control.steps.length > 0 && control.steps.every((step) => step.target))
      ? 'exact'
      : 'unresolved';
    return control;
  }));

  for (const control of controls) {
    const partials = control.steps
      .filter((step) => step.kind.startsWith('http') && step.target)
      .flatMap((step) => {
        const segments = step.target.split(/[?#]/, 1)[0].split('/').filter(Boolean);
        if (segments.length < 2) return [];
        const [controllerName, actionName] = segments.slice(-2);
        const action = mvcActions.find((candidate) => (
          candidate.controller === controllerName && candidate.action === actionName
        ));
        return action?.returns
          .filter((item) => item.kind === 'partial_view' && item.target)
          .map((item) => ({ ...item, controller: action.controller })) ?? [];
      })
      .filter((partial, index, items) => items.findIndex((item) => (
        item.controller === partial.controller && item.target === partial.target
      )) === index);
    if (!partials.length) continue;
    for (const partial of partials) {
      const scopedSuffix = `/${partial.controller}/${partial.target}.cshtml`;
      const scopedControls = controls.filter((candidate) => candidate.file.endsWith(scopedSuffix));
      const partialControls = scopedControls.length ? scopedControls : controls.filter((candidate) => (
        candidate.file.endsWith(`/${partial.target}.cshtml`)
        || candidate.file === `${partial.target}.cshtml`
      ));
      const continuation = partialControls
        .flatMap((candidate) => candidate.steps)
        .find((step) => step.target);
      control.steps.push({ kind: 'partial_continuation', method: null, target: partial.target });
      if (continuation) control.steps.push({ ...continuation, kind: 'http_on_success' });
    }
    control.confidence = control.steps.every((step) => step.target) ? 'exact' : 'unresolved';
  }

  const identityCounts = new Map();
  for (const control of controls) {
    const targets = control.steps.map((step) => `${step.kind}:${step.method ?? ''}:${step.target ?? ''}`);
    const identity = JSON.stringify([
      control.type,
      control.file,
      control.control_kind,
      control.selector,
      control.label,
      control.guards,
      targets,
    ]);
    const ordinal = (identityCounts.get(identity) ?? 0) + 1;
    identityCounts.set(identity, ordinal);
    control.id = candidateId(identity, ordinal > 1 ? ordinal : '');
    delete control.selectors;
  }
  return controls;
}

function extractCandidates(sources, files) {
  const readableFiles = files.filter((file) => sources.has(file));
  const mvcActions = readableFiles
    .filter((file) => extension(file) === '.cs')
    .flatMap((file) => extractMvcActions(file, sources.get(file)));
  const controls = readableFiles
    .filter((file) => extension(file) === '.cshtml')
    .flatMap((file) => extractRazorControls(file, sources.get(file)));
  const javascriptFiles = readableFiles.filter((file) => extension(file) === '.js');
  const viewScripts = new Map(readableFiles
    .filter((file) => extension(file) === '.cshtml')
    .map((file) => {
      const references = [...sources.get(file).matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)]
        .map((match) => match[2].split(/[?#]/, 1)[0].replace(/^~?\//, ''));
      return [file, new Set(javascriptFiles.filter((candidate) => (
        references.some((reference) => candidate === reference || candidate.endsWith(`/${reference}`))
      )))];
    }));
  const functionsByFile = new Map(readableFiles
    .filter((file) => extension(file) === '.js' || extension(file) === '.cshtml')
    .map((file) => [file, extractNamedFunctions(sources.get(file))]));
  const scriptsByDirectory = new Map();
  for (const file of javascriptFiles) {
    const directory = normalizePath(dirname(file));
    const related = scriptsByDirectory.get(directory) ?? [];
    related.push(file);
    scriptsByDirectory.set(directory, related);
  }
  const bindings = [...functionsByFile.keys()].flatMap((file) => {
    const relatedFiles = new Set([file]);
    if (extension(file) === '.js') {
      for (const script of scriptsByDirectory.get(normalizePath(dirname(file))) ?? []) {
        relatedFiles.add(script);
      }
    }
    for (const script of viewScripts.get(file) ?? []) {
      relatedFiles.add(script);
      for (const sibling of scriptsByDirectory.get(normalizePath(dirname(script))) ?? []) {
        relatedFiles.add(sibling);
      }
    }
    const availableFunctions = new Map();
    const ambiguousFunctions = new Set();
    for (const relatedFile of relatedFiles) {
      for (const [name, body] of functionsByFile.get(relatedFile) ?? []) {
        if (ambiguousFunctions.has(name)) continue;
        if (availableFunctions.has(name) && availableFunctions.get(name) !== body) {
          availableFunctions.delete(name);
          ambiguousFunctions.add(name);
        } else {
          availableFunctions.set(name, body);
        }
      }
    }
    return extractClientBindings(file, sources.get(file), availableFunctions);
  });
  return [...mvcActions, ...linkUiActions(controls, bindings, mvcActions, viewScripts)].sort((left, right) => (
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
  const scanned = readSourceFiles(source.absolute, files);
  const snapshot = { kind: 'manifest_sha256', id: scanned.snapshotId };
  const artifactPath = join(root, '.reversa', 'context', 'surface-candidates.json');
  const existing = readReusableArtifact(artifactPath);
  if (existing?.schema_version === 1
      && existing.scanner_revision === SURFACE_SCANNER_REVISION
      && existing.source_root === source.relative
      && existing.source_snapshot?.id === snapshot.id) {
    return { artifactPath, artifact: existing };
  }
  const candidates = extractCandidates(scanned.sources, files);
  const gapsByFile = new Map(scanned.scanGaps.map((gap) => [gap.file, gap]));
  const fileCoverage = files.map((file) => ({
    file,
    extension: extension(file),
    status: gapsByFile.has(file) ? 'read_error' : 'analyzed',
    candidates: candidates.filter((candidate) => (
      candidate.file === file || candidate.evidence?.some((evidence) => evidence.file === file)
    )).length,
  }));
  const artifact = {
    schema_version: 1,
    scanner_revision: SURFACE_SCANNER_REVISION,
    generated_at: new Date().toISOString(),
    source_root: source.relative,
    source_snapshot: snapshot,
    summary: {
      files_scanned: files.length,
      candidates: candidates.length,
      exact: candidates.filter((candidate) => candidate.confidence === 'exact').length,
      unresolved: candidates.filter((candidate) => candidate.confidence === 'unresolved').length,
    },
    file_coverage: fileCoverage,
    candidates,
    scan_gaps: scanned.scanGaps,
  };
  writeJsonAtomic(artifactPath, artifact, options.beforeRename);
  return { artifactPath, artifact };
}
