# Schema — .reversa/context/surface.json

Arquivo gerado pelo Scout. Usado pelos demais agentes como fonte de contexto estruturado.

## Estrutura completa

```json
{
  "generated_at": "2026-04-26T10:00:00Z",
  "project_root": "/caminho/do/projeto",
  "source_snapshot": {
    "kind": "git",
    "id": "commit-ou-hash-do-manifesto"
  },
  "languages": [
    { "name": "TypeScript", "extensions": [".ts", ".tsx"], "file_count": 142 },
    { "name": "JavaScript", "extensions": [".js", ".mjs"], "file_count": 23 }
  ],
  "primary_language": "TypeScript",
  "frameworks": [
    { "name": "Next.js", "version": "14.2.0", "source": "package.json" },
    { "name": "Prisma", "version": "5.10.0", "source": "package.json" }
  ],
  "package_manager": "npm",
  "entry_points": [
    { "path": "src/app/layout.tsx", "type": "app_entry" },
    { "path": "src/server.ts", "type": "server_entry" }
  ],
  "operation_entry_points": [
    {
      "id": "ENTRY-001",
      "type": "endpoint",
      "name": "POST /orders",
      "file": "src/orders/orders.controller.ts",
      "line": 24
    }
  ],
  "surface_discovery": {
    "schema_version": 1,
    "scan_snapshot_id": "sha256-do-manifesto",
    "candidate_resolutions": [
      {
        "candidate_id": "CAND-UI-A1B2C3",
        "disposition": "promoted",
        "entry_point_id": "ENTRY-001",
        "reason": "O controle inicia uma operação observável."
      },
      {
        "candidate_id": "CAND-UI-D4E5F6",
        "disposition": "auxiliary",
        "related_entry_point_ids": ["ENTRY-001"],
        "reason": "O mesmo fluxo já está representado pela entrada informada."
      },
      {
        "candidate_id": "CAND-UI-VISUAL",
        "disposition": "auxiliary",
        "reason": "O controle apenas fecha um painel visual da operação."
      },
      {
        "candidate_id": "CAND-UI-G7H8I9",
        "disposition": "pending",
        "reason": "O destino é dinâmico e a evidência atual não permite classificá-lo."
      }
    ]
  },
  "config_files": [
    "next.config.js", ".env.example", "tsconfig.json"
  ],
  "ci_cd": [
    ".github/workflows/deploy.yml"
  ],
  "docker": {
    "dockerfile": "Dockerfile",
    "compose": "docker-compose.yml"
  },
  "database_hints": [
    { "path": "prisma/schema.prisma", "type": "prisma_schema" },
    { "path": "prisma/migrations/", "type": "migrations_dir" }
  ],
  "test_framework": "Jest",
  "test_file_count": 47,
  "modules": [
    "auth", "orders", "payments", "users", "notifications"
  ],
  "total_files": 312,
  "organization_suggestion": {
    "granularity": "module",
    "rationale": "A estrutura de pastas top-level está organizada por domínio: auth/, orders/, payments/, users/, notifications/.",
    "signals": [
      { "type": "top_level_domain_folders", "evidence": ["src/auth/", "src/orders/", "src/payments/"] }
    ],
    "features": []
  }
}
```

## Campos obrigatórios

`generated_at`, `source_snapshot`, `languages`, `primary_language`, `frameworks`, `entry_points`, `operation_entry_points`, `modules`, `organization_suggestion`

## Campos opcionais

Todos os demais, inclua apenas o que for encontrado.

## Identidade e entradas comportamentais

`source_snapshot.id` identifica exatamente o código analisado e deve ser igual a `surface-candidates.json.source_snapshot.id`. Os caminhos de `operation_entry_points` e evidências são relativos a `surface-candidates.json.source_root`. Reaproveite o inventário enquanto esse ID permanecer igual.

`entry_points` continua descrevendo inicialização técnica. `operation_entry_points` enumera entradas observáveis que originam operações: telas/ações, endpoints, comandos, eventos, jobs e serviços expostos. Não inclua construtores, interfaces ou helpers apenas para aumentar a contagem.

