import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.demo import (
    DEMO_DIR,
    ORIGINS,
    DESTINATIONS,
    load_cadastro,
    load_layout,
    seed_api,
    seed_warehouse,
    simulate,
)
from app.domain import EquipmentType
from app.warehouse import DispatchError, Warehouse
from tests.conftest import FakeClock

ADMIN = {"X-Admin-Token": "admin-secret"}
INTEGRATION = {"X-Integration-Token": "integration-secret"}


@pytest.fixture
def demo_warehouse():
    layout = load_layout()
    warehouse = Warehouse(layout, clock=FakeClock())
    seed_warehouse(warehouse, load_cadastro())
    return warehouse


def test_every_replenishment_route_is_reachable():
    layout = load_layout()
    for origin in ORIGINS:
        for destination in DESTINATIONS:
            assert layout.distance(origin, destination) < float("inf"), (origin, destination)


def test_every_scan_code_is_unique_and_mapped():
    layout = load_layout()
    codes = [code for zone in layout.zones.values() for code in zone.scan_codes]
    assert len(codes) == len(set(codes))
    assert all(layout.zone_for_scan(code) for code in codes)


def test_shift_loads_cleanly_and_matches_equipment_types(demo_warehouse):
    assert len(demo_warehouse.operators) == 12
    on_shift = [op for op in demo_warehouse.operators.values() if op.equipment_id]
    assert len(on_shift) == 9
    for operator in on_shift:
        assert operator.zone_id is not None


def test_expired_forklift_certification_blocks_checkin(demo_warehouse):
    # OP-05 tem validade vencida em 2026-06-30, antes da data fixada no relógio de teste.
    demo_warehouse.register_equipment("EM-99", EquipmentType.FORKLIFT)

    with pytest.raises(DispatchError, match="habilitação"):
        demo_warehouse.checkin("OP-05", "EM-99", "CN-01")


def test_simulation_is_deterministic_for_the_same_seed():
    assert simulate(seed=7, hours=0.5) == simulate(seed=7, hours=0.5)


def test_simulation_accounts_for_every_task():
    report = simulate(seed=3, hours=1)

    assert sum(report["tasks_by_status"].values()) == report["tasks_created"]
    assert report["tasks_created"] == round(90 * 1)
    assert report["tasks_by_status"].get("completed", 0) > 0


def test_simulation_reports_operator_time_shares_that_add_up():
    report = simulate(seed=5, hours=1)

    assert sum(report["operator_time_share"].values()) == pytest.approx(1.0, abs=0.01)
    assert report["operator_time_share"]["idle"] > 0  # a ociosidade é a dor que o sistema mede


def test_simulation_exercises_rejection_and_expiry_paths():
    report = simulate(seed=42, hours=2)

    assert report["events"].get("task.rejected", 0) > 0
    assert report["events"].get("task.expired", 0) > 0


def test_seed_api_loads_the_demo_through_http_endpoints():
    app = create_app(
        layout_path=DEMO_DIR / "layout.json",
        run_ticker=False,
        admin_token="admin-secret",
        integration_token="integration-secret",
    )
    with TestClient(app) as client:
        counts = seed_api(client, load_cadastro(), ADMIN, INTEGRATION, tasks=12, seed=1)

        zones = client.get("/supervisor/zones", headers=ADMIN).json()["zones"]
        on_shift = sum(zone["operators_on_shift"] for zone in zones)

        assert counts["operators"] == 12
        assert counts["tasks"] == 12
        assert on_shift == 9
        assert sum(zone["pending_tasks"] for zone in zones) == 12
