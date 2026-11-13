# Digital Twin Logístico

Gêmeo digital 3D de operações logísticas: **chegada de veículos → docas → descarga → stage → conferência e triagem → armazenagem (direta ou faseada) → separação → expedição**.
Você descreve a operação (planilha Excel e/ou editor na tela, ou importa a planta) e o sistema:

1. **simula a operação em 3D** – empilhadeiras, paleteiras, transpaleteiras, AMR, operários, esteiras, docas, caminhões, racks e paletes, com rotas calculadas em torno de obstáculos;
2. **mede produtividade e capacidade** com estatística (Monte Carlo, IC 95%, percentis) e **teoria das filas**;
3. **dimensiona recursos e espaços** (empilhadeiras, conferentes, movimentadores, vagas de carga, docas, posições de palete, stage, ruas, triagem);
4. **monta processos com ações genéricas** (movimentar, elevar, recuperar, conferir, separar…) num editor visual de blocos e setas;
5. **aponta gargalos** (stage cheio, rua cheia, triagem lotada, fila de carga do AMR, docas) e o que fazer.

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
   No 3D cada equipamento e veículo tem o seu desenho: empilhadeira, **paleteira manual** (com o operário caminhando atrás), **transpaleteira elétrica** (bateria e timão de comando), **AMR** (plataforma baixa com LED e sensor, que ergue o palete) e, pelo comprimento do baú, **carreta** (cavalo + semirreboque), **truque**, **toco**, **VUC** e **picape**, com o nome do tipo sobre o veículo.
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

## Processos personalizados (ações genéricas)

Em vez de ações "de recebimento" ou "de triagem", o app tem **ações genéricas** que o usuário combina. Na aba **Processos**, *Editar* abre o **editor de blocos e setas** (arraste blocos; arraste da bolinha de saída até outro bloco para ligar; `Delete` remove bloco ou seta; roda do mouse dá zoom).

| Ação | O que faz | Exemplos de uso |
|---|---|---|
| **Movimentar** | Leva o item (palete, caixa ou fardo) de um local a outro com os recursos escolhidos (o disponível é acionado) | descarga (veículo → stage), levar à triagem, etapa 1 da faseada |
| **Elevar** | Leva o palete à posição do endereço e o eleva (ou retira) | guardar no nível do rack |
| **Recuperar** | Retira caixas/fardos do item atual (todas, N ou fração) e cria um novo item | pegar caixas de um palete |
| **Paletizar / Despaletizar** | Converte entre palete e caixas/fardos (tempo por item) | montar/desmontar paletes |
| **Separar** | Divide o palete: o bom segue, o avariado vai para um segundo palete | triagem |
| **Conferir** | Tempo de conferência e chance de avaria (que aumenta o tempo) | conferência |
| **Decidir** | Escolhe o caminho (avariado, todo avariado, sorteio, quantidade) | desvios |
| **Endereçar** | Define rua + estante + nível pela regra de armazenagem | destino da guarda |
| **Aguardar** | Espera um tempo | |

Locais: dentro do veículo, doca, stage, rua (endereço transitório), triagem, endereço no rack, qualquer área do layout ou "onde está agora". Stage, rua e triagem têm capacidade: o item reserva espaço antes de pegar recurso e espera se estiver cheio. Há **modelos prontos** (recebimento direto; com conferência e triagem; faseado) já preenchidos com a configuração atual, e a aba **Processos** da planilha guarda os blocos.

Com *Usar os processos personalizados* ativo, vale o **primeiro processo da lista de cada tipo**, no lugar do fluxo padrão; tipos sem processo seguem o padrão. Os quatro tipos de processo:

