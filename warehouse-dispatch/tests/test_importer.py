from app.domain import EquipmentType
from app.importer import parse_tasks_csv

HEADER = "task_id,origin_zone,destination_zone,equipment_type,priority\n"


def test_valid_file_is_parsed(layout):
    text = HEADER + "R-1,RES-A,SEP-A,pallet_jack,4\nR-2,RES-A,DOC-1,forklift,5\n"

    specs, issues = parse_tasks_csv(text, layout)

    assert issues == []
    assert [spec.id for spec in specs] == ["R-1", "R-2"]
    assert specs[1].equipment_type is EquipmentType.FORKLIFT
    assert specs[1].priority == 5


def test_missing_column_is_reported_once(layout):
    specs, issues = parse_tasks_csv("task_id,origin_zone\nR-1,RES-A\n", layout)

    assert specs == []
    assert issues[0].line == 1
    assert "destination_zone" in issues[0].message


def test_each_invalid_row_is_reported_with_its_line(layout):
    text = HEADER + (
        "R-1,RES-A,NAO-EXISTE,pallet_jack,4\n"   # zona desconhecida
        "R-2,RES-A,RES-A,pallet_jack,4\n"        # origem igual ao destino
        "R-3,RES-A,SEP-A,empilhadeira,4\n"       # tipo inválido
        "R-4,RES-A,SEP-A,pallet_jack,9\n"        # prioridade fora da faixa
        "R-5,RES-A,SEP-A,pallet_jack,abc\n"      # prioridade não numérica
    )

    specs, issues = parse_tasks_csv(text, layout)

    assert specs == []
    assert [issue.line for issue in issues] == [2, 3, 4, 5, 6]


def test_duplicate_id_inside_file_is_refused(layout):
    text = HEADER + "R-1,RES-A,SEP-A,pallet_jack,4\nR-1,RES-A,SEP-B,pallet_jack,2\n"

    specs, issues = parse_tasks_csv(text, layout)

    assert [spec.id for spec in specs] == ["R-1"]
    assert issues[0].line == 3
    assert "duplicado" in issues[0].message
