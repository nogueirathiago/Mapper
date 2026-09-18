#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  cpSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSourceRoot, scanSurface } from '../lib/surface-scanner.js';

const fixturesRoot = fileURLToPath(new URL('./fixtures/surface-scanner/', import.meta.url));
const cli = fileURLToPath(new URL('../bin/reversa.js', import.meta.url));

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'reversa-surface-'));
  mkdirSync(join(root, '.reversa'), { recursive: true });
  mkdirSync(join(root, 'managed'), { recursive: true });
  mkdirSync(join(root, 'user'), { recursive: true });
  mkdirSync(join(root, 'override'), { recursive: true });
  writeFileSync(join(root, '.reversa', 'config.toml'), '[analysis]\nsource_root = "managed"\n');
  writeFileSync(join(root, '.reversa', 'config.user.toml'), '[analysis]\nsource_root = "user"\n');
  return root;
};

function testSourcePrecedenceAndContainment() {
  const root = makeRoot();
  try {
    assert.equal(resolveSourceRoot(root).relative, 'user');
    assert.equal(resolveSourceRoot(root, 'override').relative, 'override');
    mkdirSync(join(root, 'nested', 'legacy'), { recursive: true });
    assert.equal(resolveSourceRoot(root, 'nested/legacy').relative, 'nested/legacy');
    assert.throws(() => resolveSourceRoot(root, '../outside'), /outside_project/);
    assert.throws(() => resolveSourceRoot(root, root), /source_path_absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testDeterministicArtifactAndAtomicFailure() {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'user', 'sample.js'), 'export const value = 1;\n');
    const first = scanSurface(root);
    const firstBytes = readFileSync(first.artifactPath);
    const second = scanSurface(root);

    assert.equal(first.artifact.source_snapshot.id, second.artifact.source_snapshot.id);
    assert.equal(first.artifact.source_root, 'user');
    assert.ok(existsSync(first.artifactPath));
    assert.deepEqual(JSON.parse(readFileSync(first.artifactPath, 'utf8')).candidates, []);
    assert.deepEqual(readFileSync(first.artifactPath), firstBytes);
    assert.equal(existsSync(`${first.artifactPath}.tmp`), false);

    writeFileSync(first.artifactPath, '{"sentinel":true}\n');
    const sentinel = readFileSync(first.artifactPath);
    writeFileSync(join(root, 'user', 'sample.js'), 'export const value = 2;\n');
    assert.throws(
      () => scanSurface(root, { beforeRename: () => { throw new Error('atomic-test'); } }),
      /atomic-test/,
    );
    assert.deepEqual(readFileSync(first.artifactPath), sentinel);
    assert.equal(existsSync(`${first.artifactPath}.tmp`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testUnreadableFileBecomesScanGap() {
  const root = makeRoot();
  const unreadable = join(root, 'user', 'unreadable.js');
  try {
    writeFileSync(unreadable, 'export const value = 1;\n');
    chmodSync(unreadable, 0o000);
    const { artifact } = scanSurface(root);
    assert.equal(artifact.summary.files_scanned, 1);
    assert.equal(artifact.candidates.length, 0);
    assert.equal(artifact.scan_gaps.length, 1);
    assert.equal(artifact.scan_gaps[0].file, 'unreadable.js');
    assert.match(artifact.scan_gaps[0].error, /read_failed|EACCES/);
  } finally {
    chmodSync(unreadable, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
}

function testMvcActions() {
  const root = mkdtempSync(join(tmpdir(), 'reversa-surface-mvc-'));
  try {
    cpSync(join(fixturesRoot, 'mvc-basic'), root, { recursive: true });
    const first = scanSurface(root).artifact;
    const mvc = first.candidates.filter((item) => item.type === 'mvc_action');
    const firstIds = mvc.map((item) => item.id);

    assert.deepEqual(mvc.map((item) => item.action), ['Detail', 'ValidateSend']);
    assert.deepEqual(mvc.map((item) => item.method), ['GET', 'POST']);
    assert.equal(mvc[0].route, 'requests/{id}');
    assert.deepEqual(mvc[1].returns, [{ kind: 'partial_view', target: '_ConfirmSend' }]);
    assert.equal(mvc.some((item) => item.action === 'InternalCheck'), false);
    assert.equal(mvc.some((item) => item.action === 'PublicHelper'), false);
    assert.equal(first.summary.candidates, 2);
    assert.equal(first.summary.exact, 2);

    const secondIds = scanSurface(root).artifact.candidates
      .filter((item) => item.type === 'mvc_action')
      .map((item) => item.id);
    assert.deepEqual(firstIds, secondIds);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scanFixture(name, extras = []) {
  const root = mkdtempSync(join(tmpdir(), `reversa-surface-${name}-`));
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  for (const extra of extras) cpSync(join(fixturesRoot, extra), root, { recursive: true });
  return { root, artifact: scanSurface(root).artifact };
}

function compactSteps(candidate) {
  return candidate.steps.map(({ kind, method, target }) => ({ kind, method, target }));
}

function testRazorAndJavaScriptFlows() {
  const a = scanFixture('ui-flow-a');
  const b = scanFixture('ui-flow-b');
  try {
    const uiA = a.artifact.candidates.filter((item) => item.type === 'ui_action');
    const send = uiA.find((item) => item.selector === '#btnSendRequest');
    assert.deepEqual(send.guards, ['Model.Status == Status.Pending', '!Model.CanSend']);
    assert.deepEqual(compactSteps(send), [
      { kind: 'http', method: 'GET', target: '/Requests/ValidateSend' },
      { kind: 'partial_continuation', method: null, target: '_ConfirmSend' },
      { kind: 'http_on_success', method: 'POST', target: '/Requests/Send' },
    ]);
    assert.equal(send.confidence, 'exact');

    const confirmations = uiA.filter((item) => (
      item.selector === '#btnConfirmSend' || item.selector === '#btnConfirmExpress'
    ));
    assert.equal(confirmations.length, 2);
    assert.notEqual(confirmations[0].id, confirmations[1].id);
    assert.deepEqual(
      confirmations.map((item) => item.steps[0].arguments.mode).sort(),
      ['expedited', 'standard'],
    );

    assert.deepEqual(compactSteps(uiA.find((item) => item.selector === '#requestForm')), [
      { kind: 'http', method: 'POST', target: '/Requests/Create' },
    ]);
    assert.deepEqual(compactSteps(uiA.find((item) => item.selector === '#formSave')), [
      { kind: 'http', method: 'POST', target: '/Requests/Save' },
    ]);
    assert.deepEqual(compactSteps(uiA.find((item) => item.selector === '#linkDetail')), [
      { kind: 'navigation', method: 'GET', target: '/Requests/Detail' },
    ]);
    assert.deepEqual(compactSteps(uiA.find((item) => item.selector === '#linkHistory')), [
      { kind: 'navigation', method: 'GET', target: '/Requests/History' },
    ]);
    assert.deepEqual(compactSteps(uiA.find((item) => item.selector === '#btnSubmitRequest')), [
      { kind: 'submit', method: 'POST', target: '/Requests/Create' },
    ]);

    const uiB = b.artifact.candidates.filter((item) => item.type === 'ui_action');
    const duplicateIdBranches = uiB.filter((item) => item.selector === '#btnReview');
    assert.equal(duplicateIdBranches.length, 2);
    assert.notEqual(duplicateIdBranches[0].id, duplicateIdBranches[1].id);
    assert.deepEqual(duplicateIdBranches.map((item) => item.guards), [
      ['Model.CanSubmit'],
      ['Model.CanResubmit'],
    ]);
    for (const branch of duplicateIdBranches) {
      assert.deepEqual(compactSteps(branch), [
        { kind: 'http', method: 'POST', target: '/Review/Validate' },
        { kind: 'http_on_success', method: 'POST', target: '/Review/Submit' },
      ]);
    }

    const alternative = uiB.find((item) => item.selector === '#btnAlternative');
    assert.deepEqual(compactSteps(alternative), [
      { kind: 'http', method: 'POST', target: '/Alternative/Validate' },
    ]);
    assert.notEqual(duplicateIdBranches[0].id, alternative.id);

    const dynamic = uiB.find((item) => item.selector === '#btnDynamic');
    assert.equal(dynamic.confidence, 'unresolved');
    assert.deepEqual(compactSteps(dynamic), [
      { kind: 'http', method: 'POST', target: null },
    ]);

    const closeModal = uiB.find((item) => item.selector === '#btnCloseModal');
    assert.equal(closeModal.disposition_hint, 'auxiliary');
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
}

function testScanSurfaceCommand() {
  const root = mkdtempSync(join(tmpdir(), 'reversa-surface-cli-'));
  try {
    mkdirSync(join(root, 'alternate'), { recursive: true });
    writeFileSync(join(root, 'sample.js'), 'export const value = 1;\n');
    writeFileSync(join(root, 'alternate', 'sample.js'), 'export const value = 2;\n');
    const options = { cwd: root, encoding: 'utf8' };

    const ok = spawnSync(process.execPath, [cli, 'scan-surface', '--json'], options);
    assert.equal(ok.status, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.deepEqual(Object.keys(summary).sort(), [
      'candidates',
      'exact',
      'files_scanned',
      'source_root',
      'source_snapshot_id',
      'unresolved',
    ]);
    assert.equal('artifact' in summary, false);

    const override = spawnSync(
      process.execPath,
      [cli, 'scan-surface', '--source=alternate', '--json'],
      options,
    );
    assert.equal(override.status, 0, override.stderr);
    assert.equal(JSON.parse(override.stdout).source_root, 'alternate');

    const fatal = spawnSync(
      process.execPath,
      [cli, 'scan-surface', '--source=../outside', '--json'],
      options,
    );
    assert.equal(fatal.status, 1);
    assert.equal(JSON.parse(fatal.stdout).error.code, 'source_path_outside_project');

    const human = spawnSync(process.execPath, [cli, 'scan-surface'], options);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /surface|superficie/i);
    assert.doesNotMatch(human.stdout, /"candidates"\s*:/);

    const unknown = spawnSync(process.execPath, [cli, 'scan-surface', '--wat'], options);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown_option/);
    assert.doesNotMatch(unknown.stderr, /\n\s+at\s/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function flowShape(artifact) {
  return artifact.candidates
    .filter((item) => item.type === 'ui_action')
    .map((item) => ({
      type: item.type,
      control_kind: item.control_kind,
      guard_count: item.guards.length,
      steps: item.steps.map((step) => ({ kind: step.kind, method: step.method })),
      confidence: item.confidence,
      disposition_hint: item.disposition_hint ?? null,
    }));
}

function testScannerIsIndependentFromFixtureNames() {
  const original = scanFixture('ui-flow-b');
  const renamedRoot = mkdtempSync(join(tmpdir(), 'reversa-surface-renamed-'));
  try {
    cpSync(join(fixturesRoot, 'ui-flow-b'), renamedRoot, { recursive: true });
    for (const relativePath of ['Views/Review/Index.cshtml', 'Scripts/review-flow.js']) {
      const path = join(renamedRoot, relativePath);
      const renamed = readFileSync(path, 'utf8')
        .replaceAll('Review', 'Audit')
        .replaceAll('review', 'audit')
        .replaceAll('Submit', 'Approve')
        .replaceAll('submit', 'approve')
        .replaceAll('Alternative', 'Secondary')
        .replaceAll('alternative', 'secondary')
        .replaceAll('Validate', 'Check')
        .replaceAll('Close', 'Dismiss')
        .replaceAll('close', 'dismiss');
      writeFileSync(path, renamed);
    }
    const renamedArtifact = scanSurface(renamedRoot).artifact;
    assert.deepEqual(flowShape(renamedArtifact), flowShape(original.artifact));
  } finally {
    rmSync(original.root, { recursive: true, force: true });
    rmSync(renamedRoot, { recursive: true, force: true });
  }
}

function testAgentAndDocumentationContracts() {
  const orchestrator = readFileSync(
    new URL('../agents/reversa/SKILL.md', import.meta.url),
    'utf8',
  );
  assert.match(
    orchestrator,
    /antes de (?:ativar|executar|reativar)[\s\S]*Scout[\s\S]*reversa scan-surface --json/i,
  );
  assert.match(orchestrator, /n[aã]o (?:faça|apresente)[\s\S]*pergunta/i);

  const scout = readFileSync(
    new URL('../agents/reversa-scout/SKILL.md', import.meta.url),
    'utf8',
  );
  for (const token of [
    'surface-candidates.json',
    'candidate_resolutions',
    'promoted',
    'auxiliary',
    'excluded',
    'pending',
  ]) {
    assert.ok(scout.includes(token), `Scout sem contrato ${token}`);
  }

  const schema = readFileSync(
    new URL('../agents/reversa-scout/references/surface-schema.md', import.meta.url),
    'utf8',
  );
  assert.match(schema, /surface_discovery/);
  assert.match(schema, /scan_snapshot_id/);
  assert.match(schema, /candidate_resolutions/);

  const reviewer = readFileSync(
    new URL('../agents/reversa-reviewer/SKILL.md', import.meta.url),
    'utf8',
  );
  assert.match(
    reviewer,
    /novos, alterados, pendentes, contraditórios|new, changed, pending, contradictory/i,
  );

  const config = readFileSync(new URL('../templates/config.toml', import.meta.url), 'utf8');
  assert.match(config, /\[analysis][\s\S]*source_root\s*=\s*"\."/);

  for (const guide of ['cli.md', 'cli.pt.md', 'cli.es.md']) {
    const content = readFileSync(new URL(`../docs/${guide}`, import.meta.url), 'utf8');
    for (const token of ['scan-surface', '--source=<', '--json', 'surface-candidates.json']) {
      assert.ok(content.includes(token), `${guide} sem ${token}`);
    }
  }
}

testSourcePrecedenceAndContainment();
testDeterministicArtifactAndAtomicFailure();
testUnreadableFileBecomesScanGap();
testMvcActions();
testRazorAndJavaScriptFlows();
testScanSurfaceCommand();
testScannerIsIndependentFromFixtureNames();
testAgentAndDocumentationContracts();
console.log('RESULTADO: ✓ nucleo do scanner de superficie');