| Tipo | Dispara em | Blocos próprios |
| --- | --- | --- |
| Recebimento | cada palete que sai do veículo | movimentar, elevar, conferir, separar avariados, endereçar… |
| Separação por palete | cada pedido | **Percorrer rota de separação** (rota em U/zigue-zague, separadores por pedido, caixas por pedido, limite de palete, curvas ABC, leitura/pegar/colocar, furos de estoque) |
| Palete full | cada palete de um pedido full | endereçar (retirar), elevar (retirar), movimentar até o **Stage de expedição** (direto ou via rua + equipamento sem elevação) |
| Expedição | cada caminhão de saída | **Formar a carga**, **Tarefa de pessoa** (conferir cada palete, batimento com divergência, customizar uma parte dos paletes, registrar, lacrar…), **Embarcar** |

Modelos prontos reproduzem os formatos padrão (os resultados da separação em blocos são idênticos aos do padrão com a mesma semente). Processos de separação/palete full entregam ao stage de expedição, então o caminhão passa a carregar a partir do stage. Na expedição em blocos a conferência é sempre "depois da carga formada" (a simultânea do formato padrão não existe em blocos). A análise analítica continua modelando o fluxo padrão (aviso na aba Dimensionar); a planilha `Processos` guarda o tipo (`Gatilho`) e os parâmetros de cada bloco.

## Planilha Excel

| Aba | Conteúdo |
|---|---|
| `Parametros` | turno, dias, aquecimento, réplicas, semente, metas (utilização, espera P95, nível de serviço), paletes por caminhão, linhas/caixas por pedido, elevação, ocupação inicial, endereçamento (`abc`/`proximo`/`aleatorio`), fator de demanda; **chegadas** (`chegada_entrada_modo` = `aleatorio`/`intervalo`/`agendado`, intervalo, horários, `atraso_*`); `limite_espera_doca_min`; **recebimento** (`dano_paletes_pct`, `dano_fracao_min/moda/max`, `dano_fator_conferencia`, `triagem_esvaziar_h`, `bau_profundidade`, `descarga_equipamentos`); **armazenagem** (`armazenagem_modo` = `direta`/`faseada`, `armazenagem_etapa1_equipamentos`); `amr_trabalha_intervalos`; **separação** (`separacao_modo`, `pedido_caixas_*`, `curva_a/b/c_pct`, `palete_limite_*`, `rota_separacao`, `separadores_por_pedido`, `furo_*`, `picking_area_*`, `palete_full_*`, `expedicao_*`, `veiculo_exclusivo`). |
| `Recursos` | `empilhadeira`, `paleteira_manual`, `transpaleteira`, `amr`, `operario`, `conferente`: quantidade, velocidades, disponibilidade, custo/h, capacidade (paletes e kg), eleva, operador; AMR: `Autonomia_min`, `Gatilho_carga`, `Carga_min`, `Setup_min`, carga no início/fim do turno e `Carga_horarios`. |
| `Expedicao` | etapas da expedição (uma linha por etapa; `Parametros` em JSON; `expedicao_modo` e `expedicao_paletes_por_carga` em `Parametros`) |
| `Processos` | processos personalizados: uma linha por bloco (`Saidas` e `Parametros` em JSON; edite de preferência no editor visual); `processos_personalizados` em `Parametros` liga o uso |
| `Veiculos` | tipos de veículo: participação (geral, no recebimento e na expedição), manobra/docagem (distribuição em s), capacidade em paletes, média e desvio de paletes por veículo, comprimento do baú. Aba vazia = um caminhão genérico. |
| `Intervalos` | pausas: início, duração, grupos (`todos` ou `empilhadeira;operario;conferente;paleteira`) e escalonamento (`todos` / `metade` / `percentual`). |
| `Demanda` | 24 linhas (hora 0–23): caminhões de entrada/h, de saída/h, pedidos/h |
| `Operacoes` | tempos (s) como distribuição: `constante`, `triangular`, `normal`, `lognormal`, `exponencial`, `uniforme` – descarga, conferência, guarda, carga, separação, manobra, embalagem, **triagem por caixa** |
| `SKUs` | SKU, classe ABC, giro %, caixas/palete |
| `Layout` | tipo (`rack`, `doca_entrada`, `doca_saida`, `esteira`, `parede`, `zona`, `estacao`, `estacionamento`, `rua`, `endereco_transitorio`, `stage`, `triagem`, `carga_amr`), posição, rotação, dimensões, vãos, níveis, `Capacidade`, `Rua`, `Prioridade`, `Rua_frente`/`Rua_fundo` |

