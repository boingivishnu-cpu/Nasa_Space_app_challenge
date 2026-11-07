import math
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.models.terrain import (
    CostGridRequest,
    CostGridWeights,
    GoNoGoRequest,
    RouteAnalysisRequest,
    RouteLocation,
    RouteRequest,
    SciencePoint,
    SiteConfig,
)
from backend.app.services.cost_grid import build_cost_grid
from backend.app.services.routing import (
    RoutePlanningError,
    analyze_routes,
    find_path,
    plan_routes,
)
from backend.app.services.resources import evaluate_go_nogo
from backend.app.services.terrain import (
    SiteTerrain,
    _pixel_window,
    calculate_slope,
    classify_hazards,
    get_site_config,
    get_site_terrain,
)


class SlopeCalculationTests(unittest.TestCase):
    def test_constant_elevation_has_zero_slope(self) -> None:
        elevations = np.full((5, 6), 123.0)
        slope = calculate_slope(elevations, 100.0, 100.0)
        np.testing.assert_allclose(slope, 0.0, atol=1e-12)

    def test_planar_surface_uses_both_real_cell_dimensions(self) -> None:
        rows, columns = np.mgrid[0:5, 0:6]
        dx, dy = 20.0, 10.0
        elevations = columns * dx * 0.3 + rows * dy * 0.4
        expected = math.degrees(math.atan(math.hypot(0.3, 0.4)))

        slope = calculate_slope(elevations, dx, dy)

        np.testing.assert_allclose(slope, expected, atol=1e-10)

    def test_rejects_grids_that_cannot_produce_a_gradient(self) -> None:
        with self.assertRaises(ValueError):
            calculate_slope(np.ones((2, 4)), 10.0, 10.0)

    def test_rejects_invalid_cell_spacing(self) -> None:
        with self.assertRaises(ValueError):
            calculate_slope(np.ones((3, 3)), 0.0, 10.0)


class HazardClassificationTests(unittest.TestCase):
    def test_only_cells_strictly_over_limit_are_blocked(self) -> None:
        slope = np.array([[0.0, 24.9, 25.0, 25.1, 45.0]])
        expected = np.array([[False, False, False, True, True]])
        np.testing.assert_array_equal(classify_hazards(slope, 25.0), expected)

    def test_rejects_out_of_range_limit(self) -> None:
        with self.assertRaises(ValueError):
            classify_hazards(np.zeros((3, 3)), 0.0)


class JezeroProductTests(unittest.TestCase):
    def test_jezero_uses_verified_mola_topography_product(self) -> None:
        site = get_site_config("jezero")
        self.assertEqual(site.terrain.product_id, "MEGT44N000HB")
        self.assertEqual(site.terrain.unit, "meters")
        self.assertEqual(site.coordinate_system, "planetocentric")
        self.assertEqual(site.terrain.pixels_per_degree, 128)

    def test_jezero_crop_includes_a_slope_neighbor_border(self) -> None:
        site = get_site_config("jezero")
        row_start, row_end, col_start, col_end = _pixel_window(site)
        self.assertGreaterEqual(row_start, 0)
        self.assertLess(row_end, site.terrain.lines)
        self.assertGreaterEqual(col_start, 0)
        self.assertLess(col_end, site.terrain.samples)
        self.assertGreater(row_end - row_start, 40)
        self.assertGreater(col_end - col_start, 40)
        self.assertLess(row_end - row_start, 60)
        self.assertLess(col_end - col_start, 60)

    def test_terrain_grid_is_cached_after_first_preprocess(self) -> None:
        get_site_terrain.cache_clear()
        site = get_site_config("jezero")
        row_start, row_end, col_start, col_end = _pixel_window(site)
        source_shape = (row_end - row_start, site.terrain.samples)
        source_sample = np.full(source_shape, 1200, dtype=np.int16)

        with patch(
            "backend.app.services.terrain._fetch_raster_rows",
            return_value=source_sample,
        ) as fetch_rows:
            first = get_site_terrain("jezero")
            second = get_site_terrain("jezero")

        self.assertIs(first, second)
        fetch_rows.assert_called_once_with(site, row_start, row_end)
        self.assertGreaterEqual(first.elevation_m.shape[0], 40)
        self.assertGreaterEqual(first.elevation_m.shape[1], 40)
        self.assertEqual(first.elevation_m.shape, first.slope_deg.shape)
        self.assertAlmostEqual(first.latitudes_deg[0], site.bounds.north, delta=0.01)
        self.assertAlmostEqual(first.longitudes_deg[0], site.bounds.west, delta=0.01)
        self.assertAlmostEqual(first.elevation_m[0, 0], 1200.0)
        self.assertGreater(first.cell_size_x_m, 0)
        self.assertGreater(first.cell_size_y_m, 0)


