from datetime import date, timedelta

import pytest

from app.domain import EquipmentType, RejectReason, TaskSpec, TaskStatus
from app.warehouse import DispatchError
from tests.conftest import checkin_operator


def add_task(warehouse, task_id, origin="RES-A", destination="DOC-1",
             equipment=EquipmentType.FORKLIFT, priority=3):
    warehouse.add_tasks([TaskSpec(task_id, origin, destination, equipment, priority)])


def test_offer_goes_to_nearest_certified_operator(warehouse):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")  # 30 m da reserva
    checkin_operator(warehouse, "bruno", EquipmentType.FORKLIFT, "SB-01")  # 80 m da reserva
    add_task(warehouse, "T1")

    warehouse.tick()

    offer, active = warehouse.current("ana")
    assert offer.id == "T1" and active is None
    assert warehouse.current("bruno")[0] is None


def test_operator_without_certification_never_receives_offer(warehouse):
    checkin_operator(warehouse, "carla", EquipmentType.PALLET_JACK, "SA-01")
    add_task(warehouse, "T1", equipment=EquipmentType.FORKLIFT)

    warehouse.tick()

    assert warehouse.current("carla")[0] is None
    assert warehouse.tasks["T1"].status is TaskStatus.PENDING


def test_pallet_jack_needs_no_certification(warehouse):
    checkin_operator(warehouse, "ana", EquipmentType.PALLET_JACK, "SA-01", certifications={})
    add_task(warehouse, "T1", equipment=EquipmentType.PALLET_JACK)

    warehouse.tick()

    assert warehouse.current("ana")[0].id == "T1"


def test_expired_certification_blocks_checkin(warehouse, clock):
    warehouse.register_equipment("EQ-1", EquipmentType.FORKLIFT)
    warehouse.register_operator("diego", "Diego", {EquipmentType.FORKLIFT: date(2026, 10, 1)})

    with pytest.raises(DispatchError, match="habilitação"):
        warehouse.checkin("diego", "EQ-1", "SA-01")


def test_higher_priority_task_is_offered_first(warehouse):
    checkin_operator(warehouse, "ana", EquipmentType.PALLET_JACK, "SA-01")
    add_task(warehouse, "baixa", equipment=EquipmentType.PALLET_JACK, priority=1)
    add_task(warehouse, "urgente", equipment=EquipmentType.PALLET_JACK, priority=5)

    warehouse.tick()

    assert warehouse.current("ana")[0].id == "urgente"
    assert warehouse.tasks["baixa"].status is TaskStatus.PENDING


def test_expired_offer_moves_to_next_operator(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    checkin_operator(warehouse, "bruno", EquipmentType.FORKLIFT, "SB-01")
    add_task(warehouse, "T1")
    warehouse.tick()

    clock.advance(21)
    warehouse.tick()

    assert warehouse.current("ana")[0] is None
    assert warehouse.current("bruno")[0].id == "T1"
    task = warehouse.tasks["T1"]
    assert task.rejected_by == {"ana"}
    assert task.rejections[-1].reason is None  # expirou sem resposta


def test_rejection_records_reason_and_reassigns(warehouse):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    checkin_operator(warehouse, "bruno", EquipmentType.FORKLIFT, "SB-01")
    add_task(warehouse, "T1")
    warehouse.tick()

    warehouse.reject("T1", "ana", RejectReason.EQUIPMENT_PROBLEM)
    warehouse.tick()

    assert warehouse.tasks["T1"].rejections[0].reason is RejectReason.EQUIPMENT_PROBLEM
    assert warehouse.current("bruno")[0].id == "T1"


def test_accept_after_expiry_is_refused(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    add_task(warehouse, "T1")
    warehouse.tick()

    clock.advance(25)

    with pytest.raises(DispatchError, match="expirou"):
        warehouse.accept("T1", "ana")
    assert warehouse.tasks["T1"].status is TaskStatus.PENDING


def test_full_cycle_and_response_time(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    add_task(warehouse, "T1")
    warehouse.tick()
    clock.advance(4)
    warehouse.accept("T1", "ana")

    with pytest.raises(DispatchError, match="esperado"):
        warehouse.arrive("T1", "ana", "SB-01")
    clock.advance(6)
    warehouse.arrive("T1", "ana", "RA-01")

    with pytest.raises(DispatchError, match="chegada"):
        warehouse.arrive("T1", "ana", "RA-01")
    clock.advance(10)
    with pytest.raises(DispatchError, match="esperado"):
        warehouse.complete("T1", "ana", "RA-01")
    warehouse.complete("T1", "ana", "D1-01")

    task = warehouse.tasks["T1"]
    assert task.status is TaskStatus.COMPLETED
    summary = warehouse.response_summary()
    assert summary["arrived_count"] == 1
    assert summary["median_response_seconds"] == 10.0
    assert summary["median_accept_seconds"] == 4.0
    assert warehouse.current("ana") == (None, None)


def test_checkout_is_blocked_while_task_is_active(warehouse):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    add_task(warehouse, "T1")
    warehouse.tick()
    warehouse.accept("T1", "ana")

    with pytest.raises(DispatchError, match="finalize"):
        warehouse.checkout("ana")


def test_all_eligible_operators_rejecting_reopens_cycle_after_wait(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    add_task(warehouse, "T1")
    warehouse.tick()
    warehouse.reject("T1", "ana", RejectReason.OTHER)

    warehouse.tick()
    assert warehouse.current("ana")[0] is None  # ainda em espera
    assert warehouse.tasks["T1"].retry_after is not None

    clock.advance(21)
    warehouse.tick()
    assert warehouse.current("ana")[0].id == "T1"


def test_once_runs_command_a_single_time_per_event(warehouse):
    calls = []

    def command():
        calls.append(1)
        return {"ok": len(calls)}

    first = warehouse.once("evt-1", command)
    second = warehouse.once("evt-1", command)

    assert first == second == {"ok": 1}
    assert len(calls) == 1


def test_duplicate_task_ids_are_refused(warehouse):
    add_task(warehouse, "T1")
    with pytest.raises(DispatchError, match="já existentes"):
        add_task(warehouse, "T1")
