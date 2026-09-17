# Reversa Sync Projects Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a skill global explícita `$reversa-sync-projects`, com registro automático e sincronização segura dos projetos Reversa a partir de `origin/main` do fork.

**Architecture:** O core Node.js mantém a política de armazenamento no `NEO MATRIX`, o registro global e o planejador/aplicador por projeto. A skill global é uma camada fina instalada no volume externo e descoberta por um único link simbólico em `~/.codex/skills`; ela chama o fork configurado, que materializa e valida `origin/main` antes de sincronizar qualquer projeto.

**Tech Stack:** Node.js ESM 18.20.2+, Git, npm, Agent Skills, testes smoke com `node:assert`.

**Spec:** `docs/superpowers/specs/2026-09-17-reversa-sync-projects-skill-design.md`

## Global Constraints

- O fork, os projetos registrados, a configuração, o cache, os temporários e o conteúdo da skill devem permanecer sob `/Volumes/NEO MATRIX/`.
- A única entrada permitida no SSD é o link simbólico `~/.codex/skills/reversa-sync-projects`.
- A fonte de sincronização é exclusivamente o commit materializado de `origin/main` do fork configurado.
- Arquivos modificados localmente ou colisões não gerenciadas nunca são sobrescritos.
- Nenhum mapeamento, revalidação ou artefato de análise pode ser executado ou alterado.
- A execução apresenta o plano agregado e pede uma única confirmação antes de escrever nos projetos.
- A implementação deve reutilizar o core do Reversa; a skill não duplica a lógica de sincronização.

---

### Task 1: Política de armazenamento e registro global

**Files:**
- Create: `lib/sync/storage.js`
- Create: `lib/sync/registry.js`
- Create: `scripts/test-project-registry.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createStoragePolicy({ volumeRoot?, dataRoot? })` com `assertOnVolume(path)`, `ensureLayout()` e caminhos `configDir`, `skillDir`, `tmpDir`, `cacheDir`.
- Produces: `loadProjectRegistry({ policy })`, `registerProject(projectRoot, { policy })` e `PROJECTS_REGISTRY_VERSION`.
- Consumes: filesystem Node.js; nenhum módulo de tarefas posteriores.

- [ ] **Step 1: Escrever testes inicialmente falhos para a política de volume**

Criar fixtures em um diretório temporário fornecido ao teste como `volumeRoot` e cobrir caminho interno, caminho externo, link simbólico que escapa e volume ausente:

```js
const policy = createStoragePolicy({ volumeRoot: fixtureVolume, dataRoot: join(fixtureVolume, '.reversa-global') });
assert.equal(policy.assertOnVolume(projectInside), realpathSync(projectInside));
assert.throws(() => policy.assertOnVolume(projectOutside), /fora do volume permitido/);
assert.throws(() => policy.assertOnVolume(linkToOutside), /fora do volume permitido/);
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `TMPDIR='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/tmp' node scripts/test-project-registry.mjs`

Expected: FAIL por ausência de `lib/sync/storage.js`.

- [ ] **Step 3: Implementar a política de armazenamento**

Implementar defaults exatos e comparação por fronteira de caminho físico:

```js
export const NEO_MATRIX_ROOT = '/Volumes/NEO MATRIX';
export const DEFAULT_DATA_ROOT = '/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global';

export function createStoragePolicy({ volumeRoot = NEO_MATRIX_ROOT, dataRoot = DEFAULT_DATA_ROOT } = {}) {
  // resolve realpath do volume e do alvo; recusa escapes e cria apenas
  // config/, skill/, tmp/ e cache/ dentro do dataRoot validado.
}
```

- [ ] **Step 4: Escrever testes inicialmente falhos para o registro**

Cobrir criação, deduplicação por caminho físico, JSON inválido, versão desconhecida, projeto sem `.reversa/state.json` e preservação de entrada inacessível:

```js
assert.deepEqual(registerProject(projectRoot, { policy }).projects, [realpathSync(projectRoot)]);
assert.deepEqual(registerProject(projectRoot, { policy }).projects, [realpathSync(projectRoot)]);
assert.throws(() => loadProjectRegistry({ policy }), /registro global inválido/);
```

- [ ] **Step 5: Implementar o registro com escrita atômica**

Usar arquivo temporário no mesmo `configDir`, `renameSync` e schema mínimo:

```js
export const PROJECTS_REGISTRY_VERSION = 1;