## Campo `surface_discovery`

`surface_discovery` registra a classificação semântica feita pelo Scout sobre os fatos sintáticos de `.reversa/context/surface-candidates.json`:

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `schema_version` | integer | sim | Versão `1` deste contrato. |
| `scan_snapshot_id` | string | sim | Mesmo ID de `surface-candidates.json.source_snapshot.id`. |
| `candidate_resolutions` | array | sim | Exatamente uma resolução para cada candidato do scan atual. |

Cada resolução contém `candidate_id`, `disposition` e `reason`. `disposition` aceita somente:

- `promoted`: representa efeito funcional observável; exige `entry_point_id` existente e vinculado a uma operação;
- `auxiliary`: participa da interface sem ser operação autônoma; exige justificativa. Para candidato `ui_action` funcional produzido pela revisão atual do scanner, exige `related_entry_point_ids` com uma ou mais entradas existentes e vinculadas a operações. Somente candidatos com `disposition_hint: "auxiliary"` podem omitir esse vínculo. Resoluções históricas permanecem válidas sem o campo e recebem aviso de cobertura antiga;
- `excluded`: não representa comportamento funcional; exige justificativa;
- `pending`: a evidência é insuficiente; permanece lacuna e bloqueia cobertura total.

Uma resolução cujo candidato não existe no scan atual é obsoleta. O Scout não apaga silenciosamente candidatos não resolvidos, não inventa destinos e não usa a organização das specs para reduzir a cobertura.

O artefato da revisão atual do scanner também contém `file_coverage`, com uma linha para cada arquivo considerado e seu estado `analyzed` ou `read_error`. Nesse contrato, cobertura total exige inventário consistente e ausência de `scan_gaps`. Artefatos históricos continuam válidos no contrato em que foram aprovados, com aviso de que não comprovam a cobertura integral atual. Bindings JavaScript sem um controle HTML vinculável permanecem candidatos `ui_action` do tipo `client_binding`; eles não podem ser descartados por não possuírem um botão Razor correspondente.

## Campo `organization_suggestion`

Sugestão de como organizar as specs deste projeto. Lido pelo orquestrador Reversa para pré-marcar a opção default no menu de organização das specs.

### Subcampos

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `granularity` | string | sim | Um de: `module`, `use-case`, `endpoint`, `hybrid`, `feature`, `custom`. O Scout nunca sugere `custom`, esse valor só vem da escolha do usuário. |
| `rationale` | string | sim | Frase curta explicando por que essa granularidade foi escolhida. Aparece no menu como "Razão:" do Scout. |
| `signals` | array | sim | Lista dos sinais detectados que levaram à sugestão. Cada item tem `type` e `evidence` (lista de caminhos). Pode ser vazia quando o fallback `feature` é usado. |
| `features` | array | sim quando `granularity = "feature"` | Lista de nomes de features descobertas pelo Scout. Cada nome vira uma pasta de primeiro nível. |

### Heurísticas para definir `granularity`

| Sinal detectado | `granularity` sugerida |
|-----------------|------------------------|
| Roteamento centralizado (`routes.*`, `urls.py`, `*Controller.cs`, `@RestController`) | `endpoint` |
| Pastas top-level com nomes de domínio (`auth/`, `orders/`, `payments/`) | `module` |
| Specs Gherkin / E2E orientadas a comportamento (`features/*.feature`, `*.spec.*` BDD) | `use-case` |
| Múltiplos sinais coexistindo com peso parecido | `hybrid` |
| Nenhum sinal claro de organização | `feature` (fallback, preencher `features` com o que foi possível extrair) |

### Imutabilidade

Após a primeira execução, o orquestrador persiste o `granularity` sugerido em `.reversa/config.toml` no campo `scout_suggestion`. Em re-execuções, o Scout pode regerar o `surface.json` (o legado pode ter mudado), mas o orquestrador NÃO atualiza o `scout_suggestion` em `config.toml` (RF-14 da spec de organização das specs).

## Nota

Use este schema como guia. Se um campo não se aplicar ao projeto, omita-o, exceto os obrigatórios listados acima.
