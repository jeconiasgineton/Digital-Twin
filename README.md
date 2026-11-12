# Digital Twin Logístico

Gêmeo digital 3D de operações logísticas: **chegada de veículos → docas → descarga → stage → conferência e triagem → armazenagem (direta ou faseada) → separação → expedição**.
Você descreve a operação (planilha Excel e/ou editor na tela, ou importa a planta) e o sistema:

1. **simula a operação em 3D** – empilhadeiras, paleteiras, transpaleteiras, AMR, operários, esteiras, docas, caminhões, racks e paletes, com rotas calculadas em torno de obstáculos;
2. **mede produtividade e capacidade** com estatística (Monte Carlo, IC 95%, percentis) e **teoria das filas**;
3. **dimensiona recursos e espaços** (empilhadeiras, conferentes, movimentadores, vagas de carga, docas, posições de palete, stage, ruas, triagem);
4. **aponta gargalos** (stage cheio, rua cheia, triagem lotada, fila de carga do AMR, docas) e o que fazer.

## Como usar

```bash
npm install
npm run dev                 # http://localhost:5173
npm test                    # testes (motor DES vs. Erlang C, processos, Excel, importação de planta…)
npm run build               # build de produção em dist/
npm run template            # regenera examples/exemplo-dimensionamento.xlsx
npm run template:completo   # regenera examples/exemplo-completo.xlsx (todos os processos ligados)
```

Fluxo típico:

1. **Importar Excel** (botão no topo ou arraste o `.xlsx`), **importar uma planta** (Layout → *Planta / desenho existente*) ou usar **Exemplo**. *Modelo .xlsx* baixa uma planilha preenchida com o cenário atual; há também `examples/exemplo-completo.xlsx`.
2. A simulação roda **ao vivo** em 3D (1× a 4000×, mapa de calor, vista 2D).
3. Edite **Layout** (ferramentas à esquerda) e **Dados** (equipamentos, veículos e chegadas, recebimento, armazenagem, intervalos, tempos) – tudo é recalculado.
4. **Resultados** → *Executar Monte Carlo*: KPIs com IC 95%, resultados por tipo de veículo, gráficos e diagnóstico. Exporta `.xlsx`.
5. **Dimensionar**: análise analítica instantânea (filas e espaços) e varreduras por simulação.

## Editor de layout

| Atalho | Ferramenta | | Atalho | Ferramenta |
|---|---|---|---|---|
| `V` | Selecionar/mover | | `A` | **Rua** (corredor, com código A, B…) |
| `K` | Rack (arraste = comprimento) | | `T` | **Endereço transitório** (dentro da rua) |
| `W` | Parede (clique por vértice; `Shift` trava 0°/90°) | | `G` | **Stage** do recebimento |
| `C` | Esteira | | `X` | **Triagem** |
| `I` / `O` | Doca de entrada / saída (encaixa na parede) | | `B` | **Carga AMR** |
| `Z` / `E` / `P` | Zona / Estação / Estacionamento | | | |

`R`/`Shift+R` giram ±90°, `Ctrl+D` duplica, `Del` exclui, `Ctrl+Z`/`Ctrl+Y` desfazem/refazem, setas movem.
Capacidade de stage, transitório e triagem (paletes) e vagas de carga são editáveis; vazio = calculada pela área (palete 1,2 × 1,0 m + 30% de folga). Triagens têm **prioridade de uso**. Em cada rack dá para fixar a **rua de cada face** (senão vale a mais próxima daquele lado).

### Importar planta

**Layout → Planta / desenho existente → Importar planta** (ou arraste o arquivo). O app lê o arquivo, mostra as **camadas** com o tipo sugerido pelo nome (`PAREDES`, `RACK`, `DOCA_SAIDA`, `Corredores`…), você confirma o que cada camada é, informa a escala e aplica. Há pré-visualização.

| Formato | Como é lido |
|---|---|
| **DXF** (ASCII) | `LINE`, `LWPOLYLINE`, `POLYLINE` e blocos (`INSERT`) por camada. Unidade detectada (`$INSUNITS`) ou escolhida. Arcos, círculos e textos são ignorados. |
| **PDF vetorial** | pdf.js, localmente: traços e preenchimentos agrupados por **cor**, com transformações; moldura da página descartada. Você informa a largura real do desenho. |
| **Imagem** (PNG/JPG…) | Reconhecimento local: linhas horizontais/verticais, blocos preenchidos e retângulos de contorno. Aproximado; revise no editor. |
| **DWG** | Não é lido (formato fechado): converta para DXF (AutoCAD, ODA File Converter, LibreCAD) ou exporte PDF vetorial. |

