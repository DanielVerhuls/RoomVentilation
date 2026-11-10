import numpy as np
import pytest

from app.solver import BOUNDARY, FLUID, FRAME_FIELDS, FRAME_HEADER, SOLID, Settings, Simulation, saturation_vapour_density

ADIABATIC = Settings(h_surface=0.0)  # no heat/vapour exchange with floor, ceiling, walls

PAD = 2
H = 2.7


def box_grid(w: int, h: int, dx: float = 0.1, boundaries=(), conditions=None, fans=(), sources=()) -> dict:
    """A w x h cell fluid box surrounded by solid cells.

    boundaries: (side, first, last, info) - side 'left'/'right'/'bottom'/'top', cell range along it.
    sources: (i, j, heat_w, co2_lps) in fluid-cell coordinates.
    """
    nx, ny = w + 2 * PAD, h + 2 * PAD
    T = np.full((ny, nx), SOLID, dtype=np.uint8)
    B = np.full((ny, nx), -1, dtype=np.int16)
    T[PAD : PAD + h, PAD : PAD + w] = FLUID
    normals = {"left": [-1, 0], "right": [1, 0], "bottom": [0, -1], "top": [0, 1]}
    infos = []
    for k, (side, a, b, info) in enumerate(boundaries):
        for s in range(a, b):
            j, i = {
                "left": (PAD + s, PAD - 1),
                "right": (PAD + s, PAD + w),
                "bottom": (PAD - 1, PAD + s),
                "top": (PAD + h, PAD + s),
            }[side]
            T[j, i] = BOUNDARY
            B[j, i] = k
        infos.append({"index": k, "id": f"b{k}", "outward_normal": normals[side], "cells": b - a, **info})
    heat = np.zeros((ny, nx))
    co2 = np.zeros((ny, nx))
    for i, j, q, g in sources:
        heat[PAD + j, PAD + i] += q
        co2[PAD + j, PAD + i] += g
    return {
        "nx": nx,
        "ny": ny,
        "dx": dx,
        "origin": [0.0, 0.0],
        "cell_type": T.ravel().tolist(),
        "boundary_id": B.ravel().tolist(),
        "boundaries": infos,
        "room_height": H,
        "conditions": {"wind_speed": 0.0, **(conditions or {})},
        "fans": list(fans),
        "heat_source": heat.ravel().tolist(),
        "co2_source": co2.ravel().tolist(),
    }


WINDOW = {"type": "opening", "kind": "window", "open": True, "connects_to": "outside"}
DOOR = {"type": "opening", "kind": "door", "open": True, "connects_to": "indoors"}


def cross_ventilated(**kw):
    # Window on the left (west) facade, door on the right; wind from the west.
    return box_grid(
        40, 10, boundaries=[("left", 0, 10, WINDOW), ("right", 0, 10, DOOR)],
        conditions={"wind_speed": 2.0, "wind_direction": 270.0}, **kw,
    )  # fmt: skip


def run(sim, steps):
    for _ in range(steps):
        sim.step()
    return sim


def test_closed_room_stays_at_rest():
    sim = run(Simulation(box_grid(20, 10)), 20)
    assert np.abs(sim.u).max() < 1e-12 and np.abs(sim.v).max() < 1e-12


def test_wind_drives_cross_ventilation():
    sim = run(Simulation(cross_ventilated()), 400)
    assert sim.max_div < 1e-10
    q_window, q_door = sim.boundary_flows()
    assert q_window > 0 and q_door == pytest.approx(-q_window, rel=1e-6)
    # Orifice equation upper bound: u <= Cd * sqrt(2 dp / rho) with dp = 0.95 * 1/2 rho U^2.
    u_mean = q_window / (1.0 * H)
    assert 0.2 < u_mean < 0.6 * np.sqrt(2 * 0.95 * 0.5 * 1.2 * 4 / 1.2)


def test_cross_ventilation_matches_the_orifice_equation():
    # Window 1.2 m high, door 2.0 m high: the classic hand calculation for two openings in
    # series is Q = A_eff * sqrt(2 dp / rho) with 1 / A_eff^2 = sum 1 / (Cd A_i)^2.
    grid = cross_ventilated()
    grid["boundaries"][0]["height"] = 1.2
    grid["boundaries"][1]["height"] = 2.0
    sim = run(Simulation(grid), 600)
    a_window, a_door = 0.6 * 1.0 * 1.2, 0.6 * 1.0 * 2.0
    a_eff = (1 / a_window**2 + 1 / a_door**2) ** -0.5
    dp = 0.6 * 0.5 * 1.2 * 2.0**2  # windward window Cp = +0.6, indoor door 0 Pa
    expected = a_eff * np.sqrt(2 * dp / 1.2)
    # The 2D room adds some friction of its own, so allow 15 %.
    assert sim.boundary_flows()[0] == pytest.approx(expected, rel=0.15)


