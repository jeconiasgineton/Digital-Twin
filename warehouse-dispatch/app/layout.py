import heapq
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Zone:
    id: str
    name: str
    scan_codes: frozenset[str]


class Layout:
    """Mapa do armazém como grafo: zonas são nós, corredores são arestas com distância em metros."""

    def __init__(self, zones: list[Zone], edges: list[tuple[str, str, float]]):
        self.zones: dict[str, Zone] = {zone.id: zone for zone in zones}
        self._scan_to_zone: dict[str, str] = {}
        for zone in zones:
            for code in zone.scan_codes:
                if code in self._scan_to_zone:
                    raise ValueError(f"código de scan em mais de uma zona: {code}")
                self._scan_to_zone[code] = zone.id

        self._adjacency: dict[str, list[tuple[str, float]]] = {zone_id: [] for zone_id in self.zones}
        for origin, destination, meters in edges:
            if origin not in self.zones or destination not in self.zones:
                raise ValueError(f"aresta referencia zona inexistente: {origin} -> {destination}")
            if meters <= 0:
                raise ValueError(f"distância inválida entre {origin} e {destination}")
            self._adjacency[origin].append((destination, meters))
            self._adjacency[destination].append((origin, meters))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Layout":
        zones = [
            Zone(id=item["id"], name=item["name"], scan_codes=frozenset(item["scan_codes"]))
            for item in data["zones"]
        ]
        edges = [(item["from"], item["to"], float(item["meters"])) for item in data["edges"]]
        return cls(zones, edges)

    @classmethod
    def from_file(cls, path: Path) -> "Layout":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def zone_for_scan(self, scan_code: str) -> str | None:
        return self._scan_to_zone.get(scan_code)

    def distance(self, origin: str, destination: str) -> float:
        """Menor distância em metros pelo grafo; infinito se não houver caminho."""
        if origin not in self.zones or destination not in self.zones:
            raise ValueError(f"zona desconhecida: {origin} ou {destination}")
        if origin == destination:
            return 0.0

        best = {origin: 0.0}
        queue: list[tuple[float, str]] = [(0.0, origin)]
        while queue:
            cost, zone_id = heapq.heappop(queue)
            if zone_id == destination:
                return cost
            if cost > best[zone_id]:
                continue
            for neighbour, meters in self._adjacency[zone_id]:
                candidate = cost + meters
                if candidate < best.get(neighbour, math.inf):
                    best[neighbour] = candidate
                    heapq.heappush(queue, (candidate, neighbour))
        return math.inf