Números aceitam `1,5`, `85%`, `0,85`, `85`; horários aceitam `6,5`, `06:30`, `6h30`. Avisos de leitura aparecem após a importação. Padrões com fonte (AMR, transpaleteira, NIOSH 23 kg) aparecem na tela; valores sem dado público são marcados como **premissa**.

## Modelo da operação

**Chegadas e veículos.** Três modos por sentido: *aleatório* (Poisson por hora), *intervalo fixo* (a cada X min) e *agendado* (horários do dia), os dois últimos com probabilidade e duração de **atraso**. **Tipos de veículo**: o cenário já traz o catálogo **carreta (28 paletes), truque (16), toco (12), VUC ¾ (6) e picape (1)**, com tamanho do baú, capacidade em paletes, tempo de docagem e participação **própria em cada sentido** (recebimento e expedição). O usuário edita os tipos conhecidos e **cadastra novos** ("+ Novo veículo") com nome, baú e capacidade, ou restaura o catálogo. No recebimento o veículo traz uma média de paletes limitada pela capacidade; na expedição por etapas a carga é a capacidade × a ocupação definida. O comprimento do baú define a profundidade de trabalho (fileiras de 2 paletes PBR a cada 1 m) nos dois sentidos; o app avisa se a capacidade não cabe no baú. Fontes: capacidade da carreta (28) definida no projeto; toco 12, truque 16 e ¾ 6 de tabelas de lotação de transportadoras (baixa autoridade); baús, picape e participações são premissas. Os resultados saem por tipo, nos dois sentidos. O limite de espera na doca define o % de caminhões em “gargalo”.

**Calendário.** Jornada, horas úteis e não úteis; **intervalos** por grupo (empilhadeiristas, operários, conferentes, operadores de paleteira) com saída de todos juntos, metade por vez ou um percentual por vez, em ondas. Os AMR continuam ou não trabalhando nos intervalos (opção). A produtividade usa as horas úteis.

**Equipamentos** (catálogo): empilhadeira, paleteira manual, transpaleteira elétrica e AMR, com velocidade, capacidade, elevação, operador, disponibilidade e custo. O equipamento **disponível** entre os permitidos é acionado. **AMR**: bateria desgasta com o trabalho; à fração configurada da autonomia (padrão 1/2) termina a tarefa, vai à estação de carga, espera vaga, carrega e faz o setup; também carrega em horários do calendário.

**Recebimento.** Descarga pelo equipamento disponível, com a distância dentro do baú pelo comprimento do veículo → **stage com capacidade** (o palete reserva espaço antes de pegar equipamento) → **conferência** pelo conferente. **Avaria por palete** (padrão 3%): aumenta o tempo de conferência, e o mesmo conferente faz a **triagem**: move as caixas avariadas (fração configurável) para um segundo palete, tempo por caixa. Palete sem caixa boa vai inteiro. O palete de avarias é levado por paleteira/transpaleteira/AMR (ou empilhadeira) à **área de triagem** de maior prioridade com espaço; ao lotar, vai para a próxima; as áreas são esvaziadas periodicamente.

**Armazenagem.** Cada posição de palete tem **endereço** (rua + estante + nível, ex.: `A015`, único no galpão) e estado (livre/reservada/ocupada). Modo global: **direta** (empilhadeira do stage ao endereço, com elevação) ou **faseada** (etapa 1 por equipamento sem elevação até o endereço transitório da rua do destino, esperando se a rua estiver cheia; etapa 2 pela empilhadeira, que recebe o destino final). Endereçamento por curva ABC, mais próximo ou aleatório.

