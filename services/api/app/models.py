"""Layout data model (schema version 1).

Coordinates are in metres, x to the right, y up (CFD convention; the editor
flips y for the screen). Walls are the polygon edges: wall i runs from
vertex i to vertex i+1 (wrapping around).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Room(_Model):
    vertices: list[tuple[float, float]] = Field(min_length=3, max_length=200)
    height: float = Field(2.7, gt=0, le=20, description="Ceiling height [m], used to turn 2D cells into volumes")


class Conditions(_Model):
    initial_temperature: float = Field(21.0, ge=-30, le=60, description="[°C]")
    initial_co2_ppm: float = Field(600.0, ge=0, le=50_000)
    outdoor_temperature: float = Field(10.0, ge=-50, le=60, description="[°C], temperature of inflowing air")
    outdoor_co2_ppm: float = Field(420.0, ge=0, le=50_000, description="CO2 of inflowing air")


class Opening(_Model):
    id: str = Field(min_length=1, max_length=64)
    kind: Literal["door", "window"]
    wall: int = Field(ge=0, description="Index of the wall (polygon edge) the opening sits on")
    offset: float = Field(ge=0, description="Distance from the wall's start vertex to the opening's start [m]")
    width: float = Field(gt=0, le=50)
    # Boundary condition seen by the solver:
    #   closed -> wall (no-slip)
    #   inlet  -> prescribed inflow velocity (Dirichlet on u)
    #   outlet -> prescribed pressure, zero-gradient velocity (Neumann on u)
    bc: Literal["closed", "inlet", "outlet"] = "closed"
    velocity: float = Field(0.5, ge=0, le=20, description="Inflow speed for bc='inlet' [m/s]")


class Person(_Model):
    id: str = Field(min_length=1, max_length=64)
    x: float
    y: float
    radius: float = Field(0.25, gt=0, le=1.0)
    activity: Literal["seated", "standing", "active"] = "seated"
    co2_lps: float = Field(0.005, ge=0, le=0.1, description="Exhaled CO2 [L/s]")
    heat_w: float = Field(100.0, ge=0, le=1000, description="Heat released [W]")


class Layout(_Model):
    schema_version: Literal[1] = 1
    name: str = Field("untitled", max_length=128)
    room: Room
    conditions: Conditions = Field(default_factory=Conditions)
    openings: list[Opening] = Field(default_factory=list)
    people: list[Person] = Field(default_factory=list)