def test_no_wind_no_flow():
    grid = cross_ventilated()
    grid["conditions"]["wind_speed"] = 0.0
    sim = run(Simulation(grid), 50)
    assert np.abs(sim.boundary_flows()).max() < 1e-12


def test_closing_the_door_stops_the_flow():
    sim = run(Simulation(cross_ventilated()), 200)
    assert sim.boundary_flows()[0] > 0.1
    sim.update("boundary", "b1", open=False)
    run(sim, 20)
    assert np.abs(sim.boundary_flows()).max() < 1e-9
    assert sim.max_div < 1e-10


def test_balanced_units_in_airtight_room():
    units = [
        ("left", 0, 3, {"type": "vent", "kind": "vent", "mode": "supply", "flow_m3h": 100.0, "on": True}),
        ("right", 7, 10, {"type": "vent", "kind": "vent", "mode": "exhaust", "flow_m3h": 100.0, "on": True}),
    ]
    sim = run(Simulation(box_grid(30, 10, boundaries=units)), 100)
    assert sim.boundary_flows() == pytest.approx([100 / 3600, -100 / 3600])
    assert sim.max_div < 1e-10  # the pinned pressure cell must not cost mass conservation


def test_unbalanced_airtight_room_is_rescaled_or_stopped():
    supply = ("left", 0, 3, {"type": "vent", "kind": "vent", "mode": "supply", "flow_m3h": 100.0, "on": True})
    exhaust = ("right", 0, 3, {"type": "vent", "kind": "vent", "mode": "exhaust", "flow_m3h": 50.0, "on": True})
    sim = run(Simulation(box_grid(20, 10, boundaries=[supply, exhaust])), 10)
    assert sim.boundary_flows() == pytest.approx([100 / 3600, -100 / 3600])
    assert sim.notes

    sim = run(Simulation(box_grid(20, 10, boundaries=[supply])), 10)
    assert np.abs(sim.boundary_flows()).max() < 1e-12
    assert "stalled" in sim.notes[0]


def test_fan_stirs_a_closed_room():
    fan = {"id": "f", "x": 1.0, "y": 0.5, "angle": 0.0, "width": 0.4, "speed": 2.0, "on": True}
    sim = run(Simulation(box_grid(30, 10, fans=[fan])), 100)
    uc, _ = sim.cell_velocity()
    assert np.hypot(*sim.cell_velocity()).max() > 0.5
    assert uc[PAD + 5, PAD + 10] > 0  # blowing in +x through its own centre
    assert sim.max_div < 1e-10
    sim.update("fan", "f", on=False)
    assert sim.fan_forcing == []


def test_heat_and_co2_are_conserved_in_a_closed_room():
    fan = {"id": "f", "x": 1.0, "y": 0.5, "angle": 30.0, "speed": 1.0}
    grid = box_grid(20, 10, fans=[fan], sources=[(5, 5, 100.0, 0.005)])
    sim = Simulation(grid, ADIABATIC)
    T0, c0 = sim.T[sim.fluid].mean(), sim.c[sim.fluid].mean()
    run(sim, 200)
    volume = 20 * 10 * 0.01 * H
    assert sim.T[sim.fluid].mean() - T0 == pytest.approx(100 * sim.time / (1.2 * 1005 * volume), rel=1e-6)
    assert sim.c[sim.fluid].mean() - c0 == pytest.approx(0.005e-3 * sim.time / volume * 1e6, rel=1e-6)


def test_co2_reaches_the_well_mixed_steady_state_at_the_exhaust():
    units = [
        ("left", 0, 10, {"type": "vent", "kind": "vent", "mode": "supply", "flow_m3h": 1000.0, "on": True}),
        ("right", 0, 10, {"type": "vent", "kind": "vent", "mode": "exhaust", "flow_m3h": 1000.0, "on": True}),
    ]
    grid = box_grid(20, 10, boundaries=units, sources=[(10, 5, 0.0, 0.01)], conditions={"outdoor_co2_ppm": 400})
    sim = Simulation(grid)
    while sim.time < 150:  # time constant V / Q is about 2 s here
        sim.step()
    _, steady = sim.ventilation_stats()
    assert steady == pytest.approx(400 + 0.01e-3 / (1000 / 3600) * 1e6)
    # Mass balance: what leaves through the exhaust carries exactly in + generated.
    exhaust_c = sim.c[PAD : PAD + 10, PAD + 19].mean()
    assert exhaust_c == pytest.approx(steady, rel=0.01)