**Separação.** Dois modos. *Padrão antigo*: pedidos por Poisson; operário roteiriza as linhas (vizinho mais próximo), deposita na esteira (gargalo = headway) e consolida em estações. *Picking por palete*: o usuário define as **caixas por pedido** (média/desvio) e o **percentual das curvas A, B e C**; cada pedido vira paradas nos endereços de picking, na zona da curva sorteada. A **área de picking** é, por padrão, todos os endereços próximos ao chão (nível 1, ou os N níveis que você definir, formato `A011`), com opção de só as faces de picking marcadas ou de uma **lista de posições específicas**; as curvas A/B/C dividem a área por proximidade das docas (20/30/50%). O separador **lê o código do endereço, pega a caixa e a coloca no palete** (tempos editáveis; padrão de ~10 s por caixa, premissa a partir de referências públicas) e, ao atingir o **limite do palete** (média/desvio), leva-o ao **stage de expedição**. **Rota** em *U* (um lado da rua na ida, o outro na volta, ruas da mais próxima à mais distante) ou *zigue-zague* (parada mais próxima, qualquer lado); o app mede o **tempo da 1ª à última caixa de cada palete** e calcula o tempo médio de rota **dos dois formatos sobre os mesmos pedidos**. **Furos de estoque**: percentual das visitas ou lista de endereços vazios, com tempo perdido até a reposição. **Vários separadores** por pedido (dividido por ruas). A produtividade sai em **caixas por hora trabalhada** do separador. **Expedição por etapas.** Três formatos: *básico* (como antes), *padrão* (bloco pronto) e *etapas configuráveis*. Uma **carga** é a quantidade de paletes por caminhão definida pelo usuário (ex.: 28). Etapas, nesta ordem no padrão: **conferir** a separação (simultânea enquanto a separação acontece, se houver conferente livre, ou posterior; palete full com tempo fixo e palete de picking com tempo por caixa) → **batimento** (pedido × separado; sempre bate, com opção de % de cargas com divergência e tempo de correção) → **customizar** (% de paletes de picking em cada carga e tempo por palete, por operários no stage; o embarque só começa depois) → **embarcar** (equipamentos escolhidos; do stage ao interior do veículo pela distância e pelo comprimento do baú, do fundo para a porta) → **registrar** (documental e sistêmico, pelo conferente) → **lacrar** o baú (conferente; o motorista pode ou não acompanhar, sem efeito no tempo) → veículo liberado. No formato de etapas o usuário ativa, desativa, reordena, acrescenta e remove etapas (há uma tarefa livre) e o app valida a ordem. Os tempos padrão são premissas (não há dado público separado para registro e lacre).

**Regras de veículo (recebimento e expedição).** Dentro de cada veículo só um equipamento, ou um operário com paleteira, trabalha por vez; o próximo já se aproxima enquanto o atual está dentro (sem fila de equipamentos ociosos na porta). A paleteira manual é uma unidade **mais um operário do pool de operários**. O trecho do stage ao interior do veículo usa a distância e o comprimento do baú nos dois sentidos.

**Palete full**: pedidos por quantidade de paletes (média/desvio) e percentual das curvas A/B/C; a empilhadeira retira o palete inteiro do endereço e o leva ao **stage de expedição** (*direta*) ou o baixa na rua e uma paleteira/transpaleteira/AMR o leva ao stage (*faseada*). **Expedição**: o caminhão carrega direto do rack (padrão) ou **do stage de expedição**, esperando os paletes separados (picking e palete full); a capacidade do stage limita os paletes que aguardam e freia a separação.

**Simulação (DES)** – kernel de eventos discretos com processos em geradores (`src/sim/engine.ts`), validado contra Erlang C. Navegação por grade de ocupação com Dijkstra/A* e rotas suavizadas; despacho FIFO com recurso ocioso mais próximo; falhas por MTBF exponencial e reparo médio de 30 min; intervalos e cargas se encadeiam com as falhas; réplicas com fluxos aleatórios separados (CRN nas varreduras); média, desvio, IC 95% (t de Student), P50/P90/P95.

