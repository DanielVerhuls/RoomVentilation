import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main
from app.models import Layout
from app.rasterize import FLUID, INLET, OUTLET, SOLID, rasterize
from app.storage import LayoutStore
from app.validation import validate_layout


def make_layout(**overrides) -> Layout:
    data = {
        "name": "test",
        "room": {"vertices": [[0, 0], [6, 0], [6, 4], [0, 4]]},
        "openings": [
            {"id": "w1", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.2, "bc": "inlet", "velocity": 0.5},
            {"id": "d1", "kind": "door", "wall": 2, "offset": 2.0, "width": 0.9, "bc": "outlet"},
        ],
        "people": [{"id": "p1", "x": 3.0, "y": 2.0, "radius": 0.25, "heat_w": 100, "co2_lps": 0.005}],
    }
    data.update(overrides)
    return Layout.model_validate(data)


def levels(issues):
    return [i.level for i in issues]


# --- validation ---------------------------------------------------------------


def test_valid_layout_has_no_issues():
    assert validate_layout(make_layout()) == []


def test_self_intersecting_outline_is_error():
    layout = make_layout(room={"vertices": [[0, 0], [4, 4], [4, 0], [0, 4]]}, openings=[], people=[])
    assert "error" in levels(validate_layout(layout))


def test_opening_must_fit_on_wall():
    layout = make_layout(openings=[{"id": "w", "kind": "window", "wall": 1, "offset": 3.5, "width": 1.0}])
    issues = validate_layout(layout)
    assert any(i.level == "error" and "does not fit" in i.message for i in issues)


def test_overlapping_openings_are_error():
    ops = [
        {"id": "a", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.0},
        {"id": "b", "kind": "window", "wall": 0, "offset": 1.5, "width": 1.0},
    ]
    assert any("Overlaps" in i.message for i in validate_layout(make_layout(openings=ops)))


def test_inlet_without_outlet_warns():
    ops = [{"id": "w", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.0, "bc": "inlet"}]
    issues = validate_layout(make_layout(openings=ops))
    assert levels(issues) == ["warning"]
    assert "outlet" in issues[0].message


def test_person_outside_is_error():
    people = [{"id": "p", "x": 10, "y": 10}]
    assert "error" in levels(validate_layout(make_layout(people=people)))


# --- rasterization ------------------------------------------------------------


def test_rectangle_fluid_cell_count():
    grid = rasterize(make_layout(), dx=0.1)
    assert np.count_nonzero(grid.cell_type == FLUID) == 60 * 40
    # Padding keeps the outermost ring solid.
    assert (grid.cell_type[0, :] == SOLID).all() and (grid.cell_type[:, -1] == SOLID).all()


def test_openings_become_boundary_cells():
    grid = rasterize(make_layout(), dx=0.1)
    assert np.count_nonzero(grid.cell_type == INLET) == 12
    assert np.count_nonzero(grid.cell_type == OUTLET) == 9
    inlet = grid.boundaries[0]
    # Window on the bottom wall blows into the room, i.e. +y.
    assert inlet["inflow_velocity"] == pytest.approx([0.0, 0.5])


def test_clockwise_polygon_gives_same_inflow_direction():
    layout = make_layout(room={"vertices": [[0, 0], [0, 4], [6, 4], [6, 0]]})
    # Wall 3 of the clockwise outline is the bottom wall, running from (6,0) to (0,0).
    layout.openings[0].wall = 3
    layout.openings[1].wall = 1
    grid = rasterize(layout, dx=0.1)
    assert grid.boundaries[0]["inflow_velocity"] == pytest.approx([0.0, 0.5])


def test_person_sources_are_conserved():
    grid = rasterize(make_layout(), dx=0.05)
    assert grid.heat_source.sum() == pytest.approx(100)
    assert grid.co2_source.sum() == pytest.approx(0.005)


def test_tiny_person_still_emits():
    people = [{"id": "p", "x": 3.03, "y": 2.03, "radius": 0.01}]
    grid = rasterize(make_layout(people=people), dx=0.1)
    assert grid.heat_source.sum() == pytest.approx(100)


def test_l_shaped_room():
    layout = make_layout(room={"vertices": [[0, 0], [6, 0], [6, 2], [3, 2], [3, 4], [0, 4]]}, openings=[], people=[])
    grid = rasterize(layout, dx=0.1)
    assert np.count_nonzero(grid.cell_type == FLUID) == 60 * 20 + 30 * 20


# --- API ----------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "store", LayoutStore(tmp_path))
    return TestClient(main.app)


def test_api_roundtrip(client):
    body = make_layout().model_dump(mode="json")
    assert client.put("/api/layouts/office", json=body).status_code == 200
    assert client.get("/api/layouts").json() == ["office"]
    assert client.get("/api/layouts/office").json() == body
    assert client.delete("/api/layouts/office").status_code == 200
    assert client.get("/api/layouts/office").status_code == 404


def test_api_rejects_bad_names(client):
    assert client.put("/api/layouts/..%2Fevil", json=make_layout().model_dump()).status_code in (400, 404, 405)
    assert client.get("/api/layouts/a.b").status_code == 400


def test_api_rasterize(client):
    r = client.post("/api/rasterize?dx=0.1", json=make_layout().model_dump())
    assert r.status_code == 200
    data = r.json()
    assert len(data["cell_type"]) == data["nx"] * data["ny"]
    assert data["stats"]["fluid_cells"] == 2400


def test_api_rasterize_refuses_invalid(client):
    layout = make_layout(people=[{"id": "p", "x": 10, "y": 10}])
    assert client.post("/api/rasterize", json=layout.model_dump()).status_code == 422
