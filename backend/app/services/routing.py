import heapq
import math
from dataclasses import dataclass
from itertools import count
from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray

from backend.app.models.terrain import (
    CostGridRequest,
    CostGridWeights,
    AnalyzedRoute,
    RouteAnalysisRequest,
    RouteAnalysisResponse,
    RouteLocation,
    RouteMode,
    RouteModeResult,
    RoutePoint,
    RouteProfilePoint,
    RouteRequest,
    RouteResponse,
    SearchAlgorithm,
)
from backend.app.services.cost_grid import build_cost_grid
from backend.app.services.terrain import SiteTerrain, classify_hazards

Cell: TypeAlias = tuple[int, int]
RouteWeights: TypeAlias = tuple[float, float, float, float]
NEIGHBORS: tuple[Cell, ...] = (
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
)


class RoutePlanningError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SearchResult:
    path: list[Cell]
    weighted_cost_m: float
    algorithm_used: SearchAlgorithm
    fallback_used: bool


def _snap_to_valid_cell(
    terrain: SiteTerrain,
    blocked: NDArray[np.bool_],
    location: RouteLocation,
) -> Cell:
    bounds = terrain.site.bounds
    if not (
        bounds.south <= location.latitude_deg <= bounds.north
        and bounds.west <= location.longitude_deg <= bounds.east
    ):
        raise RoutePlanningError(
            "waypoint_outside_site",
            "Start and end coordinates must be within the configured site bounds.",
        )

    available = np.argwhere(~blocked)
    if available.size == 0:
        raise RoutePlanningError("no_traversable_cells", "The terrain grid has no traversable cells.")

    latitude_scale = terrain.site.terrain.mars_radius_meters * math.pi / 180
    reference_latitude = math.radians(location.latitude_deg)
    longitude_scale = latitude_scale * math.cos(reference_latitude)
    distances = (
        np.square(
            (terrain.latitudes_deg[available[:, 0]] - location.latitude_deg)
            * latitude_scale
        )
        + np.square(
            (terrain.longitudes_deg[available[:, 1]] - location.longitude_deg)
            * longitude_scale
        )
    )
    nearest = available[int(np.argmin(distances))]
    return int(nearest[0]), int(nearest[1])


def _hazard_proximity(
    blocked: NDArray[np.bool_],
    cell_size_x_m: float,
    cell_size_y_m: float,
) -> NDArray[np.float64]:
    proximity = np.zeros(blocked.shape, dtype=np.float64)
    radius = 2 * max(cell_size_x_m, cell_size_y_m)
    for blocked_row, blocked_column in np.argwhere(blocked):
        row_start = max(0, int(blocked_row) - 2)
        row_end = min(blocked.shape[0], int(blocked_row) + 3)
        column_start = max(0, int(blocked_column) - 2)
        column_end = min(blocked.shape[1], int(blocked_column) + 3)
        rows = np.arange(row_start, row_end)[:, None]
        columns = np.arange(column_start, column_end)[None, :]
        distance = np.hypot(
            (rows - blocked_row) * cell_size_y_m,
            (columns - blocked_column) * cell_size_x_m,
        )
        risk = np.maximum(0.0, 1 - distance / radius)
        neighborhood = proximity[row_start:row_end, column_start:column_end]
        np.maximum(neighborhood, risk, out=neighborhood)
    proximity[blocked] = 0
    return proximity


def _mode_weights(mode: RouteMode) -> tuple[CostGridWeights, float]:
    if mode == "shortest":
        return (
            CostGridWeights(slope=0, roughness_per_100m=0, science_bonus=0),
            0,
        )
    if mode == "safest":
        return (
            CostGridWeights(slope=4, roughness_per_100m=0.75, science_bonus=0),
            5,
        )
    return (
        CostGridWeights(slope=0.6, roughness_per_100m=0.25, science_bonus=0.8),
        1,
    )