**Análise analítica** (`src/analysis/capacity.ts`) – Erlang B/C, Allen–Cunneen para G/G/c, chegadas em lote (IDC), Little (L=λ·W) e M/G/∞. Estende-se aos novos processos como **estimativa** (indicada em cada linha): conferentes (tempo por palete amostrado das mesmas distribuições, com avaria), movimentadores (etapa 1, avarias, descarga), **stage, transitórios e triagem** (Little com folga de lote e pior caso de caminhões simultâneos), **vagas de carga do AMR** (binomial, com o tempo em carga descontado da disponibilidade) e o efeito do baú e da armazenagem faseada na tarefa da empilhadeira. Também cobre **separação por palete** (amostra de 40 pedidos com semente fixa, rota em U × zigue-zague, viagens de palete cheio ao stage, furos de estoque, separadores por pedido), **palete full** (empilhadeira e, na faseada, o equipamento de etapa 1), **carga a partir do stage** e **expedição por etapas**: tempo da carga na doca de saída (espera pela separação, conferência posterior, batimento, customização, embarque e registro/lacre), conferentes e operários necessários (mistura das tarefas de recebimento, separação e expedição), balanço oferta × demanda de paletes no stage (`Separação × carga de saída`) e capacidade do stage de expedição (Little + lote por carga em andamento). Nos testes, as utilizações analíticas ficam a menos de ~0,15 das simuladas e os picos de stage/transitórios na mesma ordem de grandeza (a estimativa de pico tende a ficar abaixo do simulado).

## Estrutura

```
src/
  model/    tipos, cenário padrão, gerador de galpão, equipamentos, tráfego/calendário, recebimento, áreas
  math/     RNG/distribuições, estatística, filas, navegação (A*/Dijkstra)
  sim/      motor DES, mundo espacial, processos logísticos, intérprete dos processos personalizados (workflow), Monte Carlo, worker
  analysis/ capacidade/dimensionamento analítico, diagnóstico
  io/       Excel (exceljs), importação de planta (DXF, PDF, imagem)
  view/     cena Three.js, entidades 3D, reprodução ao vivo
  ui/       editor, painéis, gráficos SVG, janela de importação
tests/      vitest
scripts/    modelos de planilha, benchmarks
```

## Limitações conhecidas

- Colisões/bloqueio entre veículos em corredores estreitos não são modelados (apenas distância e velocidade); a largura da rua não limita o tráfego. Use o mapa de calor.
- Processos personalizados: só o gatilho "palete que sai do veículo de recebimento" (recebimento e armazenagem); o editor não tem desfazer; os tipos de veículo e os locais são os do layout.
- A conferência (e, portanto, a detecção e a triagem de avarias) só ocorre com conferentes (quantidade > 0).
- AMR: a bateria desgasta com o tempo de trabalho (não distingue vazio/carregado).
- Armazenagem faseada: a análise analítica trata os transitórios em conjunto (sem desequilíbrio entre ruas); a regra ABC escolhe o rack e sorteia a posição dentro dele.
- Separação por palete: o furo de estoque é um tempo de espera (a reposição em si não é simulada por empilhadeira); as caixas do pedido não são ligadas a SKUs reais (só à curva A/B/C); com a carga a partir do rack (padrão) os paletes separados só se acumulam no stage de expedição. No modo antigo a face é considerada sempre abastecida.
- Tempo de simulação é “operacional” (horas fora do turno são comprimidas); backlog atravessa os dias.
- Importação de planta: DXF somente ASCII; imagem reconhece só linhas horizontais/verticais (sem diagonais ou curvas); PDF escaneado não é vetorial; DWG precisa ser convertido.
- Padrões de equipamento sem dado público (setup do AMR, paleteira manual, custos) e do recebimento (3% de avaria, +50% no tempo, 8 s por caixa) são **premissas** editáveis.
