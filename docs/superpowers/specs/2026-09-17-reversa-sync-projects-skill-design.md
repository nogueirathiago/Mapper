# Skill global para sincronizar projetos Reversa com o fork

**Status:** aprovado para planejamento em 2026-09-17

## Contexto

O fork do Reversa é a fonte das correções e evoluções usadas nos projetos mapeados. Hoje cada projeto mantém sua própria instalação de skills e arquivos gerenciados pelo Reversa, enquanto o comando `update` consulta a versão pública do npm. Isso não garante que uma mudança existente apenas no fork chegue aos projetos e pode considerar uma instalação atualizada quando fork e pacote público compartilham a mesma versão.

O usuário quer iniciar a sincronização sob demanda, por uma skill explícita, sem serviço em segundo plano e sem precisar executar comandos manualmente no terminal.

## Objetivos

- Disponibilizar a skill global explícita `$reversa-sync-projects`.
- Usar `origin/main` do fork como única fonte da sincronização.
- Manter uma lista global explícita dos projetos Reversa conhecidos.
- Registrar automaticamente um projeto novo quando o Reversa for instalado ou ativado nele.
- Atualizar arquivos gerenciados pelo Reversa sem remapear o legado.
- Preservar arquivos que tenham sido modificados localmente e relatar as divergências.
- Isolar falhas por projeto e apresentar um resultado verificável da execução.
- Manter o fork, os projetos e todos os dados operacionais da sincronização no volume `NEO MATRIX`, sem armazenar esse conteúdo no SSD interno do Mac.

## Não objetivos

- Não executar mapeamento, revalidação ou revisão das análises existentes.
- Não alterar conteúdo produzido em `_reversa_sdd/`, `_reversa_docs/`, `_reversa_forward/`, `_reversa_bugs/` ou `_reversa_refactor/`.
- Não varrer o disco em busca de projetos.
- Não executar atualizações automáticas, periódicas ou em segundo plano.
- Não publicar o fork no npm.
- Não depender da CLI global instalada nem substituí-la como efeito da sincronização.
- Não sobrescrever customizações locais para forçar igualdade byte a byte com o fork.

## Arquitetura

### 1. Skill global explícita

A fonte versionada da skill ficará em `global-skills/reversa-sync-projects/` no fork, dentro do volume `NEO MATRIX`. A instalação manterá a cópia ativa em `/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/skill/reversa-sync-projects` e criará `~/.codex/skills/reversa-sync-projects` somente como link simbólico para ela. Essa é a única entrada permitida no SSD interno; nenhum arquivo de conteúdo da skill será copiado para lá. A política de invocação será explícita (`allow_implicit_invocation: false`), pois a operação altera vários projetos.

A skill será uma camada fina: ela localizará o checkout configurado do fork e acionará diretamente o comando determinístico de sincronização desse checkout. As regras de cópia, preservação e atualização de manifestos permanecerão no core do Reversa, em vez de serem duplicadas em instruções da skill ou dependerem da CLI pública instalada globalmente.

A instalação inicial da skill gravará a configuração no diretório operacional `/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/`. O arquivo `config/sync.json` conterá a localização absoluta do repositório do fork, o remoto `origin` e a branch `main`. Se o checkout for movido, estiver fora de `/Volumes/NEO MATRIX/` ou a configuração ficar inválida, a execução falhará antes de alterar projetos e informará que a skill deve ser reinstalada a partir do novo local.

### 2. Política de armazenamento

Todo conteúdo real usado ou produzido por esse fluxo deverá permanecer sob `/Volumes/NEO MATRIX/`:

- checkout do fork;
- projetos registrados;
- configuração e registro globais do sincronizador;
- áreas de preparação e arquivos temporários;
- cache npm usado para validar o fork;
- código e metadados da skill global.

O diretório operacional padrão será `/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/`, organizado em `config/`, `skill/`, `tmp/` e `cache/`. A execução definirá caminhos próprios nesse diretório para não recorrer a `/tmp`, `TMPDIR`, `~/.npm` ou outras áreas do SSD interno.

Antes de registrar ou sincronizar um caminho, o fluxo resolverá seu caminho físico e confirmará que ele pertence a `/Volumes/NEO MATRIX/`. Caminhos no SSD interno, inclusive por meio de links simbólicos que apontem para fora do volume, serão recusados sem alteração. Se o volume estiver desmontado, a execução falhará de forma segura.

A única exceção é o link simbólico `~/.codex/skills/reversa-sync-projects`, necessário para descoberta da skill pelo Codex. O destino e todo o conteúdo desse link permanecerão no volume `NEO MATRIX`.

### 3. Registro global de projetos

O registro ficará em `/Volumes/NEO MATRIX/Projetos/Documents/Codex/.reversa-global/config/projects.json` com formato mínimo e versionado:

```json
{
  "version": 1,
  "projects": [
    "/caminho/absoluto/do/projeto"
  ]
}
```

Os caminhos serão absolutos, normalizados e sem duplicatas. Entradas inacessíveis não serão removidas automaticamente; serão informadas no resultado para não perder cadastro por causa de volume desmontado ou indisponibilidade temporária.

O registro será idempotente e ocorrerá em dois pontos:

- ao concluir `reversa install` com sucesso;
- ao ativar a skill principal `reversa` dentro de um projeto que já possua `.reversa/state.json`, caso o caminho ainda não esteja registrado.

O segundo ponto cobre projetos antigos e instalações copiadas sem exigir cadastro manual.

### 4. Fonte do fork

