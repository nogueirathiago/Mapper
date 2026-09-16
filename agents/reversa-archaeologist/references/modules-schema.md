# Schema — .reversa/context/modules.json

Arquivo gerado pelo Arqueólogo. Usado pelo Detetive, Arquiteto e Redator.

## Estrutura completa

```json
{
  "generated_at": "2026-04-26T11:00:00Z",
  "modules": [
    {
      "name": "auth",
      "path": "src/modules/auth",
      "purpose": "Autenticação e autorização de usuários",
      "primary_files": [
        "src/modules/auth/auth.service.ts",
        "src/modules/auth/auth.controller.ts"
      ],
      "functions": [
        {
          "name": "login",
          "file": "src/modules/auth/auth.service.ts",
          "params": ["email: string", "password: string"],
          "returns": "Promise<AuthToken>",
          "confidence": "confirmed"
        }
      ],
      "entities": [
        {
          "name": "User",
          "fields": [
            { "name": "id", "type": "string", "required": true },
            { "name": "email", "type": "string", "required": true },
            { "name": "password_hash", "type": "string", "required": true },
            { "name": "role", "type": "UserRole", "required": true }
          ],
          "confidence": "confirmed"
        }
      ],
      "business_rules": [
        {
          "description": "Senha deve ter mínimo 8 caracteres",
          "location": "src/modules/auth/auth.service.ts:45",
          "confidence": "confirmed"
        }
      ],
      "dependencies": ["users", "notifications"],
      "algorithms": [],
      "complexity": "medium"
    }
  ],
  "behavioral_analysis": {
    "version": 1,
    "source_snapshot_id": "commit-ou-hash-do-manifesto",
    "completion_status": "in_progress",
    "operations": [
      {
        "id": "OP-001",
        "name": "Criar pedido",
        "module": "orders",
        "entry_point_ids": ["ENTRY-001"],
        "status": "reviewed",
        "flow": ["entry", "authorization", "service", "validation", "persistence", "response"],
        "rule_ids": ["RULE-001"],
        "dimensions": {
          "analyzed": ["mutation", "authorization", "state", "failure", "persistence"],
          "not_applicable": [
            { "name": "selection", "reason": "A operação não lista nem seleciona registros." },
            { "name": "calculation", "reason": "A operação não calcula valores." },
            { "name": "variation", "reason": "Não há variação por data, perfil ou configuração." }
          ],
          "pending": []
        }
      }
    ],
    "rules": [
      {
        "id": "RULE-001",
        "operation_ids": ["OP-001"],
        "condition": "O usuário possui permissão para criar pedidos.",
        "consequence": "O pedido é persistido e seu identificador é retornado.",
        "exceptions": ["Falha de persistência reverte a transação."],
        "allowed_scenarios": ["Usuário autorizado envia pedido válido."],
        "blocked_scenarios": ["Usuário sem permissão recebe resposta de acesso negado."],
        "implementation_status": "implemented",
        "evidence": [
          {
            "file": "src/orders/orders.controller.ts",
            "line": 24,
            "end_line": 58,
            "file_sha256": "<sha256>"
          }
        ]
      }
    ]
  }
}
```

## Níveis de confiança

| Valor | Equivalente | Significado |
|-------|-------------|-------------|
| `"confirmed"` | 🟢 | Extraído diretamente do código |
| `"inferred"` | 🟡 | Baseado em padrões |
| `"unknown"` | 🔴 | Não determinável |

## Campos obrigatórios por módulo

`name`, `path`, `purpose`, `primary_files`

## Contrato comportamental v1

Em novas análises, `behavioral_analysis` é obrigatório e segue `../../reversa/references/behavioral-analysis-guide.md`:

- `source_snapshot_id` deve coincidir com `surface.json#source_snapshot.id`;
- `operations` contém somente operações originadas nas entradas catalogadas;
- `rules` guarda regras compartilháveis, referenciadas por ID pelas operações;
- `completion_status` aceita `in_progress`, `reviewed_scope_complete` ou `completed_with_caveats`;
- `completion_decision` é obrigatório em `completed_with_caveats`, com `decision: complete_with_caveats`, `decided_by: user` e `decided_at` em ISO 8601.

Os estados de operação são `identified`, `analyzing`, `reviewed` e `blocked`. Operação sem regra usa `no_business_decisions_reason`. Operação bloqueada usa `investigation_id`, ligado ao checkpoint do `state.json`.

As dimensões válidas são `selection`, `mutation`, `authorization`, `state`, `calculation`, `variation`, `failure` e `persistence`. Toda dimensão deve aparecer em exatamente uma lista: `analyzed`, `not_applicable` ou `pending`; itens não aplicáveis usam objeto com `name` e `reason`.

`implementation_status` aceita `implemented`, `inferred`, `presumed_intent` e `unknown`. O hash é do arquivo inteiro; isso permite detectar evidência obsoleta sem pretender validar semanticamente a explicação.

## Nota

Salve o checkpoint em `.reversa/state.json` após cada módulo analisado, antes de iniciar o próximo.
