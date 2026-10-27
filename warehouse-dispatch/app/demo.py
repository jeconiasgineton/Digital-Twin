"""Cliente fictício 'Armazém Demo' para testar o sistema antes de um cliente real.

Tudo aqui é inventado: mapa, frota, operadores e tarefas. A simulação usa um relógio próprio
e um gerador de números com semente, então o mesmo comando sempre produz o mesmo resultado.

Uso:
    python -m app.demo simulate --seed 42 --hours 2
    python -m app.demo seed --url http://localhost:8000 --admin-token X --integration-token Y
"""

import argparse
import json
import random
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from .domain import EquipmentType, RejectReason, TaskSpec, TaskStatus
from .layout import Layout
from .warehouse import DispatchError, Warehouse

DEMO_DIR = Path(__file__).resolve().parent.parent / "config" / "demo"
SIM_START = datetime(2026, 10, 27, 8, 0, tzinfo=timezone.utc)

SPEED_M_PER_S = {EquipmentType.PALLET_JACK: 1.1, EquipmentType.FORKLIFT: 1.6}
MOVE_OVERHEAD_SECONDS = 3.0
PICK_SECONDS = (20.0, 40.0)
REPLY_SECONDS = (2.0, 8.0)
ACCEPT_SHARE = 0.9
SILENT_SHARE = 0.05  # operadores que não respondem e deixam a oferta expirar
FORKLIFT_SHARE = 0.3
PRIORITY_WEIGHTS = {1: 10, 2: 20, 3: 40, 4: 20, 5: 10}
ORIGINS = ("RES-A", "RES-B", "RES-C")
DESTINATIONS = ("SEP-A", "SEP-B", "SEP-C", "SEP-D")


# Carga dos dados fictícios

def load_layout() -> Layout:
    return Layout.from_file(DEMO_DIR / "layout.json")


def load_cadastro() -> dict[str, Any]:
    return json.loads((DEMO_DIR / "cadastro.json").read_text(encoding="utf-8"))


def _certifications(raw: dict[str, str | None]) -> dict[EquipmentType, date | None]:
    return {
        EquipmentType(kind): (date.fromisoformat(expires) if expires else None)
        for kind, expires in raw.items()
    }


def scan_code_for(layout: Layout, zone_id: str) -> str:
    return sorted(layout.zones[zone_id].scan_codes)[0]


def seed_warehouse(warehouse: Warehouse, cadastro: dict[str, Any]) -> int:
    """Carrega cadastro e turno direto no estado em memória. Devolve o número de check-ins."""
    for item in cadastro["equipment"]:
        warehouse.register_equipment(item["id"], EquipmentType(item["type"]))
    for item in cadastro["operators"]:
        warehouse.register_operator(item["id"], item["name"], _certifications(item["certifications"]))
    for item in cadastro["shift"]:
        warehouse.checkin(item["operator"], item["equipment"], item["scan_code"])
    return len(cadastro["shift"])


def generate_tasks(rng: random.Random, count: int, prefix: str = "RP") -> list[TaskSpec]:
    """Reposições de picking: reserva para separação, com mix de equipamentos e prioridades."""
    priorities = list(PRIORITY_WEIGHTS)
    weights = list(PRIORITY_WEIGHTS.values())
    specs = []
    for index in range(1, count + 1):
        equipment = EquipmentType.FORKLIFT if rng.random() < FORKLIFT_SHARE else EquipmentType.PALLET_JACK
        specs.append(TaskSpec(
            id=f"{prefix}-{index:05d}",
            origin_zone=rng.choice(ORIGINS),
            destination_zone=rng.choice(DESTINATIONS),
            equipment_type=equipment,
            priority=rng.choices(priorities, weights)[0],
        ))
    return specs


# Alimentação pela API (cliente HTTP, real ou de teste)

