# Deterministic UI Surface Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao Reversa uma camada interna e automatica que descubra actions MVC e fluxos Razor/JavaScript antes do Scout, sem regras especificas de qualquer projeto consumidor.

**Architecture:** Um unico scanner Node.js resolve a raiz do codigo, cria um snapshot deterministico e grava candidatos sintaticos em `.reversa/context/surface-candidates.json`. O Scout continua responsavel pela classificacao semantica no `surface.json`, e o validador passa a reconciliar candidatos, resolucoes, entradas e operacoes. O `/reversa` chama o scanner automaticamente antes do Scout; o comando explicito existe apenas para diagnostico e reexecucao.

**Tech Stack:** Node.js ESM 18.20.2+, APIs nativas (`fs`, `path`, `crypto`), CLI existente, Markdown Agent Skills, testes executaveis com `node` e suite `npm run verify`.

**Spec:** `docs/superpowers/specs/2026-09-18-surface-scanner-ui-mapping-design.md`

## Global Constraints

- A implementacao deve ser generica por dominio e projeto para qualquer consumidor ASP.NET MVC, Razor e JavaScript/jQuery.
- Nenhum nome de sistema, modulo, Controller, rota, status, seletor ou texto de um consumidor pode virar regra especial.
- Nao adicionar dependencias npm, parser Razor completo, AST universal, call graph geral, registro de plugins, banco ou cache incremental.
- O scanner produz apenas fatos sintaticos; somente o Scout decide `promoted`, `auxiliary`, `excluded` ou `pending`.
- O fluxo normal `/reversa` executa o scan automaticamente antes do Scout e nao apresenta uma nova pergunta ao usuario.
- A escolha posterior de granularidade (`endpoint`, `hybrid` etc.) nao altera a descoberta.
- A precedencia da raiz e `--source`, `config.user.toml`, `config.toml`, `.`; caminhos absolutos ou que escapem da raiz falham.
- O artefato e escrito atomicamente e uma falha nunca substitui o ultimo JSON valido.
- O scanner nunca escreve no codigo legado nem em `_reversa_sdd/`.
- Nao publicar, remapear ou reindexar Basic Memory nesta entrega.
- Implementar com TDD, executar o teste focal a cada ciclo e criar um commit pequeno por tarefa.

---

### Task 1: Nucleo deterministico, configuracao e artefato atomico

**Files:**
- Create: `lib/surface-scanner.js`
- Create: `scripts/test-surface-scanner.mjs`
- Test: `scripts/test-surface-scanner.mjs`

**Interfaces:**
- Produces: `resolveSourceRoot(projectRoot: string, sourceOverride?: string): { absolute: string, relative: string }`
- Produces: `scanSurface(projectRoot?: string, options?: { source?: string, beforeRename?: () => void }): { artifactPath: string, artifact: SurfaceCandidates }`; `beforeRename` e um hook interno exclusivo do teste de atomicidade.
- Produces: `SurfaceCandidates` JSON v1 with `source_root`, `source_snapshot`, `summary`, `candidates` and `scan_gaps`.
- Consumes: only Node.js standard library; no task anterior.

- [ ] **Step 1: Escrever testes que fixam precedencia, seguranca, snapshot e escrita atomica**

Adicione ao novo `scripts/test-surface-scanner.mjs` um workspace temporario e estes casos reais:

```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSourceRoot, scanSurface } from '../lib/surface-scanner.js';

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
  assert.equal(resolveSourceRoot(root).relative, 'user');
  assert.equal(resolveSourceRoot(root, 'override').relative, 'override');
  mkdirSync(join(root, 'nested', 'legacy'), { recursive: true });
  assert.equal(resolveSourceRoot(root, 'nested/legacy').relative, 'nested/legacy');
  assert.throws(() => resolveSourceRoot(root, '../outside'), /outside_project/);
  assert.throws(() => resolveSourceRoot(root, root), /source_path_absolute/);
  rmSync(root, { recursive: true, force: true });
}

function testDeterministicArtifactAndAtomicFailure() {
  const root = makeRoot();
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
  rmSync(root, { recursive: true, force: true });
}

testSourcePrecedenceAndContainment();
testDeterministicArtifactAndAtomicFailure();
console.log('RESULTADO: ✓ nucleo do scanner de superficie');
```

