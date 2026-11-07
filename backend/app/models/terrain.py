from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(name: str) -> str:
    first, *rest = name.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class GeoBounds(ApiModel):
    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=360)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=360)

    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True, frozen=True)

    @model_validator(mode="after")
    def validate_order(self) -> "GeoBounds":
        if self.south >= self.north or self.west >= self.east:
            raise ValueError("Bounds must have positive width and height.")
        return self


class SiteCenter(ApiModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=360)


class ZoomLimits(ApiModel):
    initial: int = Field(ge=0, le=24)
    minimum: int = Field(ge=0, le=24)
    maximum: int = Field(ge=0, le=24)


class TerrainSource(ApiModel):
    source: str
    product_id: str
    product_url: str
    label_url: str
    header_url: str
    pixels_per_degree: int = Field(gt=0)
    mars_radius_meters: float = Field(gt=0)
    sample_bounds: GeoBounds
    samples: int = Field(gt=0)
    lines: int = Field(gt=0)
    bytes_per_sample: int = Field(gt=0)
    byte_order: str
    sample_type: str
    unit: str
    product_status: str

class SiteConfig(ApiModel):
    id: str
    name: str
    description: str
    center: SiteCenter
    bounds: GeoBounds
    zoom: ZoomLimits
    terrain: TerrainSource
    units: str
    coordinate_system: str
    data_status: str

    @model_validator(mode="after")
    def validate_zoom(self) -> "SiteConfig":
        if not self.zoom.minimum <= self.zoom.initial <= self.zoom.maximum:
            raise ValueError("Initial zoom must be between minimum and maximum zoom.")
        return self


class SiteResponse(ApiModel):
    site: SiteConfig


class ElevationGridResponse(ApiModel):
    site_id: str
    rows: int
    columns: int
    latitudes_deg: list[float]
    longitudes_deg: list[float]
    elevation_m: list[list[float]]
    cell_size_m: dict[str, float]
    source: str
    product_id: str
    product_url: str
    label_url: str
    pixel_resolution_degrees: float
    missing_observation_bins_interpolated: bool
    coordinate_system: str


class HazardGridResponse(ElevationGridResponse):
    slope_limit_deg: float
    slope_deg: list[list[float]]
    no_go_mask: list[list[bool]]
    blocked_cells: int
    total_cells: int
    hazard_definition: str
    slope_method: str


class SciencePoint(ApiModel):
    name: str = Field(min_length=1, max_length=100)
    latitude_deg: float = Field(ge=-90, le=90)
    longitude_deg: float = Field(ge=-180, le=360)


class CostGridWeights(ApiModel):
    slope: float = Field(default=0.8, ge=0, le=20)
    roughness_per_100m: float = Field(default=0.25, ge=0, le=20)
    science_bonus: float = Field(default=0.35, ge=0, le=0.9)
    science_radius_m: float = Field(default=1000, gt=0, le=100_000)


class CostGridRequest(ApiModel):
    site_id: str = Field(default="jezero", min_length=1, max_length=64)
    slope_limit_deg: float = Field(default=25, gt=0, le=90)
    weights: CostGridWeights = Field(default_factory=CostGridWeights)
    science_points: list[SciencePoint] = Field(default_factory=list, max_length=100)


class CostGridResponse(ApiModel):
    site_id: str
    coordinate_system: str
    pixel_resolution_degrees: float
    rows: int
    columns: int
    latitudes_deg: list[float]
    longitudes_deg: list[float]
    elevation_m: list[list[float]]
    cost_m: list[list[float | None]]
    base_distance_m: float
    slope_penalty_m: list[list[float]]
    roughness_m: list[list[float]]
    roughness_penalty_m: list[list[float]]
    science_bonus_m: list[list[float]]
    no_go_mask: list[list[bool]]
    slope_limit_deg: float
    blocked_cells: int
    total_cells: int
    science_points_used: int
    weights: CostGridWeights
    cost_definition: str


