import time

from fastapi.testclient import TestClient

from app.demo_api import MAX_HOURS, MAX_TASKS_PER_HOUR, create_demo_app


def client():
    return TestClient(create_demo_app())


def test_page_is_served():
    response = client().get("/")

    assert response.status_code == 200
    assert "fictícios" in response.text


def test_simulation_endpoint_returns_report():
    response = client().get("/api/simulate", params={"seed": 1, "hours": 0.5})

    assert response.status_code == 200
    body = response.json()
    assert body["seed"] == 1
    assert sum(body["tasks_by_status"].values()) == body["tasks_created"]


def test_simulation_is_bounded_in_hours_and_rate():
    too_long = client().get("/api/simulate", params={"hours": MAX_HOURS + 1})
    too_busy = client().get("/api/simulate", params={"tasks_per_hour": MAX_TASKS_PER_HOUR + 1})

    assert too_long.status_code == 422
    assert too_busy.status_code == 422


def test_worst_case_simulation_fits_a_serverless_budget():
    started = time.perf_counter()
    response = client().get("/api/simulate", params={"hours": MAX_HOURS, "tasks_per_hour": MAX_TASKS_PER_HOUR})
    elapsed = time.perf_counter() - started

    assert response.status_code == 200
    assert elapsed < 10  # limite conservador frente ao maxDuration configurado


def test_demo_data_endpoints_serve_fictional_files():
    layout = client().get("/api/layout").json()
    cadastro = client().get("/api/cadastro").json()

    assert len(layout["zones"]) == 13
    assert cadastro["_aviso"].startswith("Dados fictícios")


def test_vercel_entrypoint_exposes_the_app():
    import importlib.util
    from pathlib import Path

    entry = Path(__file__).resolve().parent.parent / "api" / "index.py"
    spec = importlib.util.spec_from_file_location("vercel_entry", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.app.title == "Armazém Demo"
