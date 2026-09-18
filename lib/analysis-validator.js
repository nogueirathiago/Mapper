import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { readJsonSafe } from './utils/json-safe.js';

export const BEHAVIOR_DIMENSIONS = [
  'selection',
  'mutation',
  'authorization',
  'state',
  'calculation',
  'variation',
  'failure',
  'persistence',
];

const OPERATION_STATUSES = new Set(['identified', 'analyzing', 'reviewed', 'blocked']);
const COMPLETION_STATUSES = new Set(['in_progress', 'completed_with_caveats', 'reviewed_scope_complete']);
const IMPLEMENTATION_STATUSES = new Set(['implemented', 'inferred', 'presumed_intent', 'unknown']);
const BLOCKER_KINDS = new Set(['evidence_exhausted', 'source_unavailable', 'out_of_scope']);

const issue = (code, message, context = {}) => ({ code, message, ...context });
const digest = (content) => createHash('sha256').update(content).digest('hex');

function dimensionName(value) {
  return typeof value === 'string' ? value : value?.name;
}

function readRequiredJson(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(issue(`${label}_missing`, `${label} não encontrado.`, { path }));
    return null;
  }
  try {
    return readJsonSafe(path);
  } catch (error) {
    errors.push(issue(`${label}_invalid`, `${label} não contém JSON válido.`, { path, detail: error.message }));
    return null;
  }
}

function validateEvidence(evidenceRoot, evidence, label, errors) {
  if (!evidence || typeof evidence.file !== 'string' || !evidence.file) {
    errors.push(issue('evidence_file_missing', 'Evidência sem arquivo.', { item: label }));
    return;
  }
  if (isAbsolute(evidence.file)) {
    errors.push(issue('evidence_path_absolute', 'Evidências devem usar caminho relativo ao projeto.', { item: label, file: evidence.file }));
    return;
  }

  const root = resolve(evidenceRoot);
  const path = resolve(evidenceRoot, evidence.file);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    errors.push(issue('evidence_path_outside_project', 'Evidência aponta para fora do projeto.', { item: label, file: evidence.file }));
    return;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    errors.push(issue('evidence_file_not_found', 'Arquivo de evidência não encontrado.', { item: label, file: evidence.file }));
    return;
  }

  const content = readFileSync(path);
  if (typeof evidence.file_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(evidence.file_sha256)) {
    errors.push(issue('evidence_hash_missing', 'Evidência sem SHA-256 de arquivo válido.', { item: label, file: evidence.file }));
  } else if (digest(content) !== evidence.file_sha256.toLowerCase()) {
    errors.push(issue('evidence_hash_mismatch', 'O arquivo mudou desde a coleta da evidência.', { item: label, file: evidence.file }));
  }

  const line = evidence.line;
  const endLine = evidence.end_line ?? line;
  const lineCount = content.toString('utf8').split(/\r?\n/).length;
  if (!Number.isInteger(line) || !Number.isInteger(endLine) || line < 1 || endLine < line || endLine > lineCount) {
    errors.push(issue('evidence_range_invalid', 'Faixa de linhas da evidência é inválida.', {
      item: label, file: evidence.file, line, end_line: endLine,
    }));
  }
}

function resolveContainedSourceRoot(projectRoot, sourceRoot, errors) {
  if (typeof sourceRoot !== 'string' || !sourceRoot || isAbsolute(sourceRoot)) {
    errors.push(issue('surface_source_root_invalid', 'A raiz de evidências do scan é inválida.', { source_root: sourceRoot }));
    return resolve(projectRoot);
  }
  const root = resolve(projectRoot);
  const evidenceRoot = resolve(root, sourceRoot);
  const rel = relative(root, evidenceRoot);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    errors.push(issue('surface_source_root_invalid', 'A raiz de evidências do scan sai do projeto.', { source_root: sourceRoot }));
    return root;
  }
  if (!existsSync(evidenceRoot) || !statSync(evidenceRoot).isDirectory()) {
    errors.push(issue('surface_source_root_invalid', 'A raiz de evidências do scan não existe.', { source_root: sourceRoot }));
    return root;
  }
  return evidenceRoot;
}

