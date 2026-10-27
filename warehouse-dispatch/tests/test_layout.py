import math

import pytest

from app.layout import Layout


def test_distance_uses_shortest_path_through_corridors(layout):
    assert layout.distance("RES-A", "SEP-A") == 30
    assert layout.distance("SEP-B", "RES-A") == 80  # SEP-B -> SEP-A -> RES-A
    assert layout.distance("SEP-A", "SEP-A") == 0


def test_distance_is_infinite_when_zone_has_no_corridor(layout):
    layout_with_island = Layout.from_dict(
        {
            "zones": [
                {"id": "A", "name": "A", "scan_codes": ["A-1"]},
                {"id": "B", "name": "B", "scan_codes": ["B-1"]},
            ],
            "edges": [],
        }
    )
    assert math.isinf(layout_with_island.distance("A", "B"))


def test_scan_code_resolves_to_zone(layout):
    assert layout.zone_for_scan("SA-01") == "SEP-A"
    assert layout.zone_for_scan("XX-99") is None


def test_scan_code_cannot_belong_to_two_zones():
    with pytest.raises(ValueError, match="mais de uma zona"):
        Layout.from_dict(
            {
                "zones": [
                    {"id": "A", "name": "A", "scan_codes": ["X"]},
                    {"id": "B", "name": "B", "scan_codes": ["X"]},
                ],
                "edges": [],
            }
        )


def test_edge_must_reference_existing_zones():
    with pytest.raises(ValueError, match="zona inexistente"):
        Layout.from_dict(
            {
                "zones": [{"id": "A", "name": "A", "scan_codes": ["A-1"]}],
                "edges": [{"from": "A", "to": "Z", "meters": 10}],
            }
        )


def test_distance_rejects_unknown_zone(layout):
    with pytest.raises(ValueError):
        layout.distance("RES-A", "NAO-EXISTE")