def seed_api(
    client: Any,
    cadastro: dict[str, Any],
    admin_headers: dict[str, str],
    integration_headers: dict[str, str],
    tasks: int = 30,
    seed: int = 42,
) -> dict[str, int]:
    """Cadastra, faz o turno e envia tarefas pelo endpoint de integração. Rodar em base limpa."""
    layout = load_layout()
    for item in cadastro["equipment"]:
        client.post("/admin/equipment", json=item, headers=admin_headers).raise_for_status()
    for item in cadastro["operators"]:
        payload = {"id": item["id"], "name": item["name"], "certifications": item["certifications"]}
        client.post("/admin/operators", json=payload, headers=admin_headers).raise_for_status()
    for item in cadastro["shift"]:
        payload = {
            "event_id": str(uuid.uuid4()),
            "equipment_id": item["equipment"],
            "scan_code": item["scan_code"],
        }
        client.post(f"/operators/{item['operator']}/checkin", json=payload).raise_for_status()

    specs = generate_tasks(random.Random(seed), tasks)
    batch = [
        {
            "external_id": spec.id,
            "origin_zone": spec.origin_zone,
            "destination_zone": spec.destination_zone,
            "equipment_type": spec.equipment_type.value,
            "priority": spec.priority,
        }
        for spec in specs
    ]
    if batch:
        client.post("/integrations/tasks", json={"tasks": batch}, headers=integration_headers).raise_for_status()
    return {
        "equipment": len(cadastro["equipment"]),
        "operators": len(cadastro["operators"]),
        "checkins": len(cadastro["shift"]),
        "tasks": len(batch),
        "zones": len(layout.zones),
    }


# Simulação

class SimClock:
    def __init__(self, start: datetime):
        self.now = start

    def __call__(self) -> datetime:
        return self.now


@dataclass
class _Runner:
    """Comportamento simulado de um operador: reage a ofertas e executa a tarefa atual."""

    phase: str = "idle"  # idle | to_origin | working
    task_id: str | None = None
    due: datetime | None = None
    offer_id: str | None = None
    reply_due: datetime | None = None
    accepts: bool = True
    reason: RejectReason = RejectReason.OTHER
    silent: bool = False


def _travel(warehouse: Warehouse, origin: str, destination: str, equipment_type: EquipmentType) -> timedelta:
    meters = warehouse.layout.distance(origin, destination)
    return timedelta(seconds=meters / SPEED_M_PER_S[equipment_type] + MOVE_OVERHEAD_SECONDS)


def _step_operator(
    warehouse: Warehouse,
    layout: Layout,
    operator_id: str,
    runner: _Runner,
    rng: random.Random,
) -> None:
    now = warehouse.now()

    offer, _ = warehouse.current(operator_id)
    if offer is None:
        runner.offer_id = None
        runner.reply_due = None
    elif offer.id != runner.offer_id:
        runner.offer_id = offer.id
        runner.reply_due = now + timedelta(seconds=rng.uniform(*REPLY_SECONDS))
        runner.silent = rng.random() < SILENT_SHARE
        runner.accepts = rng.random() < ACCEPT_SHARE
        runner.reason = rng.choice(list(RejectReason))
    elif not runner.silent and now >= runner.reply_due:
        try:
            if runner.accepts:
                warehouse.accept(offer.id, operator_id)
            else:
                warehouse.reject(offer.id, operator_id, runner.reason)
        except DispatchError:
            pass  # a oferta pode ter expirado no mesmo instante

    _, active = warehouse.current(operator_id)
    if active is None:
        runner.phase, runner.task_id = "idle", None
        return

    operator = warehouse.operators[operator_id]
    equipment_type = warehouse.equipment[operator.equipment_id].type

    if active.status is TaskStatus.ASSIGNED:
        if runner.task_id != active.id:
            runner.task_id = active.id
            runner.phase = "to_origin"
            runner.due = now + _travel(warehouse, operator.zone_id, active.origin_zone, equipment_type)
        if now >= runner.due:
            warehouse.arrive(active.id, operator_id, scan_code_for(layout, active.origin_zone))
            runner.phase = "working"
            pick = timedelta(seconds=rng.uniform(*PICK_SECONDS))
            runner.due = now + pick + _travel(warehouse, active.origin_zone, active.destination_zone, equipment_type)
    elif active.status is TaskStatus.IN_PROGRESS and now >= runner.due:
        warehouse.complete(active.id, operator_id, scan_code_for(layout, active.destination_zone))
        runner.phase, runner.task_id = "idle", None


