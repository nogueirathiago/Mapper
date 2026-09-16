# Guia de Checkpoints — .reversa/state.json

O Reversa é o único agente que **escreve** no state.json. Os demais agentes apenas leem.

## Regras absolutas

1. **Nunca remova campos existentes.** Apenas adicione ou atualize.
2. **Sempre leia o arquivo antes de escrever** — outro agente pode ter atualizado `checkpoints`.
3. **Salve após cada fase concluída**, não apenas no final.
4. **Em caso de estouro de contexto**, salve imediatamente antes de pausar.
5. Para análise comportamental, derive as contagens das operações em `.reversa/context/modules.json`; não use quantidade de arquivos ou métodos como substituto.

## O que salvar a cada fase

### Ao iniciar uma fase
```json
{
  "phase": "reconhecimento"
}
```

### Ao concluir um agente
```json
{
  "checkpoints": {
    "scout": {
      "completed_at": "2026-04-26T10:30:00Z",
      "files": [
        "_reversa_sdd/inventory.md",
        "_reversa_sdd/dependencies.md",
        ".reversa/context/surface.json"
      ]
    }
  }
}
```

### Ao concluir uma fase inteira
```json
{
  "phase": "escavacao",
  "completed": ["reconhecimento"],
  "pending": ["escavacao", "interpretacao", "geracao", "revisao"]
}
```

### Ao marcar uma tarefa parcial do Archaeologist
```json
{
  "checkpoints": {
    "archaeologist": {
      "modules_analyzed": ["auth", "orders"],
      "modules_pending": ["payments", "users"]
    }
  }
}
```

### Ao salvar progresso comportamental

```json
{
  "checkpoints": {
    "behavioral_analysis": {
      "current_operation_id": "OP-004",
      "reviewed": 3,
      "pending": 2,
      "blocked": 0,
      "investigations": []
    }
  }
}
```

Salve após cada operação ou pequeno lote que caiba com segurança no contexto. O detalhe das operações e regras fica em `modules.json`; o `state.json` mantém somente o necessário para retomar e auditar bloqueios.

Antes de marcar uma operação `blocked`, registre a investigação conforme `behavioral-analysis-guide.md`. Uma contagem automática, busca repetida ou ausência de execução não substitui tentativa sobre a fonte disponível.

## Sequência de fases

```
null → reconhecimento → escavacao → interpretacao → geracao → revisao
```

Ao mover de fase:
- Retire a fase concluída de `pending` e adicione a `completed`
- Atualize `phase` para a próxima fase

## Exemplo de state.json com análise em andamento

```json
{
  "version": "1.0.0",
  "project": "meu-sistema",
  "user_name": "Ana",
  "chat_language": "pt-br",
  "doc_language": "Português",
  "answer_mode": "chat",
  "output_folder": "_reversa_sdd",
  "phase": "escavacao",
  "completed": ["reconhecimento"],
  "pending": ["escavacao", "interpretacao", "geracao", "revisao"],
  "checkpoints": {
    "scout": {
      "completed_at": "2026-04-26T10:30:00Z",
      "files": [
        "_reversa_sdd/inventory.md",
        "_reversa_sdd/dependencies.md",
        ".reversa/context/surface.json"
      ]
    },
    "archaeologist": {
      "modules_analyzed": ["auth", "orders"],
      "modules_pending": ["payments", "users"]
    }
  },
  "engines": ["claude-code"],
  "agents": ["reversa", "reversa-scout", "reversa-archaeologist"],
  "created_files": []
}
```

## Mensagem de pausa por estouro de contexto

Se o contexto estiver se esgotando, salve o checkpoint atual e diga:

> "[Nome], vou pausar aqui para preservar o contexto. Tudo está salvo em `.reversa/state.json`. Digite `reversa` em uma nova sessão para continuar de onde paramos."
