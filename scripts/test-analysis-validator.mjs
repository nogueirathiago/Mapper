#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnalysis } from '../lib/analysis-validator.js';

const DIMENSIONS = [
  'selection', 'mutation', 'authorization', 'state',
  'calculation', 'variation', 'failure', 'persistence',
];
const CLI = fileURLToPath(new URL('../bin/reversa.js', import.meta.url));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');

function createWorkspace({
  operationStatus = 'reviewed',
  completionStatus = 'reviewed_scope_complete',
  sourceFile = 'source/approval.js',
  source = 'export function approve(amount) { return amount <= 100; }\n',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reversa-analysis-'));
  mkdirSync(join(root, '.reversa', 'context'), { recursive: true });
  mkdirSync(dirname(join(root, sourceFile)), { recursive: true });
  writeFileSync(join(root, sourceFile), source, 'utf8');
  writeJson(join(root, '.reversa', 'context', 'surface.json'), {
    source_snapshot: { kind: 'manifest', id: 'snapshot-1' },
    operation_entry_points: [
      { id: 'ENTRY-001', type: 'endpoint', name: 'Approve', file: sourceFile, line: 1 },
    ],
  });

  const operation = {
    id: 'OP-001',
    name: 'Approve amount',
    module: 'approval',
    entry_point_ids: ['ENTRY-001'],
    status: operationStatus,
    flow: ['entry', 'validation', 'response'],
    rule_ids: operationStatus === 'reviewed' ? ['RULE-001'] : [],
    dimensions: operationStatus === 'reviewed'
      ? { analyzed: DIMENSIONS, not_applicable: [], pending: [] }
      : { analyzed: [], not_applicable: [], pending: DIMENSIONS },
  };

  writeJson(join(root, '.reversa', 'context', 'modules.json'), {
    generated_at: '2026-09-16T00:00:00Z',
    modules: [{ name: 'approval', path: 'source', purpose: 'Approval', primary_files: [sourceFile] }],
    behavioral_analysis: {
      version: 1,
      source_snapshot_id: 'snapshot-1',
      completion_status: completionStatus,
      operations: [operation],
      rules: operationStatus === 'reviewed' ? [{
        id: 'RULE-001',
        operation_ids: ['OP-001'],
        condition: 'Amount is at most 100.',
        consequence: 'The operation returns true.',
        exceptions: [],
        allowed_scenarios: ['Amount equals 100.'],
        blocked_scenarios: ['Amount is greater than 100.'],
        implementation_status: 'implemented',
        evidence: [{ file: sourceFile, line: 1, end_line: 1, file_sha256: sha256(source) }],
      }] : [],
    },
  });
  writeJson(join(root, '.reversa', 'state.json'), {
    checkpoints: {
      behavioral_analysis: {
        current_operation_id: null,
        reviewed: operationStatus === 'reviewed' ? 1 : 0,
        pending: operationStatus === 'reviewed' ? 0 : 1,
        blocked: 0,
        investigations: [],
      },
    },
  });
  return root;
}

function testLegacyWorkspaceIsNotPromoted() {
  const root = mkdtempSync(join(tmpdir(), 'reversa-analysis-legacy-'));
  mkdirSync(join(root, '.reversa', 'context'), { recursive: true });
  writeJson(join(root, '.reversa', 'context', 'modules.json'), { modules: [] });
  const report = validateAnalysis(root);
  assert.equal(report.status, 'legacy_unmeasured');
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((item) => item.code === 'analysis_contract_missing'));
  rmSync(root, { recursive: true, force: true });
}

function testReviewedScopePasses() {
  const root = createWorkspace();
  const report = validateAnalysis(root);
  assert.equal(report.status, 'reviewed_scope_complete');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.counts, { identified: 0, analyzing: 0, reviewed: 1, blocked: 0 });
  const cli = spawnSync(process.execPath, [CLI, 'validate-analysis', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'reviewed_scope_complete');
  rmSync(root, { recursive: true, force: true });
}

function testPendingWorkRejectsTotalConclusion() {
  const root = createWorkspace({ operationStatus: 'identified' });
  const report = validateAnalysis(root);
  assert.ok(report.errors.some((item) => item.code === 'complete_with_open_operations'));
  assert.ok(report.warnings.some((item) => item.code === 'operation_not_reviewed'));
  rmSync(root, { recursive: true, force: true });
}

