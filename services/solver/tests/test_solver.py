import numpy as np
import pytest

from app.solver import FLUID, INLET, OUTLET, SOLID, SetupError, Simulation

PAD = 2


def box_grid(w: int, h: int, dx: float = 0.1, inlet=None, outlet=None, inflow=(0.5, 0.0)) -> dict:
    """A w x h cell fluid box surrounded by solid cells.

    inlet / outlet: 'left' or 'right' to open that whole side.
    """
    nx, ny = w + 2 * PAD, h + 2 * PAD
    T = np.full((ny, nx), SOLID, dtype=np.uint8)
    B = np.full((ny, nx), -1, dtype=np.int16)
    T[PAD : PAD + h, PAD : PAD + w] = FLUID
    boundaries = []
    for side, kind in ((inlet, INLET), (outlet, OUTLET)):
        if side is None:
            continue
        col = PAD - 1 if side == "left" else PAD + w
        T[PAD : PAD + h, col] = kind
        B[PAD : PAD + h, col] = len(boundaries)
        boundaries.append({"index": len(boundaries), "inflow_velocity": list(inflow) if kind == INLET else [0, 0]})
    return {
        "nx": nx,
        "ny": ny,
        "dx": dx,
        "origin": [0.0, 0.0],
        "cell_type": T.ravel().tolist(),
        "boundary_id": B.ravel().tolist(),
        "boundaries": boundaries,
    }


def test_closed_room_stays_at_rest():
    sim = Simulation(box_grid(20, 10))
    for _ in range(20):
        sim.step()
    assert np.abs(sim.u).max() < 1e-12 and np.abs(sim.v).max() < 1e-12


def test_inlet_without_outlet_is_rejected():
    with pytest.raises(SetupError):
        Simulation(box_grid(20, 10, inlet="left"))


def test_channel_conserves_mass():
    sim = Simulation(box_grid(40, 10, inlet="left", outlet="right"))
    for _ in range(300):
        sim.step()
    # Projection makes the velocity field divergence-free...
    assert sim.max_div < 1e-8
    # ...so what comes in through the inlet leaves through the outlet.
    q_in = sim.flux(INLET)
    assert q_in == pytest.approx(0.5 * 10 * 0.1)
    assert sim.flux(OUTLET) == pytest.approx(-q_in, rel=1e-6)
    # Far from the inlet the mean velocity equals the inflow velocity.
    uc, _ = sim.cell_velocity()
    assert uc[PAD : PAD + 10, PAD + 20].mean() == pytest.approx(0.5, rel=1e-3)


def test_channel_pressure_drops_towards_outlet():
    sim = Simulation(box_grid(40, 10, inlet="left", outlet="right"), )
    for _ in range(300):
        sim.step()
    row = sim.p[PAD + 5, PAD : PAD + 40]
    # Viscous friction at the walls needs a pressure gradient to push the air through.
    assert row[0] > row[-1]


def test_frame_layout():
    sim = Simulation(box_grid(8, 6, inlet="left", outlet="right"))
    sim.step()
    data = np.frombuffer(sim.frame_bytes(), dtype="<f4")
    assert data.size == 8 + 3 * sim.nx * sim.ny
    assert data[1] == 1  # step count


def test_advance_keeps_real_time_pace():
    sim = Simulation(box_grid(40, 10, inlet="left", outlet="right"))
    # 60 frames of 1/15 s: the overshoot of each frame must not add up.
    for _ in range(60):
        sim.advance(1 / 15, max_wall=10)
    assert sim.time == pytest.approx(4.0, abs=sim.dt + 1e-9)
