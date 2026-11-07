import json
import math
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from pydantic import ValidationError

from backend.app.core.config import get_settings
from backend.app.models.terrain import GeoBounds, SiteConfig

EARTH_TO_MARS_NOTES = (
    "Slope is derived from the MGS MOLA MEGDR topography samples using "
    "Mars-radius-aware local east-west and north-south cell spacing."
)
CONTENT_RANGE_PATTERN = re.compile(r"bytes (\d+)-(\d+)/(\d+)")


class TerrainDataUnavailable(Exception):
    def __init__(self, message: str):
        super().__init__(message)


@dataclass(frozen=True)
class SiteTerrain:
    site: SiteConfig
    latitudes_deg: NDArray[np.float64]
    longitudes_deg: NDArray[np.float64]
    elevation_m: NDArray[np.float64]
    slope_deg: NDArray[np.float64]
    cell_size_x_m: float
    cell_size_y_m: float


def _read_site_config(configured_path: Path) -> SiteConfig:
    try:
        payload = json.loads(configured_path.read_text(encoding="utf-8"))
        return SiteConfig.model_validate(payload)
    except FileNotFoundError as error:
        raise TerrainDataUnavailable(
            f"Site configuration was not found: {configured_path}"
        ) from error
    except (json.JSONDecodeError, ValidationError) as error:
        raise TerrainDataUnavailable(
            f"Site configuration is invalid: {configured_path}"
        ) from error


@lru_cache(maxsize=8)
def get_site_config(site_id: str) -> SiteConfig:
    settings = get_settings()
    configured_path = settings.resolve_path(settings.site_config)
    site = _read_site_config(configured_path)
    if site.id != site_id:
        raise KeyError(site_id)
    return site


def _pixel_window(site: SiteConfig) -> tuple[int, int, int, int]:
    source = site.terrain
    source_bounds = source.sample_bounds
    bounds = site.bounds
    ppd = source.pixels_per_degree

    if (
        bounds.south < source_bounds.south
        or bounds.north > source_bounds.north
        or bounds.west < source_bounds.west
        or bounds.east > source_bounds.east
    ):
        raise TerrainDataUnavailable(
            f"The configured site bounds are outside MOLA product {source.product_id}."
        )
    if bounds.south >= bounds.north or bounds.west >= bounds.east:
        raise TerrainDataUnavailable("Site bounds must have positive width and height.")

    row_start = max(0, math.ceil((source_bounds.north - bounds.north) * ppd - 0.5) - 1)
    row_end = min(
        source.lines,
        math.floor((source_bounds.north - bounds.south) * ppd - 0.5) + 2,
    )
    col_start = max(0, math.ceil((bounds.west - source_bounds.west) * ppd - 0.5) - 1)
    col_end = min(
        source.samples,
        math.floor((bounds.east - source_bounds.west) * ppd - 0.5) + 2,
    )
    if row_end - row_start < 3 or col_end - col_start < 3:
        raise TerrainDataUnavailable("Configured site is too small to compute slope.")
    return row_start, row_end, col_start, col_end


