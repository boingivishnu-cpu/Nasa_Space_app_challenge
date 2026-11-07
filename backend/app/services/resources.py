from backend.app.models.terrain import (
    GoNoGoRequest,
    GoNoGoResponse,
    ResourceCheck,
    ResourceKind,
)
from backend.app.services.routing import analyze_routes
from backend.app.services.terrain import SiteTerrain


def evaluate_go_nogo(
    terrain: SiteTerrain,
    request: GoNoGoRequest,
) -> GoNoGoResponse:
    analysis = analyze_routes(terrain, request)
    selected_route = next(
        route for route in analysis.routes if route.mode == request.selected_route
    )
    trip_factor = 2 if request.include_return_trip else 1
    reserve_factor = 1 + request.safety_margin
    estimates: list[tuple[ResourceKind, str, float, float]] = [
        ("oxygen", "L", selected_route.oxygen_liters, request.oxygen_available_liters),
        ("power", "Wh", selected_route.power_wh, request.power_available_wh),
        ("water", "L", selected_route.water_liters, request.water_available_liters),
    ]

    checks = [
        ResourceCheck(
            resource=resource,
            unit=unit,
            available=available,
            one_way_estimate=one_way,
            trip_estimate=one_way * trip_factor,
            buffered_requirement=one_way * trip_factor * reserve_factor,
            remaining=available - one_way * trip_factor * reserve_factor,
            remaining_margin_percent=(
                (available - one_way * trip_factor * reserve_factor)
                / (one_way * trip_factor * reserve_factor)
                * 100
                if one_way > 0
                else None
            ),
            sufficient=available >= one_way * trip_factor * reserve_factor,
        )
        for resource, unit, one_way, available in estimates
    ]
    constrained = [
        check
        for check in checks
        if check.buffered_requirement > 0
    ]
    limiting = min(
        constrained,
        key=lambda check: check.available / check.buffered_requirement,
    ) if constrained else None
    deficits = [check for check in checks if not check.sufficient]
    verdict = "no_go" if deficits else "go"
    if deficits:
        deficit_labels = ", ".join(
            f"{check.resource} short by {abs(check.remaining):.2f} {check.unit}"
            for check in deficits
        )
        reason = f"Buffered round-trip needs exceed available suit resources: {deficit_labels}."
        suggestion = (
            "Shorten the traverse or increase the limiting resource supply, then "
            "recheck. Do not trade away terrain review to meet a resource target."
        )
    else:
        reason = (
            "Entered suit capacities meet the modeled resource needs for the "
            "selected route and configured reserve."
        )
        suggestion = (
            "Review the coarse-terrain limitations and mission plan with qualified "
            "operators; this demo estimate is not a safety authorization."
        )

    margin_percent = (
        limiting.remaining_margin_percent
        if limiting is not None
        else None
    )
    return GoNoGoResponse(
        site_id=analysis.site_id,
        selected_route=request.selected_route,
        verdict=verdict,
        reason=reason,
        limiting_resource=limiting.resource if limiting is not None else None,
        remaining_margin_percent=margin_percent,
        safety_margin=request.safety_margin,
        return_trip_included=request.include_return_trip,
        dust_storm=request.dust_storm,
        resources=checks,
        suggestion=suggestion,
        model_notice=(
            analysis.model_notice
            + " Return-trip use assumes a symmetric retrace at the same modeled "
            "rate; stops, contingencies, and environmental variation are excluded."
        ),
        safety_notice=analysis.safety_notice,
    )
