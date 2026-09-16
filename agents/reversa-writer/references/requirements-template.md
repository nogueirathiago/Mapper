# [Nome da Unit]

> Template do arquivo `requirements.md`. Foca no QUE a unit faz, não no como.

## Visão Geral
[O que é, qual problema resolve, 2 a 3 linhas]

## Responsabilidades
- [Responsabilidade 1]
- [Responsabilidade 2]

## Regras de Negócio

### [RULE-001] [Nome da regra] 🟢

- **Operações:** [OP-001]
- **Condição:** [condição concreta]
- **Consequência:** [resultado observável]
- **Exceções/variações:** [exceções, ou "nenhuma encontrada"]
- **Permitido:** [cenário concreto]
- **Bloqueado:** [cenário concreto]
- **Implementação:** [implemented | inferred | presumed_intent | unknown]
- **Evidência:** `caminho/arquivo.ext:linha-inicial-linha-final` (`sha256:...`)

Não use contagem de condicionais, assinatura ou lista de chamadas como explicação. Comportamentos desconhecidos permanecem lacunas vinculadas à operação correspondente.

## Requisitos Funcionais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | [Descrição] | Must | [Como validar] |
| RF-02 | [Descrição] | Should | [Como validar] |

## Requisitos Não Funcionais

| Tipo | Requisito inferido | Evidência no código | Confiança |
|------|--------------------|---------------------|-----------|
| Performance | [ex: timeout de 30s em chamadas externas] | `caminho/arquivo.ext:linha` | 🟢 |
| Segurança | [ex: autenticação obrigatória na rota] | `caminho/arquivo.ext:linha` | 🟡 |
| Escalabilidade | [ex: uso de cache Redis] | `caminho/arquivo.ext:linha` | 🟢 |
| Disponibilidade | [ex: retry automático em falha] | `caminho/arquivo.ext:linha` | 🟡 |

> Inferido a partir do código. Validar com equipe de operações.

## Critérios de Aceitação

```gherkin
Dado [pré-condição]
Quando [ação]
Então [resultado esperado]

Dado [condição de erro]
Quando [ação inválida]
Então [comportamento de falha esperado]
```

## Prioridade (MoSCoW)

| Requisito | MoSCoW | Justificativa |
|-----------|--------|---------------|
| [Responsabilidade principal] | Must | Caminho crítico, chamado em todo fluxo |
| [Regra de negócio central] | Must | Regra de negócio sem fallback |
| [Funcionalidade secundária] | Should | Importante mas com alternativa |
| [Caso de borda] | Could | Raramente acionado |

> Prioridade inferida por frequência de chamada e posição na cadeia de dependências.

## Rastreabilidade de Código

| Arquivo | Função / Classe | Cobertura |
|---------|-----------------|-----------|
| `caminho/arquivo.ext` | `NomeDaClasse` | 🟢 |
