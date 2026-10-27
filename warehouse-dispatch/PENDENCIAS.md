# Pendências do projeto Warehouse Dispatch

Organizadas por fase do roadmap. Cada item diz de quem depende e o que desbloqueia,
para tratarmos um a um.

Legenda de dono:
- **Cliente**: dado ou decisão que só o cliente piloto pode fornecer.
- **Você**: decisão de produto, negócio ou jurídico.
- **Dev**: decisão técnica que posso tomar depois de ter o insumo indicado.

## Fase 0 · Preparação com o cliente piloto (após a definição do cliente)

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| 0.1 | Mapa real da zona-piloto: scan codes, corredores e distâncias medidas | Cliente | Ajustar `config/layout.example.json` para o layout real e validar o grafo |
| 0.2 | Lista de operadores, matrículas e habilitações NR-11 de empilhadeira, com validade | Cliente | Carga inicial de operadores, sem cadastro manual |
| 0.3 | Lista de equipamentos com identificação e tipo (transpaleteira ou empilhadeira) | Cliente | Carga inicial de equipamentos |
| 0.4 | Medição de linha de base: uma semana de tempo de resposta na zona, sem o sistema | Cliente + Dev | Comparação antes e depois para o KPI do piloto |
| 0.5 | Regras de prioridade (escala 1 a 5) e desempate, com os supervisores | Cliente + Você | Parametrizar a prioridade vinda do WMS |
| 0.6 | Motivos de recusa válidos, validados com a operação | Cliente | Ajustar o enum `RejectReason` |
| 0.7 | Tempo de expiração da oferta (hoje 20 s) validado em campo | Cliente + Dev | Ajustar `offer_timeout_seconds` |
| 0.8 | Política de envelhecimento: tarefa de prioridade baixa pode esperar indefinidamente? | Você | Implementar aging no despacho, se necessário |
| 0.9 | Política de dados de pessoas: quanto tempo guardar eventos, quem vê o quê | Você + Jurídico | Retenção e perfis de acesso (ver 2.4) |
| 0.10 | Qualidade do Wi-Fi nos corredores e nas câmaras, se houver | Cliente | Testes de sincronização offline em campo |

## Fase 1 · Piloto de reposição (software construído)

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| 1.1 | Teste em campo com coletor real ou tablet, incluindo queda de conexão | Cliente + Dev | Validar a fila offline de ponta a ponta |
| 1.2 | Ajuste da política de recusa: quais motivos bloqueiam o operador por um período | Você + Cliente | Regra de recusa aplicada pelo supervisor |

## Fase 2 · Integração e validação

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| 2.1 | Fornecedor do WMS do cliente e formato de integração (API, fila ou planilha) | Cliente | Adaptador específico para o WMS. Hoje há entrada genérica em `POST /integrations/tasks` |
| 2.2 | Campos de tarefa do WMS e mapeamento para o modelo (zona, equipamento, prioridade) | Cliente + Dev | Tradução de códigos do WMS para zonas e tipos do sistema |
| 2.3 | Confirmação de quais eventos o WMS precisa receber, e em que formato | Cliente + Dev | Consumo do feed `GET /integrations/events` pelo WMS, com cursor |
| 2.4 | Autenticação de operador (matrícula com PIN, crachá QR ou SSO) | Você | Substituir a ausência de login nos endpoints de operador |
| 2.5 | Perfis de supervisor e acesso aos painéis (hoje o painel usa o token administrativo) | Você | Login de supervisor com permissões |
| 2.6 | Visão de supervisor por equipe e zona com identificação individual só quando necessário | Você + Jurídico | Confirmar que a visão agregada atende a operação |
| 2.7 | Substituir o token compartilhado por credenciais por cliente e rotação | Dev | Segurança de integração em produção |
| 2.8 | Persistência atual é um snapshot em SQLite. Migrar para tabelas quando o volume justificar | Dev | Escala e consultas históricas |
| 2.9 | Hospedagem e região de dados (nuvem escolhida pelo cliente) | Cliente + Você | Deploy e contrato de dados |

## Fase 3 · Inteligência do despacho

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| 3.1 | Batching: pegar vários pallets no mesmo corredor, ou rebocador com várias paradas | Dev (depois de dados do piloto) | Redução de deslocamento vazio. Precisa de volume e layout reais para validar ganho |
| 3.2 | Otimização em janelas de 10 a 30 s, com otimização global além do guloso atual | Dev | Melhor atribuição em pico |
| 3.3 | Realocação de equipamentos antes do pico, a partir da previsão de demanda | Dev + Cliente | Requer histórico de demanda por onda |
| 3.4 | Incentivo por equipe (bônus ou PLR) e regra de incentivo | Você + Cliente + Sindicato | Parametrização de incentivo sem gerar pressa perigosa |

## Fase 4 · Localização avançada e ecossistema

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| 4.1 | Odometria e telemetria das empilhadeiras: fabricante e protocolo | Cliente | Localização contínua entre scans. Hoje o piloto não tem |
| 4.2 | Decisão sobre beacons BLE: custo e precisão necessária | Você + Cliente | Localização de metros em toda a área |
| 4.3 | Contrato de executor (humano, empilhadeira, AMR) com o projeto de AMR | Você + equipe AMR | Integrar AMR como novo tipo de recurso sem reescrever o despacho |
| 4.4 | Integração com o digital twin | Futuro | Fora do escopo desta fase, conforme definido |

## Fase 5 · Plataforma SaaS

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| 5.1 | Multi-tenancy: banco por cliente ou schema compartilhado | Você + Dev | Isolamento de dados entre clientes |
| 5.2 | Provedor de identidade e gestão de usuários por cliente | Você | Login corporativo |
| 5.3 | Modelo comercial e cobrança | Você | Onboarding de novos clientes |
| 5.4 | Conector para WMS de outros fornecedores | Dev (depois de 2.1 e 2.2) | Escala para mais clientes |

## Entrega de app para o operador

| # | Pendência | Dono | Desbloqueia |
|---|---|---|---|
| A.1 | Ícone e nome final do app (manifest atual é provisório) | Você | Identidade visual na instalação |
| A.2 | APK Android: empacotamento como Trusted Web Activity ou similar | Dev + Você | Instalação sem loja, ou via Google Play, precisa de domínio HTTPS e conta de publicação |
| A.3 | Teste do service worker em coletor real | Dev + Cliente | Confirmar cache da interface sem rede |

## O que já foi construído nesta etapa

- Persistência do estado em SQLite, com recuperação após reinício.
- Token separado para administração e para integração, com acesso fechado quando o token não está configurado.
- Entrada de tarefas do WMS com idempotência e recusa de conteúdo conflitante.
- Feed de eventos de saída com cursor.
- Supervisão agregada por zona, sem identificar operadores.
- Atribuição global por pares, com prioridade e depois distância.
- Interface instalável (PWA) com cache da casca da aplicação.
- 47 testes.