def test_frame_contains_only_requested_fields():
    sim = run(Simulation(cross_ventilated()), 1)
    H = len(FRAME_HEADER)
    full = np.frombuffer(sim.frame_bytes(), dtype="<f4")
    assert full.size == H + len(FRAME_FIELDS) * sim.nx * sim.ny
    some = np.frombuffer(sim.frame_bytes(["u", "v", "rh"]), dtype="<f4")
    assert some.size == H + 3 * sim.nx * sim.ny
    assert int(some[H - 1]) == 0b100011  # u, v and rh


def test_advance_keeps_real_time_pace():
    sim = Simulation(cross_ventilated())
    # 60 frames of 1/15 s: the overshoot of each frame must not add up.
    for _ in range(60):
        sim.advance(1 / 15, max_wall=10)
    assert sim.time == pytest.approx(4.0, abs=sim.dt + 1e-9)


# --- humidity, extracts, hoods ---------------------------------------------------------


def cells(grid, i0, i1, j0, j1):
    """Flat indices of the fluid cells i0 <= i < i1, j0 <= j < j1 (fluid-cell coordinates)."""
    return [(PAD + j) * grid["nx"] + PAD + i for j in range(j0, j1) for i in range(i0, i1)]


def with_sources(grid, sources=(), extracts=()):
    grid["sources"] = list(sources)
    grid["extracts"] = list(extracts)
    return grid


def test_vapour_is_conserved_below_saturation():
    grid = box_grid(20, 10, fans=[{"id": "f", "x": 1.0, "y": 0.5, "angle": 30.0, "speed": 1.0}])
    shower = {"id": "s", "type": "shower", "cells": cells(grid, 2, 5, 2, 5), "moisture_gph": 360.0, "on": True}
    sim = Simulation(with_sources(grid, [shower]), ADIABATIC)
    w0 = sim.w[sim.fluid].mean()
    run(sim, 100)
    volume = 20 * 10 * 0.01 * H
    assert sim.condensate == 0
    assert sim.w[sim.fluid].mean() - w0 == pytest.approx(0.1 * sim.time / volume, rel=1e-6)


def test_condensation_caps_humidity_and_releases_latent_heat():
    grid = box_grid(10, 10)
    shower = {"id": "s", "type": "shower", "cells": cells(grid, 0, 10, 0, 10), "moisture_gph": 36000.0, "on": True}
    sim = Simulation(with_sources(grid, [shower]), ADIABATIC)
    T0, w0 = sim.T[sim.fluid].mean(), sim.w[sim.fluid].mean()
    run(sim, 300)
    assert sim.relative_humidity()[sim.fluid].max() <= 100.0 + 1e-6
    volume = 10 * 10 * 0.01 * H
    emitted = 10.0 * sim.time  # g
    stored = (sim.w[sim.fluid].mean() - w0) * volume
    assert sim.condensate > 0
    assert stored + sim.condensate == pytest.approx(emitted, rel=1e-6)
    # Every gram that condenses gives its latent heat to the air.
    heating = 2.45e6 * sim.condensate / 1000 / (1.2 * 1005 * volume)
    assert sim.T[sim.fluid].mean() - T0 == pytest.approx(heating, rel=1e-3)
    assert sim.T[sim.fluid].mean() > T0 + 1


def test_bathroom_extract_pulls_air_through_the_door_gap():
    # 2 x 1 m room, closed door (10 x 1 cm gap... 1.0 m wide here), ceiling extract 60 m3/h.
    door = {"type": "opening", "kind": "door", "open": False, "undercut": 0.01, "height": 2.0, "connects_to": "indoors"}
    grid = box_grid(20, 10, boundaries=[("left", 0, 10, door)])
    fan = {"id": "e", "kind": "ceiling", "cells": cells(grid, 16, 19, 4, 7), "flow_m3h": 60.0, "on": True}
    sim = run(Simulation(with_sources(grid, extracts=[fan])), 300)
    q = 60 / 3600
    assert sim.boundary_flows()[0] == pytest.approx(q, rel=1e-6)  # all replacement air comes through the gap
    assert sim.max_div < 1e-10
    # Orifice equation for the gap: dp = 1/2 rho (Q / (Cd * w * h))^2, the room is at under-pressure.
    dp = 0.5 * 1.2 * (q / (0.6 * 1.0 * 0.01)) ** 2
    assert sim.p[sim.fluid].mean() == pytest.approx(-dp, rel=0.05)


def test_extract_in_an_airtight_room_stalls():
    grid = box_grid(20, 10)
    fan = {"id": "e", "kind": "ceiling", "cells": cells(grid, 16, 19, 4, 7), "flow_m3h": 60.0, "on": True}
    sim = run(Simulation(with_sources(grid, extracts=[fan])), 10)
    assert "stalled" in sim.notes[0]
    assert np.abs(sim.u).max() < 1e-12