A sincronização usará exclusivamente `origin/main` do fork configurado. Ela não trocará a branch nem modificará o worktree de desenvolvimento atual.

O fluxo buscará a referência remota, materializará o commit de `origin/main` em uma área temporária e validará esse conteúdo antes de tocar nos projetos. Isso evita sincronizar arquivos não commitados ou uma branch de trabalho por engano.

Se o fetch falhar, `origin/main` não existir ou a validação do fork falhar, a execução será encerrada antes de qualquer projeto ser alterado.

### 5. Planejamento e confirmação

Antes das escritas, o comando examinará todos os projetos registrados e apresentará um único plano contendo:

- commit do fork que será aplicado;
- projetos válidos, inacessíveis ou sem instalação Reversa reconhecida;
- quantidade de arquivos atualizáveis, ausentes, modificados localmente e conflitantes em cada projeto.

Após o plano, haverá uma única confirmação para sincronizar os projetos elegíveis. Cancelar não produzirá alterações.

### 6. Regra de atualização

Para cada projeto elegível, a sincronização reutilizará o manifesto e o estado do instalador:

- arquivo gerenciado e intacto: atualizar para a versão do fork;
- arquivo gerenciado e ausente: restaurar;
- arquivo gerenciado e modificado localmente: preservar e relatar;
- arquivo novo do fork sem colisão local: instalar;
- arquivo novo do fork que colida com conteúdo local não gerenciado: preservar e relatar como conflito;
- manifesto, versão e estado técnico: atualizar apenas para refletir os arquivos efetivamente instalados ou preservados;
- commit de origem: registrar no estado técnico o SHA de `origin/main` efetivamente aplicado, sem depender de mudança na versão npm.

Diretórios de saída das análises e qualquer arquivo de código legado ficam fora desse conjunto.

Uma falha em um projeto será registrada e a execução continuará nos demais. Falhas na obtenção ou validação da fonte do fork interrompem a execução inteira, porque afetam todos os destinos.

## Fluxo do usuário

1. O usuário instala ou ativa o Reversa em um projeto; o caminho entra no registro global de forma idempotente.
2. Quando desejar propagar uma atualização publicada na `main` do fork, chama `$reversa-sync-projects` no Codex.
3. A skill obtém e valida `origin/main`, mostra o plano agregado e solicita uma confirmação.
4. O core atualiza apenas os arquivos elegíveis de cada projeto.
5. A skill apresenta um resumo por projeto, separando atualizados, preservados, conflitos, inacessíveis e falhas.

## Tratamento de erros

- Registro ausente: criar com `version: 1` e lista vazia antes do primeiro cadastro.
- JSON inválido ou versão desconhecida: falhar de forma segura e não reescrever o arquivo silenciosamente.
- Volume `NEO MATRIX` desmontado: abortar antes de criar temporários, consultar a fonte ou alterar projetos.
- Fork ou projeto fora de `/Volumes/NEO MATRIX/`: recusar o caminho e não registrá-lo nem sincronizá-lo.
- Projeto inacessível: ignorar naquela execução, manter no registro e relatar.
- Projeto sem `.reversa/state.json`: não alterar e relatar como instalação não reconhecida.
- Manifesto ausente ou inválido: não presumir que arquivos são seguros para sobrescrita; preservar e relatar a necessidade de reparo.
- Arquivo modificado ou colisão não gerenciada: preservar e continuar.
- Erro durante um projeto: marcar esse projeto como falha e continuar nos demais.
- Fonte do fork inválida: abortar antes de qualquer escrita nos projetos.

## Validação

A implementação deverá cobrir, em diretórios temporários:

- criação e leitura do registro global;
- normalização e deduplicação de caminhos;
- rejeição do fork e de projetos cujo caminho físico esteja fora de `/Volumes/NEO MATRIX/`;
- uso de temporários e cache npm somente no diretório operacional do volume externo;
- funcionamento do link global sem cópia de conteúdo para `~/.codex/skills`;
- registro automático por instalação e por ativação;
- projeto inacessível ou sem instalação reconhecida;
- classificação de arquivo intacto, ausente e modificado;
- preservação de modificação local e de colisão não gerenciada;
- instalação de arquivo novo do fork;
- atualização coerente de manifesto e estado;
- isolamento de falha entre dois projetos;
- cancelamento após o plano sem produzir escritas;
- aborto global quando a validação da fonte falha;
- garantia de que diretórios de análise não sejam alterados.

Também deverão passar os verificadores já existentes do pacote (`npm run verify`) e o validador da nova skill (`quick_validate.py`).

## Critérios de aceite

- `$reversa-sync-projects` só é invocada explicitamente.
- O checkout do fork, todos os projetos registrados e todos os dados operacionais ficam em `/Volumes/NEO MATRIX/`.
- No SSD interno existe somente o link simbólico necessário em `~/.codex/skills/reversa-sync-projects`; seu destino está no volume externo.
- Temporários e cache npm da sincronização não usam o SSD interno.
- Projetos novos entram no registro sem edição manual da lista.
- A origem aplicada é identificada pelo commit de `origin/main` do fork.
- Cada projeto sincronizado registra o commit do fork efetivamente aplicado.
- Nenhum projeto é alterado antes da apresentação e confirmação do plano.
- Arquivos modificados localmente nunca são sobrescritos.
- Projetos inacessíveis permanecem registrados.
- Uma falha isolada não impede a atualização dos outros projetos.
- Nenhuma análise é refeita e nenhum artefato de mapeamento é alterado.
- O resultado final permite verificar o que foi atualizado, preservado ou ignorado em cada projeto.
