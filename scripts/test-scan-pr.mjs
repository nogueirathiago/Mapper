#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPr } from '../lib/commands/scan-pr.js';

const root = mkdtempSync(join(tmpdir(), 'reversa-pr-'));
const fixture = fileURLToPath(new URL('./fixtures/surface-scanner/mvc-basic/Controllers/RequestsController.cs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/reversa.js', import.meta.url));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

try {
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'Controllers'));
  copyFileSync(fixture, join(root, 'Controllers/RequestsController.cs'));
  writeFileSync(join(root, 'old.sql'), 'SELECT 1;\n');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  writeFileSync(join(root, 'Controllers/RequestsController.cs'),
    readFileSync(fixture, 'utf8').replace('=> View();', '=> PartialView("_Updated");'));
  writeFileSync(join(root, 'Controllers/NewController.cs'),
    'using System.Web.Mvc; public class NewController : Controller { public ActionResult Index() => View(); }\n');
  writeFileSync(join(root, 'Helpers.cs'), 'public class Helpers { public int Add(int a) => a + 1; }\n');
  unlinkSync(join(root, 'old.sql'));
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'head');

  const result = scanPr(root, { base });
  assert.equal(result.base_commit, base);
  assert.deepEqual(result.files.map((file) => [file.path, file.kind]), [
    ['Controllers/NewController.cs', 'addition'],
    ['Controllers/RequestsController.cs', 'change'],
    ['Helpers.cs', 'addition'],
    ['old.sql', 'possible_removal'],
  ]);
  assert.ok(result.files.find((file) => file.path === 'Controllers/RequestsController.cs').candidate_ids.length);
  assert.ok(result.files.find((file) => file.path === 'old.sql').before_sha256);
  assert.equal(result.files.find((file) => file.path === 'old.sql').after_sha256, null);
  assert.ok(result.gaps.some((gap) => gap.path === 'old.sql' && gap.reason === 'possible_removal_requires_review'));
  assert.ok(result.gaps.some((gap) => gap.path === 'Helpers.cs' && gap.reason === 'no_candidate_detected'));
  const cliRun = spawnSync(process.execPath, [cli, 'scan-pr', `--base=${base}`, '--json'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(cliRun.status, 0, cliRun.stderr);
  assert.deepEqual(JSON.parse(cliRun.stdout), result);
  writeFileSync(join(root, 'Helpers.cs'), 'modified without commit\n');
  assert.throws(() => scanPr(root, { base }), /tracked_changes/);
  git('checkout', '--', 'Helpers.cs');
  writeFileSync(join(root, 'Untracked.js'), 'const value = 1;\n');
  assert.throws(() => scanPr(root, { base }), /untracked_source/);
  console.log('scan-pr: additions, changes, possible removals, gaps and clean-worktree gate passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