Complemente o segundo teste injetando, por uma opcao privada apenas de teste `beforeRename`, uma excecao depois de gravar o temporario. Confirme que um artefato sentinela anterior permanece byte a byte igual e que o `.tmp` e removido.

- [ ] **Step 2: Executar o teste e confirmar a falha inicial**

Run: `node scripts/test-surface-scanner.mjs`

Expected: FAIL com `ERR_MODULE_NOT_FOUND` para `lib/surface-scanner.js`.

- [ ] **Step 3: Implementar resolucao minima da raiz sem parser TOML externo**

Em `lib/surface-scanner.js`, implemente um leitor estrito somente para `analysis.source_root`. Ele deve ignorar comentarios e outras secoes, aceitar strings TOML com aspas simples ou duplas e falhar se a chave estiver presente com tipo ou sintaxe invalida.

```js
export function resolveSourceRoot(projectRoot, sourceOverride) {
  const root = resolve(projectRoot);
  const configured = sourceOverride
    ?? readAnalysisSourceRoot(join(root, '.reversa', 'config.user.toml'))
    ?? readAnalysisSourceRoot(join(root, '.reversa', 'config.toml'))
    ?? '.';
  if (isAbsolute(configured)) throw scannerError('source_path_absolute', configured);
  const absolute = resolve(root, configured);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw scannerError('source_path_outside_project', configured);
  }
  if (!statSync(absolute).isDirectory()) throw scannerError('source_root_invalid', configured);
  return { absolute, relative: normalizePath(relativePath || '.') };
}
```

- [ ] **Step 4: Implementar manifesto deterministico e escrita atomica**

Percorra somente arquivos `.cs`, `.cshtml` e `.js`; ignore `.git`, `.reversa`, `_reversa_sdd`, `node_modules`, `bin`, `obj`, `dist`, `build`, `coverage` e diretorios de cache. Ordene caminhos POSIX e gere o hash sobre linhas `<caminho>\t<sha256-do-arquivo>`. Se ja existir um artefato v1 valido com o mesmo `source_root` e snapshot, retorne-o sem reextrair nem regravar; isso torna o comando idempotente.

```js
export function scanSurface(projectRoot = process.cwd(), options = {}) {
  const root = resolve(projectRoot);
  const source = resolveSourceRoot(root, options.source);
  const files = collectSupportedFiles(source.absolute);
  const snapshot = { kind: 'manifest_sha256', id: manifestDigest(source.absolute, files) };
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
```

Falha ao ler um arquivo individual entra em `scan_gaps`; raiz/configuracao/escrita invalida lanca erro com `code` estavel e mantem o artefato anterior.

- [ ] **Step 5: Executar o teste focal**

Run: `node scripts/test-surface-scanner.mjs`

Expected: PASS e `RESULTADO: ✓ nucleo do scanner de superficie`.

- [ ] **Step 6: Commitar a fundacao**

```bash
git add lib/surface-scanner.js scripts/test-surface-scanner.mjs
git commit -m "feat: add deterministic surface scan foundation"
```

---

### Task 2: Extracao de actions ASP.NET MVC

**Files:**
- Modify: `lib/surface-scanner.js`
- Modify: `scripts/test-surface-scanner.mjs`
- Create: `scripts/fixtures/surface-scanner/mvc-basic/Controllers/RequestsController.cs`
- Test: `scripts/test-surface-scanner.mjs`

**Interfaces:**
- Consumes: `scanSurface()` e caminhos relativos a `source_root` da Task 1.
- Produces: candidatos `mvc_action` com ID estavel, verbo, rota, retornos MVC e evidencia de arquivo/linha.
- Produces internally: `extractMvcActions(file): SurfaceCandidate[]`.

- [ ] **Step 1: Criar uma fixture MVC sintetica**

```csharp
using System.Web.Mvc;

public class RequestsController : Controller
{
    [HttpGet]
    [Route("requests/{id}")]
    public ActionResult Detail(int id) => View();

    [HttpPost]
    public ActionResult ValidateSend(int id)
        => PartialView("_ConfirmSend");

    [NonAction]
    public bool PublicHelper(int id) => id > 0;

    private bool InternalCheck(int id) => id > 0;
}
```

- [ ] **Step 2: Escrever o teste de action, verbo, rota, retorno e estabilidade do ID**