Docas encaixam na parede mais próxima abrindo para fora; ruas recebem códigos A, B, C… do norte para o sul. Depois de aplicar, a importação **não** se desfaz com Ctrl+Z (salve o layout em JSON antes se precisar). *Imagem de fundo* continua existindo para decalque manual.

## Planilha Excel

| Aba | Conteúdo |
|---|---|
| `Parametros` | turno, dias, aquecimento, réplicas, semente, metas (utilização, espera P95, nível de serviço), paletes por caminhão, linhas/caixas por pedido, elevação, ocupação inicial, endereçamento (`abc`/`proximo`/`aleatorio`), fator de demanda; **chegadas** (`chegada_entrada_modo` = `aleatorio`/`intervalo`/`agendado`, intervalo, horários, `atraso_*`); `limite_espera_doca_min`; **recebimento** (`dano_paletes_pct`, `dano_fracao_min/moda/max`, `dano_fator_conferencia`, `triagem_esvaziar_h`, `bau_profundidade`, `descarga_equipamentos`); **armazenagem** (`armazenagem_modo` = `direta`/`faseada`, `armazenagem_etapa1_equipamentos`); `amr_trabalha_intervalos`. |
| `Recursos` | `empilhadeira`, `paleteira_manual`, `transpaleteira`, `amr`, `operario`, `conferente`: quantidade, velocidades, disponibilidade, custo/h, capacidade (paletes e kg), eleva, operador; AMR: `Autonomia_min`, `Gatilho_carga`, `Carga_min`, `Setup_min`, carga no início/fim do turno e `Carga_horarios`. |
| `Veiculos` | tipos de veículo: participação, manobra/docagem (distribuição em s), paletes por veículo, comprimento do baú. Vazio = tipo único. |
| `Intervalos` | pausas: início, duração, grupos (`todos` ou `empilhadeira;operario;conferente;paleteira`) e escalonamento (`todos` / `metade` / `percentual`). |
| `Demanda` | 24 linhas (hora 0–23): caminhões de entrada/h, de saída/h, pedidos/h |
| `Operacoes` | tempos (s) como distribuição: `constante`, `triangular`, `normal`, `lognormal`, `exponencial`, `uniforme` – descarga, conferência, guarda, carga, separação, manobra, embalagem, **triagem por caixa** |
| `SKUs` | SKU, classe ABC, giro %, caixas/palete |
| `Layout` | tipo (`rack`, `doca_entrada`, `doca_saida`, `esteira`, `parede`, `zona`, `estacao`, `estacionamento`, `rua`, `endereco_transitorio`, `stage`, `triagem`, `carga_amr`), posição, rotação, dimensões, vãos, níveis, `Capacidade`, `Rua`, `Prioridade`, `Rua_frente`/`Rua_fundo` |

Números aceitam `1,5`, `85%`, `0,85`, `85`; horários aceitam `6,5`, `06:30`, `6h30`. Avisos de leitura aparecem após a importação. Padrões com fonte (AMR, transpaleteira, NIOSH 23 kg) aparecem na tela; valores sem dado público são marcados como **premissa**.

## Modelo da operação

**Chegadas e veículos.** Três modos por sentido: *aleatório* (Poisson por hora), *intervalo fixo* (a cada X min) e *agendado* (horários do dia), os dois últimos com probabilidade e duração de **atraso**. **Tipos de veículo** (carreta, truck…) têm tempo de docagem, paletes e comprimento de baú próprios; os resultados saem por tipo. O limite de espera na doca define o % de caminhões em “gargalo”.

**Calendário.** Jornada, horas úteis e não úteis; **intervalos** por grupo (empilhadeiristas, operários, conferentes, operadores de paleteira) com saída de todos juntos, metade por vez ou um percentual por vez, em ondas. Os AMR continuam ou não trabalhando nos intervalos (opção). A produtividade usa as horas úteis.

**Equipamentos** (catálogo): empilhadeira, paleteira manual, transpaleteira elétrica e AMR, com velocidade, capacidade, elevação, operador, disponibilidade e custo. O equipamento **disponível** entre os permitidos é acionado. **AMR**: bateria desgasta com o trabalho; à fração configurada da autonomia (padrão 1/2) termina a tarefa, vai à estação de carga, espera vaga, carrega e faz o setup; também carrega em horários do calendário.