export function registerProject(projectRoot, { policy = createStoragePolicy() } = {}) {
  const physicalRoot = policy.assertOnVolume(projectRoot);
  assertInstalledProject(physicalRoot);
  const registry = loadProjectRegistry({ policy, createIfMissing: true });
  registry.projects = [...new Set([...registry.projects, physicalRoot])].sort();
  return saveProjectRegistry(registry, { policy });
}
```

- [ ] **Step 6: Integrar e executar GREEN**

Adicionar `node scripts/test-project-registry.mjs` a `npm run verify` e executar o teste focado com `TMPDIR` no `NEO MATRIX`.

- [ ] **Step 7: Commit**

```bash
git add lib/sync/storage.js lib/sync/registry.js scripts/test-project-registry.mjs package.json
git commit -m "feat: add neo matrix project registry"
```

### Task 2: Planejamento e aplicação conservadora por projeto

**Files:**
- Create: `lib/sync/project-sync.js`
- Create: `scripts/test-project-sync.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createStoragePolicy`, `loadProjectRegistry`, `Writer`, `ENGINES`, `listAllAgents`, `hashFile`, `loadManifest`, `saveManifest`.
- Produces: `planProjectSync(projectRoot, { sourceCommit, policy }) -> ProjectSyncPlan`.
- Produces: `applyProjectSync(plan) -> ProjectSyncResult`.
- `ProjectSyncPlan` contém `projectRoot`, `sourceCommit`, `updates`, `missing`, `modified`, `conflicts`, `unchanged`, `inaccessible` e o snapshot desejado criado dentro de `policy.tmpDir`.

- [ ] **Step 1: Escrever fixtures e testes RED para classificação**

Construir projeto instalado mínimo com manifesto contendo um arquivo intacto, um ausente e um modificado; criar também colisão local sem entrada no manifesto:

```js
const plan = planProjectSync(projectRoot, { sourceCommit: 'a'.repeat(40), policy });
assert.deepEqual(plan.updates.map(x => x.relPath), ['.agents/skills/reversa/SKILL.md']);
assert.deepEqual(plan.modified.map(x => x.relPath), ['.agents/skills/reversa-reviewer/SKILL.md']);
assert.deepEqual(plan.conflicts.map(x => x.relPath), ['.agents/skills/reversa-new/local.txt']);
```

- [ ] **Step 2: Executar o teste e confirmar RED**

Run: `TMPDIR='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/tmp' node scripts/test-project-sync.mjs`

Expected: FAIL por ausência de `lib/sync/project-sync.js`.

- [ ] **Step 3: Gerar snapshot desejado sem tocar no projeto**

Usar `Writer` sobre uma pasta criada em `policy.tmpDir`, instalar todos os agentes para as engines registradas, renderizar entry files e forward assets e então enumerar apenas arquivos gerenciáveis. Não chamar `createReversaDir`, para não tratar estado, plano ou outputs como templates substituíveis.

```js
const writer = new Writer(snapshotRoot);
for (const agent of listAllAgents()) {
  for (const engine of installedEngines) await writer.installSkill(agent, engine.skillsDir);
}
writer.refreshForwardAssets(new Set());
```

- [ ] **Step 4: Implementar classificação conservadora**

Para cada arquivo desejado:

```js
if (!existsSync(dest)) category = 'missing';
else if (manifest[relPath] && hashFile(dest) === manifest[relPath]) category = 'updates';
else if (manifest[relPath]) category = 'modified';
else if (hashFile(dest) === hashFile(source)) category = 'unchanged';
else category = 'conflicts';
```

Manter entradas antigas que desapareceram do fork e nunca planejar exclusões.

- [ ] **Step 5: Implementar aplicação e metadados**

Copiar somente `updates` e `missing`, adotar `unchanged`, preservar `modified` e `conflicts`, atualizar o manifesto coerentemente e mesclar no `state.json`:

```js
state.agents = listAllAgents();
state.fork_source = { remote: 'origin', branch: 'main', commit: plan.sourceCommit };
```

O manifesto conserva o hash-base anterior para modificados, não cria entrada para conflitos e registra o novo hash para atualizados, ausentes e iguais.

- [ ] **Step 6: Cobrir aplicação, isolamento e outputs protegidos**

Testar que um projeto falho não impede outro, que `_reversa_sdd/` mantém hash e mtime, e que modificação local permanece byte a byte.

- [ ] **Step 7: Executar GREEN e integrar ao verify**

Run: `TMPDIR='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/tmp' node scripts/test-project-sync.mjs`

Expected: PASS com resumo de classificação e preservação.

- [ ] **Step 8: Commit**

```bash
git add lib/sync/project-sync.js scripts/test-project-sync.mjs package.json
git commit -m "feat: sync managed reversa project files"
```

### Task 3: Comandos, bootstrap validado e registro automático

**Files:**
- Create: `lib/commands/register-project.js`
- Create: `lib/commands/sync-projects.js`
- Create: `lib/sync/source.js`
- Create: `scripts/test-sync-command.mjs`
- Modify: `bin/reversa.js`
- Modify: `lib/commands/install.js`
- Modify: `agents/reversa/SKILL.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: registro e sincronizador das Tasks 1–2.
- Produces: `reversa register-project [path]` e `reversa sync-projects`.
- Produces: `prepareValidatedMain({ policy, forkPath, remote, branch }) -> { stageRoot, commit, cleanup }`.

