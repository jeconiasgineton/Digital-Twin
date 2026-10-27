"""Demonstração pública do Armazém Demo, pronta para rodar em serverless.

Sem estado e sem banco: cada requisição de simulação roda do zero com a semente informada.
O despacho em produção não está aqui; ele depende de banco externo e de um agendamento para o tick.
"""

import json
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse

from .demo import DEMO_DIR, simulate

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Limites para caber no tempo de execução de uma função serverless.
MAX_HOURS = 2.0
MAX_TASKS_PER_HOUR = 150


def create_demo_app() -> FastAPI:
    app = FastAPI(title="Armazém Demo", version="0.1.0")

    @app.get("/")
    def page() -> FileResponse:
        return FileResponse(STATIC_DIR / "demo.html")

    @app.get("/api/simulate")
    def run_simulation(
        seed: int = Query(42, ge=0, le=10_000),
        hours: float = Query(2.0, gt=0, le=MAX_HOURS),
        tasks_per_hour: float = Query(90, gt=0, le=MAX_TASKS_PER_HOUR),
    ) -> JSONResponse:
        report = simulate(seed=seed, hours=hours, tasks_per_hour=tasks_per_hour)
        return JSONResponse(report)

    @app.get("/api/layout")
    def layout() -> JSONResponse:
        return JSONResponse(json.loads((DEMO_DIR / "layout.json").read_text(encoding="utf-8")))

    @app.get("/api/cadastro")
    def cadastro() -> JSONResponse:
        return JSONResponse(json.loads((DEMO_DIR / "cadastro.json").read_text(encoding="utf-8")))

    return app


app = create_demo_app()
