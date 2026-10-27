# Warehouse Dispatch · Fase 1

Despacho de tarefas de reposição de picking para operadores de transpaleteira e empilhadeira,
inspirado na lógica de oferta e aceite do Uber: o sistema escolhe quem recebe a tarefa
pelo menor deslocamento, o operador aceita ou recusa com motivo, e o tempo de resposta é medido.

Módulo independente. Não depende do digital twin nem do projeto de AMRs; a integração
acontece depois, pelos contratos de tarefa e de posição.

## Como rodar

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/pytest
WD_LAYOUT=config/layout.example.json ./.venv/bin/uvicorn "app.api:create_app" --factory --port 8000
```

Interface do operador: `http://localhost:8000/`
Layout de exemplo: `config/layout.example.json`
Planilha de exemplo: `examples/reposicao.exemplo.csv`

## Regras de despacho

- A atribuição é global por pares (tarefa, operador): primeiro a maior prioridade (5 = urgente), depois a menor distância,
  e cada operador recebe no máximo uma oferta por ciclo. Uma tarefa antiga e distante não tem preferência sobre uma nova e próxima
  de mesma prioridade. Essa regra de envelhecimento está em aberto (pendência 0.8).
- Candidato elegível: operador com check-in, sem oferta nem tarefa ativa, com equipamento do tipo exigido,
  habilitação válida quando o equipamento exige (empilhadeira, NR-11; transpaleteira não exige) e caminho no grafo até a origem.
- Entre os elegíveis, vence o de menor distância até a origem.
- A oferta expira em 20 s (configurável). Expirada ou recusada, a tarefa vai ao próximo elegível.
- Quem recusou não recebe a mesma tarefa de novo. Se todos os elegíveis recusarem, o ciclo reabre após o tempo de espera.
- Não há escolha livre pelo operador: quem decide é o sistema.

## Ciclo de vida da tarefa

`pending → offered → assigned → in_progress → completed`

- **accept / reject**: resposta à oferta. A recusa exige motivo.
- **arrive**: scan do local de origem. Este instante fecha o tempo de resposta.
- **complete**: scan do local de destino. Confirma a entrega.

## Tempo de resposta (KPI do piloto)

`arrived_at − created_at`, em segundos. Disponível em `GET /kpi/response-time` com mediana e média.
O tempo até o aceite também é reportado (`median_accept_seconds`), para separar a demora do operador
da demora do deslocamento.

## Endpoints principais

| Método | Caminho | Autenticação | Uso |
|---|---|---|---|
| POST | `/admin/equipment` | `X-Admin-Token` | Cadastra equipamento |
| POST | `/admin/operators` | `X-Admin-Token` | Cadastra operador e habilitações |
| POST | `/admin/tasks/import` | `X-Admin-Token` | Importa CSV (tudo ou nada) |
| POST | `/integrations/tasks` | `X-Integration-Token` | Entrada de tarefas do WMS (idempotente) |
| GET | `/integrations/events?after=N` | `X-Integration-Token` | Feed de eventos de saída, com cursor |
| POST | `/operators/{id}/checkin` | — (pendência 2.4) | Início de turno com equipamento e scan de local |
| POST | `/operators/{id}/checkout` | — (pendência 2.4) | Fim de turno |
| GET | `/operators/{id}/current` | — (pendência 2.4) | Oferta e tarefa ativa do operador |
| POST | `/tasks/{id}/accept` · `/reject` · `/arrive` · `/complete` | — (pendência 2.4) | Ações do operador |
| GET | `/supervisor/zones` | `X-Admin-Token` | Visão agregada por zona, sem operadores |
| GET | `/kpi/response-time` | `X-Admin-Token` | Indicadores de tempo de resposta |

Configuração por variáveis de ambiente:

- `WD_LAYOUT`: arquivo de layout do armazém.
- `WD_DB`: caminho do SQLite. Sem ele, o estado fica só em memória.
- `WD_ADMIN_TOKEN` e `WD_INTEGRATION_TOKEN`: sem eles, as rotas protegidas recusam todo acesso.

Eventos gerados: `task.offered`, `task.accepted`, `task.rejected`, `task.expired`, `task.arrived`, `task.completed`.

Todo comando de operador exige `event_id`. Reenvios com o mesmo `event_id` devolvem o resultado original,
sem aplicar a ação de novo. Isso permite que a fila do coletor reenvie após queda de conexão.

## Interface do operador

- Funciona em tela de coletor ou tablet, com tamanho de toque e tema claro ou escuro.
- Ações entram numa fila local (`localStorage`) e são reenviadas até o servidor confirmar.
- Quando há conexão, a atualização ocorre a cada 2 s.

## Limites conhecidos

Todas as pendências estão em `PENDENCIAS.md`, com dono e o que desbloqueia cada uma.

- **Operador sem login.** Os endpoints de operador ainda não exigem identificação (pendência 2.4).
- **Localização por scan.** Não há posição contínua (fase 4).
- **Persistência em snapshot.** O estado inteiro é gravado numa linha do SQLite a cada mudança (pendência 2.8).
- **Sem APK.** A interface é PWA instalável. O empacotamento Android está na pendência A.2.
- **Sem batching.** Uma tarefa por operador por vez (fase 3).
- **Habilitação cadastrada manualmente.** Vale só para empilhadeiras, pois transpaleteira não exige NR-11.
