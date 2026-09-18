# CLI

O Reversa tem um CLI simples para gerenciar a instalação e o ciclo de vida dos agentes no seu projeto. Todos os comandos rodam com `npx reversa` na raiz do projeto.

---

## Comportamento inicial

Ao iniciar e antes de mostrar a logo ASCII do Reversa, o CLI deve limpar a tela do terminal. A logo deve aparecer no alto do terminal, sem conteúdo anterior acima dela.

A assinatura `by sandeco` deve aparecer em branco na última linha da arte, depois de uma margem à direita do final do `Reversa` grande. Ela não deve ficar flutuando no meio da altura da logo.

Formato esperado:

```text
  ______
  | ___ \
  | |_/ /_____   _____ _ __ ___  __ _
  |    // _ \ \ / / _ \ '__/ __|/ _` |
  | |\ \  __/\ V /  __/ |  \__ \ (_| |
  \_| \_\___| \_/ \___|_|  |___/\__,_|  by sandeco

  AI-Powered Reverse Engineering Framework
```

---

## Comandos disponíveis

### `install`

```bash
npx reversa install
```

Instala o Reversa no projeto legado atual. Detecta as engines presentes, pergunta suas preferências e cria toda a estrutura necessária.

Use uma vez, na raiz do projeto que você quer analisar.

#### Layout do menu de instalação

O instalador deve tratar o menu como interface principal, não como despejo de texto. As perguntas devem ser numeradas, ter uma linha em branco antes da pergunta e, quando houver opções, uma linha em branco entre a pergunta e a lista.

Após o usuário confirmar uma pergunta de múltipla escolha, o CLI não deve imprimir todos os itens selecionados em uma única linha contínua. Isso é proibido porque gera um parágrafo longo e ilegível. Use uma destas alternativas:

- Não renderizar a seleção completa e avançar para a próxima pergunta.
- Renderizar um resumo curto, uma linha por time.

Não existe seleção de agentes: o instalador sempre instala **todos** os agentes que vêm no pacote. O resumo final da instalação quebra a contagem por time (Discovery, Migration, Code Forward, New Project, Documentation, Translators e Pricing).

---

### `status`

```bash
npx reversa status
```

Mostra o estado atual da análise: qual fase está em andamento, quais agentes já rodaram, o que falta completar e o resumo da análise comportamental.

Útil para ter uma visão geral rápida antes de retomar uma sessão.

---

### `validate-analysis`

```bash
npx reversa validate-analysis
npx reversa validate-analysis --json
```

Valida referências e hashes de evidência, vínculos entre entradas, operações e regras, progresso, bloqueios investigados e coerência da conclusão. Avisos permitem continuidade ou encerramento com ressalvas; erros indicam contrato inconsistente. O comando não certifica sozinho se a interpretação semântica de uma regra está correta.

---

### `scan-surface`

```bash
npx reversa scan-surface
npx reversa scan-surface --source=<caminho-relativo> --json
```

Descobre actions ASP.NET MVC e fluxos Razor/JavaScript e grava `.reversa/context/surface-candidates.json`. O `/reversa` executa o comando automaticamente antes do Scout, sem fazer outra pergunta; o uso manual serve somente para diagnóstico ou reexecução. `--source` substitui a raiz relativa configurada, e `--json` imprime apenas o resumo operacional. O código de saída `0` indica scan concluído, inclusive com candidatos não resolvidos; `1` indica falha fatal de configuração, acesso ou escrita.

---

### `update`

```bash
npx reversa update
```

Atualiza tudo para a versão mais recente do Reversa: todos os agentes do pacote são reinstalados, incluindo agentes que não existiam quando você instalou.

O comando é inteligente: ele verifica o manifesto SHA-256 de cada arquivo e nunca sobrescreve arquivos que você personalizou. Se você fez ajustes em algum agente, eles ficam intactos.

---

### `add-engine`

```bash
npx reversa add-engine
```

Adiciona suporte a uma engine de IA que não estava presente quando você instalou. Por exemplo: instalou só para Claude Code e agora quer adicionar Codex também.

---

### `uninstall`

```bash
npx reversa uninstall
```

Remove o Reversa do projeto: apaga os arquivos criados pela instalação (`.reversa/`, `.agents/skills/reversa-*/`, os arquivos de entrada das engines).

!!! info "Seus arquivos continuam intactos"
    O `uninstall` remove **apenas** o que o Reversa criou. Nenhum arquivo original do projeto é tocado. As especificações geradas em `_reversa_sdd/` também são preservadas por padrão.
