import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.layout import Layout
from tests.conftest import LAYOUT, FakeClock


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def client(clock):
    app = create_app(layout=Layout.from_dict(LAYOUT), clock=clock, run_ticker=False)
    with TestClient(app) as test_client:
        yield test_client


def setup_pilot(client):
    client.post("/admin/equipment", json={"id": "EQ-1", "type": "forklift"})
    client.post("/admin/operators", json={
        "id": "ana", "name": "Ana", "certifications": {"forklift": None},
    })
    csv = "task_id,origin_zone,destination_zone,equipment_type,priority\nR-1,RES-A,DOC-1,forklift,5\n"
    response = client.post("/admin/tasks/import", content=csv.encode("utf-8"))
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

    kpi = client.get("/kpi/response-time").json()
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
    csv = "task_id,origin_zone,destination_zone,equipment_type,priority\nOK,RES-A,DOC-1,forklift,2\nBAD,RES-A,XX,forklift,2\n"
    response = client.post("/admin/tasks/import", content=csv.encode("utf-8"))

    assert response.status_code == 422
    assert response.json()["created"] == 0
    assert response.json()["errors"][0]["line"] == 3
    assert client.get("/supervisor/board").json()["tasks"] == []


def test_operator_page_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Operador" in response.text