def _fetch_raster_rows(site: SiteConfig, row_start: int, row_end: int) -> NDArray[np.int16]:
    source = site.terrain
    if source.byte_order != "big" or source.sample_type != "signed_integer":
        raise TerrainDataUnavailable(
            f"Unsupported sample encoding in MOLA product {source.product_id}."
        )
    record_bytes = source.samples * source.bytes_per_sample
    first_byte = row_start * record_bytes
    last_byte = row_end * record_bytes - 1
    expected_size = last_byte - first_byte + 1
    request = urllib.request.Request(
        source.product_url,
        headers={
            "Range": f"bytes={first_byte}-{last_byte}",
            "User-Agent": "MARSWAY/0.1 (Marswalk planning research application)",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            content_range = response.headers.get("Content-Range", "")
            match = CONTENT_RANGE_PATTERN.fullmatch(content_range)
            if response.status != 206 or not match:
                raise TerrainDataUnavailable(
                    "The PDS MOLA server did not honor the requested byte range; "
                    "the full global product was not downloaded."
                )
            returned_start, returned_end, total_size = map(int, match.groups())
            expected_product_size = source.samples * source.lines * source.bytes_per_sample
            if (
                returned_start != first_byte
                or returned_end != last_byte
                or total_size != expected_product_size
            ):
                raise TerrainDataUnavailable(
                    "The MOLA byte-range response did not match the verified product layout."
                )
            content = response.read(expected_size + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise TerrainDataUnavailable(
            f"Could not retrieve numeric MOLA elevations from the PDS archive: {error}"
        ) from error

    if len(content) != expected_size:
        raise TerrainDataUnavailable(
            "The PDS MOLA byte-range response was incomplete."
        )
    return np.frombuffer(content, dtype=">i2").astype(np.int16).reshape(
        row_end - row_start, source.samples
    )


def calculate_slope(
    elevations_m: NDArray[np.float64],
    cell_size_x_m: float,
    cell_size_y_m: float,
) -> NDArray[np.float64]:
    """Calculate slope angle in degrees from a regular Mars elevation grid."""
    if elevations_m.ndim != 2 or min(elevations_m.shape) < 3:
        raise ValueError("Elevation grid must be two-dimensional and at least 3 by 3.")
    if not np.isfinite(elevations_m).all():
        raise ValueError("Elevation grid must contain finite values.")
    if cell_size_x_m <= 0 or cell_size_y_m <= 0:
        raise ValueError("Cell dimensions must be positive.")

    gradient_y, gradient_x = np.gradient(
        elevations_m,
        cell_size_y_m,
        cell_size_x_m,
        edge_order=2,
    )
    return np.degrees(np.arctan(np.hypot(gradient_x, gradient_y)))


def classify_hazards(
    slope_deg: NDArray[np.float64], slope_limit_deg: float = 25.0
) -> NDArray[np.bool_]:
    if not 0 < slope_limit_deg <= 90:
        raise ValueError("Slope limit must be greater than 0 and no more than 90 degrees.")
    if slope_deg.ndim != 2 or not np.isfinite(slope_deg).all():
        raise ValueError("Slope grid must be a finite two-dimensional array.")
    return slope_deg > slope_limit_deg


@lru_cache(maxsize=8)
def get_site_terrain(site_id: str) -> SiteTerrain:
    site = get_site_config(site_id)
    source = site.terrain
    row_start, row_end, col_start, col_end = _pixel_window(site)
    full_rows = _fetch_raster_rows(site, row_start, row_end)
    padded_elevation = full_rows[:, col_start:col_end].astype(np.float64)

    if not np.isfinite(padded_elevation).all():
        raise TerrainDataUnavailable("MOLA elevation crop contains invalid samples.")

    pad_row, pad_col = 1, 1
    elevation = padded_elevation[
        pad_row:-pad_row if pad_row else None,
        pad_col:-pad_col if pad_col else None,
    ]
    north_index = np.arange(row_start + pad_row, row_end - pad_row)
    east_index = np.arange(col_start + pad_col, col_end - pad_col)
    ppd = source.pixels_per_degree
    latitudes = source.sample_bounds.north - (north_index + 0.5) / ppd
    longitudes = source.sample_bounds.west + (east_index + 0.5) / ppd
    center_latitude = float(np.mean(latitudes))
    pixel_size_y = source.mars_radius_meters * math.pi / (180 * ppd)
    pixel_size_x = pixel_size_y * math.cos(math.radians(center_latitude))
    slope = calculate_slope(elevation, pixel_size_x, pixel_size_y)

    for array in (elevation, slope, latitudes, longitudes):
        array.setflags(write=False)

    return SiteTerrain(
        site=site,
        latitudes_deg=latitudes,
        longitudes_deg=longitudes,
        elevation_m=elevation,
        slope_deg=slope,
        cell_size_x_m=pixel_size_x,
        cell_size_y_m=pixel_size_y,
    )