def test_hood_catches_part_of_the_hob_emissions():
    grid = cross_ventilated()
    hob = {"id": "h", "type": "hob", "x": 2.0, "y": 0.5, "cells": cells(grid, 18, 22, 3, 7),
           "heat_w": 1000.0, "moisture_gph": 1000.0, "fumes_mgpm": 1.0, "on": True}  # fmt: skip
    hood = {"id": "e", "kind": "hood", "x": 2.0, "y": 0.5, "width": 0.6, "depth": 0.5,
            "cells": cells(grid, 18, 22, 3, 7), "flow_m3h": 400.0, "on": True}  # fmt: skip
    sim = Simulation(with_sources(grid, [hob], [hood]))
    eta = 1 - np.exp(-400 / 250)
    assert sim.capture["h"] == pytest.approx(eta)
    V = sim.cell_volume
    assert sim.source_rate["w"].sum() * V == pytest.approx((1 - eta) * 1000 / 3600)
    assert sim.balance()["moisture"]["captured_gph"] == pytest.approx(eta * 1000, abs=0.1)
    sim.update("extract", "e", on=False)
    assert sim.source_rate["w"].sum() * V == pytest.approx(1000 / 3600)


def test_saturation_vapour_density():
    # Tabulated: 17.3 g/m3 at 20 °C, 30.4 g/m3 at 30 °C.
    assert saturation_vapour_density(20.0) == pytest.approx(17.3, abs=0.1)
    assert saturation_vapour_density(30.0) == pytest.approx(30.4, abs=0.2)


def test_surfaces_take_up_the_heat_in_steady_state():
    # 1 x 1 m closed room, 100 W heater: in steady state floor, ceiling and walls take all of it.
    grid = box_grid(10, 10, sources=[(5, 5, 100.0, 0.0)], fans=[{"id": "f", "x": 0.5, "y": 0.5, "speed": 0.5}])
    sim = Simulation(grid)
    while sim.time < 700:  # time constant rho cp V / (h A) is about 85 s
        sim.step()
    T_s = sim.conditions["initial_temperature"]
    to_surfaces = (sim.settings.h_surface * sim.surface_area * (sim.T - T_s))[sim.fluid].sum()
    assert to_surfaces == pytest.approx(100.0, rel=0.01)
    assert sim.surface_area.sum() == pytest.approx(2 * 1.0 + 4 * 1.0 * H)


def test_vapour_condenses_on_surfaces_colder_than_its_dew_point():
    grid = box_grid(10, 10)
    shower = {"id": "s", "type": "shower", "cells": cells(grid, 0, 10, 0, 10), "moisture_gph": 3600.0, "heat_w": 0.0, "on": True}
    sim = run(Simulation(with_sources(grid, [shower])), 600)
    w_s = saturation_vapour_density(sim.conditions["initial_temperature"])
    assert sim.condensate > 0
    assert sim.w[sim.fluid].mean() > w_s  # air above the surface dew point keeps condensing
    assert sim.relative_humidity()[sim.fluid].max() <= 100.0 + 1e-6


def test_oscillating_fan_swings_its_footprint():
    fan = {"id": "f", "x": 1.5, "y": 0.5, "angle": 0.0, "speed": 2.0, "oscillate": True, "sweep": 60.0, "period": 4.0}
    sim = Simulation(box_grid(30, 10, fans=[fan]))
    assert sim.fan_angle(sim.fans[0], t=1.0) == pytest.approx(60.0)  # a quarter period: full swing
    assert sim.fan_angle(sim.fans[0], t=3.0) == pytest.approx(-60.0)
    masks = []
    for t in (1.0, 3.0):
        while sim.time < t:
            sim.step()
        masks.append(sim.fan_forcing[0][0].copy())
    assert (masks[0] != masks[1]).any()
    sim.update("fan", "f", oscillate=False, angle=90.0)
    assert sim.fan_angle(sim.fans[0]) == 90.0 and not sim.fans_oscillating


def test_mixing_spreads_scalars_faster():
    def spread(kappa):
        grid = box_grid(30, 10)
        src = {"id": "s", "type": "hob", "x": 0.0, "y": 0.0, "cells": cells(grid, 2, 4, 4, 6), "fumes_mgpm": 1.0, "on": True}
        sim = Simulation(with_sources(grid, [src]), Settings(kappa=kappa))
        while sim.time < 60:
            sim.step()
        f = sim.scalar["f"][sim.fluid]
        return f.max() / f.mean()  # how peaked the fume cloud is

    assert spread(0.02) < spread(0.002)
