# Descoberta deterministica de acoes de interface

**Status:** aprovado pelo usuario em 2026-09-18
**Escopo inicial:** ASP.NET MVC, Razor e JavaScript/jQuery  
**Checkout de referencia:** `main@be14234`

## 1. Problema

O contrato comportamental do Reversa define tela ou acao como uma entrada
observavel, mas a descoberta atual e executada apenas por instrucoes do Scout.
O CLI valida o catalogo produzido pelo agente, sem descobrir entradas por conta
propria nem comparar o catalogo com a superficie real do codigo.

Em projetos que usam views e handlers no cliente, enumerar somente actions de
Controller pode omitir cadeias implementadas e observaveis como:

```text
estado de dominio
-> controle visivel sob uma guarda
-> handler JavaScript
-> validacao HTTP
-> callback de sucesso
-> partial com a etapa seguinte
-> confirmacao
-> mutacao HTTP final
```

Quando essa cadeia nao existe no catalogo, as specs e os consumidores de
conhecimento nao conseguem recompor o fluxo correto. A presenca de controles
com rotulos semelhantes e destinos diferentes ainda pode provocar associacoes
incorretas entre operacoes independentes.

## 2. Objetivo

Adicionar ao CLI uma descoberta deterministica, conservadora e auditavel da
superficie MVC/Razor/jQuery antes do Scout, mantendo separadas:

1. a descoberta sintatica feita pelo CLI;
2. a classificacao semantica feita pelo Scout;
3. o catalogo canonico em `surface.json`;
4. a validacao de que nenhum candidato ficou sem tratamento.

A granularidade das specs (`endpoint`, `hybrid` etc.) permanece uma decisao de
organizacao posterior e nao altera a cobertura da descoberta.

O desenho e os artefatos sao independentes de dominio e de projeto. Nenhum
nome de sistema, modulo, Controller, rota, status, seletor, texto de interface
ou caminho de um consumidor pode integrar regras do scanner ou criterios
normativos de aceite. A generalidade vale para qualquer projeto dentro das
stacks suportadas; ampliar a lista de stacks e uma evolucao separada.

## 3. Fora de escopo

- suporte inicial a outras stacks;
- sistema generico de plugins ou SDK de extratores;
- parser Razor completo, AST universal ou call graph geral;
- banco, indice, servico de background ou cache incremental;
- inferencia de regras de negocio pelo scanner;
- heuristicas, excecoes ou dicionarios especificos de um projeto consumidor;
- publicacao no Basic Memory;
- regeneracao automatica de notas;
- reextracao silenciosa de projetos consumidores;
- qualquer alteracao no codigo legado analisado.

## 4. Interface do CLI

Adicionar o comando:

```bash
reversa scan-surface [--source=<caminho-relativo>] [--json]
```

Resolucao da raiz do codigo, em ordem de precedencia:

1. `--source`;
2. `[analysis].source_root` de `.reversa/config.user.toml`;
3. `[analysis].source_root` de `.reversa/config.toml`;
4. `.` como fallback.

O caminho deve ser relativo a raiz do projeto e permanecer dentro dela. Caminho
absoluto ou que escape por `..` e rejeitado. Por exemplo, um consumidor que
mantenha o codigo em `src/` pode configurar:

```toml
[analysis]
source_root = "src"
```

O modo `--json` imprime somente o resumo operacional. Os candidatos completos
ficam no artefato em disco.

Codigos de saida:

- `0`: scan concluido, inclusive quando existem candidatos nao resolvidos;
- `1`: falha fatal de configuracao, acesso ou escrita; o artefato valido
  anterior permanece intacto.

## 5. Artefato de descoberta

O comando grava atomicamente:

```text
.reversa/context/surface-candidates.json
```

