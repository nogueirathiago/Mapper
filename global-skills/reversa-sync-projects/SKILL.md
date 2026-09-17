---
name: reversa-sync-projects
description: Sincroniza, sob solicitação explícita, os projetos Reversa registrados com a main validada do fork, preservando customizações locais. Use somente quando o usuário pedir para atualizar ou sincronizar os projetos Reversa pelo fork.
license: MIT
metadata:
  author: nogueirathiago
  framework: reversa
  role: maintenance
---

# Sincronizar projetos Reversa

Esta skill atualiza somente os arquivos gerenciados pelo Reversa. Ela não remapeia código, não revalida análises e não altera os artefatos produzidos pelo mapeamento.

## Execução

1. Confirme que o dispositivo `/Volumes/NEO MATRIX` está montado.
2. Execute em terminal interativo:

```bash
node '/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/skill/reversa-sync-projects/scripts/run-sync.mjs'
```

3. Mostre ao usuário o plano agregado emitido pelo comando.
4. Aguarde a confirmação única solicitada pelo próprio comando.
5. Ao concluir, relate por projeto: atualizados, restaurados, modificados preservados, conflitos preservados, inacessíveis e falhas.

## Limites

- Nunca substitua arquivos classificados como modificados ou conflitantes.
- Nunca remova projetos do registro por indisponibilidade temporária.
- Nunca execute mapeamento, revisão ou revalidação como parte desta atualização.
- Nunca use outra branch, pacote npm ou worktree sujo como fonte; o core materializa e valida `origin/main`.
- Não improvise cópias manuais se o comando falhar. Informe a causa sem alterar os projetos.