function validateDimensions(operation, errors) {
  const dimensions = operation.dimensions ?? {};
  const analyzed = Array.isArray(dimensions.analyzed) ? dimensions.analyzed.map(dimensionName) : [];
  const notApplicable = Array.isArray(dimensions.not_applicable) ? dimensions.not_applicable.map(dimensionName) : [];
  const pending = Array.isArray(dimensions.pending) ? dimensions.pending.map(dimensionName) : [];
  const all = [...analyzed, ...notApplicable, ...pending];
  const unknown = all.filter((name) => !BEHAVIOR_DIMENSIONS.includes(name));
  const duplicates = all.filter((name, index) => all.indexOf(name) !== index);
  const missing = BEHAVIOR_DIMENSIONS.filter((name) => !all.includes(name));

  if (unknown.length) {
    errors.push(issue('operation_dimensions_unknown', 'Operação contém dimensões desconhecidas.', { operation_id: operation.id, dimensions: [...new Set(unknown)] }));
  }
  if (duplicates.length) {
    errors.push(issue('operation_dimensions_duplicate', 'Uma dimensão foi classificada mais de uma vez.', { operation_id: operation.id, dimensions: [...new Set(duplicates)] }));
  }
  if (missing.length) {
    errors.push(issue('operation_dimensions_missing', 'Nem todas as dimensões comportamentais foram avaliadas.', { operation_id: operation.id, dimensions: missing }));
  }

  for (const value of dimensions.not_applicable ?? []) {
    if (typeof value !== 'object' || typeof value.reason !== 'string' || !value.reason.trim()) {
      errors.push(issue('not_applicable_reason_missing', 'Dimensão não aplicável precisa de justificativa.', {
        operation_id: operation.id, dimension: dimensionName(value),
      }));
    }
  }
  if (operation.status === 'reviewed' && pending.length) {
    errors.push(issue('reviewed_operation_has_pending_dimensions', 'Operação revisada ainda possui dimensões pendentes.', {
      operation_id: operation.id, dimensions: pending,
    }));
  }
}

function validateInvestigation(operation, investigations, errors) {
  const investigation = investigations.find((item) => item.id === operation.investigation_id);
  if (!investigation || investigation.operation_id !== operation.id) {
    errors.push(issue('blocked_operation_without_investigation', 'Operação bloqueada não possui investigação vinculada.', { operation_id: operation.id }));
    return;
  }
  if (!BLOCKER_KINDS.has(investigation.blocker_kind)) {
    errors.push(issue('blocker_kind_invalid', 'Tipo de bloqueio inválido.', { operation_id: operation.id }));
    return;
  }
  if (typeof investigation.question !== 'string' || !investigation.question.trim()) {
    errors.push(issue('investigation_question_missing', 'Investigação sem lacuna concreta formulada.', { operation_id: operation.id }));
  }

  if (investigation.blocker_kind === 'evidence_exhausted') {
    const attempts = Array.isArray(investigation.attempts) ? investigation.attempts : [];
    const valid = attempts.filter((attempt) => (
      typeof attempt.approach === 'string' && attempt.approach.trim()
      && Array.isArray(attempt.sources) && attempt.sources.length > 0
      && typeof attempt.result === 'string' && attempt.result.trim()
      && typeof attempt.new_evidence === 'boolean'
    ));
    const stalled = valid.slice(-3);
    const approaches = new Set(stalled.map((attempt) => attempt.approach.trim().toLowerCase()));
    const noNewEvidence = stalled.every((attempt) => attempt.new_evidence === false);
    if (stalled.length < 3 || approaches.size < 3 || !noNewEvidence) {
      errors.push(issue('insufficient_investigation', 'Bloqueio por evidência esgotada exige três tentativas relevantes e distintas.', {
        operation_id: operation.id, valid_attempts: stalled.length, distinct_approaches: approaches.size,
      }));
    }
  } else if (!Array.isArray(investigation.blocking_evidence) || investigation.blocking_evidence.length === 0) {
    errors.push(issue('blocking_evidence_missing', 'Fonte indisponível ou fora de escopo exige evidência objetiva do impedimento.', { operation_id: operation.id }));
  }
}

function validateSnapshot(context) {
  const { surface, analysis, errors } = context;
  if (!surface?.source_snapshot?.id) {
    errors.push(issue('source_snapshot_missing', 'surface.json não identifica o snapshot analisado.'));
  } else if (analysis.source_snapshot_id !== surface.source_snapshot.id) {
    errors.push(issue('source_snapshot_mismatch', 'modules.json não corresponde ao snapshot de surface.json.', {
      expected: surface.source_snapshot.id, actual: analysis.source_snapshot_id,
    }));
  }
}

