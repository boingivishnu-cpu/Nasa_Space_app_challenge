from fastapi import APIRouter, HTTPException, Query

from backend.app.models.terrain import (
    CostGridRequest,
    CostGridResponse,
    ElevationGridResponse,
    GoNoGoRequest,
    GoNoGoResponse,
    HazardGridResponse,
    RouteAnalysisRequest,
    RouteAnalysisResponse,
    RouteRequest,
    RouteResponse,
    SiteResponse,
)
from backend.app.services.cost_grid import build_cost_grid
from backend.app.services.routing import RoutePlanningError, analyze_routes, plan_routes
from backend.app.services.resources import evaluate_go_nogo
from backend.app.services.terrain import (
    EARTH_TO_MARS_NOTES,
    classify_hazards,
    get_site_config,
    get_site_terrain,
)

router = APIRouter(tags=["terrain"])


def _get_site(site_id: str):
    try:
        return get_site_config(site_id)
    except KeyError as error:
        raise HTTPException(
            status_code=404,
            detail={"code": "site_not_found", "message": f"Unknown site: {site_id}"},
        ) from error


def _get_terrain(site_id: str):
    try:
        return get_site_terrain(site_id)
    except KeyError as error:
        raise HTTPException(
            status_code=404,
            detail={"code": "site_not_found", "message": f"Unknown site: {site_id}"},
        ) from error


def _grid_response(site_id: str) -> dict[str, object]:
    terrain = _get_terrain(site_id)
    source = terrain.site.terrain
    return {
        "site_id": site_id,
        "rows": int(terrain.elevation_m.shape[0]),
        "columns": int(terrain.elevation_m.shape[1]),
        "latitudes_deg": terrain.latitudes_deg.tolist(),
        "longitudes_deg": terrain.longitudes_deg.tolist(),
        "elevation_m": terrain.elevation_m.tolist(),
        "cell_size_m": {
            "east_west": terrain.cell_size_x_m,
            "north_south": terrain.cell_size_y_m,
        },
        "source": source.source,
        "product_id": source.product_id,
        "product_url": source.product_url,
        "label_url": source.label_url,
        "pixel_resolution_degrees": 1 / source.pixels_per_degree,
        "missing_observation_bins_interpolated": True,
        "coordinate_system": terrain.site.coordinate_system,
    }


@router.get(
    "/site",
    response_model=SiteResponse,
    responses={404: {"model": dict}},
    summary="Get configured Mars site",
)
def site(site_id: str = Query(default="jezero", min_length=1, max_length=64)):
    return {"site": _get_site(site_id)}


@router.get(
    "/elevation",
    response_model=ElevationGridResponse,
    responses={404: {"model": dict}, 503: {"model": dict}},
    summary="Get MOLA elevation grid for a configured site",
)
def elevation(site_id: str = Query(default="jezero", min_length=1, max_length=64)):
    return _grid_response(site_id)


@router.get(
    "/hazards",
    response_model=HazardGridResponse,
    responses={404: {"model": dict}, 503: {"model": dict}},
    summary="Compute slope hazards for a configured site",
)
def hazards(
    site_id: str = Query(default="jezero", min_length=1, max_length=64),
    slope_limit_deg: float = Query(default=25.0, gt=0, le=90),
):
    grid = _grid_response(site_id)
    terrain = _get_terrain(site_id)
    try:
        no_go_mask = classify_hazards(terrain.slope_deg, slope_limit_deg)
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_terrain_grid", "message": str(error)},
        ) from error

    return {
        **grid,
        "slope_limit_deg": slope_limit_deg,
        "slope_deg": terrain.slope_deg.tolist(),
        "no_go_mask": no_go_mask.tolist(),
        "blocked_cells": int(no_go_mask.sum()),
        "total_cells": int(no_go_mask.size),
        "hazard_definition": (
            f"Cells with MOLA-derived slope greater than {slope_limit_deg:g} degrees "
            "are marked no-go. This is a demo terrain screening rule, not a certified "
            "astronaut safety limit. MOLA data are interpolated in bins without "
            "observations."
        ),
        "slope_method": EARTH_TO_MARS_NOTES,
    }


@router.post(
    "/cost-grid",
    response_model=CostGridResponse,
    responses={404: {"model": dict}, 422: {"model": dict}, 503: {"model": dict}},
    summary="Build weighted traversal costs for a configured site",
)
def cost_grid(request: CostGridRequest):
    terrain = _get_terrain(request.site_id)
    try:
        return build_cost_grid(terrain, request)
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_cost_grid", "message": str(error)},
        ) from error


@router.post(
    "/route",
    response_model=RouteResponse,
    responses={404: {"model": dict}, 422: {"model": dict}, 503: {"model": dict}},
    summary="Compute shortest, safest, and science-weighted Marswalk routes",
)
def route(request: RouteRequest):
    terrain = _get_terrain(request.site_id)
    try:
        return plan_routes(terrain, request)
    except RoutePlanningError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": error.code, "message": str(error)},
        ) from error


@router.post(
    "/analyze",
    response_model=RouteAnalysisResponse,
    responses={404: {"model": dict}, 422: {"model": dict}, 503: {"model": dict}},
    summary="Analyze route distance, elevation, time, and modeled resources",
)
def analyze(request: RouteAnalysisRequest):
    terrain = _get_terrain(request.site_id)
    try:
        return analyze_routes(terrain, request)
    except RoutePlanningError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": error.code, "message": str(error)},
        ) from error


@router.post(
    "/go-nogo",
    response_model=GoNoGoResponse,
    responses={404: {"model": dict}, 422: {"model": dict}, 503: {"model": dict}},
    summary="Compare round-trip route resource needs with entered suit supplies",
)
def go_nogo(request: GoNoGoRequest):
    terrain = _get_terrain(request.site_id)
    try:
        return evaluate_go_nogo(terrain, request)
    except RoutePlanningError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": error.code, "message": str(error)},
        ) from error