def simulate(
    seed: int = 42,
    hours: float = 2.0,
    tasks_per_hour: float = 90,
    offer_timeout_seconds: int = 20,
) -> dict[str, Any]:
    rng = random.Random(seed)
    clock = SimClock(SIM_START)
    layout = load_layout()
    warehouse = Warehouse(layout, offer_timeout=timedelta(seconds=offer_timeout_seconds), clock=clock)
    seed_warehouse(warehouse, load_cadastro())

    runners = {
        operator_id: _Runner()
        for operator_id, operator in warehouse.operators.items()
        if operator.equipment_id is not None
    }

    total = round(tasks_per_hour * hours)
    specs = generate_tasks(rng, total, prefix="SIM")
    arrivals = sorted(rng.uniform(0, hours * 3600) for _ in range(total))
    end = SIM_START + timedelta(hours=hours)

    created = 0
    seconds_in_state: Counter[str] = Counter()
    while clock() < end:
        while created < total and SIM_START + timedelta(seconds=arrivals[created]) <= clock():
            warehouse.ingest_tasks([specs[created]])
            created += 1

        warehouse.tick()
        for operator_id, runner in runners.items():
            _step_operator(warehouse, layout, operator_id, runner, rng)
            seconds_in_state[_state_of(runner)] += 1
        warehouse.tick()

        if created == total and all(t.status is TaskStatus.COMPLETED for t in warehouse.tasks.values()):
            break
        clock.now += timedelta(seconds=1)

    return _report(warehouse, seed, hours, len(runners), created, seconds_in_state)


def _state_of(runner: _Runner) -> str:
    return {"to_origin": "empty_travel", "working": "working"}.get(runner.phase, "idle")


def _report(
    warehouse: Warehouse,
    seed: int,
    hours: float,
    operators: int,
    created: int,
    seconds_in_state: Counter[str],
) -> dict[str, Any]:
    statuses = Counter(task.status.value for task in warehouse.tasks.values())
    events = Counter(event["type"] for event in warehouse.events)
    response = warehouse.response_summary()
    total_seconds = sum(seconds_in_state.values())
    return {
        "seed": seed,
        "hours_simulated": hours,
        "operators": operators,
        "tasks_created": created,
        "tasks_by_status": dict(statuses),
        "events": dict(events),
        "response_time_seconds": {
            "median": _round(response["median_response_seconds"]),
            "mean": _round(response["mean_response_seconds"]),
            "median_accept": _round(response["median_accept_seconds"]),
            "arrived_count": response["arrived_count"],
        },
        "operator_time_share": {
            state: round(seconds_in_state[state] / total_seconds, 3) if total_seconds else 0.0
            for state in ("idle", "empty_travel", "working")
        },
    }


def _round(value: float | None) -> float | None:
    return round(value, 1) if value is not None else None


# CLI

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.demo", description="Cliente fictício Armazém Demo")
    commands = parser.add_subparsers(dest="command", required=True)

    simulate_cmd = commands.add_parser("simulate", help="roda a simulação e imprime o relatório")
    simulate_cmd.add_argument("--seed", type=int, default=42)
    simulate_cmd.add_argument("--hours", type=float, default=2.0)
    simulate_cmd.add_argument("--tasks-per-hour", type=float, default=90)

    seed_cmd = commands.add_parser("seed", help="carrega o cliente fictício num servidor em execução")
    seed_cmd.add_argument("--url", required=True)
    seed_cmd.add_argument("--admin-token", required=True)
    seed_cmd.add_argument("--integration-token", required=True)
    seed_cmd.add_argument("--tasks", type=int, default=30)
    seed_cmd.add_argument("--seed", type=int, default=42)

    args = parser.parse_args(argv)
    if args.command == "simulate":
        report = simulate(seed=args.seed, hours=args.hours, tasks_per_hour=args.tasks_per_hour)
    else:
        with httpx.Client(base_url=args.url, timeout=10) as client:
            report = seed_api(
                client,
                load_cadastro(),
                admin_headers={"X-Admin-Token": args.admin_token},
                integration_headers={"X-Integration-Token": args.integration_token},
                tasks=args.tasks,
                seed=args.seed,
            )
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