function validateEntryPoints(context) {
  const { entryPoints, entryIds, errors } = context;
  for (const entry of entryPoints) {
    if (entry?.id && entryIds.has(entry.id)) {
      errors.push(issue('entry_point_id_duplicate', 'Ponto de entrada sem ID único.', { entry_point_id: entry.id }));
    }
    if (entry?.id) entryIds.add(entry.id);
    if (!entry?.id || !entry?.type || !entry?.name || !entry?.file || !Number.isInteger(entry?.line)) {
      errors.push(issue('entry_point_invalid', 'Ponto de entrada incompleto.', { entry_point_id: entry?.id }));
    }
  }
}

function indexRules(context) {
  const { rules, ruleById, errors } = context;
  for (const rule of rules) {
    if (!rule?.id || ruleById.has(rule.id)) {
      errors.push(issue('rule_id_invalid', 'Regra sem ID único.', { rule_id: rule?.id }));
      continue;
    }
    ruleById.set(rule.id, rule);
  }
}

function validateOperation(operation, context) {
  const { entryIds, referencedEntryIds, operationById, ruleById, investigations, counts, errors, warnings } = context;
  if (!operation?.id || operationById.has(operation.id)) {
    errors.push(issue('operation_id_invalid', 'Operação sem ID único.', { operation_id: operation?.id }));
    return;
  }
  operationById.set(operation.id, operation);
  if (!OPERATION_STATUSES.has(operation.status)) {
    errors.push(issue('operation_status_invalid', 'Estado de operação inválido.', { operation_id: operation.id, status: operation.status }));
  } else {
    counts[operation.status]++;
  }
  if (!operation.name || !operation.module) {
    errors.push(issue('operation_identity_missing', 'Operação sem nome ou módulo.', { operation_id: operation.id }));
  }
  if (!Array.isArray(operation.entry_point_ids) || operation.entry_point_ids.length === 0) {
    errors.push(issue('operation_entry_point_missing', 'Operação sem ponto de entrada vinculado.', { operation_id: operation.id }));
  } else {
    for (const entryId of operation.entry_point_ids) {
      referencedEntryIds.add(entryId);
      if (!entryIds.has(entryId)) {
        errors.push(issue('operation_entry_point_unknown', 'Operação referencia ponto de entrada inexistente.', { operation_id: operation.id, entry_point_id: entryId }));
      }
    }
  }

  validateDimensions(operation, errors);
  if (operation.status === 'reviewed') {
    if (!Array.isArray(operation.flow) || operation.flow.length < 2) {
      errors.push(issue('reviewed_operation_flow_missing', 'Operação revisada precisa registrar o fluxo rastreado.', { operation_id: operation.id }));
    }
    const ruleReferences = Array.isArray(operation.rule_ids) ? operation.rule_ids : [];
    if (ruleReferences.length === 0 && !operation.no_business_decisions_reason) {
      errors.push(issue('reviewed_operation_without_decision', 'Operação revisada precisa de regras ou justificativa de ausência de decisão.', { operation_id: operation.id }));
    }
  } else {
    warnings.push(issue('operation_not_reviewed', 'Operação ainda não possui revisão comportamental concluída.', { operation_id: operation.id, status: operation.status }));
  }
  for (const ruleId of operation.rule_ids ?? []) {
    if (!ruleById.has(ruleId)) {
      errors.push(issue('operation_rule_unknown', 'Operação referencia regra inexistente.', { operation_id: operation.id, rule_id: ruleId }));
    }
  }
  if (operation.status === 'blocked') {
    warnings.push(issue('blocked_operation', 'Operação permanece bloqueada.', { operation_id: operation.id }));
    validateInvestigation(operation, investigations, errors);
  }
}

function validateOperations(context) {
  const { operations, entryIds, referencedEntryIds, warnings } = context;
  operations.forEach((operation) => validateOperation(operation, context));
  for (const entryId of entryIds) {
    if (!referencedEntryIds.has(entryId)) {
      warnings.push(issue('entry_point_without_operation', 'Ponto de entrada ainda não está vinculado a uma operação.', { entry_point_id: entryId }));
    }
  }
}

