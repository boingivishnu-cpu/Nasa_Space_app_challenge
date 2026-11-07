import math

import numpy as np
from numpy.typing import NDArray

from backend.app.models.terrain import CostGridRequest, CostGridResponse
from backend.app.services.terrain import SiteTerrain, classify_hazards


def _local_relief(elevation_m: NDArray[np.float64]) -> NDArray[np.float64]:
    padded = np.pad(elevation_m, 1, mode="edge")
    neighborhoods = [
        padded[row : row + elevation_m.shape[0], column : column + elevation_m.shape[1]]
        for row in range(3)
        for column in range(3)
    ]
    return np.maximum.reduce(neighborhoods) - np.minimum.reduce(neighborhoods)


def _science_proximity(
    terrain: SiteTerrain,
    request: CostGridRequest,
) -> NDArray[np.float64]:
    proximity = np.zeros(terrain.elevation_m.shape, dtype=np.float64)
    bounds = terrain.site.bounds
    radius = request.weights.science_radius_m
    mars_radius = terrain.site.terrain.mars_radius_meters
    reference_latitude = math.radians(float(np.mean(terrain.latitudes_deg)))

    for point in request.science_points:
        if not (
            bounds.south <= point.latitude_deg <= bounds.north
            and bounds.west <= point.longitude_deg <= bounds.east
        ):
            raise ValueError(
                f"Science point '{point.name}' is outside configured site bounds."
            )

        north_distance = np.radians(terrain.latitudes_deg - point.latitude_deg) * mars_radius
        east_distance = (
            np.radians(terrain.longitudes_deg - point.longitude_deg)
            * mars_radius
            * math.cos(reference_latitude)
        )
        distance = np.hypot(north_distance[:, None], east_distance[None, :])
        point_proximity = np.exp(-0.5 * np.square(distance / radius))
        proximity = np.maximum(proximity, point_proximity)

    return proximity


def build_cost_grid(
    terrain: SiteTerrain,
    request: CostGridRequest,
) -> CostGridResponse:
    """Build per-cardinal-cell traversal costs; diagonal steps scale by distance."""
    expected_shape = terrain.elevation_m.shape
    if (
        terrain.elevation_m.ndim != 2
        or request.site_id != terrain.site.id
        or terrain.slope_deg.shape != expected_shape
        or terrain.latitudes_deg.ndim != 1
        or terrain.longitudes_deg.ndim != 1
        or len(terrain.latitudes_deg) != expected_shape[0]
        or len(terrain.longitudes_deg) != expected_shape[1]
    ):
        raise ValueError("Terrain site, arrays, and coordinates must match the request.")
    if (
        not np.isfinite(terrain.elevation_m).all()
        or not np.isfinite(terrain.latitudes_deg).all()
        or not np.isfinite(terrain.longitudes_deg).all()
        or terrain.cell_size_x_m <= 0
        or terrain.cell_size_y_m <= 0
    ):
        raise ValueError("Terrain elevations, coordinates, and cell sizes must be valid.")

    no_go = classify_hazards(terrain.slope_deg, request.slope_limit_deg)
    roughness = _local_relief(terrain.elevation_m)
    proximity = _science_proximity(terrain, request)
    base_distance = math.sqrt(terrain.cell_size_x_m * terrain.cell_size_y_m)
    weights = request.weights

    slope_penalty = (
        base_distance
        * weights.slope
        * np.square(terrain.slope_deg / request.slope_limit_deg)
    )
    roughness_penalty = (
        base_distance * weights.roughness_per_100m * (roughness / 100.0)
    )
    science_bonus = base_distance * weights.science_bonus * proximity
    cost = np.maximum(
        base_distance + slope_penalty + roughness_penalty - science_bonus,
        base_distance * 0.1,
    )
    cost_grid: list[list[float | None]] = [
        [
            None if no_go[row, column] else float(cost[row, column])
            for column in range(cost.shape[1])
        ]
        for row in range(cost.shape[0])
    ]

    return CostGridResponse(
        site_id=terrain.site.id,
        coordinate_system=terrain.site.coordinate_system,
        pixel_resolution_degrees=1 / terrain.site.terrain.pixels_per_degree,
        rows=int(cost.shape[0]),
        columns=int(cost.shape[1]),
        latitudes_deg=terrain.latitudes_deg.tolist(),
        longitudes_deg=terrain.longitudes_deg.tolist(),
        elevation_m=terrain.elevation_m.tolist(),
        cost_m=cost_grid,
        base_distance_m=base_distance,
        slope_penalty_m=slope_penalty.tolist(),
        roughness_m=roughness.tolist(),
        roughness_penalty_m=roughness_penalty.tolist(),
        science_bonus_m=science_bonus.tolist(),
        no_go_mask=no_go.tolist(),
        slope_limit_deg=request.slope_limit_deg,
        blocked_cells=int(no_go.sum()),
        total_cells=int(no_go.size),
        science_points_used=len(request.science_points),
        weights=weights,
        cost_definition=(
            "Per-cardinal-cell equivalent meters: base distance plus normalized "
            "slope and 3x3 local-relief penalties, less the nearest science-point "
            "Gaussian bonus. Costs are floored at 10% of base distance; cells "
            "above the slope limit are blocked (null). Scale diagonal movement "
            "by its physical distance in pathfinding."
        ),
    )