def _heuristic(
    cell: Cell,
    goal: Cell,
    cell_size_x_m: float,
    cell_size_y_m: float,
    minimum_factor: float,
) -> float:
    return math.hypot(
        (goal[1] - cell[1]) * cell_size_x_m,
        (goal[0] - cell[0]) * cell_size_y_m,
    ) * minimum_factor


def _search(
    factors: NDArray[np.float64],
    blocked: NDArray[np.bool_],
    start: Cell,
    goal: Cell,
    cell_size_x_m: float,
    cell_size_y_m: float,
    algorithm: SearchAlgorithm,
    minimum_factor: float,
) -> tuple[list[Cell], float] | None:
    if blocked[start] or blocked[goal]:
        return None
    if start == goal:
        return [start], 0.0

    serial = count()
    initial_estimate = (
        _heuristic(start, goal, cell_size_x_m, cell_size_y_m, minimum_factor)
        if algorithm == "astar"
        else 0.0
    )
    frontier: list[tuple[float, int, float, Cell]] = [
        (initial_estimate, next(serial), 0.0, start)
    ]
    distances: dict[Cell, float] = {start: 0.0}
    previous: dict[Cell, Cell] = {}

    while frontier:
        _, _, current_cost, current = heapq.heappop(frontier)
        if current_cost > distances.get(current, math.inf):
            continue
        if current == goal:
            path = [goal]
            while path[-1] != start:
                path.append(previous[path[-1]])
            path.reverse()
            return path, current_cost

        row, column = current
        for row_step, column_step in NEIGHBORS:
            next_row = row + row_step
            next_column = column + column_step
            neighbor = (next_row, next_column)
            if (
                next_row < 0
                or next_row >= blocked.shape[0]
                or next_column < 0
                or next_column >= blocked.shape[1]
                or blocked[neighbor]
            ):
                continue
            if row_step and column_step and (
                blocked[row + row_step, column]
                or blocked[row, column + column_step]
            ):
                continue

            step_distance = math.hypot(
                row_step * cell_size_y_m,
                column_step * cell_size_x_m,
            )
            step_cost = step_distance * (factors[current] + factors[neighbor]) / 2
            candidate = current_cost + step_cost
            if candidate >= distances.get(neighbor, math.inf):
                continue

            distances[neighbor] = candidate
            previous[neighbor] = current
            estimate = (
                _heuristic(
                    neighbor,
                    goal,
                    cell_size_x_m,
                    cell_size_y_m,
                    minimum_factor,
                )
                if algorithm == "astar"
                else 0.0
            )
            heapq.heappush(
                frontier,
                (candidate + estimate, next(serial), candidate, neighbor),
            )

    return None


def find_path(
    factors: NDArray[np.float64],
    blocked: NDArray[np.bool_],
    start: Cell,
    goal: Cell,
    cell_size_x_m: float,
    cell_size_y_m: float,
    algorithm: SearchAlgorithm = "astar",
    minimum_factor: float = 1.0,
) -> SearchResult | None:
    result = _search(
        factors,
        blocked,
        start,
        goal,
        cell_size_x_m,
        cell_size_y_m,
        algorithm,
        minimum_factor,
    )
    if result is not None:
        return SearchResult(result[0], result[1], algorithm, False)
    if algorithm == "dijkstra":
        return None

    fallback = _search(
        factors,
        blocked,
        start,
        goal,
        cell_size_x_m,
        cell_size_y_m,
        "dijkstra",
        minimum_factor,
    )
    if fallback is None:
        return None
    return SearchResult(fallback[0], fallback[1], "dijkstra", True)


def _route_point(terrain: SiteTerrain, cell: Cell) -> RoutePoint:
    row, column = cell
    return RoutePoint(
        row=row,
        column=column,
        latitude_deg=float(terrain.latitudes_deg[row]),
        longitude_deg=float(terrain.longitudes_deg[column]),
        elevation_m=float(terrain.elevation_m[row, column]),
        slope_deg=float(terrain.slope_deg[row, column]),
    )


