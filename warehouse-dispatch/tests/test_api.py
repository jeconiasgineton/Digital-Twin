import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.layout import Layout
from tests.conftest import LAYOUT, FakeClock

ADMIN = {"X-Admin-Token": "admin-secret"}
INTEGRATION = {"X-Integration-Token": "integration-secret"}
CSV_HEADER = "task_id,origin_zone,destination_zone,equipment_type,priority\n"


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def client(clock):
    app = create_app(
        layout=Layout.from_dict(LAYOUT),
        clock=clock,
        run_ticker=False,
        admin_token="admin-secret",
        integration_token="integration-secret",
    )
    with TestClient(app) as test_client:
        yield test_client


def setup_pilot(client):
    client.post("/admin/equipment", json={"id": "EQ-1", "type": "forklift"}, headers=ADMIN)
    client.post("/admin/operators", headers=ADMIN, json={
        "id": "ana", "name": "Ana", "certifications": {"forklift": None},
    })
    csv = CSV_HEADER + "R-1,RES-A,DOC-1,forklift,5\n"
    response = client.post("/admin/tasks/import", content=csv.encode("utf-8"), headers=ADMIN)
    assert response.status_code == 201
    assert response.json()["created"] == 1


def test_full_operator_flow_through_api(client, clock):
    setup_pilot(client)
    checkin = client.post("/operators/ana/checkin", json={
        "event_id": "c1", "equipment_id": "EQ-1", "scan_code": "SA-01",
    })
    assert checkin.status_code == 200

    client.app.state.warehouse.tick()
    offer = client.get("/operators/ana/current").json()["offer"]
    assert offer["id"] == "R-1"
    assert offer["status"] == "offered"

    clock.advance(3)
    accepted = client.post("/tasks/R-1/accept", json={"event_id": "a1", "operator_id": "ana"})
    assert accepted.json()["status"] == "assigned"

    clock.advance(7)
    arrived = client.post("/tasks/R-1/arrive", json={
        "event_id": "ar1", "operator_id": "ana", "scan_code": "RA-01",
    })
    assert arrived.json()["status"] == "in_progress"

    client.post("/tasks/R-1/complete", json={
        "event_id": "co1", "operator_id": "ana", "scan_code": "D1-01",
    })

    kpi = client.get("/kpi/response-time", headers=ADMIN).json()
    assert kpi["arrived_count"] == 1
    assert kpi["median_response_seconds"] == 10.0


def test_repeated_event_returns_original_result_without_reapplying(client):
    setup_pilot(client)
    client.post("/operators/ana/checkin", json={
        "event_id": "c1", "equipment_id": "EQ-1", "scan_code": "SA-01",
    })
    client.app.state.warehouse.tick()

    first = client.post("/tasks/R-1/accept", json={"event_id": "same", "operator_id": "ana"})
    retry = client.post("/tasks/R-1/accept", json={"event_id": "same", "operator_id": "ana"})

    assert first.status_code == retry.status_code == 200
    assert first.json() == retry.json()


def test_business_error_has_status_and_message(client):
    setup_pilot(client)
    response = client.post("/tasks/R-1/accept", json={"event_id": "x", "operator_id": "ana"})

    assert response.status_code == 409
    assert "não está ofertada" in response.json()["detail"]


def test_import_is_all_or_nothing(client):
    csv = CSV_HEADER + "OK,RES-A,DOC-1,forklift,2\nBAD,RES-A,XX,forklift,2\n"
    response = client.post("/admin/tasks/import", content=csv.encode("utf-8"), headers=ADMIN)

    assert response.status_code == 422
    assert response.json()["created"] == 0
    assert response.json()["errors"][0]["line"] == 3
    assert client.get("/supervisor/zones", headers=ADMIN).json()["zones"][1]["pending_tasks"] == 0


def test_admin_routes_require_token(client):
    assert client.post("/admin/equipment", json={"id": "E", "type": "forklift"}).status_code == 401
    wrong = client.post("/admin/equipment", json={"id": "E", "type": "forklift"},
                        headers={"X-Admin-Token": "nope"})
    assert wrong.status_code == 401
    assert client.get("/kpi/response-time").status_code == 401
    assert client.get("/supervisor/zones", headers=INTEGRATION).status_code == 401


def test_integration_routes_require_their_own_token(client):
    assert client.get("/integrations/events").status_code == 401
    assert client.get("/integrations/events", headers=ADMIN).status_code == 401