RouteMode = Literal["shortest", "safest", "science"]
SearchAlgorithm = Literal["astar", "dijkstra"]


class RouteLocation(ApiModel):
    latitude_deg: float = Field(ge=-90, le=90)
    longitude_deg: float = Field(ge=-180, le=360)


class RouteRequest(ApiModel):
    site_id: str = Field(default="jezero", min_length=1, max_length=64)
    start: RouteLocation
    end: RouteLocation
    slope_limit_deg: float = Field(default=25, gt=0, le=90)
    search_algorithm: SearchAlgorithm = "astar"
    science_points: list[SciencePoint] = Field(default_factory=list, max_length=100)
    dust_storm: bool = False


class RoutePoint(ApiModel):
    row: int
    column: int
    latitude_deg: float
    longitude_deg: float
    elevation_m: float
    slope_deg: float


class RouteModeResult(ApiModel):
    mode: RouteMode
    distance_m: float
    weighted_cost_m: float
    steepest_slope_deg: float
    algorithm_used: SearchAlgorithm
    fallback_used: bool
    path: list[RoutePoint]
    science_points_used: int
    note: str


class RouteResponse(ApiModel):
    site_id: str
    coordinate_system: str
    slope_limit_deg: float
    start_cell: RoutePoint
    end_cell: RoutePoint
    requested_algorithm: SearchAlgorithm
    routes: list[RouteModeResult]
    safety_notice: str


class RouteAnalysisRequest(RouteRequest):
    walking_speed_m_s: float = Field(default=0.8, gt=0, le=5)
    oxygen_rate_l_per_min: float = Field(default=1.0, ge=0, le=20)
    power_rate_w: float = Field(default=120, ge=0, le=10_000)
    water_rate_l_per_hour: float = Field(default=0.5, ge=0, le=100)


class RouteProfilePoint(RoutePoint):
    distance_from_start_m: float


class AnalyzedRoute(RouteModeResult):
    walking_time_seconds: float
    ascent_m: float
    descent_m: float
    oxygen_liters: float
    power_wh: float
    water_liters: float
    elevation_profile: list[RouteProfilePoint]


class RouteAnalysisResponse(ApiModel):
    site_id: str
    coordinate_system: str
    slope_limit_deg: float
    requested_algorithm: SearchAlgorithm
    walking_speed_m_s: float
    oxygen_rate_l_per_min: float
    power_rate_w: float
    water_rate_l_per_hour: float
    dust_storm: bool
    routes: list[AnalyzedRoute]
    model_notice: str
    safety_notice: str


ResourceKind = Literal["oxygen", "power", "water"]


class GoNoGoRequest(RouteAnalysisRequest):
    selected_route: RouteMode = "safest"
    oxygen_available_liters: float = Field(ge=0, le=1_000_000)
    power_available_wh: float = Field(ge=0, le=1_000_000)
    water_available_liters: float = Field(ge=0, le=1_000_000)
    safety_margin: float = Field(default=0.2, ge=0, le=1)
    include_return_trip: bool = True


class ResourceCheck(ApiModel):
    resource: ResourceKind
    unit: str
    available: float
    one_way_estimate: float
    trip_estimate: float
    buffered_requirement: float
    remaining: float
    remaining_margin_percent: float | None
    sufficient: bool


class GoNoGoResponse(ApiModel):
    site_id: str
    selected_route: RouteMode
    verdict: Literal["go", "no_go"]
    reason: str
    limiting_resource: ResourceKind | None
    remaining_margin_percent: float | None
    safety_margin: float
    return_trip_included: bool
    dust_storm: bool
    resources: list[ResourceCheck]
    suggestion: str
    model_notice: str
    safety_notice: str


class ApiErrorDetail(ApiModel):
    code: str
    message: str


class ApiErrorResponse(ApiModel):
    error: ApiErrorDetail