Copie a fixture para um workspace temporario, execute `scanSurface()` duas vezes e verifique:

```js
const mvc = artifact.candidates.filter((item) => item.type === 'mvc_action');
assert.deepEqual(mvc.map((item) => item.action), ['Detail', 'ValidateSend']);
assert.deepEqual(mvc.map((item) => item.method), ['GET', 'POST']);
assert.equal(mvc[0].route, 'requests/{id}');
assert.deepEqual(mvc[1].returns, [{ kind: 'partial_view', target: '_ConfirmSend' }]);
assert.equal(mvc.some((item) => item.action === 'InternalCheck'), false);
assert.equal(mvc.some((item) => item.action === 'PublicHelper'), false);
assert.deepEqual(firstIds, secondIds);
```

- [ ] **Step 3: Executar o teste e confirmar a falha**

Run: `node scripts/test-surface-scanner.mjs`

Expected: FAIL porque `candidates` ainda esta vazio.

- [ ] **Step 4: Implementar a leitura lexical de Controllers**

Use um scanner de delimitadores para localizar classes que herdam de `Controller`, seus metodos `public` e atributos imediatamente anteriores. Nao dependa de compilacao. Ignore construtores, propriedades e metodos nao publicos. Normalize convencoes sem atributo para `ANY` e preserve faixa de linhas.

```js
function extractMvcActions(file, content) {
  return findControllerClasses(content).flatMap((controller) =>
    findPublicMethods(controller.body)
      .filter((method) => method.name !== controller.name)
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
  );
}
```

O hash do ID recebe campos normalizados, nunca somente o numero de linha. Ordene candidatos por `file`, `line`, `type`, `id` antes de gravar.

- [ ] **Step 5: Executar testes e confirmar resumo consistente**

Run: `node scripts/test-surface-scanner.mjs`

Expected: PASS; `summary.candidates`, `summary.exact` e a lista MVC devem coincidir.

- [ ] **Step 6: Commitar o extrator MVC**

```bash
git add lib/surface-scanner.js scripts/test-surface-scanner.mjs scripts/fixtures/surface-scanner/mvc-basic
git commit -m "feat: discover aspnet mvc actions"
```

---

### Task 3: Extracao e encadeamento Razor/JavaScript

**Files:**
- Modify: `lib/surface-scanner.js`
- Modify: `scripts/test-surface-scanner.mjs`
- Create: `scripts/fixtures/surface-scanner/ui-flow-a/Views/Requests/Detail.cshtml`
- Create: `scripts/fixtures/surface-scanner/ui-flow-a/Views/Requests/_ConfirmSend.cshtml`
- Create: `scripts/fixtures/surface-scanner/ui-flow-a/Scripts/request-flow.js`
- Create: `scripts/fixtures/surface-scanner/ui-flow-b/Views/Review/Index.cshtml`
- Create: `scripts/fixtures/surface-scanner/ui-flow-b/Scripts/review-flow.js`
- Test: `scripts/test-surface-scanner.mjs`

**Interfaces:**
- Consumes: lista ordenada de arquivos e `candidateId()` das Tasks 1–2.
- Produces: candidatos `ui_action` com `selector`, `label`, `guards`, `steps`, `confidence` e evidencia.
- Produces internally: `extractRazorControls()`, `extractClientBindings()` e `linkUiActions()`.

- [ ] **Step 1: Criar duas fixtures genericas e independentes**

Na fixture A, use este fluxo completo:

```cshtml
@if (Model.Status == Status.Pending) {
  <button id="btnSendRequest" disabled="@(!Model.CanSend)">Send request</button>
}
```

```js
$('#btnSendRequest').on('click', function () {
  $.ajax({ method: 'GET', url: '/Requests/ValidateSend' })
    .done(function (html) { $('#dialog').html(html); });
});
```

E na partial:

```cshtml
<button id="btnConfirmSend">Confirm send</button>
<script>
document.getElementById('btnConfirmSend').addEventListener('click', () => {
  fetch('/Requests/Send', { method: 'POST' });
});
</script>
```

Na fixture B, use o mesmo ID em dois ramos Razor com guardas diferentes, `.click(...)`, uma chamada local que chega a `$.ajax`, um fluxo alternativo com rotulo parecido e uma URL calculada que deve ficar `unresolved`.