function validateRule(rule, context) {
  const { evidenceRoot, operationById, ruleById, errors } = context;
  if (!rule?.id || ruleById.get(rule.id) !== rule) return;
  if (!Array.isArray(rule.operation_ids) || rule.operation_ids.length === 0) {
    errors.push(issue('rule_operation_missing', 'Regra sem operação vinculada.', { rule_id: rule.id }));
  } else {
    for (const operationId of rule.operation_ids) {
      const operation = operationById.get(operationId);
      if (!operation) {
        errors.push(issue('rule_operation_unknown', 'Regra referencia operação inexistente.', { rule_id: rule.id, operation_id: operationId }));
      } else if (!(operation.rule_ids ?? []).includes(rule.id)) {
        errors.push(issue('rule_link_asymmetric', 'Vínculo entre regra e operação não é bidirecional.', { rule_id: rule.id, operation_id: operationId }));
      }
    }
  }
  for (const field of ['condition', 'consequence']) {
    if (typeof rule[field] !== 'string' || !rule[field].trim()) {
      errors.push(issue('rule_explanation_missing', `Regra sem ${field}.`, { rule_id: rule.id, field }));
    }
  }
  for (const field of ['exceptions', 'allowed_scenarios', 'blocked_scenarios']) {
    if (!Array.isArray(rule[field])) {
      errors.push(issue('rule_scenarios_invalid', `Campo ${field} deve ser uma lista.`, { rule_id: rule.id, field }));
    }
  }
  if (!Array.isArray(rule.allowed_scenarios) || rule.allowed_scenarios.length === 0
    || !Array.isArray(rule.blocked_scenarios) || rule.blocked_scenarios.length === 0) {
    errors.push(issue('rule_scenarios_missing', 'Regra precisa de cenários concretos permitido e bloqueado.', { rule_id: rule.id }));
  }
  if (!IMPLEMENTATION_STATUSES.has(rule.implementation_status)) {
    errors.push(issue('rule_implementation_status_invalid', 'Classificação de implementação inválida.', { rule_id: rule.id }));
  }
  if (!Array.isArray(rule.evidence) || rule.evidence.length === 0) {
    errors.push(issue('rule_evidence_missing', 'Regra sem evidência.', { rule_id: rule.id }));
  } else {
    rule.evidence.forEach((evidence, index) => validateEvidence(evidenceRoot, evidence, `${rule.id}:${index}`, errors));
  }
}

function validateRules(context) {
  context.rules.forEach((rule) => validateRule(rule, context));
}

function validateCheckpoint(context) {
  const { state, counts, operationById, errors } = context;
  const checkpoint = state?.checkpoints?.behavioral_analysis;
  if (!checkpoint) {
    errors.push(issue('behavioral_checkpoint_missing', 'state.json não contém checkpoint comportamental.'));
    return;
  }
  const expectedPending = counts.identified + counts.analyzing;
  for (const [field, expected] of [['reviewed', counts.reviewed], ['pending', expectedPending], ['blocked', counts.blocked]]) {
    if (checkpoint[field] !== expected) {
      errors.push(issue('checkpoint_count_mismatch', 'Contagem do checkpoint não corresponde às operações.', { field, expected, actual: checkpoint[field] }));
    }
  }
  if (checkpoint.current_operation_id && !operationById.has(checkpoint.current_operation_id)) {
    errors.push(issue('checkpoint_operation_unknown', 'Checkpoint aponta para operação inexistente.', { operation_id: checkpoint.current_operation_id }));
  }
}