Estrutura de alto nivel:

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-18T00:00:00Z",
  "source_root": "src",
  "source_snapshot": {
    "kind": "manifest_sha256",
    "id": "<hash>"
  },
  "summary": {
    "files_scanned": 0,
    "candidates": 0,
    "exact": 0,
    "unresolved": 0
  },
  "candidates": [],
  "scan_gaps": []
}
```

O scanner nunca escreve diretamente em `surface.json`.

## 6. Candidatos

O primeiro release reconhece duas classes principais:

- `mvc_action`: action, verbo, rota e retorno MVC;
- `ui_action`: botao, link ou formulario com efeito funcional potencial.

Um candidato de interface possui somente fatos extraidos do codigo:

```json
{
  "id": "CAND-UI-<hash>",
  "type": "ui_action",
  "label": "Enviar solicitacao",
  "selector": "#btnEnviarSolicitacao",
  "file": "Aplicacao.Web/Views/Solicitacoes/Detalhe.cshtml",
  "line": 155,
  "guards": [
    "Status == PENDENTE",
    "PodeEnviar"
  ],
  "confidence": "exact",
  "steps": [
    {
      "kind": "http",
      "method": "GET",
      "target": "Solicitacoes/ValidarEnvio"
    },
    {
      "kind": "http_on_success",
      "method": "GET",
      "target": "Solicitacoes/PrepararConfirmacao"
    }
  ],
  "evidence": []
}
```

Valores de `confidence`:

- `exact`: seletor e destino literais comprovados;
- `unresolved`: existe acao observavel, mas handler ou destino nao foi resolvido.

Nao havera categoria de inferencia semantica no scanner.

O ID e derivado do tipo, caminho relativo, identidade estrutural do controle ou
action, rotulo normalizado, destino conhecido e guarda normalizada. Numero de
linha nao sera a unica base da identidade. Colisoes estruturais usam ordinal
deterministico dentro do arquivo.

## 7. Regras de extracao

O scanner sera uma implementacao pequena em Node.js, sem dependencia nova e sem
compilacao do legado. Usara leitura lexical tolerante, preservando linhas e
ignorando comentarios e strings quando necessario.

### 7.1 ASP.NET MVC

Extrair:

- classes `Controller` e actions publicas;
- atributos de rota e verbo;
- convencoes Controller/Action;
- `PartialView`, `View`, redirect e JSON relevantes para continuidade;
- caminho e faixa de evidencia.

### 7.2 Razor

Extrair:

- `<button>`, submit, links e formularios;
- ID, seletor e texto visivel;
- condicoes Razor envolventes;
- expressoes de habilitacao ou `disabled`;
- `BeginForm`, `ActionLink`, `Url.Action`;
- partials e scripts referenciados.

IDs repetidos em ramos Razor diferentes permanecem candidatos distintos, com
guardas e linhas proprias.

### 7.3 JavaScript e jQuery

Extrair:

- `.click(...)`, `.on("click", ...)` e `addEventListener`;
- `$.ajax`, `fetch`, submit e navegacao;
- metodo HTTP e URL literal;
- chamadas posteriores dentro de callbacks de sucesso;
- chamadas locais de funcao que conduzem a uma requisicao.

URL calculada, seletor dinamico ou chamada indireta que nao possa ser provada
permanece `unresolved`.

### 7.4 Filtro de ruido

So se torna candidato de operacao uma acao com potencial efeito funcional:
consulta, validacao, envio, mutacao, persistencia, integracao ou navegacao de
negocio. Fechar modal, alternar aba, expandir painel e outros controles apenas
visuais podem ser classificados como `auxiliary`, mas continuam contabilizados
na cobertura quando descobertos.

## 8. Classificacao pelo Scout

O Scout le `surface-candidates.json`, interpreta o contexto e escreve as
resolucoes no proprio `surface.json`:

```json
{
  "surface_discovery": {
    "schema_version": 1,
    "scan_snapshot_id": "<hash>",
    "candidate_resolutions": [
      {
        "candidate_id": "CAND-UI-<hash>",
        "disposition": "promoted",
        "entry_point_id": "ENTRY-UI-<hash>",
        "reason": "Acao inicia a validacao e o envio da solicitacao."
      }
    ]
  }
}
```

Disposicoes permitidas:

- `promoted`: vira entrada canonica e deve chegar a uma operacao;
- `auxiliary`: participa de uma operacao, sem ser operacao autonoma;
- `excluded`: nao representa comportamento funcional do sistema;
- `pending`: nao ha evidencia suficiente para classificar.

`auxiliary` e `excluded` exigem justificativa. `pending` permanece uma lacuna e
impede conclusao total.

O Scout deve processar o arquivo em lotes por arquivo ou modulo, sem carregar o
corpus inteiro no contexto de uma vez.

## 9. Integracao com o pipeline

O orquestrador `/reversa` executa `scan-surface` antes de ativar o Scout. O
proprio Scout tambem verifica a existencia e vigencia do artefato para falhar de
forma segura caso seja invocado isoladamente.

Em nova extracao:

```text
scan-surface
-> Scout classifica candidatos
-> Archaeologist aprofunda entradas promovidas
-> Detective reconcilia regras e estados
-> Writer organiza conforme a granularidade escolhida
-> Reviewer reconcilia fontes e candidatos
-> validate-analysis aplica os gates
```

Em revisao incremental, o scanner completo so e reexecutado quando o snapshot
muda. O Reviewer compara IDs e evidencias, aprofundando apenas candidatos novos,
alterados, pendentes, contraditorios ou com resolucao obsoleta. Nao existe cache
incremental de scan nesta primeira versao.

## 10. Validacao

`validate-analysis` passa a verificar:

- snapshot do scan igual ao snapshot analisado;
- todo candidato possui exatamente uma resolucao;
- `promoted` referencia um `operation_entry_point` existente;
- a entrada promovida esta vinculada a uma operacao;
- `auxiliary` e `excluded` possuem justificativa;
- `pending` bloqueia `reviewed_scope_complete`;
- resolucao sem candidato atual gera `candidate_resolution_stale`;
- candidato sem resolucao gera `candidate_resolution_missing`;
- `scan_gaps` bloqueia `reviewed_scope_complete`;
- raiz de evidencias e resolvida a partir de `source_root`.

Uma acao nao resolvida pode permanecer em `completed_with_caveats` somente apos
decisao explicita do usuario, conforme o contrato comportamental existente.

Projetos anteriores, sem `surface-candidates.json`, recebem o aviso
`surface_discovery_unmeasured` e preservam seus artefatos. Quando uma nova
extracao ou reextracao gerar o arquivo, o contrato novo passa a ser obrigatorio.

## 11. Tratamento de falhas

- raiz ausente, fora do projeto ou ilegivel: falha fatal sem sobrescrita;
- falha de escrita: manter ultimo artefato valido;
- arquivo individual ilegivel: registrar `scan_gap` com caminho e erro saneado;
- sintaxe tolerada mas destino dinamico: candidato `unresolved`;
- snapshot alterado apos o scan: exigir nova varredura;
- candidato removido ou alterado: invalidar resolucao antiga sem apaga-la
  silenciosamente.

Nenhuma falha de parse autoriza inventar destino ou descartar o arquivo.

## 12. Aceitacao

### 12.1 Fixtures genericas

Os testes usam fixtures sinteticas, sem copiar nomes, caminhos ou regras de um
projeto consumidor. O scanner deve recuperar e ordenar evidencias suficientes
para o Scout documentar uma cadeia completa como:

```text
PENDENTE
-> btnEnviarSolicitacao: Enviar solicitacao
-> GET Solicitacoes/ValidarEnvio
-> em sucesso, GET Solicitacoes/PrepararConfirmacao
-> retorno _ConfirmarEnvio
-> btnConfirmarEnvio
-> confirmacao
-> POST Solicitacoes/Enviar
```

Uma segunda fixture deve provar que rotulos semelhantes nao unem fluxos com
guardas, handlers ou destinos distintos:

```text
btnEnviarAlternativo
-> POST FluxoAlternativo/Validar
-> confirmacao
-> POST FluxoAlternativo/Enviar
```

As fixtures devem variar nomes, estrutura de diretorios, convencoes de rota e
forma de registrar handlers. Nenhum valor literal das fixtures pode aparecer
na implementacao do scanner como regra especial.

### 12.2 Testes automatizados

Cobrir ao menos:

- action MVC e verbo;
- botao sob condicao de status;
- atributo de habilitacao;
- IDs repetidos em ramos Razor;
- `.click`, `.on("click")` e Ajax;
- chamada dentro de callback de sucesso;
- `PartialView` que introduz a etapa seguinte;
- POST final com variantes de parametro;
- URL dinamica mantida como nao resolvida;
- controle visual auxiliar;
- candidato sem classificacao bloqueando conclusao;
- resolucao obsoleta;
- `source_root` aninhado;
- escrita atomica em falha;
- compatibilidade com analise antiga sem scan.

### 12.3 Gates

- suite `npm run verify` verde;
- testes novos do scanner e validador verdes;
- dry-run em pelo menos dois projetos-fixture independentes, sem alterar
  `_reversa_sdd/`;
- comparacao documentada entre candidatos novos, resolucoes esperadas e o
  `surface.json` gerado para cada fixture;
- busca estatica comprovando ausencia de nomes de projetos consumidores na
  implementacao e nas fixtures automatizadas;
- nenhum remapeamento, publicacao ou reindexacao automatica.

## 13. Superficie de implementacao

Arquivos novos esperados:

- `lib/surface-scanner.js`;
- `lib/commands/scan-surface.js`;
- `scripts/test-surface-scanner.mjs`.

Arquivos existentes a ajustar:

- `bin/reversa.js`;
- `lib/analysis-validator.js`;
- `scripts/test-analysis-validator.mjs`;
- `package.json`;
- `templates/config.toml`;
- `agents/reversa/SKILL.md`;
- `agents/reversa-scout/SKILL.md`;
- `agents/reversa-scout/references/surface-schema.md`;
- `agents/reversa-reviewer/SKILL.md`;
- documentacao do CLI nos idiomas mantidos pelo projeto.

Nao criar nesta entrega registro generico de plugins, banco de candidatos,
servico residente ou segundo pipeline de mapeamento.
