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
  sourceFile = 'approval.js',
  source = 'export function approve(amount) { return amount <= 100; }\n',
  includeDiscovery = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reversa-analysis-'));
  mkdirSync(join(root, '.reversa', 'context'), { recursive: true });
  const sourceRoot = join(root, 'source');
  mkdirSync(dirname(join(sourceRoot, sourceFile)), { recursive: true });
  writeFileSync(join(sourceRoot, sourceFile), source, 'utf8');
  const surface = {
    source_snapshot: { kind: 'manifest', id: 'snapshot-1' },
    operation_entry_points: [
      { id: 'ENTRY-001', type: 'endpoint', name: 'Approve', file: sourceFile, line: 1 },
    ],
  };
  if (includeDiscovery) {
    surface.surface_discovery = {
      schema_version: 1,
      scan_snapshot_id: 'snapshot-1',
      candidate_resolutions: [{
        candidate_id: 'CAND-001',
        disposition: 'promoted',
        entry_point_id: 'ENTRY-001',
        reason: 'Observable operation entry.',
      }],
    };
    writeJson(join(root, '.reversa', 'context', 'surface-candidates.json'), {
      schema_version: 1,
      scanner_revision: 6,
      source_root: 'source',
      source_snapshot: { kind: 'manifest_sha256', id: 'snapshot-1' },
      summary: { files_scanned: 1, candidates: 1, exact: 1, unresolved: 0 },
      file_coverage: [{
        file: sourceFile,
        extension: sourceFile.endsWith('.js') ? '.js' : '.cs',
        status: 'analyzed',
        candidates: 1,
      }],
      candidates: [{
        id: 'CAND-001',
        type: 'mvc_action',
        file: sourceFile,
        line: 1,
        confidence: 'exact',
        evidence: [{ file: sourceFile, line: 1, end_line: 1 }],
      }],
      scan_gaps: [],
    });
  }
  writeJson(join(root, '.reversa', 'context', 'surface.json'), surface);

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

function createLegacyWorkspace(options = {}) {
  const root = createWorkspace({ ...options, includeDiscovery: false });
  mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
    surface.operation_entry_points[0].file = `source/${surface.operation_entry_points[0].file}`;
  });
  mutateJson(join(root, '.reversa', 'context', 'modules.json'), (modules) => {
    const evidence = modules.behavioral_analysis.rules[0]?.evidence[0];
    if (evidence) evidence.file = `source/${evidence.file}`;
  });
  return root;
}

