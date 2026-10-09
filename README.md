# Digital Twin Logístico

Gêmeo digital 3D para operações logísticas (recebimento → armazenagem → separação → expedição).
Você alimenta o sistema com uma **planilha Excel de dimensionamento** (e, opcionalmente, o layout da planta) e ele:

1. **traduz a planilha em uma simulação realística em 3D** – empilhadeiras, operários, esteiras, docas, caminhões, estruturas porta-paletes e paletes, com rotas calculadas em torno de obstáculos;
2. **permite criar/editar o layout** dentro da ferramenta (desenhar paredes, racks, docas, esteiras, zonas…), ou **importar a planta** (imagem de fundo calibrável ou DXF);
3. **calcula a produtividade e a capacidade operacional** com estatística (Monte Carlo, IC 95%, percentis) e **teoria das filas**;
4. **dimensiona recursos** (nº de empilhadeiras, operários, docas, posições de palete) para cumprir metas de utilização e de espera.

## Como usar

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # testes (motor DES vs. Erlang C, Excel, DXF, simulação…)
npm run build      # build de produção em dist/
npm run template   # regenera examples/exemplo-dimensionamento.xlsx
```

Fluxo típico:

1. **Importar Excel** (botão no topo, ou arraste o `.xlsx` para a tela). Use **Modelo .xlsx** para baixar uma planilha preenchida com o cenário atual (há também `examples/exemplo-dimensionamento.xlsx`).
2. A simulação roda **ao vivo** em 3D (play/pause, 1× a 4000×, mapa de calor de tráfego, vista 2D de planta).
3. Edite o layout (aba **Layout** + barra de ferramentas à esquerda) – tudo é recalculado automaticamente.
4. Aba **Resultados** → *Executar Monte Carlo*: N réplicas independentes, KPIs com IC 95%, gráficos e diagnóstico de gargalos. Exporta `.xlsx`.
5. Aba **Dimensionar**: tabela analítica instantânea (filas), capacidade de armazenagem e varreduras por simulação (nº de empilhadeiras/operários, sensibilidade da demanda).

### Editor de layout

| Atalho | Ferramenta | | Atalho | Ação |
|---|---|---|---|---|
| `V` | Selecionar/mover | | `R` / `Shift+R` | girar ±90° |
| `K` | Rack (arraste = comprimento) | | `Ctrl+D` | duplicar |
| `W` | Parede (clique por vértice; duplo-clique/Enter termina; `Shift` trava 0°/90°) | | `Del` | excluir |
| `C` | Esteira (arraste) | | `Ctrl+Z` / `Ctrl+Y` | desfazer / refazer |
| `I` / `O` | Doca de entrada / saída (encaixa na parede mais próxima e se orienta sozinha) | | setas | mover (Shift = 5 m) |
| `Z` / `E` / `P` | Zona / Estação / Estacionamento | | | |

Planta existente: **Layout → Planta / desenho existente** → *Imagem de fundo* (calibre a escala informando a largura real em metros e trace as paredes por cima) ou *Importar DXF* (LINE, LWPOLYLINE, POLYLINE → paredes; unidade detectada por `$INSUNITS`). Layouts salvam/abrem em JSON.

## Planilha Excel

| Aba | Conteúdo |
|---|---|
| `Parametros` | chave/valor: turno, dias simulados, aquecimento, réplicas, semente, metas (utilização, espera P95, nível de serviço), paletes por caminhão (média/desvio/máx), linhas por pedido, caixas por linha, elevação, ocupação inicial, permanência, política de endereçamento (`abc`/`proximo`/`aleatorio`), fator de demanda. Se não houver aba `Layout`, o galpão é gerado por `docas_entrada`, `docas_saida`, `fileiras_rack`, `vaos_por_fileira`, `niveis`, `esteiras`, `estacoes`. |
| `Recursos` | `empilhadeira` / `operario` / `conferente`: quantidade, velocidades (vazio/carregado, m/s), disponibilidade, custo/h |
| `Demanda` | 24 linhas (hora 0–23): caminhões de entrada/h, caminhões de saída/h, pedidos/h |
| `Operacoes` | tempos (s) como distribuição: `constante`, `triangular(mín,moda,máx)`, `normal`, `lognormal`, `exponencial`, `uniforme` – descarga, conferência, guarda, carga, separação de caixa, manobra de doca, embalagem |
| `SKUs` | SKU, classe ABC, giro %, caixas/palete |
| `Layout` (opcional) | tipo (`rack`, `doca_entrada`, `doca_saida`, `esteira`, `parede`, `zona`, `estacao`, `estacionamento`), nome, X, Z, rotação, comprimento, largura, vãos, níveis, fileiras, picking, velocidade |

Números aceitam `1,5`, `85%`, `0,85` ou `85` (frações). Avisos de leitura são exibidos após a importação.

## Modelo matemático

**Simulação (DES)** – kernel de eventos discretos com processos em geradores (`src/sim/engine.ts`), validado contra Erlang C em teste.
- *Chegadas*: Poisson não homogêneo (taxa por hora do dia) para caminhões e pedidos; paletes por caminhão ~ normal truncada (chegadas em lote = Poisson composto).
- *Tempos de serviço*: distribuições paramétricas da planilha; elevação do garfo proporcional ao nível; deslocamento com aceleração constante (`d/v + v/a`).
- *Navegação*: grade de ocupação (racks/paredes bloqueiam), Dijkstra a partir de pontos‑chave (docas, indução) e A* com cache para os demais pares; rotas suavizadas (string-pulling) usadas na animação.
- *Despacho*: FIFO entre solicitantes; empilhadeira/operário **ocioso mais próximo** da tarefa.
- *Falhas*: disponibilidade → MTBF exponencial e MTTR médio de 30 min por recurso (parada após a tarefa em curso).
- *Endereçamento*: curva ABC (A nas posições mais próximas das docas), mais próxima ou aleatória; rupturas e falta de posições são contabilizadas.
- *Picking*: operário roteiriza as linhas (vizinho mais próximo), deposita na esteira (gargalo = headway `espaçamento/velocidade`), consolidação em estações.
- *Estatística*: warm‑up descartado; N réplicas com sementes independentes e fluxos aleatórios separados (CRN nas varreduras); média, desvio, IC 95% (t de Student), P50/P90/P95.

**Análise analítica** (`src/analysis/capacity.ts`, `src/math/queueing.ts`)
- Erlang B/C; M/G/c e G/G/c por **Allen–Cunneen**: `Wq ≈ C(c,a)/(cμ−λ)·(ca²+cs²)/2`, cauda `P(Wq>t) ≈ C·exp(−2(cμ−λ)t/(ca²+cs²))`.
- Chegadas de paletes em lote: índice de dispersão `IDC = E[B²]/E[B]`.
- Dimensionamento: menor `c` com `ρ ≤ meta` **e** `P(Wq>t) ≤ 1−nível de serviço`, para demanda média e de pico, com disponibilidade (`λ/A`).
- Armazenagem: **Lei de Little** (`L=λ·W`), **M/G/∞** (Poisson) para `P(estouro de posições)`, estoque de segurança `z·σ·√L`, saldo diário e dias até lotar.

## Estrutura

```
src/
  model/    tipos, cenário padrão, gerador de galpão
  math/     RNG/distribuições, estatística, filas, navegação (A*/Dijkstra)
  sim/      motor DES, mundo espacial, processos logísticos, Monte Carlo, worker
  analysis/ capacidade/dimensionamento analítico, diagnóstico
  io/       Excel (exceljs), DXF
  view/     cena Three.js, entidades 3D, reprodução ao vivo
  ui/       editor, painéis, gráficos SVG
tests/      vitest
```

## Limitações conhecidas

- Colisões/bloqueio entre empilhadeiras em corredores estreitos não são modelados (apenas distância e velocidade); use o mapa de calor para identificar congestionamento.
- Reabastecimento de faces de picking não é simulado (a face é considerada sempre abastecida).
- Tempo de simulação é “operacional” (horas fora do turno são comprimidas); backlog atravessa os dias.
- DXF: somente ASCII com LINE/LWPOLYLINE/POLYLINE (arcos e blocos são ignorados).