- [ ] **Step 2: Escrever testes do fluxo, separacao e ruido**

As assercoes devem verificar, sem depender de texto de projeto real:

```js
const send = ui.find((item) => item.selector === '#btnSendRequest');
assert.deepEqual(send.guards, ['Model.Status == Status.Pending', '!Model.CanSend']);
assert.deepEqual(send.steps.map(({ kind, method, target }) => ({ kind, method, target })), [
  { kind: 'http', method: 'GET', target: '/Requests/ValidateSend' },
  { kind: 'partial_continuation', method: null, target: '_ConfirmSend' },
  { kind: 'http_on_success', method: 'POST', target: '/Requests/Send' },
]);
assert.equal(send.confidence, 'exact');
assert.equal(dynamic.confidence, 'unresolved');
assert.equal(duplicateIdBranches.length, 2);
assert.notEqual(duplicateIdBranches[0].id, duplicateIdBranches[1].id);
assert.notEqual(primaryFlow.id, alternativeFlow.id);
assert.equal(closeModal.disposition_hint, 'auxiliary');
```

Inclua casos para `<form>`, `Html.BeginForm`, `Html.ActionLink`, `Url.Action`, submit e navegacao literal. Verifique `.click`, `.on("click")` e `addEventListener` em testes separados.

- [ ] **Step 3: Executar o teste e confirmar a falha**

Run: `node scripts/test-surface-scanner.mjs`

Expected: FAIL porque nenhum candidato `ui_action` existe.

- [ ] **Step 4: Implementar controles Razor e guardas estruturais**

Use leitura linha a linha com pilha de blocos Razor. Extraia botao, link e formulario, seus IDs/seletores, texto visivel, `disabled`, `BeginForm`, `ActionLink`, `Url.Action`, partials e scripts. IDs repetidos em ramos distintos recebem a guarda no material do hash.

```js
function uiCandidate(control) {
  return {
    type: 'ui_action',
    label: control.label,
    selector: control.selector,
    file: control.file,
    line: control.line,
    guards: control.guards,
    confidence: 'unresolved',
    steps: [],
    evidence: [{ file: control.file, line: control.line, end_line: control.endLine }],
  };
}
```

Depois de ligar handlers e destinos, atribua o ID final com tipo, arquivo, identidade estrutural, rotulo, guardas e destinos normalizados. O numero de linha nao participa sozinho da identidade:

```js
function finalizeUiCandidate(candidate) {
  const targets = candidate.steps.map((step) => `${step.kind}:${step.method ?? ''}:${step.target ?? ''}`);
  return {
    ...candidate,
    id: candidateId(candidate.type, candidate.file, candidate.selector, candidate.label, candidate.guards, targets),
  };
}
```

- [ ] **Step 5: Implementar handlers e destinos JavaScript com limites explicitos**

Remova comentarios preservando quebras de linha e use leitura balanceada de parenteses/chaves para handlers. Resolva somente seletores, URLs e metodos literais. Siga chamadas locais nomeadas apenas dentro do mesmo arquivo e interrompa em recursao/ciclo usando `visitedFunctions`.

Reconheca:

```text
.click(handler)
.on("click", handler)
.on("click", selector, handler)
addEventListener("click", handler)
$.ajax({ url, method|type, success })
$.get / $.post / fetch
location literal / submit
```

Relacione `PartialView("X")` de uma action MVC a controles da partial `X.cshtml` com `partial_continuation`. Qualquer seletor, URL ou dispatch dinamico mantem o candidato, adiciona evidencia da expressao e deixa `confidence: "unresolved"`.

Quando dois controles chamarem o mesmo POST com parametros literais diferentes, preserve a variacao em `step.arguments` sem interpreta-la como regra de negocio. Adicione a fixture A com duas confirmacoes que enviam `{ mode: "standard" }` e `{ mode: "expedited" }` e teste que ambas continuam distintas.

- [ ] **Step 6: Aplicar filtro conservador de efeito funcional**

Marque `disposition_hint: "auxiliary"` somente para controles comprovadamente visuais, como fechar modal, trocar aba ou expandir painel. Nao remova esses controles do total. Consulta, validacao, envio, mutacao, persistencia, integracao e navegacao continuam candidatos funcionais.

- [ ] **Step 7: Executar o teste focal duas vezes**

