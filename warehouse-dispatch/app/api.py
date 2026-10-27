import asyncio
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .domain import EquipmentType, RejectReason, Task
from .importer import parse_tasks_csv
from .layout import Layout
from .warehouse import DispatchError, Warehouse

PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
DEFAULT_LAYOUT = Path(os.environ.get("WD_LAYOUT", PACKAGE_DIR.parent / "config" / "layout.example.json"))


class EventIn(BaseModel):
    event_id: str = Field(min_length=1, max_length=100)


class OperatorEventIn(EventIn):
    operator_id: str = Field(min_length=1, max_length=50)


class CheckinIn(EventIn):
    equipment_id: str
    scan_code: str


class ScanIn(OperatorEventIn):
    scan_code: str


class RejectIn(OperatorEventIn):
    reason: RejectReason


class EquipmentIn(BaseModel):
    id: str = Field(min_length=1, max_length=50)
    type: EquipmentType


class OperatorIn(BaseModel):
    id: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=120)
    certifications: dict[EquipmentType, date | None] = {}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def task_view(task: Task) -> dict[str, Any]:
    return {
        "id": task.id,
        "origin_zone": task.origin_zone,
        "destination_zone": task.destination_zone,
        "equipment_type": task.equipment_type.value,
        "priority": task.priority,
        "status": task.status.value,
        "offer_expires_at": _iso(task.offer_expires_at),
        "assigned_operator_id": task.assigned_operator_id,
        "created_at": _iso(task.created_at),
        "accepted_at": _iso(task.accepted_at),
        "arrived_at": _iso(task.arrived_at),
        "completed_at": _iso(task.completed_at),
    }


def create_app(
    layout: Layout | None = None,
    layout_path: Path | None = None,
    offer_timeout_seconds: int = 20,
    clock: Callable[[], datetime] | None = None,
    run_ticker: bool = True,
) -> FastAPI:
    warehouse_kwargs: dict[str, Any] = {"offer_timeout": timedelta(seconds=offer_timeout_seconds)}
    if clock is not None:
        warehouse_kwargs["clock"] = clock
    warehouse = Warehouse(layout or Layout.from_file(layout_path or DEFAULT_LAYOUT), **warehouse_kwargs)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ticker = asyncio.create_task(_tick_forever(warehouse)) if run_ticker else None
        yield
        if ticker is not None:
            ticker.cancel()

    app = FastAPI(title="Warehouse Dispatch", version="0.1.0", lifespan=lifespan)
    app.state.warehouse = warehouse

    @app.exception_handler(DispatchError)
    async def _handle_dispatch_error(_: Request, error: DispatchError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=error.status_code)

    @app.get("/")
    def operator_page() -> FileResponse:
        return FileResponse(STATIC_DIR / "operador.html")

    # Cadastro (sem autenticação nesta fase: restrito à rede interna do piloto)

    @app.post("/admin/equipment", status_code=201)
    def register_equipment(body: EquipmentIn) -> dict[str, str]:
        warehouse.register_equipment(body.id, body.type)
        return {"id": body.id, "type": body.type.value}

    @app.post("/admin/operators", status_code=201)
    def register_operator(body: OperatorIn) -> dict[str, str]:
        warehouse.register_operator(body.id, body.name, body.certifications)
        return {"id": body.id, "name": body.name}

    @app.post("/admin/tasks/import")
    async def import_tasks(request: Request) -> JSONResponse:
        text = (await request.body()).decode("utf-8-sig")
        specs, issues = parse_tasks_csv(text, warehouse.layout)
        if issues:
            errors = [{"line": issue.line, "message": issue.message} for issue in issues]
            return JSONResponse({"created": 0, "errors": errors}, status_code=422)
        warehouse.add_tasks(specs)
        return JSONResponse({"created": len(specs), "errors": []}, status_code=201)

    # Operador

    @app.post("/operators/{operator_id}/checkin")
    def checkin(operator_id: str, body: CheckinIn) -> dict[str, Any]:
        return warehouse.once(
            body.event_id,
            lambda: warehouse.checkin(operator_id, body.equipment_id, body.scan_code),
        )

    @app.post("/operators/{operator_id}/checkout")
    def checkout(operator_id: str, body: EventIn) -> dict[str, Any]:
        return warehouse.once(body.event_id, lambda: warehouse.checkout(operator_id))

    @app.get("/operators/{operator_id}/current")
    def current(operator_id: str) -> dict[str, Any]:
        offer, active = warehouse.current(operator_id)
        return {
            "offer": task_view(offer) if offer else None,
            "task": task_view(active) if active else None,
        }

    @app.post("/tasks/{task_id}/accept")
    def accept(task_id: str, body: OperatorEventIn) -> dict[str, Any]:
        return warehouse.once(
            body.event_id,
            lambda: task_view(warehouse.accept(task_id, body.operator_id)),
        )

    @app.post("/tasks/{task_id}/reject")
    def reject(task_id: str, body: RejectIn) -> dict[str, Any]:
        return warehouse.once(
            body.event_id,
            lambda: task_view(warehouse.reject(task_id, body.operator_id, body.reason)),
        )

    @app.post("/tasks/{task_id}/arrive")
    def arrive(task_id: str, body: ScanIn) -> dict[str, Any]:
        return warehouse.once(
            body.event_id,
            lambda: task_view(warehouse.arrive(task_id, body.operator_id, body.scan_code)),
        )

    @app.post("/tasks/{task_id}/complete")
    def complete(task_id: str, body: ScanIn) -> dict[str, Any]:
        return warehouse.once(
            body.event_id,
            lambda: task_view(warehouse.complete(task_id, body.operator_id, body.scan_code)),
        )

    # Supervisão e KPI

    @app.get("/supervisor/board")
    def board() -> dict[str, Any]:
        with warehouse.lock:
            return {
                "tasks": [task_view(task) for task in warehouse.tasks.values()],
                "operators": [
                    {
                        "id": operator.id,
                        "name": operator.name,
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
            }

    @app.get("/kpi/response-time")
    def response_time() -> dict[str, Any]:
        return warehouse.response_summary()

    return app


async def _tick_forever(warehouse: Warehouse) -> None:
    while True:
        await asyncio.sleep(1)
        await asyncio.to_thread(warehouse.tick)
