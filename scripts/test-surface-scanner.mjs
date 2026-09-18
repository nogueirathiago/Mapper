#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSourceRoot, scanSurface } from '../lib/surface-scanner.js';

const fixturesRoot = fileURLToPath(new URL('./fixtures/surface-scanner/', import.meta.url));

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
  const a = scanFixture('ui-flow-a', ['mvc-basic']);
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

testSourcePrecedenceAndContainment();
testDeterministicArtifactAndAtomicFailure();
testMvcActions();
testRazorAndJavaScriptFlows();
console.log('RESULTADO: ✓ nucleo do scanner de superficie');