def test_app_without_configured_token_stays_closed(clock):
    app = create_app(layout=Layout.from_dict(LAYOUT), clock=clock, run_ticker=False,
                     admin_token="", integration_token="")
    with TestClient(app) as closed:
        assert closed.get("/kpi/response-time", headers={"X-Admin-Token": ""}).status_code == 401


def test_wms_ingest_is_idempotent_and_rejects_changed_content(client):
    task = {"external_id": "WMS-9", "origin_zone": "RES-A", "destination_zone": "SEP-A",
            "equipment_type": "pallet_jack", "priority": 3}
    first = client.post("/integrations/tasks", json={"tasks": [task]}, headers=INTEGRATION)
    again = client.post("/integrations/tasks", json={"tasks": [task]}, headers=INTEGRATION)

    assert first.json() == {"created": ["WMS-9"], "skipped": []}
    assert again.json() == {"created": [], "skipped": ["WMS-9"]}

    changed = dict(task, priority=5)
    conflict = client.post("/integrations/tasks", json={"tasks": [changed]}, headers=INTEGRATION)
    assert conflict.status_code == 409


def test_wms_ingest_rejects_unknown_zone_before_creating_anything(client):
    batch = {"tasks": [
        {"external_id": "OK", "origin_zone": "RES-A", "destination_zone": "SEP-A",
         "equipment_type": "forklift", "priority": 2},
        {"external_id": "BAD", "origin_zone": "RES-A", "destination_zone": "NAO-EXISTE",
         "equipment_type": "forklift", "priority": 2},
    ]}
    response = client.post("/integrations/tasks", json=batch, headers=INTEGRATION)

    assert response.status_code == 422
    assert response.json()["errors"][0]["external_id"] == "BAD"
    assert client.get("/integrations/events", headers=INTEGRATION).json()["events"] == []


def test_event_feed_pages_with_cursor(client, clock):
    setup_pilot(client)
    client.post("/operators/ana/checkin", json={
        "event_id": "c1", "equipment_id": "EQ-1", "scan_code": "SA-01",
    })
    client.app.state.warehouse.tick()
    client.post("/tasks/R-1/accept", json={"event_id": "a1", "operator_id": "ana"})

    page_one = client.get("/integrations/events?limit=1", headers=INTEGRATION).json()
    page_two = client.get(f"/integrations/events?after={page_one['next']}", headers=INTEGRATION).json()

    assert [event["type"] for event in page_one["events"]] == ["task.offered"]
    assert [event["type"] for event in page_two["events"]] == ["task.accepted"]
    assert page_two["next"] == 2


def test_operator_page_and_pwa_files_are_served(client):
    assert "Operador" in client.get("/").text
    assert client.get("/manifest.webmanifest").status_code == 200
    assert "fetch" in client.get("/sw.js").text


def test_state_survives_restart_and_keeps_idempotency(tmp_path, clock):
    db = str(tmp_path / "state.db")
    options = dict(layout=Layout.from_dict(LAYOUT), clock=clock, run_ticker=False,
                   admin_token="admin-secret", integration_token="integration-secret", db_path=db)

    with TestClient(create_app(**options)) as first_run:
        setup_pilot(first_run)
        first_run.post("/operators/ana/checkin", json={
            "event_id": "c1", "equipment_id": "EQ-1", "scan_code": "SA-01",
        })
        first_run.app.state.warehouse.tick()
        original = first_run.post("/tasks/R-1/accept", json={"event_id": "a1", "operator_id": "ana"}).json()

    with TestClient(create_app(**options)) as second_run:
        current = second_run.get("/operators/ana/current").json()
        assert current["task"]["id"] == "R-1"
        assert current["task"]["status"] == "assigned"
        replay = second_run.post("/tasks/R-1/accept", json={"event_id": "a1", "operator_id": "ana"})
        assert replay.json() == original
        assert second_run.get("/integrations/events", headers=INTEGRATION).json()["next"] == 2


def test_zone_summary_contains_no_operator_identity(client):
    setup_pilot(client)
    client.post("/operators/ana/checkin", json={
        "event_id": "c1", "equipment_id": "EQ-1", "scan_code": "SA-01",
    })

    body = client.get("/supervisor/zones", headers=ADMIN).text

    assert "ana" not in body.lower()
    assert "operators_on_shift" in body