class CostGridTests(unittest.TestCase):
    def setUp(self) -> None:
        self.site = get_site_config("jezero")
        self.terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )

    def test_flat_grid_has_distance_cost_and_zero_penalties(self) -> None:
        result = build_cost_grid(
            self.terrain,
            CostGridRequest(weights=CostGridWeights(science_bonus=0)),
        )

        self.assertAlmostEqual(result.base_distance_m, 100.0)
        np.testing.assert_allclose(result.cost_m, np.full((3, 3), 100.0))
        np.testing.assert_allclose(result.slope_penalty_m, 0.0)
        np.testing.assert_allclose(result.roughness_m, 0.0)
        np.testing.assert_allclose(result.roughness_penalty_m, 0.0)
        self.assertEqual(result.blocked_cells, 0)

    def test_steep_cells_are_blocked_and_roughness_adds_penalty(self) -> None:
        elevation = np.zeros((3, 3))
        elevation[1, 1] = 100
        slope = np.zeros((3, 3))
        slope[0, 0] = 30
        terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=self.terrain.latitudes_deg,
            longitudes_deg=self.terrain.longitudes_deg,
            elevation_m=elevation,
            slope_deg=slope,
            cell_size_x_m=100,
            cell_size_y_m=100,
        )

        result = build_cost_grid(
            terrain,
            CostGridRequest(weights=CostGridWeights(science_bonus=0)),
        )

        self.assertIsNone(result.cost_m[0][0])
        self.assertTrue(result.no_go_mask[0][0])
        self.assertEqual(result.blocked_cells, 1)
        self.assertGreater(result.roughness_m[1][1], 0)
        self.assertGreater(result.cost_m[1][1], result.base_distance_m)

    def test_slope_weight_adds_normalized_penalty(self) -> None:
        slope = np.zeros((3, 3))
        slope[1, 1] = 12.5
        terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=self.terrain.latitudes_deg,
            longitudes_deg=self.terrain.longitudes_deg,
            elevation_m=self.terrain.elevation_m,
            slope_deg=slope,
            cell_size_x_m=100,
            cell_size_y_m=100,
        )

        result = build_cost_grid(
            terrain,
            CostGridRequest(
                weights=CostGridWeights(
                    slope=1,
                    roughness_per_100m=0,
                    science_bonus=0,
                )
            ),
        )

        self.assertAlmostEqual(result.slope_penalty_m[1][1], 25.0)
        self.assertAlmostEqual(result.cost_m[1][1], 125.0)

    def test_science_point_reduces_cost_near_its_location(self) -> None:
        request = CostGridRequest(
            weights=CostGridWeights(
                slope=0,
                roughness_per_100m=0,
                science_bonus=0.5,
                science_radius_m=500,
            ),
            science_points=[
                SciencePoint(name="verified input", latitude_deg=18.44, longitude_deg=77.45)
            ],
        )

        result = build_cost_grid(self.terrain, request)

        self.assertLess(result.cost_m[1][1], result.cost_m[0][0])
        self.assertEqual(result.science_points_used, 1)
        self.assertGreater(result.science_bonus_m[1][1], result.science_bonus_m[0][0])

    def test_science_point_outside_site_bounds_is_rejected(self) -> None:
        request = CostGridRequest(
            science_points=[
                SciencePoint(name="outside", latitude_deg=10, longitude_deg=10)
            ]
        )
        with self.assertRaisesRegex(ValueError, "outside configured site bounds"):
            build_cost_grid(self.terrain, request)


