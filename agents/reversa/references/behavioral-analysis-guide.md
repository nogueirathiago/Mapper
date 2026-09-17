# Guia de análise comportamental

Aplique este guia ao mapeamento completo ou parcial, à revisão/revalidação e às consultas sobre regras já mapeadas. Inventário, assinaturas, contagem de condicionais e lista de chamadas ajudam a localizar trabalho, mas não constituem comportamento explicado.

## Unidade de análise

Uma **operação** nasce em uma entrada observável do sistema: tela/ação, endpoint, comando, evento, job, serviço exposto ou outra interface externa. Métodos auxiliares, construtores, interfaces e propriedades não são operações por si só; vincule-os ao fluxo que ajudam a implementar.

No primeiro mapeamento e nas operações selecionadas para aprofundamento conforme a seção **Profundidade e revisão**, siga as camadas disponíveis no snapshot:

`entrada → autorização/escopo de dados → serviço/domínio → validações/decisões → persistência/integrações → resposta/efeitos`

Leia o código e as dependências necessários para explicar o caminho, dentro do escopo autorizado, mesmo que atravessem módulos ou lotes. Não promova correspondência por nome, chamada candidata ou sinal lexical a comportamento implementado.

Considere as condições em conjunto, incluindo alternativas e exceções; preserve o alcance de filtros locais, como os de junções e CTEs/subconsultas. Uma condição auxiliar não deve ser apresentada como restrição global sem verificar seu efeito no resultado da operação.

## Dimensões a avaliar

Classifique cada dimensão como `analyzed`, `not_applicable` com justificativa curta, ou `pending`:

- `selection`: por que registros aparecem, desaparecem ou são agrupados;
- `mutation`: regras para criar, alterar, excluir, vincular ou enviar;
- `authorization`: identidade, perfil, permissão e restrição sobre dados;
- `state`: estados, transições e condições de transição;
- `calculation`: fórmulas, limites, arredondamentos e agregações;
- `variation`: diferenças por data, exercício, perfil, programa ou configuração;
- `failure`: erros, transações, repetição, concorrência e duplicidade;
- `persistence`: SQL, filtros, junções, `EXISTS`, `HAVING`, contagens, procedures e efeitos persistidos visíveis.

Listas compactas em `dimensions` evitam repetir oito blocos textuais em toda operação. Só documente regras que se aplicam; a classificação comprova que as demais dimensões foram consideradas.

## Regra comportamental

Uma regra precisa explicar:

- condição concreta;
- consequência observável;
- exceções ou variações;
- ao menos um cenário permitido e um bloqueado;
- se é implementação, inferência, intenção presumida ou desconhecida;
- evidência com arquivo relativo, linha inicial/final e SHA-256 do arquivo.

Regras compartilhadas recebem um único ID e podem ser referenciadas por várias operações. Comentários, nomes e documentação histórica ajudam a investigar, mas não provam implementação quando contradizem o código executável.

## Profundidade e revisão

- `identified`: entrada descoberta, análise ainda não iniciada;
- `analyzing`: rastreamento em andamento;
- `reviewed`: caminho e dimensões aplicáveis foram confrontados com as fontes;
- `blocked`: não há como avançar com as fontes e os limites autorizados.

Uma operação `reviewed` deve referenciar regras explicadas ou justificar por que não contém decisão de negócio. Resumo automático continua `identified` ou `analyzing` até revisão semântica.

Em revisões/revalidações de um mapeamento existente, o padrão é incremental: faça primeiro uma triagem dos registros do escopo solicitado e da vigência de suas evidências, usando hashes ou diffs disponíveis para identificar mudanças relevantes à operação. `reviewed` e `pending: []` não comprovam, por si só, que a explicação é suficiente.

Preserve análises que atendam aos critérios deste guia, tenham evidências vigentes e não apresentem indício de omissão ou contradição. Não releia suas fontes nem reescreva seus registros apenas para reconfirmá-los.

Na revisão incremental, volte ao código somente nas operações novas, ainda não analisadas ou afetadas por mudanças nas fontes/dependências, evidências ausentes/desatualizadas/não verificáveis, pendências ou explicações insuficientes/contraditórias. Isso também vale para registros `reviewed` com `pending: []` quando houver um desses motivos. Limite o aprofundamento às operações afetadas e às dependências necessárias; mantenha bloqueios registrados sem repetir a investigação se as fontes e os limites continuam iguais.

Na ausência desses motivos, só reconfira fontes de análises reaproveitáveis mediante pedido explícito, limitado ao recorte indicado. Uma revisão incremental não equivale a uma nova verificação integral das fontes.

Se a evidência continuar insuficiente, explicite a lacuna e limite a conclusão ao que está sustentado. Nas atualizações autorizadas, incorpore os complementos, evidências e pendências aos registros existentes, respeitando as políticas de escrita da etapa. Esse aprofundamento não inicia uma reextração global por conta própria.

## Lacunas e tentativas

Registre investigação apenas para uma lacuna concreta. Cada tentativa contém pergunta, abordagem, fontes consultadas, resultado e se trouxe evidência nova.

- `evidence_exhausted`: requer três abordagens relevantes e distintas sem nova evidência;
- `source_unavailable`: requer prova de que a fonte necessária não está disponível;
- `out_of_scope`: requer prova de que a ação necessária excede os limites autorizados.

Repetir a mesma busca, aguardar execução ou declarar genericamente que algo depende de runtime não conta como nova tentativa. Continue operações independentes enquanto uma estiver bloqueada.

## Conclusão

Use somente:

- `in_progress`: ainda existem operações a investigar;
- `reviewed_scope_complete`: todas as operações do escopo descoberto foram revisadas;
- `completed_with_caveats`: o usuário decidiu encerrar mesmo após receber operações pendentes/bloqueadas, causas e impactos.

Encerramento com ressalvas não promove lacunas a resolvidas. Antes de declarar o mapeamento concluído, execute `reversa validate-analysis --json` quando a CLI estiver disponível e corrija erros de integridade; avisos devem constar no relatório final.