**Recebimento.** Descarga pelo equipamento disponível, com a distância dentro do baú pelo comprimento do veículo → **stage com capacidade** (o palete reserva espaço antes de pegar equipamento) → **conferência** pelo conferente. **Avaria por palete** (padrão 3%): aumenta o tempo de conferência, e o mesmo conferente faz a **triagem**: move as caixas avariadas (fração configurável) para um segundo palete, tempo por caixa. Palete sem caixa boa vai inteiro. O palete de avarias é levado por paleteira/transpaleteira/AMR (ou empilhadeira) à **área de triagem** de maior prioridade com espaço; ao lotar, vai para a próxima; as áreas são esvaziadas periodicamente.

**Armazenagem.** Cada posição de palete tem **endereço** (rua + estante + nível, ex.: `A015`, único no galpão) e estado (livre/reservada/ocupada). Modo global: **direta** (empilhadeira do stage ao endereço, com elevação) ou **faseada** (etapa 1 por equipamento sem elevação até o endereço transitório da rua do destino, esperando se a rua estiver cheia; etapa 2 pela empilhadeira, que recebe o destino final). Endereçamento por curva ABC, mais próximo ou aleatório.

**Separação e expedição.** Pedidos por Poisson; operário roteiriza as linhas (vizinho mais próximo), deposita na esteira (gargalo = headway), consolidação em estações; expedição por caminhões de saída.

**Simulação (DES)** – kernel de eventos discretos com processos em geradores (`src/sim/engine.ts`), validado contra Erlang C. Navegação por grade de ocupação com Dijkstra/A* e rotas suavizadas; despacho FIFO com recurso ocioso mais próximo; falhas por MTBF exponencial e reparo médio de 30 min; intervalos e cargas se encadeiam com as falhas; réplicas com fluxos aleatórios separados (CRN nas varreduras); média, desvio, IC 95% (t de Student), P50/P90/P95.

**Análise analítica** (`src/analysis/capacity.ts`) – Erlang B/C, Allen–Cunneen para G/G/c, chegadas em lote (IDC), Little (L=λ·W) e M/G/∞. Estende-se aos novos processos como **estimativa** (indicada em cada linha): conferentes (tempo por palete amostrado das mesmas distribuições, com avaria), movimentadores (etapa 1, avarias, descarga), **stage, transitórios e triagem** (Little com folga de lote e pior caso de caminhões simultâneos), **vagas de carga do AMR** (binomial, com o tempo em carga descontado da disponibilidade) e o efeito do baú e da armazenagem faseada na tarefa da empilhadeira. Nos testes, as utilizações analíticas ficam a menos de ~0,15 das simuladas e os picos de stage/transitórios na mesma ordem de grandeza (a estimativa de pico tende a ficar abaixo do simulado).

## Estrutura

```
src/
  model/    tipos, cenário padrão, gerador de galpão, equipamentos, tráfego/calendário, recebimento, áreas
  math/     RNG/distribuições, estatística, filas, navegação (A*/Dijkstra)
  sim/      motor DES, mundo espacial, processos logísticos, Monte Carlo, worker
  analysis/ capacidade/dimensionamento analítico, diagnóstico
  io/       Excel (exceljs), importação de planta (DXF, PDF, imagem)
  view/     cena Three.js, entidades 3D, reprodução ao vivo
  ui/       editor, painéis, gráficos SVG, janela de importação
tests/      vitest
scripts/    modelos de planilha, benchmarks
```

## Limitações conhecidas

- Colisões/bloqueio entre veículos em corredores estreitos não são modelados (apenas distância e velocidade); a largura da rua não limita o tráfego. Use o mapa de calor.
- A conferência (e, portanto, a detecção e a triagem de avarias) só ocorre com conferentes (quantidade > 0).
- AMR: a bateria desgasta com o tempo de trabalho (não distingue vazio/carregado); no 3D, AMR, paleteiras e transpaleteiras aparecem com o desenho de operário, e os tipos de veículo com o mesmo desenho de caminhão.
- Armazenagem faseada: a análise analítica trata os transitórios em conjunto (sem desequilíbrio entre ruas); a regra ABC escolhe o rack e sorteia a posição dentro dele.
- Reabastecimento de faces de picking não é simulado (a face é considerada sempre abastecida).
- Tempo de simulação é “operacional” (horas fora do turno são comprimidas); backlog atravessa os dias.
- Importação de planta: DXF somente ASCII; imagem reconhece só linhas horizontais/verticais (sem diagonais ou curvas); PDF escaneado não é vetorial; DWG precisa ser convertido.
- Padrões de equipamento sem dado público (setup do AMR, paleteira manual, custos) e do recebimento (3% de avaria, +50% no tempo, 8 s por caixa) são **premissas** editáveis.