def _make_mode_route(
    terrain: SiteTerrain,
    request: RouteRequest,
    blocked: NDArray[np.bool_],
    start: Cell,
    goal: Cell,
    mode: RouteMode,
) -> RouteModeResult:
    weights, hazard_proximity_weight = _mode_weights(mode)
    if mode == "safest" and request.dust_storm:
        weights = CostGridWeights(
            slope=6,
            roughness_per_100m=1,
            science_bonus=0,
        )
        hazard_proximity_weight = 7
    try:
        cost_grid = build_cost_grid(
            terrain,
            CostGridRequest(
                site_id=request.site_id,
                slope_limit_deg=request.slope_limit_deg,
                weights=weights,
                science_points=request.science_points,
                dust_storm=request.dust_storm,
            ),
        )
    except ValueError as error:
        raise RoutePlanningError("invalid_route_inputs", str(error)) from error
    base_distance = cost_grid.base_distance_m
    cost_values = np.asarray(
        [
            [base_distance if value is None else value for value in row]
            for row in cost_grid.cost_m
        ],
        dtype=np.float64,
    )
    factors = cost_values / base_distance
    if mode == "safest" or hazard_proximity_weight:
        factors += hazard_proximity_weight * _hazard_proximity(
            blocked,
            terrain.cell_size_x_m,
            terrain.cell_size_y_m,
        )
    factors[blocked] = 1.0

    search = find_path(
        factors,
        blocked,
        start,
        goal,
        terrain.cell_size_x_m,
        terrain.cell_size_y_m,
        request.search_algorithm,
        minimum_factor=0.1 if mode == "science" else 1.0,
    )
    if search is None:
        raise RoutePlanningError(
            "route_unreachable",
            f"No traversable path is available for the {mode} route.",
        )

    distance = sum(
        math.hypot(
            (second[0] - first[0]) * terrain.cell_size_y_m,
            (second[1] - first[1]) * terrain.cell_size_x_m,
        )
        for first, second in zip(search.path, search.path[1:])
    )
    points = [_route_point(terrain, cell) for cell in search.path]
    note = (
        "No verified science points were supplied; this route has no science-site "
        "bonus and defaults to its terrain-weighted objective."
        if mode == "science" and not request.science_points
        else "Heuristic route over coarse MOLA terrain; not operational navigation guidance."
    )
    return RouteModeResult(
        mode=mode,
        distance_m=distance,
        weighted_cost_m=search.weighted_cost_m,
        steepest_slope_deg=max(point.slope_deg for point in points),
        algorithm_used=search.algorithm_used,
        fallback_used=search.fallback_used,
        path=points,
        science_points_used=len(request.science_points),
        note=note,
    )


def plan_routes(terrain: SiteTerrain, request: RouteRequest) -> RouteResponse:
    if request.site_id != terrain.site.id:
        raise RoutePlanningError(
            "site_mismatch",
            "The requested site does not match the loaded terrain.",
        )
    if (
        terrain.elevation_m.ndim != 2
        or terrain.slope_deg.shape != terrain.elevation_m.shape
        or terrain.latitudes_deg.size != terrain.elevation_m.shape[0]
        or terrain.longitudes_deg.size != terrain.elevation_m.shape[1]
    ):
        raise RoutePlanningError(
            "invalid_terrain_grid",
            "Elevation, slope, and coordinate arrays do not align.",
        )

    if not (
        np.isfinite(terrain.elevation_m).all()
        and np.isfinite(terrain.slope_deg).all()
        and np.isfinite(terrain.latitudes_deg).all()
        and np.isfinite(terrain.longitudes_deg).all()
        and terrain.cell_size_x_m > 0
        and terrain.cell_size_y_m > 0
    ):
        raise RoutePlanningError(
            "invalid_terrain_grid",
            "Terrain values and cell sizes must be finite and positive.",
        )

    try:
        blocked = classify_hazards(terrain.slope_deg, request.slope_limit_deg)
        start = _snap_to_valid_cell(terrain, blocked, request.start)
        end = _snap_to_valid_cell(terrain, blocked, request.end)
    except RoutePlanningError:
        raise
    except ValueError as error:
        raise RoutePlanningError("invalid_terrain_grid", str(error)) from error

    routes = [
        _make_mode_route(terrain, request, blocked, start, end, mode)
        for mode in ("shortest", "safest", "science")
    ]
    return RouteResponse(
        site_id=terrain.site.id,
        coordinate_system=terrain.site.coordinate_system,
        slope_limit_deg=request.slope_limit_deg,
        start_cell=_route_point(terrain, start),
        end_cell=_route_point(terrain, end),
        requested_algorithm=request.search_algorithm,
        routes=routes,
        safety_notice=(
            "Routes use coarse, interpolated MOLA samples (~463 m/cell) and an "
            "illustrative slope threshold. They are demo planning outputs, not "
            "certified astronaut safety or navigation guidance."
        ),
    )