Run: `node scripts/test-surface-scanner.mjs && node scripts/test-surface-scanner.mjs`

Expected: duas execucoes PASS e artefatos byte a byte identicos quando o snapshot nao mudou.

- [ ] **Step 8: Commitar a descoberta de interface**

```bash
git add lib/surface-scanner.js scripts/test-surface-scanner.mjs scripts/fixtures/surface-scanner/ui-flow-a scripts/fixtures/surface-scanner/ui-flow-b
git commit -m "feat: trace razor and javascript ui actions"
```

---

### Task 4: Comando `scan-surface` e contrato operacional do CLI

**Files:**
- Create: `lib/commands/scan-surface.js`
- Modify: `bin/reversa.js:11-55`
- Modify: `scripts/test-surface-scanner.mjs`
- Modify: `package.json:10-12`
- Test: `scripts/test-surface-scanner.mjs`

**Interfaces:**
- Consumes: `scanSurface(projectRoot, { source })` da Task 1.
- Produces: `reversa scan-surface [--source=<relativo>] [--json]`.
- Produces: exit code `0` para scan valido mesmo com `unresolved`; exit code `1` para erro fatal.

- [ ] **Step 1: Escrever testes black-box do comando**

Use `spawnSync(process.execPath, [CLI, 'scan-surface', '--json'], { cwd })` e verifique:

```js
assert.equal(ok.status, 0, ok.stderr);
const summary = JSON.parse(ok.stdout);
assert.deepEqual(Object.keys(summary).sort(), [
  'candidates', 'exact', 'files_scanned', 'source_root', 'source_snapshot_id', 'unresolved',
]);
assert.equal('artifact' in summary, false);

const override = spawnSync(process.execPath, [CLI, 'scan-surface', '--source=alternate', '--json'], options);
assert.equal(JSON.parse(override.stdout).source_root, 'alternate');

const fatal = spawnSync(process.execPath, [CLI, 'scan-surface', '--source=../outside', '--json'], options);
assert.equal(fatal.status, 1);
assert.equal(JSON.parse(fatal.stdout).error.code, 'source_path_outside_project');
```

Teste tambem saida humana curta e flag desconhecida rejeitada sem stack trace.

- [ ] **Step 2: Executar o teste e confirmar comando desconhecido**

Run: `node scripts/test-surface-scanner.mjs`

Expected: FAIL com `Comando desconhecido: "scan-surface"`.

- [ ] **Step 3: Implementar o adaptador de comando**

```js
import { scanSurface } from '../surface-scanner.js';

export default async function scanSurfaceCommand(args = []) {
  const json = args.includes('--json');
  const sourceArg = args.find((arg) => arg.startsWith('--source='));
  const unknown = args.filter((arg) => arg !== '--json' && !arg.startsWith('--source='));
  try {
    if (unknown.length) throw cliError('unknown_option', unknown[0]);
    const { artifact } = scanSurface(process.cwd(), { source: sourceArg?.slice('--source='.length) });
    const summary = {
      source_root: artifact.source_root,
      source_snapshot_id: artifact.source_snapshot.id,
      ...artifact.summary,
    };
    if (json) console.log(JSON.stringify(summary));
    else printHumanSummary(summary);
  } catch (error) {
    if (json) console.log(JSON.stringify({ error: { code: error.code ?? 'scan_failed', message: error.message } }));
    else console.error(`  ✗ ${error.code ?? 'scan_failed'}: ${error.message}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Registrar o comando e a ajuda**

Adicione o import dinamico no mapa de `bin/reversa.js` e a linha de ajuda:

```js
'scan-surface': () => import('../lib/commands/scan-surface.js'),
```

```text
scan-surface       Descobre actions MVC e fluxos Razor/JavaScript
                   Opcoes: --source=<caminho-relativo> --json
```

- [ ] **Step 5: Incluir o teste novo em `npm run verify`**

Insira `node scripts/test-surface-scanner.mjs` depois de `test-analysis-validator.mjs`, mantendo os demais comandos intactos.

- [ ] **Step 6: Executar teste focal e suite completa**

Run: `node scripts/test-surface-scanner.mjs`

Expected: PASS.

Run: `npm run verify`

Expected: exit code `0` e todas as suites existentes verdes.

