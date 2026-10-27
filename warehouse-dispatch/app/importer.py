import csv
import io
from dataclasses import dataclass

from .domain import MAX_PRIORITY, MIN_PRIORITY, EquipmentType, TaskSpec
from .layout import Layout

REQUIRED_COLUMNS = ("task_id", "origin_zone", "destination_zone", "equipment_type", "priority")


@dataclass(frozen=True)
class ImportIssue:
    line: int
    message: str


def parse_tasks_csv(text: str, layout: Layout) -> tuple[list[TaskSpec], list[ImportIssue]]:
    """Valida o CSV inteiro. Quem chama deve importar apenas se não houver problemas (tudo ou nada)."""
    reader = csv.DictReader(io.StringIO(text))
    missing = [column for column in REQUIRED_COLUMNS if column not in (reader.fieldnames or [])]
    if missing:
        return [], [ImportIssue(line=1, message=f"colunas ausentes: {', '.join(missing)}")]

    specs: list[TaskSpec] = []
    issues: list[ImportIssue] = []
    seen_ids: set[str] = set()

    for line, raw in enumerate(reader, start=2):
        row = {key: (value or "").strip() for key, value in raw.items() if key is not None}
        problems: list[str] = []

        task_id = row["task_id"]
        if not task_id:
            problems.append("task_id vazio")
        elif task_id in seen_ids:
            problems.append(f"task_id duplicado no arquivo: {task_id}")

        for column in ("origin_zone", "destination_zone"):
            if row[column] not in layout.zones:
                problems.append(f"{column} desconhecida: {row[column]!r}")
        if row["origin_zone"] and row["origin_zone"] == row["destination_zone"]:
            problems.append("origem e destino iguais")

        equipment_type = None
        try:
            equipment_type = EquipmentType(row["equipment_type"])
        except ValueError:
            problems.append(f"equipment_type inválido: {row['equipment_type']!r}")

        priority = None
        try:
            priority = int(row["priority"])
            if not MIN_PRIORITY <= priority <= MAX_PRIORITY:
                problems.append(f"priority fora da faixa {MIN_PRIORITY}-{MAX_PRIORITY}")
        except ValueError:
            problems.append(f"priority não numérica: {row['priority']!r}")

        if problems:
            issues.append(ImportIssue(line=line, message="; ".join(problems)))
            continue

        seen_ids.add(task_id)
        specs.append(
            TaskSpec(
                id=task_id,
                origin_zone=row["origin_zone"],
                destination_zone=row["destination_zone"],
                equipment_type=equipment_type,
                priority=priority,
            )
        )

    return specs, issues