function validateSurfaceDiscovery(context) {
  const {
    discovery,
    surface,
    analysis,
    entryIds,
    referencedEntryIds,
    errors,
    warnings,
  } = context;
  if (!discovery) {
    warnings.push(issue(
      'surface_discovery_unmeasured',
      'A descoberta de interface não foi aferida nesta análise.',
    ));
    return;
  }

  const surfaceDiscovery = surface?.surface_discovery;
  const candidates = Array.isArray(discovery.candidates) ? discovery.candidates : [];
  const resolutions = Array.isArray(surfaceDiscovery?.candidate_resolutions)
    ? surfaceDiscovery.candidate_resolutions
    : [];
  if (discovery.schema_version !== 1 || surfaceDiscovery?.schema_version !== 1) {
    errors.push(issue('candidate_resolution_invalid', 'Contrato de descoberta de superfície inválido.'));
  }
  if (!discovery.source_snapshot?.id
      || surfaceDiscovery?.scan_snapshot_id !== discovery.source_snapshot.id) {
    errors.push(issue('surface_scan_snapshot_mismatch', 'O snapshot classificado não corresponde ao scan atual.', {
      expected: discovery.source_snapshot?.id,
      actual: surfaceDiscovery?.scan_snapshot_id,
    }));
  }

  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (!candidate?.id || candidateIds.has(candidate.id)) {
      errors.push(issue('candidate_resolution_invalid', 'Candidato sem ID único.', { candidate_id: candidate?.id }));
    } else {
      candidateIds.add(candidate.id);
    }
  }

  const resolutionsByCandidate = new Map();
  for (const resolution of resolutions) {
    if (!resolution?.candidate_id) {
      errors.push(issue('candidate_resolution_invalid', 'Resolução sem candidate_id.'));
      continue;
    }
    const values = resolutionsByCandidate.get(resolution.candidate_id) ?? [];
    values.push(resolution);
    resolutionsByCandidate.set(resolution.candidate_id, values);
    if (!candidateIds.has(resolution.candidate_id)) {
      errors.push(issue('candidate_resolution_stale', 'Resolução referencia candidato ausente no scan atual.', {
        candidate_id: resolution.candidate_id,
      }));
    }
  }

  for (const candidateId of candidateIds) {
    const candidateResolutions = resolutionsByCandidate.get(candidateId) ?? [];
    if (candidateResolutions.length === 0) {
      errors.push(issue('candidate_resolution_missing', 'Candidato sem resolução.', { candidate_id: candidateId }));
      continue;
    }
    if (candidateResolutions.length > 1) {
      errors.push(issue('candidate_resolution_duplicate', 'Candidato possui mais de uma resolução.', {
        candidate_id: candidateId,
      }));
    }
    const resolution = candidateResolutions[0];
    if (!['promoted', 'auxiliary', 'excluded', 'pending'].includes(resolution.disposition)) {
      errors.push(issue('candidate_resolution_invalid', 'Disposição de candidato inválida.', {
        candidate_id: candidateId,
        disposition: resolution.disposition,
      }));
      continue;
    }
    if (['auxiliary', 'excluded'].includes(resolution.disposition)
        && (typeof resolution.reason !== 'string' || !resolution.reason.trim())) {
      errors.push(issue('candidate_resolution_reason_missing', 'Resolução auxiliar ou excluída exige justificativa.', {
        candidate_id: candidateId,
      }));
    }
    if (resolution.disposition === 'promoted') {
      if (!entryIds.has(resolution.entry_point_id)) {
        errors.push(issue('candidate_promotion_unknown_entry', 'Candidato promovido referencia entrada inexistente.', {
          candidate_id: candidateId,
          entry_point_id: resolution.entry_point_id,
        }));
      } else if (!referencedEntryIds.has(resolution.entry_point_id)) {
        errors.push(issue('candidate_promotion_unmapped_entry', 'Entrada promovida não está vinculada a uma operação.', {
          candidate_id: candidateId,
          entry_point_id: resolution.entry_point_id,
        }));
      }
    }
    if (resolution.disposition === 'pending') {
      const target = analysis.completion_status === 'reviewed_scope_complete' ? errors : warnings;
      target.push(issue('surface_candidate_pending', 'Candidato permanece sem classificação conclusiva.', {
        candidate_id: candidateId,
      }));
    }
  }

  const scanGaps = Array.isArray(discovery.scan_gaps) ? discovery.scan_gaps : [];
  if (scanGaps.length) {
    const target = analysis.completion_status === 'reviewed_scope_complete' ? errors : warnings;
    target.push(issue('surface_scan_gap', 'O scan possui arquivos que não puderam ser analisados.', {
      count: scanGaps.length,
    }));
  }
}

