from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum

MIN_PRIORITY = 1
MAX_PRIORITY = 5


class EquipmentType(str, Enum):
    PALLET_JACK = "pallet_jack"
    FORKLIFT = "forklift"


# Só empilhadeiras exigem habilitação NR-11. Transpaleteiras não exigem.
CERTIFICATION_REQUIRED = frozenset({EquipmentType.FORKLIFT})


class TaskStatus(str, Enum):
    PENDING = "pending"
    OFFERED = "offered"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class RejectReason(str, Enum):
    EQUIPMENT_PROBLEM = "equipment_problem"
    SAFETY = "safety"
    ALREADY_BUSY = "already_busy"
    OTHER = "other"


@dataclass(frozen=True)
class TaskSpec:
    id: str
    origin_zone: str
    destination_zone: str
    equipment_type: EquipmentType
    priority: int


@dataclass
class Equipment:
    id: str
    type: EquipmentType
    holder_id: str | None = None


@dataclass
class Operator:
    id: str
    name: str
    # Validade None significa sem vencimento.
    certifications: dict[EquipmentType, date | None]
    equipment_id: str | None = None
    zone_id: str | None = None
    offer_task_id: str | None = None
    active_task_id: str | None = None


@dataclass(frozen=True)
class Rejection:
    operator_id: str
    reason: RejectReason | None  # None quando a oferta expirou sem resposta
    at: datetime


@dataclass
class Task:
    id: str
    origin_zone: str
    destination_zone: str
    equipment_type: EquipmentType
    priority: int
    created_at: datetime
    status: TaskStatus = TaskStatus.PENDING
    offer_operator_id: str | None = None
    offer_expires_at: datetime | None = None
    assigned_operator_id: str | None = None
    accepted_at: datetime | None = None
    arrived_at: datetime | None = None
    completed_at: datetime | None = None
    retry_after: datetime | None = None
    rejected_by: set[str] = field(default_factory=set)
    rejections: list[Rejection] = field(default_factory=list)
