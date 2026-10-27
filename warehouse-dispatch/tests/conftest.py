from datetime import datetime, timedelta, timezone

import pytest

from app.domain import EquipmentType
from app.layout import Layout
from app.warehouse import Warehouse

LAYOUT = {
    "zones": [
        {"id": "REC", "name": "Recebimento", "scan_codes": ["REC-01"]},
        {"id": "RES-A", "name": "Reserva A", "scan_codes": ["RA-01"]},
        {"id": "SEP-A", "name": "Separação A", "scan_codes": ["SA-01"]},
        {"id": "SEP-B", "name": "Separação B", "scan_codes": ["SB-01"]},
        {"id": "DOC-1", "name": "Doca 1", "scan_codes": ["D1-01"]},
        {"id": "ILHA", "name": "Zona sem corredor", "scan_codes": ["IL-01"]},
    ],
    "edges": [
        {"from": "RES-A", "to": "SEP-A", "meters": 30},
        {"from": "SEP-A", "to": "SEP-B", "meters": 50},
        {"from": "RES-A", "to": "DOC-1", "meters": 120},
    ],
}


class FakeClock:
    def __init__(self):
        self.now = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def layout() -> Layout:
    return Layout.from_dict(LAYOUT)


@pytest.fixture
def warehouse(layout, clock) -> Warehouse:
    return Warehouse(layout, offer_timeout=timedelta(seconds=20), clock=clock)


def checkin_operator(
    warehouse: Warehouse,
    operator_id: str,
    equipment_type: EquipmentType,
    scan_code: str,
    certifications: dict | None = None,
) -> None:
    """Cadastra operador e equipamento e faz o check-in no local informado."""
    equipment_id = f"EQ-{operator_id}"
    if certifications is None:
        certifications = {equipment_type: None}
    warehouse.register_equipment(equipment_id, equipment_type)
    warehouse.register_operator(operator_id, operator_id.title(), certifications)
    warehouse.checkin(operator_id, equipment_id, scan_code)