function validateCompletion(context) {
  const { analysis, operations, counts, warnings, errors } = context;
  const completionStatus = analysis.completion_status ?? 'in_progress';
  if (!COMPLETION_STATUSES.has(completionStatus)) {
    errors.push(issue('completion_status_invalid', 'Estado de conclusão inválido.', { completion_status: completionStatus }));
  }
  const openOperations = counts.identified + counts.analyzing + counts.blocked;
  if (operations.length === 0) {
    const emptyIssue = issue('analysis_without_operations', 'Nenhuma operação comportamental foi registrada.');
    if (completionStatus === 'reviewed_scope_complete') errors.push(emptyIssue);
    else warnings.push(emptyIssue);
  }
  if (completionStatus === 'reviewed_scope_complete' && openOperations > 0) {
    errors.push(issue('complete_with_open_operations', 'Cobertura revisada não pode ser declarada com operações abertas ou bloqueadas.', { open_operations: openOperations }));
  }
  if (completionStatus === 'reviewed_scope_complete' && warnings.some((item) => item.code === 'entry_point_without_operation')) {
    errors.push(issue('complete_with_unmapped_entry_points', 'Cobertura revisada não pode ser declarada com entradas sem operação.'));
  }
  if (completionStatus === 'in_progress' && openOperations === 0 && !warnings.some((item) => item.code === 'entry_point_without_operation')) {
    warnings.push(issue('analysis_ready_for_completion', 'Todas as operações estão revisadas; falta registrar o encerramento.'));
  }
  if (completionStatus === 'completed_with_caveats') {
    const decision = analysis.completion_decision;
    if (openOperations === 0) {
      warnings.push(issue('caveats_without_open_operations', 'Encerramento com ressalvas não possui operações abertas.'));
    }
    if (decision?.decision !== 'complete_with_caveats' || decision?.decided_by !== 'user' || !decision?.decided_at) {
      errors.push(issue('completion_decision_missing', 'Encerramento com ressalvas exige decisão explícita do usuário.'));
    }
  }
  return completionStatus;
}

export function validateAnalysis(projectRoot = process.cwd()) {
  const errors = [];
  const warnings = [];
  const modulesPath = join(projectRoot, '.reversa', 'context', 'modules.json');

  if (!existsSync(modulesPath)) {
    return {
      status: 'not_started',
      counts: { identified: 0, analyzing: 0, reviewed: 0, blocked: 0 },
      errors,
      warnings: [issue('analysis_artifacts_missing', 'A análise comportamental ainda não foi iniciada.')],
    };
  }

  const modules = readRequiredJson(modulesPath, 'modules', errors);
  if (!modules) {
    return { status: 'invalid', counts: {}, errors, warnings };
  }
  const analysis = modules.behavioral_analysis;
  if (!analysis) {
    return {
      status: 'legacy_unmeasured',
      counts: { identified: 0, analyzing: 0, reviewed: 0, blocked: 0 },
      errors,
      warnings: [issue('analysis_contract_missing', 'Artefatos anteriores continuam utilizáveis, mas a cobertura comportamental não foi aferida pelo contrato v1.')],
    };
  }
  if (analysis.version !== 1) {
    errors.push(issue('analysis_contract_version', 'Versão de contrato comportamental não suportada.', { version: analysis.version }));
  }

  const surface = readRequiredJson(join(projectRoot, '.reversa', 'context', 'surface.json'), 'surface', errors);
  const candidatesPath = join(projectRoot, '.reversa', 'context', 'surface-candidates.json');
  const discovery = existsSync(candidatesPath)
    ? readRequiredJson(candidatesPath, 'surface_candidates', errors)
    : null;
  const state = readRequiredJson(join(projectRoot, '.reversa', 'state.json'), 'state', errors);
  const evidenceRoot = discovery
    ? resolveContainedSourceRoot(projectRoot, discovery.source_root, errors)
    : resolve(projectRoot);
  const context = {
    projectRoot,
    evidenceRoot,
    analysis,
    surface,
    discovery,
    state,
    operations: Array.isArray(analysis.operations) ? analysis.operations : [],
    rules: Array.isArray(analysis.rules) ? analysis.rules : [],
    entryPoints: Array.isArray(surface?.operation_entry_points) ? surface.operation_entry_points : [],
    investigations: state?.checkpoints?.behavioral_analysis?.investigations ?? [],
    entryIds: new Set(),
    referencedEntryIds: new Set(),
    operationById: new Map(),
    ruleById: new Map(),
    counts: { identified: 0, analyzing: 0, reviewed: 0, blocked: 0 },
    errors,
    warnings,
  };

  validateSnapshot(context);
  validateEntryPoints(context);
  indexRules(context);
  validateOperations(context);
  validateSurfaceDiscovery(context);
  validateRules(context);
  validateCheckpoint(context);
  const completionStatus = validateCompletion(context);

  return {
    status: errors.length ? 'invalid' : completionStatus,
    source_snapshot_id: analysis.source_snapshot_id,
    counts: context.counts,
    errors,
    warnings,
  };
}
