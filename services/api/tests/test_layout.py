import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main
from app.models import Layout
from app.rasterize import BOUNDARY, FLUID, SOLID, rasterize
from app.storage import LayoutStore
from app.validation import validate_layout


def make_layout(**overrides) -> Layout:
    data = {
        "name": "test",
        "room": {"vertices": [[0, 0], [6, 0], [6, 4], [0, 4]]},
        "openings": [
            {"id": "w1", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.2, "open": True},
            {"id": "d1", "kind": "door", "wall": 2, "offset": 2.0, "width": 0.9, "connects_to": "indoors"},
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
    assert any(i.level == "error" and "does not fit" in i.message.lower() for i in issues)


def test_overlapping_openings_are_error():
    ops = [
        {"id": "a", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.0},
        {"id": "b", "kind": "window", "wall": 0, "offset": 1.5, "width": 1.0},
    ]
    assert any("Overlaps" in i.message for i in validate_layout(make_layout(openings=ops)))


def test_single_opening_warns_no_net_flow():
    ops = [{"id": "w", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.0}]
    issues = validate_layout(make_layout(openings=ops))
    assert levels(issues) == ["warning"]
    assert "no net flow" in issues[0].message


def test_no_wind_warns_air_at_rest():
    issues = validate_layout(make_layout(conditions={"wind_speed": 0}))
    assert any("stays at rest" in i.message for i in issues)


def test_unbalanced_vents_in_closed_room_warn():
    vents = [{"id": "v", "wall": 1, "offset": 1.0, "mode": "supply", "flow_m3h": 100}]
    closed = [{"id": "w", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.0, "open": False}]
    issues = validate_layout(make_layout(openings=closed, vents=vents))
    assert any("unbalanced" in i.message for i in issues)


def test_vent_overlapping_window_is_error():
    vents = [{"id": "v", "wall": 0, "offset": 1.5, "mode": "exhaust"}]
    assert any("Overlaps" in i.message for i in validate_layout(make_layout(vents=vents)))


def test_v1_layout_is_migrated():
    layout = Layout.model_validate(
        {
            "schema_version": 1,
            "room": {"vertices": [[0, 0], [6, 0], [6, 4], [0, 4]]},
            "openings": [
                {"id": "w", "kind": "window", "wall": 0, "offset": 1, "width": 1, "bc": "inlet", "velocity": 0.5},
                {"id": "d", "kind": "door", "wall": 2, "offset": 1, "width": 1, "bc": "closed"},
            ],
        }
    )
    assert layout.schema_version == 3
    assert (layout.openings[0].open, layout.openings[0].connects_to) == (True, "outside")
    assert (layout.openings[1].open, layout.openings[1].connects_to) == (False, "indoors")


def test_person_outside_is_error():
    people = [{"id": "p", "x": 10, "y": 10}]
    assert "error" in levels(validate_layout(make_layout(people=people)))


# --- rasterization ------------------------------------------------------------


def test_rectangle_fluid_cell_count():
    grid = rasterize(make_layout(), dx=0.1)
    assert np.count_nonzero(grid.cell_type == FLUID) == 60 * 40
    # Padding keeps the outermost ring solid.
    assert (grid.cell_type[0, :] == SOLID).all() and (grid.cell_type[:, -1] == SOLID).all()


def test_wall_items_become_boundary_cells():
    vents = [{"id": "v", "wall": 1, "offset": 1.0, "width": 0.3, "mode": "exhaust"}]
    grid = rasterize(make_layout(vents=vents), dx=0.1)
    assert np.count_nonzero(grid.cell_type == BOUNDARY) == 12 + 9 + 3
    assert [b["cells"] for b in grid.boundaries] == [12, 9, 3]
    assert [b["type"] for b in grid.boundaries] == ["opening", "opening", "vent"]
    # The window sits on the bottom wall, so its outward normal points down.
    assert grid.boundaries[0]["outward_normal"] == pytest.approx([0.0, -1.0])
    assert np.count_nonzero(grid.boundary_id == 2) == 3
    assert [b.get("height") for b in grid.boundaries] == [1.2, 2.0, None]


def test_clockwise_polygon_gives_same_outward_normal():
    layout = make_layout(room={"vertices": [[0, 0], [0, 4], [6, 4], [6, 0]]})
    # Wall 3 of the clockwise outline is the bottom wall, running from (6,0) to (0,0).
    layout.openings[0].wall = 3
    layout.openings[1].wall = 1
    grid = rasterize(layout, dx=0.1)
    assert grid.boundaries[0]["outward_normal"] == pytest.approx([0.0, -1.0])


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
    assert data["room_height"] == 2.7 and data["conditions"]["wind_speed"] == 2.0 and data["fans"] == []


def test_api_rasterize_refuses_invalid(client):
    layout = make_layout(people=[{"id": "p", "x": 10, "y": 10}])
    assert client.post("/api/rasterize", json=layout.model_dump()).status_code == 422


def test_sources_and_extracts_are_rasterized():
    layout = make_layout(
        showers=[{"id": "s", "x": 1.0, "y": 1.0, "on": True}],
        hobs=[{"id": "h", "x": 4.0, "y": 3.0, "activity": "potatoes", "heat_w": 2000, "fumes_mgpm": 3}],
        extracts=[{"id": "e", "kind": "hood", "x": 4.0, "y": 3.0, "width": 0.6, "depth": 0.5, "flow_m3h": 400}],
    )
    grid = rasterize(layout, dx=0.1).to_dict()
    by_id = {s["id"]: s for s in grid["sources"]}
    assert set(by_id) == {"p1", "s", "h"}
    assert len(by_id["s"]["cells"]) == 9 * 9  # 0.9 x 0.9 m shower at 10 cm
    assert by_id["h"]["fumes_mgpm"] == 3 and by_id["p1"]["moisture_gph"] == 50
    assert len(grid["extracts"][0]["cells"]) == 6 * 5
    assert grid["boundaries"][1]["undercut"] == 0.01 and grid["boundaries"][0]["undercut"] == 0.0


def test_extract_without_replacement_air_warns():
    closed = [{"id": "w", "kind": "window", "wall": 0, "offset": 1.0, "width": 1.0, "open": False}]
    extract = [{"id": "e", "x": 3, "y": 2}]
    issues = validate_layout(make_layout(openings=closed, extracts=extract))
    assert any("under-pressure" in i.message for i in issues)
    # A closed door keeps its 1 cm gap, which is enough to feed the fan.
    door = [{"id": "d", "kind": "door", "wall": 2, "offset": 1.0, "width": 0.9, "open": False}]
    issues = validate_layout(make_layout(openings=door, extracts=extract))
    assert not any("under-pressure" in i.message for i in issues)


def test_hob_without_hood_warns():
    issues = validate_layout(make_layout(hobs=[{"id": "h", "x": 4.0, "y": 3.0}]))
    assert any("No cooker hood" in i.message for i in issues)