function mutateJson(path, mutate) {
  const value = JSON.parse(readText(path));
  mutate(value);
  writeJson(path, value);
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

function testLegacySurfaceDiscoveryIsOnlyWarning() {
  const root = createLegacyWorkspace();
  try {
    const report = validateAnalysis(root);
    assert.equal(report.status, 'reviewed_scope_complete');
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some((item) => item.code === 'surface_discovery_unmeasured'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testSurfaceSnapshotMismatchFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.scan_snapshot_id = 'snapshot-stale';
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'surface_scan_snapshot_mismatch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCandidateResolutionMissingFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions = [];
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'candidate_resolution_missing'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCandidateResolutionStaleFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions.push({
        candidate_id: 'CAND-STALE', disposition: 'excluded', reason: 'No current candidate.',
      });
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'candidate_resolution_stale'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCandidateResolutionDuplicateFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions.push({
        ...surface.surface_discovery.candidate_resolutions[0],
      });
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'candidate_resolution_duplicate'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCandidateResolutionInvalidFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions[0].disposition = 'invented';
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'candidate_resolution_invalid'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAuxiliaryAndExcludedRequireReason() {
  for (const disposition of ['auxiliary', 'excluded']) {
    const root = createWorkspace();
    try {
      mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
        surface.surface_discovery.candidate_resolutions[0] = {
          candidate_id: 'CAND-001', disposition, reason: '  ',
        };
      });
      const report = validateAnalysis(root);
      assert.ok(report.errors.some((item) => item.code === 'candidate_resolution_reason_missing'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function testFunctionalUiAuxiliaryRequiresTraceableEntries() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface-candidates.json'), (discovery) => {
      discovery.candidates[0] = {
        ...discovery.candidates[0],
        type: 'ui_action',
        control_kind: 'client_binding',
        selector: '#approve',
        steps: [{ kind: 'http', method: 'POST', target: '/Approval/Approve' }],
      };
    });
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions[0] = {
        candidate_id: 'CAND-001',
        disposition: 'auxiliary',
        reason: 'Already represented elsewhere.',
      };
    });

    let report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'functional_ui_auxiliary_unlinked'));

    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions[0].related_entry_point_ids = ['ENTRY-001'];
    });
    report = validateAnalysis(root);
    assert.equal(report.errors.some((item) => item.code === 'functional_ui_auxiliary_unlinked'), false);
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testVisualOnlyUiAuxiliaryDoesNotRequireBackendEntry() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface-candidates.json'), (discovery) => {
      discovery.candidates[0] = {
        ...discovery.candidates[0],
        type: 'ui_action',
        control_kind: 'button',
        selector: '#close',
        disposition_hint: 'auxiliary',
        steps: [],
      };
    });
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions[0] = {
        candidate_id: 'CAND-001', disposition: 'auxiliary', reason: 'Closes a local modal.',
      };
    });
    const report = validateAnalysis(root);
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testLegacyScannerCoverageIsAcceptedWithWarning() {
  for (const completionStatus of ['in_progress', 'reviewed_scope_complete']) {
    const root = createWorkspace({ completionStatus });
    try {
      mutateJson(join(root, '.reversa', 'context', 'surface-candidates.json'), (discovery) => {
        discovery.scanner_revision = 1;
        delete discovery.file_coverage;
      });
      const report = validateAnalysis(root);
      assert.equal(
        report.errors.some((item) => item.code === 'surface_scanner_revision_outdated'),
        false,
      );
      assert.ok(report.warnings.some((item) => item.code === 'surface_scanner_revision_outdated'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function testLegacyFunctionalUiAuxiliaryRemainsCompatible() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface-candidates.json'), (discovery) => {
      discovery.scanner_revision = 1;
      delete discovery.file_coverage;
      discovery.candidates[0] = {
        ...discovery.candidates[0],
        type: 'ui_action',
        control_kind: 'client_binding',
        selector: '#approve',
        steps: [{ kind: 'http', method: 'POST', target: '/Approval/Approve' }],
      };
    });
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions[0] = {
        candidate_id: 'CAND-001',
        disposition: 'auxiliary',
        reason: 'Already represented under the historical contract.',
      };
    });

    const report = validateAnalysis(root);
    assert.equal(report.status, 'reviewed_scope_complete');
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some((item) => item.code === 'surface_scanner_revision_outdated'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCurrentScannerRejectsInconsistentFileCoverage() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface-candidates.json'), (discovery) => {
      discovery.file_coverage = [];
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'surface_file_coverage_invalid'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCandidatePromotionUnknownEntryFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.surface_discovery.candidate_resolutions[0].entry_point_id = 'ENTRY-UNKNOWN';
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'candidate_promotion_unknown_entry'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testCandidatePromotionUnmappedEntryFails() {
  const root = createWorkspace();
  try {
    mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
      surface.operation_entry_points.push({
        id: 'ENTRY-002', type: 'endpoint', name: 'Second', file: 'approval.js', line: 1,
      });
      surface.surface_discovery.candidate_resolutions[0].entry_point_id = 'ENTRY-002';
    });
    const report = validateAnalysis(root);
    assert.ok(report.errors.some((item) => item.code === 'candidate_promotion_unmapped_entry'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testSurfaceScanGapBlocksOnlyTotalConclusion() {
  for (const completionStatus of ['in_progress', 'reviewed_scope_complete']) {
    const root = createWorkspace({ completionStatus });
    try {
      mutateJson(join(root, '.reversa', 'context', 'surface-candidates.json'), (discovery) => {
        discovery.scan_gaps = [{ file: 'unreadable.cs', error: 'read_failed' }];
      });
      const report = validateAnalysis(root);
      if (completionStatus === 'reviewed_scope_complete') {
        assert.ok(report.errors.some((item) => item.code === 'surface_scan_gap'));
      } else {
        assert.ok(report.warnings.some((item) => item.code === 'surface_scan_gap'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function testPendingCandidateBlocksOnlyTotalConclusion() {
  for (const completionStatus of ['in_progress', 'reviewed_scope_complete']) {
    const root = createWorkspace({ completionStatus });
    try {
      mutateJson(join(root, '.reversa', 'context', 'surface.json'), (surface) => {
        surface.surface_discovery.candidate_resolutions[0] = {
          candidate_id: 'CAND-001', disposition: 'pending', reason: 'Evidence is insufficient.',
        };
      });
      const report = validateAnalysis(root);
      if (completionStatus === 'reviewed_scope_complete') {
        assert.ok(report.errors.some((item) => item.code === 'surface_candidate_pending'));
      } else {
        assert.ok(report.warnings.some((item) => item.code === 'surface_candidate_pending'));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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
    id: 'ENTRY-002', type: 'job', name: 'Reconcile', file: 'approval.js', line: 1,
  });
  writeJson(surfacePath, surface);
  const report = validateAnalysis(root);
  assert.ok(report.warnings.some((item) => item.code === 'entry_point_without_operation'));
  assert.ok(report.errors.some((item) => item.code === 'complete_with_unmapped_entry_points'));
  rmSync(root, { recursive: true, force: true });
}

function testEvidenceCannotEscapeProject() {
  const root = createLegacyWorkspace();
  const modulesPath = join(root, '.reversa', 'context', 'modules.json');
  const modules = JSON.parse(readText(modulesPath));
  modules.behavioral_analysis.rules[0].evidence[0].file = '../outside.js';
  writeJson(modulesPath, modules);
  const report = validateAnalysis(root);
  assert.ok(report.errors.some((item) => item.code === 'evidence_path_outside_project'));
  rmSync(root, { recursive: true, force: true });
}

function testEvidenceCannotEscapeConfiguredSourceRoot() {
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
    sourceFile: 'ApprovalService.cs',
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
testLegacySurfaceDiscoveryIsOnlyWarning();
testSurfaceSnapshotMismatchFails();
testCandidateResolutionMissingFails();
testCandidateResolutionStaleFails();
testCandidateResolutionDuplicateFails();
testCandidateResolutionInvalidFails();
testAuxiliaryAndExcludedRequireReason();
testFunctionalUiAuxiliaryRequiresTraceableEntries();
testVisualOnlyUiAuxiliaryDoesNotRequireBackendEntry();
testLegacyScannerCoverageIsAcceptedWithWarning();
testLegacyFunctionalUiAuxiliaryRemainsCompatible();
testCurrentScannerRejectsInconsistentFileCoverage();
testCandidatePromotionUnknownEntryFails();
testCandidatePromotionUnmappedEntryFails();
testSurfaceScanGapBlocksOnlyTotalConclusion();
testPendingCandidateBlocksOnlyTotalConclusion();
testPendingWorkRejectsTotalConclusion();
testBlockedOperationRequiresRealInvestigation();
testEvidenceHashMismatchFails();
testUnmappedEntryPointRejectsTotalConclusion();
testEvidenceCannotEscapeProject();
testEvidenceCannotEscapeConfiguredSourceRoot();
testDiscoveryAgentsUseSharedMethod();
testContractIsLanguageNeutral();
console.log('RESULTADO: ✓ validador de análise comportamental');