- [ ] **Step 7: Commitar a interface do CLI**

```bash
git add lib/commands/scan-surface.js bin/reversa.js scripts/test-surface-scanner.mjs package.json
git commit -m "feat: expose surface scanner command"
```

---

### Task 5: Reconciliacao obrigatoria no validador

**Files:**
- Modify: `lib/analysis-validator.js:29-404`
- Modify: `scripts/test-analysis-validator.mjs:21-234`
- Test: `scripts/test-analysis-validator.mjs`

**Interfaces:**
- Consumes: `.reversa/context/surface-candidates.json` v1.
- Consumes: `surface.json.surface_discovery.candidate_resolutions`.
- Produces: warning `surface_discovery_unmeasured` apenas para analises antigas sem o artefato.
- Produces: erros deterministas para snapshot, resolucao ausente/obsoleta/duplicada, promocao invalida, `pending` e `scan_gaps`.

- [ ] **Step 1: Estender o workspace de teste com candidatos e resolucoes validos**

No helper `createWorkspace`, grave por padrao:

```js
writeJson(join(root, '.reversa', 'context', 'surface-candidates.json'), {
  schema_version: 1,
  source_root: 'source',
  source_snapshot: { kind: 'manifest_sha256', id: 'snapshot-1' },
  summary: { files_scanned: 1, candidates: 1, exact: 1, unresolved: 0 },
  candidates: [{
    id: 'CAND-001', type: 'mvc_action', file: 'approval.js', line: 1,
    confidence: 'exact', evidence: [{ file: 'approval.js', line: 1, end_line: 1 }],
  }],
  scan_gaps: [],
});
surface.surface_discovery = {
  schema_version: 1,
  scan_snapshot_id: 'snapshot-1',
  candidate_resolutions: [{
    candidate_id: 'CAND-001', disposition: 'promoted', entry_point_id: 'ENTRY-001',
    reason: 'Observable operation entry.',
  }],
};
```

Para o novo contrato, paths de `operation_entry_points` e evidencias sao relativos a `source_root`; mantenha um helper separado para criar o caso legado project-relative.

- [ ] **Step 2: Escrever um teste por gate**

Crie testes independentes para estes codigos e comportamentos:

```text
surface_discovery_unmeasured        warning, sem invalidar legado
surface_scan_snapshot_mismatch      error
candidate_resolution_missing        error
candidate_resolution_stale          error
candidate_resolution_duplicate      error
candidate_resolution_invalid        error
candidate_resolution_reason_missing error para auxiliary/excluded
candidate_promotion_unknown_entry    error
candidate_promotion_unmapped_entry   error
surface_scan_gap                     bloqueia reviewed_scope_complete
surface_candidate_pending            bloqueia reviewed_scope_complete
```

Inclua um teste positivo em que `source_root = "source"` resolve `approval.js`, e um negativo em que a evidencia tenta `../outside.js`.

- [ ] **Step 3: Executar o teste e confirmar falhas dos novos gates**

Run: `node scripts/test-analysis-validator.mjs`

Expected: FAIL porque o validador ainda ignora `surface-candidates.json`.

- [ ] **Step 4: Implementar leitura opcional e raiz de evidencia compatível**

Adicione `readOptionalJson()` e derive a raiz assim:

```js
const candidatesPath = join(projectRoot, '.reversa', 'context', 'surface-candidates.json');
const discovery = existsSync(candidatesPath) ? readRequiredJson(candidatesPath, 'surface_candidates', errors) : null;
const evidenceRoot = discovery
  ? resolveContainedSourceRoot(projectRoot, discovery.source_root, errors)
  : resolve(projectRoot);
```

Passe `evidenceRoot` a `validateEvidence`. Analises antigas sem candidatos recebem somente o warning e preservam o resultado anterior.

- [ ] **Step 5: Implementar reconciliacao de candidatos**

```js
function validateSurfaceDiscovery(context) {
  const { discovery, surface, entryIds, referencedEntryIds, errors, warnings } = context;
  if (!discovery) {
    warnings.push(issue('surface_discovery_unmeasured', 'A descoberta de interface nao foi aferida nesta analise.'));
    return;
  }
  // validar schema/snapshots; indexar candidatos e resolucoes;
  // exigir exatamente uma resolucao; validar disposition/reason;
  // promoted deve apontar para entry existente e vinculada a operacao;
  // stale, pending e scan_gaps seguem os codigos definidos no Step 2.
}
```

