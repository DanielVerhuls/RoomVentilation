"""Layout data model (schema version 3).

Coordinates are in metres, x to the right, y up (CFD convention; the editor
flips y for the screen). Walls are the polygon edges: wall i runs from
vertex i to vertex i+1 (wrapping around). Angles are in degrees.

Boundary-condition philosophy:
  * Doors and windows are *pressure* openings. Nobody prescribes how much air
    flows through them - that follows from the pressure difference (wind on the
    facade, fans, ventilation units).
  * Ventilation units are *flow* boundaries: a fan delivers a (roughly) fixed
    volume flow, so prescribing it is physically right.
  * Free-standing fans are momentum sources inside the room.
  * Extracts (bathroom ceiling fans, cooker hoods) remove air inside the room.
  * People, showers and hobs emit heat, CO2, water vapour and cooking fumes.

Older layouts (v1: openings with bc = inlet/outlet/closed; v2: no humidity) are migrated on load.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Room(_Model):
    vertices: list[tuple[float, float]] = Field(min_length=3, max_length=200)
    height: float = Field(2.7, gt=0, le=20, description="Ceiling height [m], used to turn 2D cells into volumes")


class Conditions(_Model):
    initial_temperature: float = Field(21.0, ge=-30, le=60, description="[°C], also the air behind indoor doors")
    initial_co2_ppm: float = Field(600.0, ge=0, le=50_000, description="Also the air behind indoor doors")
    initial_rh: float = Field(50.0, ge=0, le=100, description="Relative humidity [%], also behind indoor doors")
    outdoor_temperature: float = Field(10.0, ge=-50, le=60, description="[°C]")
    outdoor_co2_ppm: float = Field(420.0, ge=0, le=50_000)
    outdoor_rh: float = Field(80.0, ge=0, le=100, description="Relative humidity outside [%]")
    wind_speed: float = Field(2.0, ge=0, le=30, description="[m/s] at building height")
    wind_direction: float = Field(180.0, ge=0, lt=360, description="Direction the wind comes FROM: 0 = north (+y), 90 = east (+x)")


class Opening(_Model):
    id: str = Field(min_length=1, max_length=64)
    kind: Literal["door", "window"]
    wall: int = Field(ge=0, description="Index of the wall (polygon edge) it sits on")
    offset: float = Field(ge=0, description="Distance from the wall's start vertex to the opening's start [m]")
    width: float = Field(gt=0, le=50)
    # The 2D model spreads everything over the full room height; the real opening height
    # scales the flow through it (orifice equation: Q = Cd * width * height * sqrt(2 dp / rho)).
    height: float | None = Field(None, gt=0, le=20, description="[m], default 2.0 for doors, 1.2 for windows")
    open: bool = True
    # A closed door usually still has a gap at the bottom - the path for the replacement air
    # of a bathroom fan. Default 1 cm for doors, 0 (tight) for windows.
    undercut: float | None = Field(None, ge=0, le=0.2, description="[m] gap under a closed door")
    # outside: wind pressure, outdoor air. indoors: 0 Pa, air like the room's initial state.
    connects_to: Literal["outside", "indoors"] = "outside"


class Vent(_Model):
    """Mechanical ventilation unit in a wall: fixed volume flow in (supply) or out (exhaust)."""

    id: str = Field(min_length=1, max_length=64)
    wall: int = Field(ge=0)
    offset: float = Field(ge=0)
    width: float = Field(0.3, gt=0, le=10)
    mode: Literal["supply", "exhaust"] = "supply"
    flow_m3h: float = Field(100.0, ge=0, le=10_000, description="Volume flow [m³/h]")
    supply_temperature: float = Field(18.0, ge=-30, le=60, description="[°C], supply mode only")
    on: bool = True


class Fan(_Model):
    """Free-standing fan: accelerates the air in its footprint towards `speed` along `angle`."""

    id: str = Field(min_length=1, max_length=64)
    x: float
    y: float
    angle: float = Field(0.0, ge=-360, le=360, description="Blowing direction, 0 = +x, counter-clockwise")
    width: float = Field(0.4, gt=0, le=3)
    speed: float = Field(2.5, ge=0, le=15, description="Air speed it drives [m/s]")
    on: bool = True
    oscillate: bool = False
    sweep: float = Field(45.0, ge=0, le=90, description="Swing amplitude: +- degrees around angle")
    period: float = Field(12.0, ge=2, le=120, description="Seconds for one full swing back and forth")


class Person(_Model):
    id: str = Field(min_length=1, max_length=64)
    x: float
    y: float
    radius: float = Field(0.25, gt=0, le=1.0)
    activity: Literal["seated", "standing", "active"] = "seated"
    co2_lps: float = Field(0.005, ge=0, le=0.1, description="Exhaled CO2 [L/s]")
    heat_w: float = Field(100.0, ge=0, le=1000, description="Heat released [W]")
    moisture_gph: float = Field(50.0, ge=0, le=1000, description="Water vapour released [g/h]")


class Shower(_Model):
    id: str = Field(min_length=1, max_length=64)
    x: float
    y: float
    width: float = Field(0.9, gt=0, le=5)
    depth: float = Field(0.9, gt=0, le=5)
    moisture_gph: float = Field(2600.0, ge=0, le=20_000, description="Water vapour while running [g/h]")
    heat_w: float = Field(800.0, ge=0, le=10_000, description="Heat given to the air while running [W]")
    on: bool = False


class Hob(_Model):
    id: str = Field(min_length=1, max_length=64)
    x: float
    y: float
    width: float = Field(0.6, gt=0, le=3)
    depth: float = Field(0.5, gt=0, le=3)
    activity: Literal["pasta", "potatoes", "custom"] = "pasta"
    # Only part of the electrical power heats the air: the rest goes into pan and food, or (boiling)
    # into evaporating water, which leaves as steam rather than as warm air.
    heat_w: float = Field(500.0, ge=0, le=20_000, description="Sensible heat given to the air [W]")
    moisture_gph: float = Field(1200.0, ge=0, le=20_000, description="Water vapour [g/h]")
    fumes_mgpm: float = Field(0.2, ge=0, le=1000, description="Cooking fumes / fine particles [mg/min]")
    on: bool = False


class Extract(_Model):
    """Air taken out inside the room: a bathroom ceiling fan or a cooker hood above a hob."""

    id: str = Field(min_length=1, max_length=64)
    kind: Literal["ceiling", "hood"] = "ceiling"
    x: float
    y: float
    width: float = Field(0.3, gt=0, le=3)
    depth: float = Field(0.3, gt=0, le=3)
    flow_m3h: float = Field(60.0, ge=0, le=5000)
    on: bool = True


class Layout(_Model):
    schema_version: Literal[3] = 3
    name: str = Field("untitled", max_length=128)
    room: Room
    conditions: Conditions = Field(default_factory=Conditions)
    openings: list[Opening] = Field(default_factory=list)
    vents: list[Vent] = Field(default_factory=list)
    fans: list[Fan] = Field(default_factory=list)
    showers: list[Shower] = Field(default_factory=list)
    hobs: list[Hob] = Field(default_factory=list)
    extracts: list[Extract] = Field(default_factory=list)
    people: list[Person] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _migrate(cls, data: Any) -> Any:
        if isinstance(data, dict) and data.get("schema_version", 1) == 1:
            data = {**data, "schema_version": 2}
            data["openings"] = [_migrate_opening_v1(o) for o in data.get("openings", [])]
        if isinstance(data, dict) and data.get("schema_version") == 2:
            data = {**data, "schema_version": 3}  # v3 only added fields with defaults
        return data


def _migrate_opening_v1(o: Any) -> Any:
    if not isinstance(o, dict) or "bc" not in o:
        return o
    o = dict(o)
    bc = o.pop("bc")
    o.pop("velocity", None)
    o["open"] = bc != "closed"
    o["connects_to"] = "indoors" if o.get("kind") == "door" else "outside"
    return o
