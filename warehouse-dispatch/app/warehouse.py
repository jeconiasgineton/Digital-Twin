import functools
import math
import statistics
import threading
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .domain import (
    CERTIFICATION_REQUIRED,
    Equipment,
    EquipmentType,
    Operator,
    Rejection,
    RejectReason,
    Task,
    TaskSpec,
    TaskStatus,
)
from .layout import Layout


class DispatchError(Exception):
    """Regra de negócio violada. O status_code é devolvido pela API."""

    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _persisted(method: Callable[..., Any]) -> Callable[..., Any]:
    """Comando de escrita: ao final, salva o estado mesmo se a regra recusar a operação."""

    @functools.wraps(method)
    def wrapper(self: "Warehouse", *args: Any, **kwargs: Any) -> Any:
        with self.lock:
            try:
                return method(self, *args, **kwargs)
            finally:
                self._commit(force=True)

    return wrapper


class Warehouse:
    """Estado e regras do despacho. Toda operação acontece sob self.lock."""

    def __init__(
        self,
        layout: Layout,
        offer_timeout: timedelta = timedelta(seconds=20),
        clock: Callable[[], datetime] = _utc_now,
        on_change: Callable[["Warehouse"], None] | None = None,
    ):
        self.layout = layout
        self.offer_timeout = offer_timeout
        self._clock = clock
        self._on_change = on_change
        self._changed = False
        self.lock = threading.RLock()
        self.operators: dict[str, Operator] = {}
        self.equipment: dict[str, Equipment] = {}
        self.tasks: dict[str, Task] = {}
        self.events: list[dict[str, Any]] = []
        self._processed: dict[str, dict[str, Any]] = {}

    # Cadastro

    @_persisted
    def register_equipment(self, equipment_id: str, equipment_type: EquipmentType) -> None:
        if equipment_id in self.equipment:
            raise DispatchError(f"equipamento já cadastrado: {equipment_id}")
        self.equipment[equipment_id] = Equipment(equipment_id, equipment_type)

    @_persisted
    def register_operator(
        self,
        operator_id: str,
        name: str,
        certifications: dict[EquipmentType, date | None],
    ) -> None:
        if operator_id in self.operators:
            raise DispatchError(f"operador já cadastrado: {operator_id}")
        self.operators[operator_id] = Operator(operator_id, name, dict(certifications))

    @_persisted
    def add_tasks(self, specs: list[TaskSpec]) -> None:
        """Importação estrita: qualquer id repetido recusa o lote inteiro."""
        duplicated = sorted(spec.id for spec in specs if spec.id in self.tasks)
        if duplicated:
            raise DispatchError(f"tarefas já existentes: {', '.join(duplicated)}")
        for spec in specs:
            self._create_task(spec)

    @_persisted
    def ingest_tasks(self, specs: list[TaskSpec]) -> dict[str, list[str]]:
        """Entrada de integração: reenvio idêntico é ignorado; conteúdo diferente recusa o lote."""
        conflicts: set[str] = set()
        created: list[TaskSpec] = []
        skipped: list[str] = []
        seen: dict[str, TaskSpec] = {}
        for spec in specs:
            known = seen.get(spec.id) or self.tasks.get(spec.id)
            if known is None:
                seen[spec.id] = spec
                created.append(spec)
            elif self._same_content(known, spec):
                skipped.append(spec.id)
            else:
                conflicts.add(spec.id)
        if conflicts:
            raise DispatchError(
                f"tarefas com conteúdo diferente do já recebido: {', '.join(sorted(conflicts))}"
            )
        for spec in created:
            self._create_task(spec)
        return {"created": [spec.id for spec in created], "skipped": skipped}

    # Idempotência para comandos vindos de coletores com conexão instável

    @_persisted
    def once(self, event_id: str, command: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        """Executa o comando uma vez por event_id. Repetições devolvem o resultado original."""
        if event_id not in self._processed:
            self._processed[event_id] = command()
        return self._processed[event_id]

    # Operador e equipamento

    @_persisted
    def checkin(self, operator_id: str, equipment_id: str, scan_code: str) -> dict[str, str]:
        operator = self._operator(operator_id)
        equipment = self._equipment(equipment_id)
        zone_id = self._zone_for_scan(scan_code)
        now = self._clock()
        if operator.equipment_id is not None:
            raise DispatchError("operador já está com um equipamento")
        if equipment.holder_id is not None:
            raise DispatchError("equipamento já está em uso")
        if not self._is_certified(operator, equipment.type, now):
            raise DispatchError(f"operador sem habilitação válida para {equipment.type.value}")
        equipment.holder_id = operator.id
        operator.equipment_id = equipment.id
        operator.zone_id = zone_id
        return {"operator_id": operator.id, "equipment_id": equipment.id, "zone_id": zone_id}

    @_persisted
    def checkout(self, operator_id: str) -> dict[str, str]:
        operator = self._operator(operator_id)
        if self._is_busy(operator):
            raise DispatchError("finalize a tarefa atual antes de encerrar o turno")
        if operator.equipment_id is not None:
            self.equipment[operator.equipment_id].holder_id = None
            operator.equipment_id = None
        return {"operator_id": operator.id, "status": "checked_out"}

    def current(self, operator_id: str) -> tuple[Task | None, Task | None]:
        """Oferta pendente e tarefa ativa do operador, com expirações já aplicadas."""
        with self.lock:
            self._expire_offers(self._clock())
            self._commit()
            operator = self._operator(operator_id)
            offer = self.tasks[operator.offer_task_id] if operator.offer_task_id else None
            active = self.tasks[operator.active_task_id] if operator.active_task_id else None
            return offer, active

    # Ciclo de vida da tarefa

    @_persisted
    def accept(self, task_id: str, operator_id: str) -> Task:
        now = self._clock()
        task = self._task(task_id)
        operator = self._operator(operator_id)
        self._require_offer(task, operator, now)
        task.status = TaskStatus.ASSIGNED
        task.assigned_operator_id = operator.id
        task.accepted_at = now
        task.offer_operator_id = None
        task.offer_expires_at = None
        operator.offer_task_id = None
        operator.active_task_id = task.id
        self._record("task.accepted", task, operator.id, now)
        return task

    @_persisted
    def reject(self, task_id: str, operator_id: str, reason: RejectReason) -> Task:
        now = self._clock()
        task = self._task(task_id)
        operator = self._operator(operator_id)
        self._require_offer(task, operator, now)
        self._release_offer(task, now, reason)
        return task

    @_persisted
    def arrive(self, task_id: str, operator_id: str, scan_code: str) -> Task:
        """Chegada na origem. Este instante é o fim do tempo de resposta à chamada."""
        now = self._clock()
        task = self._task(task_id)
        operator = self._operator(operator_id)
        self._assigned_task(task, operator)
        if task.status is TaskStatus.IN_PROGRESS:
            raise DispatchError("chegada já confirmada")
        self._expect_scan(scan_code, task.origin_zone)
        task.status = TaskStatus.IN_PROGRESS
        task.arrived_at = now
        operator.zone_id = task.origin_zone
        self._record("task.arrived", task, operator.id, now)
        return task

    @_persisted
    def complete(self, task_id: str, operator_id: str, scan_code: str) -> Task:
        now = self._clock()
        task = self._task(task_id)
        operator = self._operator(operator_id)
        self._assigned_task(task, operator)
        if task.status is TaskStatus.ASSIGNED:
            raise DispatchError("confirme a chegada na origem antes da entrega")
        self._expect_scan(scan_code, task.destination_zone)
        task.status = TaskStatus.COMPLETED
        task.completed_at = now
        operator.active_task_id = None
        operator.zone_id = task.destination_zone
        self._record("task.completed", task, operator.id, now)
        return task

    # Despacho

    def tick(self) -> None:
        """Aplica expirações de oferta e distribui tarefas pendentes. Chamado periodicamente."""
        with self.lock:
            now = self._clock()
            self._expire_offers(now)
            self._dispatch(now)
            self._commit()

    def events_after(self, after: int, limit: int) -> list[dict[str, Any]]:
        """Feed de eventos de saída, em ordem de seq, para integrações puxarem por cursor."""
        with self.lock:
            return self.events[after:after + limit]

    def response_summary(self) -> dict[str, Any]:
        """Tempo de resposta = criação da chamada até a chegada confirmada na origem."""
        with self.lock:
            response = [
                (task.arrived_at - task.created_at).total_seconds()
                for task in self.tasks.values()
                if task.arrived_at is not None
            ]
            accept = [
                (task.accepted_at - task.created_at).total_seconds()
                for task in self.tasks.values()
                if task.accepted_at is not None
            ]
            return {
                "arrived_count": len(response),
                "median_response_seconds": _median(response),
                "mean_response_seconds": _mean(response),
                "median_accept_seconds": _median(accept),
            }

    def zone_summary(self) -> list[dict[str, Any]]:
        """Visão agregada por zona, sem identificar operadores (decisão de LGPD)."""
        with self.lock:
            now = self._clock()
            summary = []
            for zone in self.layout.zones.values():
                pending = [
                    task for task in self.tasks.values()
                    if task.status is TaskStatus.PENDING and task.origin_zone == zone.id
                ]
                in_zone = [op for op in self.operators.values() if op.zone_id == zone.id and op.equipment_id]
                free = [op for op in in_zone if self._is_free(op)]
                summary.append({
                    "zone_id": zone.id,
                    "name": zone.name,
                    "pending_tasks": len(pending),
                    "oldest_pending_seconds": max(
                        ((now - task.created_at).total_seconds() for task in pending), default=None
                    ),
                    "offered_tasks": sum(
                        1 for task in self.tasks.values()
                        if task.status is TaskStatus.OFFERED and task.origin_zone == zone.id
                    ),
                    "operators_on_shift": len(in_zone),
                    "operators_free": len(free),
                })
            return summary

    def _dispatch(self, now: datetime) -> None:
        """Atribuição global: pares (tarefa, operador) por prioridade e depois por distância."""
        pending = [
            task
            for task in self.tasks.values()
            if task.status is TaskStatus.PENDING and (task.retry_after is None or task.retry_after <= now)
        ]
        pairs: list[tuple[int, float, datetime, str, str]] = []
        with_candidates: set[str] = set()
        for task in pending:
            for distance, operator in self._candidates(task, now):
                pairs.append((-task.priority, distance, task.created_at, task.id, operator.id))
                with_candidates.add(task.id)
        pairs.sort()

        offered_tasks: set[str] = set()
        used_operators: set[str] = set()
        for _, _, _, task_id, operator_id in pairs:
            if task_id in offered_tasks or operator_id in used_operators:
                continue
            self._offer(self.tasks[task_id], self.operators[operator_id], now)
            offered_tasks.add(task_id)
            used_operators.add(operator_id)

        for task in pending:
            if task.status is TaskStatus.PENDING and task.id not in with_candidates and task.rejected_by:
                # Todos os elegíveis recusaram: reabre o ciclo após um intervalo de espera.
                task.rejected_by.clear()
                task.retry_after = now + self.offer_timeout
                self._changed = True

    def _candidates(self, task: Task, now: datetime) -> list[tuple[float, Operator]]:
        result: list[tuple[float, Operator]] = []
        for operator in self.operators.values():
            if not self._is_free(operator) or operator.id in task.rejected_by:
                continue
            equipment = self.equipment[operator.equipment_id]
            if equipment.type is not task.equipment_type or not self._is_certified(operator, equipment.type, now):
                continue
            distance = self.layout.distance(operator.zone_id, task.origin_zone)
            if not math.isinf(distance):
                result.append((distance, operator))
        return result

    def _offer(self, task: Task, operator: Operator, now: datetime) -> None:
        task.status = TaskStatus.OFFERED
        task.offer_operator_id = operator.id
        task.offer_expires_at = now + self.offer_timeout
        operator.offer_task_id = task.id
        self._record("task.offered", task, operator.id, now)

    def _release_offer(self, task: Task, now: datetime, reason: RejectReason | None) -> None:
        operator = self.operators[task.offer_operator_id]
        task.rejected_by.add(operator.id)
        task.rejections.append(Rejection(operator.id, reason, now))
        operator.offer_task_id = None
        task.offer_operator_id = None
        task.offer_expires_at = None
        task.status = TaskStatus.PENDING
        event_type = "task.expired" if reason is None else "task.rejected"
        self._record(event_type, task, operator.id, now)

    def _expire_offers(self, now: datetime) -> None:
        for task in self.tasks.values():
            if task.status is TaskStatus.OFFERED and task.offer_expires_at <= now:
                self._release_offer(task, now, reason=None)

    def _require_offer(self, task: Task, operator: Operator, now: datetime) -> None:
        if task.status is TaskStatus.OFFERED and task.offer_operator_id == operator.id and task.offer_expires_at <= now:
            self._release_offer(task, now, reason=None)
            raise DispatchError("a oferta expirou antes da resposta")
        if task.status is not TaskStatus.OFFERED or task.offer_operator_id != operator.id:
            raise DispatchError("esta tarefa não está ofertada a este operador")

    def _assigned_task(self, task: Task, operator: Operator) -> None:
        if task.status not in (TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS) or task.assigned_operator_id != operator.id:
            raise DispatchError("tarefa não está atribuída a este operador")

    def _expect_scan(self, scan_code: str, expected_zone: str) -> None:
        zone_id = self._zone_for_scan(scan_code)
        if zone_id != expected_zone:
            raise DispatchError(f"local escaneado ({zone_id}) não é o esperado ({expected_zone})")

    def _create_task(self, spec: TaskSpec) -> None:
        self.tasks[spec.id] = Task(
            id=spec.id,
            origin_zone=spec.origin_zone,
            destination_zone=spec.destination_zone,
            equipment_type=spec.equipment_type,
            priority=spec.priority,
            created_at=self._clock(),
        )

    @staticmethod
    def _same_content(task: Task, spec: TaskSpec) -> bool:
        return (
            task.origin_zone == spec.origin_zone
            and task.destination_zone == spec.destination_zone
            and task.equipment_type is spec.equipment_type
            and task.priority == spec.priority
        )

    def _record(self, event_type: str, task: Task, operator_id: str | None, now: datetime) -> None:
        self.events.append({
            "seq": len(self.events) + 1,
            "type": event_type,
            "task_id": task.id,
            "operator_id": operator_id,
            "at": now.isoformat(),
        })
        self._changed = True

    def _commit(self, force: bool = False) -> None:
        if self._on_change is not None and (force or self._changed):
            self._on_change(self)
        self._changed = False

    # Regras auxiliares

    def _is_free(self, operator: Operator) -> bool:
        return (
            operator.equipment_id is not None
            and operator.zone_id is not None
            and not self._is_busy(operator)
        )

    def _is_busy(self, operator: Operator) -> bool:
        return operator.offer_task_id is not None or operator.active_task_id is not None

    def _is_certified(self, operator: Operator, equipment_type: EquipmentType, now: datetime) -> bool:
        if equipment_type not in CERTIFICATION_REQUIRED:
            return True
        if equipment_type not in operator.certifications:
            return False
        expires_on = operator.certifications[equipment_type]
        return expires_on is None or expires_on >= now.date()

    def _zone_for_scan(self, scan_code: str) -> str:
        zone_id = self.layout.zone_for_scan(scan_code)
        if zone_id is None:
            raise DispatchError(f"código de local desconhecido: {scan_code}", status_code=422)
        return zone_id

    def _operator(self, operator_id: str) -> Operator:
        if operator_id not in self.operators:
            raise DispatchError(f"operador não encontrado: {operator_id}", status_code=404)
        return self.operators[operator_id]

    def _equipment(self, equipment_id: str) -> Equipment:
        if equipment_id not in self.equipment:
            raise DispatchError(f"equipamento não encontrado: {equipment_id}", status_code=404)
        return self.equipment[equipment_id]

    def _task(self, task_id: str) -> Task:
        if task_id not in self.tasks:
            raise DispatchError(f"tarefa não encontrada: {task_id}", status_code=404)
        return self.tasks[task_id]