- [ ] **Step 1: Escrever testes RED do bootstrap e dos comandos**

Usar um repositório Git fixture no volume de testes para cobrir branch inexistente, fetch/commit materializado, falha de verificação e modo preparado sem rede:

```js
const prepared = prepareValidatedMain({ policy, forkPath, remote: 'origin', branch: 'main', run: fakeRun });
assert.equal(prepared.commit, expectedSha);
assert.ok(prepared.stageRoot.startsWith(policy.tmpDir + sep));
```

- [ ] **Step 2: Implementar fonte validada em `origin/main`**

Executar Git e npm somente com `execFileSync`/`spawnSync`, sem shell. Criar archive e staging em `policy.tmpDir`; configurar `TMPDIR` e `npm_config_cache` para caminhos do volume externo; rodar `npm ci` e `npm run verify` antes do modo preparado.

```js
execFileSync('git', ['-C', forkPath, 'fetch', remote, branch], { stdio: 'inherit' });
const commit = execFileSync('git', ['-C', forkPath, 'rev-parse', `${remote}/${branch}`], { encoding: 'utf8' }).trim();
execFileSync('npm', ['ci'], { cwd: stageRoot, env: externalVolumeEnv, stdio: 'inherit' });
execFileSync('npm', ['run', 'verify'], { cwd: stageRoot, env: externalVolumeEnv, stdio: 'inherit' });
```

- [ ] **Step 3: Implementar `register-project` e integrar ao install**

Validar o projeto no começo de `install`, impedindo instalação fora do `NEO MATRIX`, e registrar somente após instalação concluída. O comando dedicado recebe o caminho ou usa `process.cwd()`.

- [ ] **Step 4: Implementar `sync-projects` em dois estágios**

O estágio bootstrap materializa/valida `origin/main` e executa o comando da cópia validada com `REVERSA_SYNC_PREPARED=1` e o SHA. O estágio preparado carrega o registro, mostra o plano agregado, confirma uma vez e aplica cada projeto com `try/catch` isolado.

- [ ] **Step 5: Adicionar rotas e instrução de ativação**

Adicionar ao `bin/reversa.js`:

```js
'register-project': () => import('../lib/commands/register-project.js'),
'sync-projects': () => import('../lib/commands/sync-projects.js'),
```

No início de `agents/reversa/SKILL.md`, instruir a execução idempotente do helper global quando `.reversa/state.json` existir; se o caminho físico estiver fora do volume, interromper o mapeamento e orientar a mover o projeto.

- [ ] **Step 6: Executar testes focados e verify completo**

Run: `TMPDIR='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/tmp' npm_config_cache='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/cache/npm' npm run verify`

Expected: todos os scripts PASS, sem escrita fora do volume de testes além do link ainda não instalado.

- [ ] **Step 7: Commit**