def analyze_routes(
    terrain: SiteTerrain,
    request: RouteAnalysisRequest,
) -> RouteAnalysisResponse:
    route_request = RouteRequest(
        site_id=request.site_id,
        start=request.start,
        end=request.end,
        slope_limit_deg=request.slope_limit_deg,
        search_algorithm=request.search_algorithm,
        science_points=request.science_points,
        dust_storm=request.dust_storm,
    )
    planned = plan_routes(terrain, route_request)
    analyzed_routes: list[AnalyzedRoute] = []
    for route in planned.routes:
        cumulative_distance_m = 0.0
        ascent_m = 0.0
        descent_m = 0.0
        profile: list[RouteProfilePoint] = []
        previous_point: RoutePoint | None = None

        for point in route.path:
            if previous_point is not None:
                row_step = point.row - previous_point.row
                column_step = point.column - previous_point.column
                cumulative_distance_m += math.hypot(
                    row_step * terrain.cell_size_y_m,
                    column_step * terrain.cell_size_x_m,
                )
                elevation_change = point.elevation_m - previous_point.elevation_m
                ascent_m += max(0.0, elevation_change)
                descent_m += max(0.0, -elevation_change)
            profile.append(
                RouteProfilePoint(
                    **point.model_dump(),
                    distance_from_start_m=cumulative_distance_m,
                )
            )
            previous_point = point

        walking_time_seconds = route.distance_m / request.walking_speed_m_s
        walking_time_hours = walking_time_seconds / 3600
        effective_power_rate_w = request.power_rate_w * (
            1.25 if request.dust_storm else 1.0
        )
        analyzed_routes.append(
            AnalyzedRoute(
                **route.model_dump(),
                walking_time_seconds=walking_time_seconds,
                ascent_m=ascent_m,
                descent_m=descent_m,
                oxygen_liters=walking_time_seconds / 60 * request.oxygen_rate_l_per_min,
                power_wh=walking_time_hours * effective_power_rate_w,
                water_liters=walking_time_hours * request.water_rate_l_per_hour,
                elevation_profile=profile,
            )
        )

    return RouteAnalysisResponse(
        site_id=planned.site_id,
        coordinate_system=planned.coordinate_system,
        slope_limit_deg=planned.slope_limit_deg,
        requested_algorithm=planned.requested_algorithm,
        walking_speed_m_s=request.walking_speed_m_s,
        oxygen_rate_l_per_min=request.oxygen_rate_l_per_min,
        power_rate_w=request.power_rate_w * (1.25 if request.dust_storm else 1.0),
        water_rate_l_per_hour=request.water_rate_l_per_hour,
        dust_storm=request.dust_storm,
        routes=analyzed_routes,
        model_notice=(
            "Walking speed and oxygen, power, and water rates are illustrative "
            "model inputs, not astronaut-certified suit telemetry or predictions."
            + (
                " Dust-storm mode applies an illustrative 25% power-use increase "
                "and increases safest-route slope, roughness, and hazard-proximity "
                "penalties as a visibility-risk proxy."
                if request.dust_storm
                else ""
            )
        ),
        safety_notice=planned.safety_notice,
    )