class PathfindingTests(unittest.TestCase):
    def test_astar_uses_physical_diagonal_distance(self) -> None:
        result = find_path(
            np.ones((2, 2)),
            np.zeros((2, 2), dtype=bool),
            (0, 0),
            (1, 1),
            cell_size_x_m=3.0,
            cell_size_y_m=4.0,
        )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.path, [(0, 0), (1, 1)])
        self.assertAlmostEqual(result.weighted_cost_m, 5.0)

    def test_diagonal_cannot_cut_between_blocked_cells(self) -> None:
        blocked = np.array([[False, True], [True, False]])

        result = find_path(
            np.ones((2, 2)),
            blocked,
            (0, 0),
            (1, 1),
            cell_size_x_m=1.0,
            cell_size_y_m=1.0,
        )

        self.assertIsNone(result)

    def test_disconnected_grid_is_unreachable(self) -> None:
        blocked = np.zeros((3, 3), dtype=bool)
        blocked[1, :] = True

        result = find_path(
            np.ones((3, 3)),
            blocked,
            (0, 0),
            (2, 2),
            cell_size_x_m=1.0,
            cell_size_y_m=1.0,
        )

        self.assertIsNone(result)

    def test_astar_and_dijkstra_return_same_optimal_cost(self) -> None:
        factors = np.array(
            [
                [1.0, 2.0, 1.0],
                [1.0, 5.0, 1.0],
                [1.0, 1.0, 1.0],
            ]
        )
        blocked = np.zeros((3, 3), dtype=bool)
        astar = find_path(factors, blocked, (0, 0), (2, 2), 3.0, 4.0)
        dijkstra = find_path(
            factors,
            blocked,
            (0, 0),
            (2, 2),
            3.0,
            4.0,
            algorithm="dijkstra",
        )

        self.assertIsNotNone(astar)
        self.assertIsNotNone(dijkstra)
        assert astar is not None and dijkstra is not None
        self.assertAlmostEqual(astar.weighted_cost_m, dijkstra.weighted_cost_m)

    def test_astar_no_path_uses_dijkstra_fallback(self) -> None:
        path = [(0, 0), (0, 1)]
        with patch(
            "backend.app.services.routing._search",
            side_effect=[None, (path, 2.0)],
        ):
            result = find_path(
                np.ones((1, 2)),
                np.zeros((1, 2), dtype=bool),
                (0, 0),
                (0, 1),
                1.0,
                1.0,
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.algorithm_used, "dijkstra")
        self.assertTrue(result.fallback_used)


class RoutingServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.site = get_site_config("jezero")
        self.terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        self.request = RouteRequest(
            start=RouteLocation(latitude_deg=18.45, longitude_deg=77.44),
            end=RouteLocation(latitude_deg=18.43, longitude_deg=77.46),
        )

    def test_returns_three_routes_without_inventing_science_points(self) -> None:
        result = plan_routes(self.terrain, self.request)

        self.assertEqual([route.mode for route in result.routes], ["shortest", "safest", "science"])
        self.assertEqual(result.routes[0].path[0].row, 0)
        self.assertEqual(result.routes[0].path[-1].row, 2)
        self.assertAlmostEqual(result.routes[0].distance_m, math.hypot(200, 200))
        self.assertEqual(result.routes[2].science_points_used, 0)
        self.assertIn("No verified science points", result.routes[2].note)

    def test_safest_avoids_steep_cells_and_science_uses_supplied_target(self) -> None:
        latitudes = np.array([18.48 - row * 0.005 for row in range(9)])
        longitudes = np.array([77.42 + column * 0.005 for column in range(9)])
        slopes = np.zeros((9, 9))
        slopes[4, 4] = 20
        terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=latitudes,
            longitudes_deg=longitudes,
            elevation_m=np.zeros((9, 9)),
            slope_deg=slopes,
            cell_size_x_m=200,
            cell_size_y_m=200,
        )
        request = RouteRequest(
            start=RouteLocation(
                latitude_deg=float(latitudes[0]),
                longitude_deg=float(longitudes[0]),
            ),
            end=RouteLocation(
                latitude_deg=float(latitudes[-1]),
                longitude_deg=float(longitudes[-1]),
            ),
            science_points=[
                SciencePoint(
                    name="caller-provided target",
                    latitude_deg=float(latitudes[0]),
                    longitude_deg=float(longitudes[-1]),
                )
            ],
        )

        routes = {route.mode: route for route in plan_routes(terrain, request).routes}

        shortest_cells = {(point.row, point.column) for point in routes["shortest"].path}
        safest_cells = {(point.row, point.column) for point in routes["safest"].path}
        self.assertIn((4, 4), shortest_cells)
        self.assertNotIn((4, 4), safest_cells)
        self.assertGreater(routes["safest"].distance_m, routes["shortest"].distance_m)
        self.assertEqual(routes["science"].path[-1].row, 8)
        self.assertEqual(routes["science"].science_points_used, 1)
        self.assertEqual(routes["science"].path[0].column, 0)
        self.assertEqual(routes["science"].path[-1].column, 8)
        target = (0, 8)
        science_distance_to_target = min(
            math.hypot(point.row - target[0], point.column - target[1])
            for point in routes["science"].path
        )
        shortest_distance_to_target = min(
            math.hypot(point.row - target[0], point.column - target[1])
            for point in routes["shortest"].path
        )
        self.assertLess(science_distance_to_target, shortest_distance_to_target)

    def test_start_in_blocked_cell_snaps_to_nearest_traversable_cell(self) -> None:
        slope = np.zeros((3, 3))
        slope[1, 1] = 30
        terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=self.terrain.latitudes_deg,
            longitudes_deg=self.terrain.longitudes_deg,
            elevation_m=self.terrain.elevation_m,
            slope_deg=slope,
            cell_size_x_m=100,
            cell_size_y_m=100,
        )
        request = RouteRequest(
            start=RouteLocation(latitude_deg=18.44, longitude_deg=77.45),
            end=self.request.end,
        )

        result = plan_routes(terrain, request)

        self.assertNotEqual((result.start_cell.row, result.start_cell.column), (1, 1))

    def test_out_of_bounds_waypoint_is_rejected(self) -> None:
        request = RouteRequest(
            start=RouteLocation(latitude_deg=10, longitude_deg=10),
            end=self.request.end,
        )

        with self.assertRaisesRegex(RoutePlanningError, "within the configured site bounds"):
            plan_routes(self.terrain, request)

    def test_unreachable_waypoints_raise_a_route_error(self) -> None:
        slopes = np.zeros((3, 3))
        slopes[1, :] = 30
        terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=self.terrain.latitudes_deg,
            longitudes_deg=self.terrain.longitudes_deg,
            elevation_m=self.terrain.elevation_m,
            slope_deg=slopes,
            cell_size_x_m=100,
            cell_size_y_m=100,
        )
        request = RouteRequest(
            start=RouteLocation(latitude_deg=18.45, longitude_deg=77.45),
            end=RouteLocation(latitude_deg=18.43, longitude_deg=77.45),
        )

        with self.assertRaisesRegex(RoutePlanningError, "No traversable path"):
            plan_routes(terrain, request)

    def test_out_of_bounds_science_input_is_reported_as_route_error(self) -> None:
        request = RouteRequest(
            start=self.request.start,
            end=self.request.end,
            science_points=[
                SciencePoint(name="outside", latitude_deg=10, longitude_deg=10)
            ],
        )

        with self.assertRaisesRegex(RoutePlanningError, "outside configured site bounds"):
            plan_routes(self.terrain, request)

    def test_analysis_calculates_profile_and_modeled_resources(self) -> None:
        elevations = np.array(
            [
                [0.0, 10.0, 20.0],
                [10.0, 20.0, 30.0],
                [20.0, 30.0, 40.0],
            ]
        )
        terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=self.terrain.latitudes_deg,
            longitudes_deg=self.terrain.longitudes_deg,
            elevation_m=elevations,
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        request = RouteAnalysisRequest(
            start=self.request.start,
            end=self.request.end,
            walking_speed_m_s=2.0,
            oxygen_rate_l_per_min=2.0,
            power_rate_w=120.0,
            water_rate_l_per_hour=0.5,
        )

        result = analyze_routes(terrain, request)
        shortest = next(route for route in result.routes if route.mode == "shortest")
        expected_distance = math.hypot(200.0, 200.0)
        expected_seconds = expected_distance / 2.0

        self.assertAlmostEqual(shortest.distance_m, expected_distance)
        self.assertAlmostEqual(shortest.walking_time_seconds, expected_seconds)
        self.assertAlmostEqual(shortest.ascent_m, 40.0)
        self.assertAlmostEqual(shortest.descent_m, 0.0)
        self.assertAlmostEqual(shortest.oxygen_liters, expected_seconds / 60 * 2)
        self.assertAlmostEqual(shortest.power_wh, expected_seconds / 3600 * 120)
        self.assertAlmostEqual(shortest.water_liters, expected_seconds / 3600 * 0.5)
        self.assertAlmostEqual(
            shortest.elevation_profile[-1].distance_from_start_m,
            shortest.distance_m,
        )
        self.assertIn("illustrative", result.model_notice)

    def test_analysis_of_same_cell_route_has_zero_distance_and_resources(self) -> None:
        request = RouteAnalysisRequest(
            start=self.request.start,
            end=self.request.start,
        )

        result = analyze_routes(self.terrain, request)

        for route in result.routes:
            self.assertEqual(route.path[0].row, route.path[-1].row)
            self.assertEqual(route.distance_m, 0)
            self.assertEqual(route.walking_time_seconds, 0)
            self.assertEqual(route.oxygen_liters, 0)
            self.assertEqual(route.power_wh, 0)
            self.assertEqual(route.water_liters, 0)
            self.assertEqual(len(route.elevation_profile), 1)

    def test_dust_storm_increases_power_and_safest_route_penalties(self) -> None:
        normal = RouteAnalysisRequest(
            start=self.request.start,
            end=self.request.end,
            walking_speed_m_s=2,
            power_rate_w=100,
        )
        storm = RouteAnalysisRequest(
            start=self.request.start,
            end=self.request.end,
            walking_speed_m_s=2,
            power_rate_w=100,
            dust_storm=True,
        )

        normal_result = analyze_routes(self.terrain, normal)
        storm_result = analyze_routes(self.terrain, storm)

        normal_shortest = next(route for route in normal_result.routes if route.mode == "shortest")
        storm_shortest = next(route for route in storm_result.routes if route.mode == "shortest")
        self.assertAlmostEqual(storm_shortest.power_wh, normal_shortest.power_wh * 1.25)
        self.assertEqual(storm_result.power_rate_w, 125)
        self.assertTrue(storm_result.dust_storm)
        self.assertIn("visibility-risk proxy", storm_result.model_notice)

    def test_go_nogo_includes_return_trip_and_safety_margin(self) -> None:
        request = GoNoGoRequest(
            start=self.request.start,
            end=self.request.end,
            walking_speed_m_s=2.0,
            oxygen_rate_l_per_min=2.0,
            power_rate_w=120.0,
            water_rate_l_per_hour=0.5,
            selected_route="shortest",
            oxygen_available_liters=20,
            power_available_wh=30,
            water_available_liters=2,
            safety_margin=0.2,
            dust_storm=True,
        )

        result = evaluate_go_nogo(self.terrain, request)

        self.assertEqual(result.verdict, "go")
        self.assertTrue(result.return_trip_included)
        self.assertTrue(result.dust_storm)
        oxygen = next(item for item in result.resources if item.resource == "oxygen")
        power = next(item for item in result.resources if item.resource == "power")
        self.assertAlmostEqual(oxygen.trip_estimate, oxygen.one_way_estimate * 2)
        self.assertAlmostEqual(oxygen.buffered_requirement, oxygen.trip_estimate * 1.2)
        self.assertAlmostEqual(oxygen.remaining, oxygen.available - oxygen.buffered_requirement)
        self.assertAlmostEqual(
            power.one_way_estimate,
            math.hypot(200.0, 200.0) / 2 / 3600 * 150,
        )
        self.assertEqual(result.limiting_resource, "oxygen")

    def test_go_nogo_fails_when_a_resource_is_below_buffered_need(self) -> None:
        request = GoNoGoRequest(
            start=self.request.start,
            end=self.request.end,
            walking_speed_m_s=2.0,
            oxygen_rate_l_per_min=2.0,
            power_rate_w=120.0,
            water_rate_l_per_hour=0.5,
            selected_route="shortest",
            oxygen_available_liters=5,
            power_available_wh=30,
            water_available_liters=2,
        )

        result = evaluate_go_nogo(self.terrain, request)
        oxygen = next(item for item in result.resources if item.resource == "oxygen")

        self.assertEqual(result.verdict, "no_go")
        self.assertEqual(result.limiting_resource, "oxygen")
        self.assertFalse(oxygen.sufficient)
        self.assertLess(oxygen.remaining, 0)
        self.assertIn("Shorten the traverse", result.suggestion)

    def test_go_nogo_can_explicitly_exclude_return_trip(self) -> None:
        request = GoNoGoRequest(
            start=self.request.start,
            end=self.request.end,
            walking_speed_m_s=2.0,
            oxygen_rate_l_per_min=2.0,
            power_rate_w=120.0,
            water_rate_l_per_hour=0.5,
            selected_route="shortest",
            oxygen_available_liters=5,
            power_available_wh=10,
            water_available_liters=1,
            safety_margin=0,
            include_return_trip=False,
        )

        result = evaluate_go_nogo(self.terrain, request)
        oxygen = next(item for item in result.resources if item.resource == "oxygen")

        self.assertFalse(result.return_trip_included)
        self.assertEqual(oxygen.trip_estimate, oxygen.one_way_estimate)
        self.assertEqual(result.verdict, "go")


class TerrainApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.site = get_site_config("jezero")
        elevations = np.array(
            [
                [0.0, 0.0, 0.0],
                [0.0, 10.0, 0.0],
                [0.0, 0.0, 0.0],
            ]
        )
        self.terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=elevations,
            slope_deg=calculate_slope(elevations, 1.0, 1.0),
            cell_size_x_m=1.0,
            cell_size_y_m=1.0,
        )

    def test_site_endpoint_returns_configured_site(self) -> None:
        response = self.client.get("/site")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["site"]["terrain"]["productId"], "MEGT44N000HB")

    def test_vite_loopback_origins_are_allowed_by_cors(self) -> None:
        for origin in (
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ):
            with self.subTest(origin=origin):
                response = self.client.options(
                    "/cost-grid",
                    headers={
                        "Origin": origin,
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "content-type",
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.headers.get("access-control-allow-origin"),
                    origin,
                )

    def test_unknown_site_uses_consistent_error_shape(self) -> None:
        response = self.client.get("/elevation", params={"site_id": "unknown"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "site_not_found")

    def test_hazards_endpoint_returns_grid_and_threshold(self) -> None:
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=self.terrain,
        ):
            response = self.client.get(
                "/hazards",
                params={"site_id": "jezero", "slope_limit_deg": 25},
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["slopeLimitDeg"], 25)
        self.assertEqual(body["rows"], 3)
        self.assertEqual(body["columns"], 3)
        self.assertEqual(len(body["noGoMask"]), 3)
        self.assertEqual(body["totalCells"], 9)
        self.assertEqual(body["source"], self.site.terrain.source)

    def test_rejects_invalid_threshold_with_consistent_error(self) -> None:
        response = self.client.get(
            "/hazards",
            params={"slope_limit_deg": 0},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "validation_error")

    def test_cost_grid_endpoint_returns_weighted_grid(self) -> None:
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=self.terrain,
        ):
            response = self.client.post(
                "/cost-grid",
                json={
                    "siteId": "jezero",
                    "weights": {"scienceBonus": 0},
                    "sciencePoints": [],
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["siteId"], "jezero")
        self.assertEqual(body["rows"], 3)
        self.assertEqual(body["columns"], 3)
        self.assertEqual(body["weights"]["scienceBonus"], 0)
        self.assertEqual(body["sciencePointsUsed"], 0)
        self.assertAlmostEqual(body["pixelResolutionDegrees"], 1 / 128)
        self.assertEqual(len(body["costM"]), 3)
        self.assertEqual(len(body["elevationM"]), 3)
        self.assertEqual(body["totalCells"], 9)

    def test_cost_grid_endpoint_rejects_out_of_site_science_points(self) -> None:
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=self.terrain,
        ):
            response = self.client.post(
                "/cost-grid",
                json={
                    "sciencePoints": [
                        {"name": "outside", "latitudeDeg": 10, "longitudeDeg": 10}
                    ]
                },
            )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "invalid_cost_grid")

    def test_route_endpoint_returns_all_modes_and_path_samples(self) -> None:
        flat_terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=flat_terrain,
        ):
            response = self.client.post(
                "/route",
                json={
                    "siteId": "jezero",
                    "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                    "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual([route["mode"] for route in body["routes"]], ["shortest", "safest", "science"])
        self.assertGreater(body["routes"][0]["distanceM"], 0)
        self.assertIn("not certified", body["safetyNotice"])
        self.assertEqual(body["routes"][2]["sciencePointsUsed"], 0)

    def test_route_endpoint_returns_consistent_error_for_out_of_bounds_waypoint(self) -> None:
        flat_terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=flat_terrain,
        ):
            response = self.client.post(
                "/route",
                json={
                    "start": {"latitudeDeg": 10, "longitudeDeg": 10},
                    "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                },
            )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "waypoint_outside_site")

    def test_route_endpoint_can_use_dijkstra_for_comparison(self) -> None:
        flat_terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=flat_terrain,
        ):
            response = self.client.post(
                "/route",
                json={
                    "searchAlgorithm": "dijkstra",
                    "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                    "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["requestedAlgorithm"], "dijkstra")
        self.assertTrue(all(route["algorithmUsed"] == "dijkstra" for route in body["routes"]))

    def test_analyze_endpoint_returns_profile_and_resource_model(self) -> None:
        elevations = np.array(
            [
                [0.0, 10.0, 20.0],
                [10.0, 20.0, 30.0],
                [20.0, 30.0, 40.0],
            ]
        )
        analysis_terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=elevations,
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=analysis_terrain,
        ):
            response = self.client.post(
                "/analyze",
                json={
                    "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                    "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                    "walkingSpeedMS": 2.0,
                    "oxygenRateLPerMin": 2.0,
                    "powerRateW": 120,
                    "waterRateLPerHour": 0.5,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        shortest = next(route for route in body["routes"] if route["mode"] == "shortest")
        self.assertAlmostEqual(shortest["ascentM"], 40.0)
        self.assertAlmostEqual(shortest["descentM"], 0.0)
        self.assertAlmostEqual(shortest["elevationProfile"][-1]["distanceFromStartM"], shortest["distanceM"])
        self.assertEqual(body["walkingSpeedMS"], 2.0)
        self.assertIn("illustrative", body["modelNotice"])

    def test_analyze_endpoint_rejects_nonpositive_walking_speed(self) -> None:
        response = self.client.post(
            "/analyze",
            json={
                "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                "walkingSpeedMS": 0,
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "validation_error")

    def test_go_nogo_endpoint_returns_resource_breakdown(self) -> None:
        flat_terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=flat_terrain,
        ):
            response = self.client.post(
                "/go-nogo",
                json={
                    "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                    "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                    "selectedRoute": "shortest",
                    "oxygenAvailableLiters": 20,
                    "powerAvailableWh": 60,
                    "waterAvailableLiters": 2,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["verdict"], "go")
        self.assertEqual(body["limitingResource"], "oxygen")
        self.assertTrue(body["returnTripIncluded"])
        self.assertAlmostEqual(body["safetyMargin"], 0.2)
        self.assertEqual(len(body["resources"]), 3)

    def test_go_nogo_endpoint_rejects_invalid_safety_margin(self) -> None:
        response = self.client.post(
            "/go-nogo",
            json={
                "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                "oxygenAvailableLiters": 20,
                "powerAvailableWh": 30,
                "waterAvailableLiters": 2,
                "safetyMargin": 1.1,
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "validation_error")

    def test_go_nogo_returns_dust_storm_mode(self) -> None:
        flat_terrain = SiteTerrain(
            site=self.site,
            latitudes_deg=np.array([18.45, 18.44, 18.43]),
            longitudes_deg=np.array([77.44, 77.45, 77.46]),
            elevation_m=np.zeros((3, 3)),
            slope_deg=np.zeros((3, 3)),
            cell_size_x_m=100.0,
            cell_size_y_m=100.0,
        )
        with patch(
            "backend.app.routers.terrain.get_site_terrain",
            return_value=flat_terrain,
        ):
            response = self.client.post(
                "/go-nogo",
                json={
                    "start": {"latitudeDeg": 18.45, "longitudeDeg": 77.44},
                    "end": {"latitudeDeg": 18.43, "longitudeDeg": 77.46},
                    "selectedRoute": "shortest",
                    "oxygenAvailableLiters": 20,
                    "powerAvailableWh": 100,
                    "waterAvailableLiters": 2,
                    "dustStorm": True,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["dustStorm"])
        self.assertIn("25% power-use increase", body["modelNotice"])


if __name__ == "__main__":
    unittest.main()