function testBlockedOperationRequiresRealInvestigation() {
  const root = createWorkspace({ operationStatus: 'blocked', completionStatus: 'completed_with_caveats' });
  const modulesPath = join(root, '.reversa', 'context', 'modules.json');
  const statePath = join(root, '.reversa', 'state.json');
  let report = validateAnalysis(root);
  assert.ok(report.errors.some((item) => item.code === 'completion_decision_missing'));

  const modules = JSON.parse(readText(modulesPath));
  modules.behavioral_analysis.operations[0].investigation_id = 'INV-001';
  modules.behavioral_analysis.completion_decision = {
    decision: 'complete_with_caveats', decided_at: '2026-09-16T00:00:00Z', decided_by: 'user',
  };
  writeJson(modulesPath, modules);

  let state = JSON.parse(readText(statePath));
  state.checkpoints.behavioral_analysis = {
    current_operation_id: null, reviewed: 0, pending: 0, blocked: 1,
    investigations: [{
      id: 'INV-001', operation_id: 'OP-001', question: 'Which source defines this behavior?', blocker_kind: 'evidence_exhausted',
      attempts: [1, 2, 3].map((number) => ({
        approach: 'same-search', sources: [`source-${number}`], result: 'No new evidence.', new_evidence: false,
      })),
    }],
  };
  writeJson(statePath, state);
  report = validateAnalysis(root);
  assert.ok(report.errors.some((item) => item.code === 'insufficient_investigation'));

  state = JSON.parse(readText(statePath));
  state.checkpoints.behavioral_analysis.investigations[0].attempts = [1, 2, 3].map((number) => ({
    approach: `approach-${number}`,
    sources: [`source-${number}`],
    result: 'No new evidence.',
    new_evidence: false,
  }));
  writeJson(statePath, state);
  report = validateAnalysis(root);
  assert.equal(report.errors.length, 0);
  assert.equal(report.status, 'completed_with_caveats');
  assert.ok(report.warnings.some((item) => item.code === 'blocked_operation'));
  rmSync(root, { recursive: true, force: true });
}

function testEvidenceHashMismatchFails() {
  const root = createWorkspace();
  const modulesPath = join(root, '.reversa', 'context', 'modules.json');
  const modules = JSON.parse(readText(modulesPath));
  modules.behavioral_analysis.rules[0].evidence[0].file_sha256 = '0'.repeat(64);
  writeJson(modulesPath, modules);
  const report = validateAnalysis(root);
  assert.ok(report.errors.some((item) => item.code === 'evidence_hash_mismatch'));
  const cli = spawnSync(process.execPath, [CLI, 'validate-analysis', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  rmSync(root, { recursive: true, force: true });
}

function testUnmappedEntryPointRejectsTotalConclusion() {
  const root = createWorkspace();
  const surfacePath = join(root, '.reversa', 'context', 'surface.json');
  const surface = JSON.parse(readText(surfacePath));
  surface.operation_entry_points.push({
    id: 'ENTRY-002', type: 'job', name: 'Reconcile', file: 'source/approval.js', line: 1,
  });
  writeJson(surfacePath, surface);
  const report = validateAnalysis(root);
  assert.ok(report.warnings.some((item) => item.code === 'entry_point_without_operation'));
  assert.ok(report.errors.some((item) => item.code === 'complete_with_unmapped_entry_points'));
  rmSync(root, { recursive: true, force: true });
}

function testEvidenceCannotEscapeProject() {
  const root = createWorkspace();
  const modulesPath = join(root, '.reversa', 'context', 'modules.json');
  const modules = JSON.parse(readText(modulesPath));
  modules.behavioral_analysis.rules[0].evidence[0].file = '../outside.js';
  writeJson(modulesPath, modules);
  const report = validateAnalysis(root);
  assert.ok(report.errors.some((item) => item.code === 'evidence_path_outside_project'));
  rmSync(root, { recursive: true, force: true });
}

function testDiscoveryAgentsUseSharedMethod() {
  const root = new URL('..', import.meta.url);
  for (const skill of [
    'reversa-scout', 'reversa-archaeologist', 'reversa-detective',
    'reversa-data-master', 'reversa-writer', 'reversa-reviewer',
  ]) {
    const content = readFileSync(new URL(`agents/${skill}/SKILL.md`, root), 'utf8');
    assert.match(content, /behavioral-analysis-guide\.md/, `${skill} não consulta o método compartilhado`);
  }
}

function testContractIsLanguageNeutral() {
  const root = createWorkspace({
    sourceFile: 'source/ApprovalService.cs',
    source: 'public bool Approve(decimal amount) => amount <= 100m;\n',
  });
  const report = validateAnalysis(root);
  assert.equal(report.status, 'reviewed_scope_complete');
  assert.deepEqual(report.errors, []);
  rmSync(root, { recursive: true, force: true });
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

testLegacyWorkspaceIsNotPromoted();
testReviewedScopePasses();
testPendingWorkRejectsTotalConclusion();
testBlockedOperationRequiresRealInvestigation();
testEvidenceHashMismatchFails();
testUnmappedEntryPointRejectsTotalConclusion();
testEvidenceCannotEscapeProject();
testDiscoveryAgentsUseSharedMethod();
testContractIsLanguageNeutral();
console.log('RESULTADO: ✓ validador de análise comportamental');
