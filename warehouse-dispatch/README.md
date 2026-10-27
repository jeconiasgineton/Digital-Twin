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

- Tarefas são ordenadas por prioridade (5 = urgente) e depois pela data de criação.
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

| Método | Caminho | Uso |
|---|---|---|
| POST | `/admin/equipment` | Cadastra equipamento |
| POST | `/admin/operators` | Cadastra operador e habilitações |
| POST | `/admin/tasks/import` | Importa CSV (tudo ou nada) |
| POST | `/operators/{id}/checkin` | Início de turno com equipamento e scan de local |
| POST | `/operators/{id}/checkout` | Fim de turno |
| GET | `/operators/{id}/current` | Oferta e tarefa ativa do operador |
| POST | `/tasks/{id}/accept` · `/reject` · `/arrive` · `/complete` | Ações do operador |
| GET | `/supervisor/board` | Estado de tarefas, operadores e equipamentos |
| GET | `/kpi/response-time` | Indicadores de tempo de resposta |

Todo comando de operador exige `event_id`. Reenvios com o mesmo `event_id` devolvem o resultado original,
sem aplicar a ação de novo. Isso permite que a fila do coletor reenvie após queda de conexão.

## Interface do operador

- Funciona em tela de coletor ou tablet, com tamanho de toque e tema claro ou escuro.
- Ações entram numa fila local (`localStorage`) e são reenviadas até o servidor confirmar.
- Quando há conexão, a atualização ocorre a cada 2 s.

## Limites conhecidos desta fase

- **Estado em memória.** Reiniciar o servidor perde tarefas e turnos. Persistência fica para a próxima entrega.
- **Sem autenticação.** Os endpoints `/admin/*` e os de operador estão abertos. Só usar em rede interna
  do piloto, com acesso restrito, até existir login por matrícula.
- **Sem APK.** A interface é web (PWA). O empacotamento como APK Android é um passo separado.
- **Localização por scan.** Não há posição contínua. A zona muda apenas quando o operador escaneia.
- **Sem otimização global.** O despacho é guloso por prioridade. Otimização em lote fica para a fase 3.
- **Sem integração com WMS.** A entrada é por planilha. A API do WMS entra na fase 2.
- **Habilitação cadastrada manualmente.** Não há leitura do RH ou do WMS. Vale só para empilhadeiras.
- **Painel do supervisor com dados individuais.** `/supervisor/board` lista cada operador. A decisão de registro agregado
  (por equipe e zona) ainda não está implementada e precisa ser feita antes do piloto.
