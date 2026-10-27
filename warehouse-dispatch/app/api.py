import asyncio
import hmac
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .domain import MAX_PRIORITY, MIN_PRIORITY, EquipmentType, RejectReason, Task, TaskSpec
from .importer import parse_tasks_csv
from .layout import Layout
from .store import SqliteStore
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


class IntegrationTaskIn(BaseModel):
    external_id: str = Field(min_length=1, max_length=100)
    origin_zone: str = Field(min_length=1, max_length=50)
    destination_zone: str = Field(min_length=1, max_length=50)
    equipment_type: EquipmentType
    priority: int = Field(ge=MIN_PRIORITY, le=MAX_PRIORITY)


class IntegrationBatchIn(BaseModel):
    tasks: list[IntegrationTaskIn] = Field(min_length=1, max_length=500)


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
    db_path: str | None = None,
    admin_token: str | None = None,
    integration_token: str | None = None,
) -> FastAPI:
    admin_token = admin_token if admin_token is not None else os.environ.get("WD_ADMIN_TOKEN")
    integration_token = (
        integration_token if integration_token is not None else os.environ.get("WD_INTEGRATION_TOKEN")
    )
    db_path = db_path if db_path is not None else os.environ.get("WD_DB")

    warehouse_kwargs: dict[str, Any] = {"offer_timeout": timedelta(seconds=offer_timeout_seconds)}
    if clock is not None:
        warehouse_kwargs["clock"] = clock
    store = SqliteStore(db_path) if db_path else None
    warehouse = Warehouse(
        layout or Layout.from_file(layout_path or DEFAULT_LAYOUT),
        on_change=store.save if store else None,
        **warehouse_kwargs,
    )
    if store is not None:
        store.load_into(warehouse)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ticker = asyncio.create_task(_tick_forever(warehouse)) if run_ticker else None
        yield
        if ticker is not None:
            ticker.cancel()
        if store is not None:
            store.close()

    app = FastAPI(title="Warehouse Dispatch", version="0.2.0", lifespan=lifespan)
    app.state.warehouse = warehouse

    def _guard(header: str, expected: str | None) -> Callable[[Request], None]:
        def check(request: Request) -> None:
            supplied = request.headers.get(header, "")
            # Sem token configurado, a rota fica fechada. Não existe acesso anônimo.
            if not expected or not hmac.compare_digest(supplied, expected):
                raise DispatchError("token inválido ou ausente", status_code=401)

        return check

    admin_only = Depends(_guard("X-Admin-Token", admin_token))
    integration_only = Depends(_guard("X-Integration-Token", integration_token))

    @app.exception_handler(DispatchError)
    async def _handle_dispatch_error(_: Request, error: DispatchError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=error.status_code)

    # Interface e PWA

    @app.get("/")
    def operator_page() -> FileResponse:
        return FileResponse(STATIC_DIR / "operador.html")

    @app.get("/manifest.webmanifest")
    def manifest() -> FileResponse:
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js")
    def service_worker() -> FileResponse:
        # Na raiz para que o escopo do service worker cubra a aplicação inteira.
        return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript")

    # Administração (token X-Admin-Token)

    @app.post("/admin/equipment", status_code=201, dependencies=[admin_only])
    def register_equipment(body: EquipmentIn) -> dict[str, str]:
        warehouse.register_equipment(body.id, body.type)
        return {"id": body.id, "type": body.type.value}

    @app.post("/admin/operators", status_code=201, dependencies=[admin_only])
    def register_operator(body: OperatorIn) -> dict[str, str]:
        warehouse.register_operator(body.id, body.name, body.certifications)
        return {"id": body.id, "name": body.name}

    @app.post("/admin/tasks/import", dependencies=[admin_only])
    async def import_tasks(request: Request) -> JSONResponse:
        text = (await request.body()).decode("utf-8-sig")
        specs, issues = parse_tasks_csv(text, warehouse.layout)
        if issues:
            errors = [{"line": issue.line, "message": issue.message} for issue in issues]
            return JSONResponse({"created": 0, "errors": errors}, status_code=422)
        warehouse.add_tasks(specs)
        return JSONResponse({"created": len(specs), "errors": []}, status_code=201)

    # Integração com WMS (token X-Integration-Token)

    @app.post("/integrations/tasks", dependencies=[integration_only])
    def ingest_tasks(body: IntegrationBatchIn) -> dict[str, Any]:
        unknown = [
            {"external_id": item.external_id, "message": f"zona desconhecida: {zone}"}
            for item in body.tasks
            for zone in (item.origin_zone, item.destination_zone)
            if zone not in warehouse.layout.zones
        ]
        if unknown:
            return JSONResponse({"detail": "zonas desconhecidas", "errors": unknown}, status_code=422)
        specs = [
            TaskSpec(
                id=item.external_id,
                origin_zone=item.origin_zone,
                destination_zone=item.destination_zone,
                equipment_type=item.equipment_type,
                priority=item.priority,
            )
            for item in body.tasks
        ]
        return warehouse.ingest_tasks(specs)

    @app.get("/integrations/events", dependencies=[integration_only])
    def events(after: int = 0, limit: int = 200) -> dict[str, Any]:
        limit = max(1, min(limit, 500))
        batch = warehouse.events_after(max(after, 0), limit)
        next_cursor = batch[-1]["seq"] if batch else max(after, 0)
        return {"events": batch, "next": next_cursor}

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

    # Supervisão e KPI (token X-Admin-Token, sem identificar operadores)

    @app.get("/supervisor/zones", dependencies=[admin_only])
    def zones() -> dict[str, Any]:
        return {"zones": warehouse.zone_summary()}

    @app.get("/kpi/response-time", dependencies=[admin_only])
    def response_time() -> dict[str, Any]:
        return warehouse.response_summary()

    return app


async def _tick_forever(warehouse: Warehouse) -> None:
    while True:
        await asyncio.sleep(1)
        await asyncio.to_thread(warehouse.tick)
