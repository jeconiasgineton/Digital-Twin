from datetime import timedelta

import pytest

from app.domain import EquipmentType, RejectReason, TaskSpec, TaskStatus
from app.layout import Layout
from app.store import SqliteStore, dump_state
from app.warehouse import DispatchError, Warehouse
from tests.conftest import LAYOUT, checkin_operator


def spec(task_id, origin, destination="DOC-1", equipment=EquipmentType.FORKLIFT, priority=3):
    return TaskSpec(task_id, origin, destination, equipment, priority)


# Despacho global

def test_same_priority_goes_to_the_task_nearest_the_only_operator(warehouse):
    # T-OLD nasce primeiro, mas está a 80 m do operador. T-NEW está a 0 m.
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "RA-01")
    warehouse.add_tasks([spec("T-OLD", "SEP-B")])
    warehouse.add_tasks([spec("T-NEW", "RES-A")])

    warehouse.tick()

    assert warehouse.current("ana")[0].id == "T-NEW"
    assert warehouse.tasks["T-OLD"].status is TaskStatus.PENDING


def test_each_operator_gets_at_most_one_offer_per_tick(warehouse):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    checkin_operator(warehouse, "bruno", EquipmentType.FORKLIFT, "SB-01")
    warehouse.add_tasks([spec("T1", "RES-A"), spec("T2", "RES-A")])

    warehouse.tick()

    offered = [t for t in warehouse.tasks.values() if t.status is TaskStatus.OFFERED]
    assert len(offered) == 2
    assert {t.offer_operator_id for t in offered} == {"ana", "bruno"}


# Entrada de integração

def test_ingest_skips_identical_resubmission_inside_one_batch(warehouse):
    result = warehouse.ingest_tasks([spec("W1", "RES-A"), spec("W1", "RES-A")])

    assert result == {"created": ["W1"], "skipped": ["W1"]}


def test_ingest_conflict_inside_batch_refuses_everything(warehouse):
    with pytest.raises(DispatchError, match="conteúdo diferente"):
        warehouse.ingest_tasks([spec("W1", "RES-A"), spec("W1", "SEP-A")])
    assert warehouse.tasks == {}


# Eventos

def test_events_are_sequential_and_describe_the_cycle(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    warehouse.add_tasks([spec("T1", "RES-A")])
    warehouse.tick()
    warehouse.accept("T1", "ana")
    warehouse.arrive("T1", "ana", "RA-01")
    warehouse.complete("T1", "ana", "D1-01")

    types = [event["type"] for event in warehouse.events_after(0, 100)]
    seqs = [event["seq"] for event in warehouse.events_after(0, 100)]

    assert types == ["task.offered", "task.accepted", "task.arrived", "task.completed"]
    assert seqs == [1, 2, 3, 4]


def test_expired_offer_emits_expired_event(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    warehouse.add_tasks([spec("T1", "RES-A")])
    warehouse.tick()

    clock.advance(21)
    warehouse.tick()

    assert [e["type"] for e in warehouse.events_after(0, 10)][-1] == "task.expired"


# Supervisão por zona

def test_zone_summary_counts_by_zone_without_names(warehouse, clock):
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")
    warehouse.add_tasks([spec("T1", "RES-A")])
    warehouse.tick()
    clock.advance(30)

    zones = {z["zone_id"]: z for z in warehouse.zone_summary()}

    assert zones["RES-A"]["offered_tasks"] == 1
    assert zones["RES-A"]["pending_tasks"] == 0
    assert zones["SEP-A"]["operators_on_shift"] == 1
    assert zones["SEP-A"]["operators_free"] == 0  # está com a oferta, portanto ocupada
    assert all("operator_id" not in z for z in zones.values())


def test_oldest_pending_age_is_reported(warehouse, clock):
    warehouse.add_tasks([spec("T1", "RES-A")])
    clock.advance(90)

    zones = {z["zone_id"]: z for z in warehouse.zone_summary()}

    assert zones["RES-A"]["oldest_pending_seconds"] == 90.0
    assert zones["SEP-A"]["oldest_pending_seconds"] is None


# Persistência

def test_round_trip_restores_full_state(tmp_path, clock):
    layout = Layout.from_dict(LAYOUT)
    store = SqliteStore(str(tmp_path / "state.db"))
    source = Warehouse(layout, offer_timeout=timedelta(seconds=20), clock=clock, on_change=store.save)
    checkin_operator(source, "ana", EquipmentType.FORKLIFT, "SA-01")
    source.add_tasks([spec("T1", "RES-A"), spec("T2", "SEP-B", equipment=EquipmentType.PALLET_JACK)])
    source.tick()
    source.reject("T1", "ana", RejectReason.SAFETY)

    target = Warehouse(layout, offer_timeout=timedelta(seconds=20), clock=clock)
    assert store.load_into(target) is True

    assert dump_state(target) == dump_state(source)


def test_store_is_empty_on_first_start(tmp_path):
    store = SqliteStore(str(tmp_path / "fresh.db"))
    warehouse = Warehouse(Layout.from_dict(LAYOUT))

    assert store.load_into(warehouse) is False


def test_failed_command_still_leaves_state_consistent(tmp_path, clock):
    layout = Layout.from_dict(LAYOUT)
    store = SqliteStore(str(tmp_path / "state.db"))
    warehouse = Warehouse(layout, clock=clock, on_change=store.save)
    checkin_operator(warehouse, "ana", EquipmentType.FORKLIFT, "SA-01")

    with pytest.raises(DispatchError):
        warehouse.checkin("ana", "EQ-ana", "RA-01")

    restored = Warehouse(layout, clock=clock)
    store.load_into(restored)
    assert restored.operators["ana"].equipment_id == "EQ-ana"