Chame a funcao depois de `validateOperations`, quando `entryIds` e `referencedEntryIds` ja estiverem completos, e antes de `validateCompletion`. `pending` e `scan_gaps` viram erro somente ao tentar `reviewed_scope_complete`; em `in_progress` permanecem warnings acionaveis.

- [ ] **Step 6: Executar testes focalizados e regressao**

Run: `node scripts/test-analysis-validator.mjs`

Expected: PASS com os onze cenarios novos e todos os antigos.

Run: `npm run verify`

Expected: exit code `0`.

- [ ] **Step 7: Commitar os gates**

```bash
git add lib/analysis-validator.js scripts/test-analysis-validator.mjs
git commit -m "feat: validate surface candidate coverage"
```

---

### Task 6: Execucao automatica no `/reversa`, contratos dos agentes e documentacao

**Files:**
- Modify: `agents/reversa/SKILL.md:38-88`
- Modify: `agents/reversa-scout/SKILL.md:18-88`
- Modify: `agents/reversa-scout/references/surface-schema.md:1-112`
- Modify: `agents/reversa-reviewer/SKILL.md:14-21,95-110,144-181`
- Modify: `templates/config.toml:26-31`
- Modify: `docs/cli.md:61-76`
- Modify: `docs/cli.pt.md:61-76`
- Modify: `docs/cli.es.md:61-76`
- Modify: `scripts/test-surface-scanner.mjs`
- Test: `scripts/test-surface-scanner.mjs`

**Interfaces:**
- Consumes: comando `reversa scan-surface --json` e artefato v1.
- Produces: execucao automatica imediatamente antes de qualquer Scout, sem menu adicional.
- Produces: `surface.json.surface_discovery` com uma resolucao por candidato.
- Produces: triagem incremental do Reviewer por IDs e snapshots.

- [ ] **Step 1: Escrever testes estaticos do contrato entre CLI e agentes**

Leia os Markdown como texto e exija:

```js
const orchestrator = readFileSync(new URL('../agents/reversa/SKILL.md', import.meta.url), 'utf8');
assert.match(orchestrator, /antes de (?:ativar|executar) o Scout[\s\S]*reversa scan-surface --json/i);
assert.match(orchestrator, /nao (?:faca|apresente).*pergunta/i);

const scout = readFileSync(new URL('../agents/reversa-scout/SKILL.md', import.meta.url), 'utf8');
for (const token of ['surface-candidates.json', 'candidate_resolutions', 'promoted', 'auxiliary', 'excluded', 'pending']) {
  assert.ok(scout.includes(token), `Scout sem contrato ${token}`);
}

const reviewer = readFileSync(new URL('../agents/reversa-reviewer/SKILL.md', import.meta.url), 'utf8');
assert.match(reviewer, /novos, alterados, pendentes, contraditorios|new, changed, pending, contradictory/i);
```

Teste tambem que `templates/config.toml` contem `source_root = "."` e que os tres guias de CLI documentam `scan-surface` e suas duas flags.

- [ ] **Step 2: Executar o teste e confirmar que a automacao ainda nao existe**

Run: `node scripts/test-surface-scanner.mjs`

Expected: FAIL na assercao do orquestrador.

- [ ] **Step 3: Inserir o scan transparente antes do Scout**

Em `agents/reversa/SKILL.md`, crie uma regra unica aplicavel tanto a primeira execucao quanto a retomada:

```markdown
### Pre-descoberta obrigatoria antes do Scout

Imediatamente antes de ativar ou reativar o Scout, execute `reversa scan-surface --json`
na raiz do projeto. Nao apresente uma nova pergunta ao usuario. O comando resolve
`source_root` pela configuracao existente. Se o snapshot atual ja corresponder ao
artefato valido, o resultado e idempotente; se houver mudanca, ele substitui o
artefato atomicamente. Falha fatal interrompe o Scout e deve ser relatada. Candidatos
`unresolved` nao interrompem o scan: o Scout os classifica como `pending` quando a
evidencia continuar insuficiente.
```

Nao altere as perguntas atuais de plano, nivel documental ou organizacao das specs.

- [ ] **Step 4: Atualizar o contrato do Scout e o schema**