```bash
git add bin/reversa.js lib/commands/install.js lib/commands/register-project.js lib/commands/sync-projects.js lib/sync/source.js agents/reversa/SKILL.md scripts/test-sync-command.mjs package.json
git commit -m "feat: add validated multi-project sync command"
```

### Task 4: Skill global, instalador e aceitação local

**Files:**
- Create: `global-skills/reversa-sync-projects/SKILL.md`
- Create: `global-skills/reversa-sync-projects/agents/openai.yaml`
- Create: `global-skills/reversa-sync-projects/scripts/run-sync.mjs`
- Create: `global-skills/reversa-sync-projects/scripts/register-current-project.mjs`
- Create: `scripts/install-global-sync-skill.mjs`
- Create: `scripts/test-global-sync-skill.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `reversa sync-projects` e `reversa register-project` da Task 3.
- Produces: skill explícita instalada em `/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/skill/reversa-sync-projects`.
- Produces: único symlink de descoberta `~/.codex/skills/reversa-sync-projects`.

- [ ] **Step 1: Inicializar e completar a skill**

Criar a skill sem placeholders. O `SKILL.md` deve mandar executar `scripts/run-sync.mjs`, apresentar o plano retornado, obter a confirmação única e reportar o resultado por projeto. O metadata deve conter:

```yaml
interface:
  display_name: "Sincronizar projetos Reversa"
  short_description: "Atualiza projetos registrados usando o fork"
  default_prompt: "Use $reversa-sync-projects para sincronizar os projetos registrados com a main validada do fork."
policy:
  allow_implicit_invocation: false
```

- [ ] **Step 2: Implementar wrappers finos**

`run-sync.mjs` lê `config/sync.json`, valida que o fork está no volume e executa `node <fork>/bin/reversa.js sync-projects`. `register-current-project.mjs` executa `register-project` para `process.cwd()`.

- [ ] **Step 3: Implementar instalador global seguro**

O instalador valida que o checkout atual está no `NEO MATRIX`, copia a skill para o diretório ativo externo, grava `config/sync.json` e cria/substitui somente o link simbólico específico em `~/.codex/skills/reversa-sync-projects`. Se existir conteúdo real nesse destino, deve falhar sem removê-lo.

- [ ] **Step 4: Escrever teste de instalação isolada**

Injetar diretórios fixture para validar cópia externa, link simbólico, recusa de destino real preexistente e ausência de outros arquivos no diretório home fixture.

- [ ] **Step 5: Validar a skill e o pacote**

Run: `python3 /Users/thenrique.nogueiragmail.com/.codex/skills/.system/skill-creator/scripts/quick_validate.py global-skills/reversa-sync-projects`

Run: `TMPDIR='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/tmp' npm_config_cache='/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/cache/npm' npm run verify`

Expected: validação da skill e todos os testes PASS.

- [ ] **Step 6: Instalar a skill global e registrar o projeto atual**

Executar o instalador a partir do fork, verificar com `readlink` que o destino está no `NEO MATRIX` e registrar `/Volumes/NEO MATRIX/Projetos/Documents/Codex/reversa-prestacaodecontas-fork`.

- [ ] **Step 7: Executar aceitação sem reanálise**

Rodar primeiro o modo de planejamento/cancelamento e confirmar hashes inalterados em `_reversa_sdd/`. Depois executar a sincronização somente se `origin/main` já contiver a implementação; caso contrário, promover a branch validada para `main` antes da aceitação operacional.

- [ ] **Step 8: Quality gate e commit**

Revisar status/diff, executar `git diff --check`, `npm run verify`, quick validator e confirmar que nenhum cache ou temporário entrou no repositório.

```bash
git add global-skills/reversa-sync-projects scripts/install-global-sync-skill.mjs scripts/test-global-sync-skill.mjs package.json
git commit -m "feat: add global reversa project sync skill"
```

- [ ] **Step 9: Publicação controlada**

Fazer push dos commits da branch de trabalho. Como `origin/main` é requisito funcional e está atrás da branch, promover apenas no sentido permitido `codex/reversa-behavioral-analysis -> main`, sem merge inverso, depois de confirmar o fast-forward e repetir o smoke da origem publicada.
