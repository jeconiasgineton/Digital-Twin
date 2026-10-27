import json
import sqlite3
import threading
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING

from .domain import Equipment, EquipmentType, Operator, Rejection, RejectReason, Task, TaskStatus

if TYPE_CHECKING:
    from .warehouse import Warehouse


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse_dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value is not None else None


def dump_state(warehouse: "Warehouse") -> str:
    """Serializa o estado completo do despacho. Chamado sob o lock do warehouse."""
    data = {
        "operators": [
            {
                "id": operator.id,
                "name": operator.name,
                "certifications": {
                    kind.value: (expires.isoformat() if expires else None)
                    for kind, expires in operator.certifications.items()
                },
                "equipment_id": operator.equipment_id,
                "zone_id": operator.zone_id,
                "offer_task_id": operator.offer_task_id,
                "active_task_id": operator.active_task_id,
            }
            for operator in warehouse.operators.values()
        ],
        "equipment": [
            {"id": item.id, "type": item.type.value, "holder_id": item.holder_id}
            for item in warehouse.equipment.values()
        ],
        "tasks": [
            {
                "id": task.id,
                "origin_zone": task.origin_zone,
                "destination_zone": task.destination_zone,
                "equipment_type": task.equipment_type.value,
                "priority": task.priority,
                "created_at": _iso(task.created_at),
                "status": task.status.value,
                "offer_operator_id": task.offer_operator_id,
                "offer_expires_at": _iso(task.offer_expires_at),
                "assigned_operator_id": task.assigned_operator_id,
                "accepted_at": _iso(task.accepted_at),
                "arrived_at": _iso(task.arrived_at),
                "completed_at": _iso(task.completed_at),
                "retry_after": _iso(task.retry_after),
                "rejected_by": sorted(task.rejected_by),
                "rejections": [
                    {
                        "operator_id": item.operator_id,
                        "reason": item.reason.value if item.reason else None,
                        "at": _iso(item.at),
                    }
                    for item in task.rejections
                ],
            }
            for task in warehouse.tasks.values()
        ],
        "events": warehouse.events,
        "processed": warehouse._processed,
    }
    return json.dumps(data, ensure_ascii=False)


def restore_state(warehouse: "Warehouse", body: str) -> None:
    data = json.loads(body)
    warehouse.operators.clear()
    for item in data["operators"]:
        warehouse.operators[item["id"]] = Operator(
            id=item["id"],
            name=item["name"],
            certifications={
                EquipmentType(kind): (date.fromisoformat(expires) if expires else None)
                for kind, expires in item["certifications"].items()
            },
            equipment_id=item["equipment_id"],
            zone_id=item["zone_id"],
            offer_task_id=item["offer_task_id"],
            active_task_id=item["active_task_id"],
        )

    warehouse.equipment.clear()
    for item in data["equipment"]:
        warehouse.equipment[item["id"]] = Equipment(
            id=item["id"], type=EquipmentType(item["type"]), holder_id=item["holder_id"]
        )

    warehouse.tasks.clear()
    for item in data["tasks"]:
        warehouse.tasks[item["id"]] = Task(
            id=item["id"],
            origin_zone=item["origin_zone"],
            destination_zone=item["destination_zone"],
            equipment_type=EquipmentType(item["equipment_type"]),
            priority=item["priority"],
            created_at=_parse_dt(item["created_at"]),
            status=TaskStatus(item["status"]),
            offer_operator_id=item["offer_operator_id"],
            offer_expires_at=_parse_dt(item["offer_expires_at"]),
            assigned_operator_id=item["assigned_operator_id"],
            accepted_at=_parse_dt(item["accepted_at"]),
            arrived_at=_parse_dt(item["arrived_at"]),
            completed_at=_parse_dt(item["completed_at"]),
            retry_after=_parse_dt(item["retry_after"]),
            rejected_by=set(item["rejected_by"]),
            rejections=[
                Rejection(
                    operator_id=entry["operator_id"],
                    reason=RejectReason(entry["reason"]) if entry["reason"] else None,
                    at=_parse_dt(entry["at"]),
                )
                for entry in item["rejections"]
            ],
        )

    warehouse.events[:] = data["events"]
    warehouse._processed.clear()
    warehouse._processed.update(data["processed"])


class SqliteStore:
    """Guarda o estado inteiro do despacho numa linha. Simples e suficiente para o piloto."""

    def __init__(self, path: str):
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._connection:
            self._connection.execute(
                "CREATE TABLE IF NOT EXISTS state ("
                " id INTEGER PRIMARY KEY CHECK (id = 1),"
                " body TEXT NOT NULL,"
                " saved_at TEXT NOT NULL)"
            )

    def save(self, warehouse: "Warehouse") -> None:
        body = dump_state(warehouse)
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO state (id, body, saved_at) VALUES (1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET body = excluded.body, saved_at = excluded.saved_at",
                (body, datetime.now(timezone.utc).isoformat()),
            )

    def load_into(self, warehouse: "Warehouse") -> bool:
        with self._lock:
            row = self._connection.execute("SELECT body FROM state WHERE id = 1").fetchone()
        if row is None:
            return False
        restore_state(warehouse, row[0])
        return True

    def close(self) -> None:
        self._connection.close()