Instrua o Scout a:

1. ler `surface-candidates.json` antes do inventario sem carregar todos os arquivos de uma vez;
2. preservar `surface.source_snapshot.id` igual ao snapshot do scan;
3. criar exatamente uma resolucao por candidato em `surface_discovery.candidate_resolutions`;
4. promover somente efeitos funcionais observaveis;
5. justificar `auxiliary` e `excluded`;
6. manter evidencia insuficiente como `pending`, nunca descartar ou inventar destino;
7. vincular toda promocao a `operation_entry_points` com ID estavel.

Inclua no schema um exemplo sintetico completo e as definicoes de campos, sem nomes de projetos consumidores.

- [ ] **Step 5: Atualizar a triagem incremental do Reviewer**

O Reviewer deve comparar snapshot, IDs e evidencias. Aprofunde apenas candidatos novos, alterados, pendentes, contraditorios ou com resolucao obsoleta; preserve resolucoes validas e nao reabra o corpus inteiro sem indicio de impacto. Antes de concluir, reconcilie candidatos, entradas promovidas e operacoes e execute `validate-analysis --json`.

- [ ] **Step 6: Documentar configuracao e uso manual**

Adicione a `templates/config.toml`:

```toml
[analysis]
answer_mode = "chat"
doc_level = "completo"
source_root = "."
```

Nos tres idiomas de `docs/cli*`, documente que `scan-surface` e automatico no `/reversa`; o uso manual serve para diagnostico/reexecucao. Mostre `--source=<caminho-relativo>` e `--json`, saidas `0/1` e o caminho do artefato.

- [ ] **Step 7: Executar testes e os dois dry-runs sinteticos**

Run: `node scripts/test-surface-scanner.mjs`

Expected: PASS, incluindo automacao, schema e documentacao.

Run: `npm run verify`

Expected: exit code `0`.

Copie `ui-flow-a` e `ui-flow-b` para dois diretorios temporarios independentes e execute em cada um:

```bash
node bin/reversa.js scan-surface --source=. --json
```

Expected: ambos retornam `0`, geram apenas `.reversa/context/surface-candidates.json` nos temporarios e nao criam/modificam `_reversa_sdd/` nem as fixtures versionadas.

- [ ] **Step 8: Executar gates de genericidade e higiene**

No teste da fixture B, copie o mesmo arranjo para um segundo temporario e substitua todos os nomes de Controller, action, seletor, rotulo e rota por outros valores sinteticos antes do scan. Compare apenas a forma do resultado (`type`, quantidade, sequencia de `step.kind`, metodos e confianca), nunca os literais:

```js
assert.deepEqual(flowShape(renamedArtifact), flowShape(originalArtifact));
```

Expected: PASS, demonstrando que a descoberta nao depende dos nomes escolhidos nas fixtures.

Run: `git diff -- lib/surface-scanner.js lib/commands/scan-surface.js scripts/fixtures/surface-scanner`

Expected: revisao confirma que nao existe comparacao condicional com nome de projeto, modulo, Controller, action, seletor, rotulo, rota ou status especifico.

Run: `git diff --check`

Expected: nenhum erro.

- [ ] **Step 9: Commitar a integracao automatica**

```bash
git add agents/reversa/SKILL.md agents/reversa-scout/SKILL.md agents/reversa-scout/references/surface-schema.md agents/reversa-reviewer/SKILL.md templates/config.toml docs/cli.md docs/cli.pt.md docs/cli.es.md scripts/test-surface-scanner.mjs
git commit -m "feat: run surface discovery before scout"
```

---

## Final Verification

- [ ] Run: `npm run verify`
  - Expected: exit code `0`; todas as suites existentes e novas verdes.
- [ ] Run: `git diff --check`
  - Expected: nenhuma saida.
- [ ] Run: `git status --short`
  - Expected: apenas alteracoes intencionais, ou arvore limpa depois dos commits.
- [ ] Confirmar que nenhum teste abriu navegador, acessou rede, publicou memoria ou modificou um projeto consumidor real.
- [ ] Confirmar manualmente no diff que o `/reversa` preserva todas as perguntas existentes e apenas insere o scan interno antes do Scout.
- [ ] Confirmar que a implementacao contem zero regra especial baseada em nomes das fixtures ou de consumidores.
