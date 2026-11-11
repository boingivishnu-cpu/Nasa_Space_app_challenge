import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Globe2, LocateFixed, Map as MapIcon, ShieldCheck } from "lucide-react";
import {
  MapContainer,
  Marker,
  Pane,
  CircleMarker,
  Polyline,
  Popup,
  TileLayer,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L, { type LatLng, type PathOptions } from "leaflet";
import site from "../../data/sites/jezero.json";
import { useLayerStore } from "./state/layerStore";
import type { LayerId } from "./layers";
import MissionAssistant from "./MissionAssistant";

type CesiumMapProps = {
  onPosition: (position: LatLng) => void;
  onError: (message: string) => void;
  onTilesLoaded: () => void;
  elevationEnabled: boolean;
  elevationOpacity: number;
};

interface HazardGridPayload {
  pixelResolutionDegrees: number;
  latitudesDeg: number[];
  longitudesDeg: number[];
  elevationM: number[][];
  slopeDeg: number[][];
  noGoMask: boolean[][];
  slopeLimitDeg: number;
  blockedCells: number;
  totalCells: number;
}

interface CostGridPayload {
  pixelResolutionDegrees: number;
  latitudesDeg: number[];
  longitudesDeg: number[];
  elevationM: number[][];
  costM: (number | null)[][];
  noGoMask: boolean[][];
}

type RouteMode = "shortest" | "safest" | "science";

interface RoutePathPoint {
  row: number;
  column: number;
  latitudeDeg: number;
  longitudeDeg: number;
  elevationM: number;
  slopeDeg: number;
}

interface RouteProfilePoint extends RoutePathPoint {
  distanceFromStartM: number;
}

interface RouteModeResult {
  mode: RouteMode;
  distanceM: number;
  weightedCostM: number;
  steepestSlopeDeg: number;
  algorithmUsed: "astar" | "dijkstra";
  fallbackUsed: boolean;
  path: RoutePathPoint[];
  sciencePointsUsed: number;
  note: string;
  walkingTimeSeconds: number;
  ascentM: number;
  descentM: number;
  oxygenLiters: number;
  powerWh: number;
  waterLiters: number;
  elevationProfile: RouteProfilePoint[];
}

type ResourceKind = "oxygen" | "power" | "water";

interface ResourceCheck {
  resource: ResourceKind;
  unit: string;
  available: number;
  oneWayEstimate: number;
  tripEstimate: number;
  bufferedRequirement: number;
  remaining: number;
  remainingMarginPercent: number | null;
  sufficient: boolean;
}

interface GoNoGoResult {
  selectedRoute: RouteMode;
  verdict: "go" | "no_go";
  reason: string;
  limitingResource: ResourceKind | null;
  remainingMarginPercent: number | null;
  safetyMargin: number;
  returnTripIncluded: boolean;
  dustStorm: boolean;
  resources: ResourceCheck[];
  suggestion: string;
  modelNotice: string;
  safetyNotice: string;
}

interface HighlightedRoutePoint {
  mode: RouteMode;
  index: number;
}

interface Waypoint {
  row: number;
  column: number;
  position: LatLng;
  latitude: number;
  longitude: number;
  elevationM: number;
}

type WaypointName = "start" | "end";

const WAYPOINT_ICONS: Record<WaypointName, L.DivIcon> = {
  start: L.divIcon({
    className: "waypoint-div-icon waypoint-div-icon-start",
    html: "<span>S</span>",
    iconSize: [28, 36],
    iconAnchor: [14, 33],
  }),
  end: L.divIcon({
    className: "waypoint-div-icon waypoint-div-icon-end",
    html: "<span>E</span>",
    iconSize: [28, 36],
    iconAnchor: [14, 33],
  }),
};

const ROUTE_LABELS: Record<RouteMode, string> = {
  shortest: "SHORTEST",
  safest: "SAFEST",
  science: "SCIENCE",
};

const ROUTE_COLORS: Record<RouteMode, string> = {
  shortest: "#5ec8e5",
  safest: "#87c78b",
  science: "#d394e8",
};

const TILE_URL =
  import.meta.env.VITE_MARS_TILES_URL ??
  "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD ? "/api" : "http://localhost:8000");

const marsCrs = L.Util.extend({}, L.CRS.Simple, {
  transformation: new L.Transformation(256 / 180, 256, -256 / 180, 128),
  infinite: false,
});

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

function formatDistance(distanceM: number) {
  return distanceM >= 1000 ? `${(distanceM / 1000).toFixed(2)} km` : `${Math.round(distanceM)} m`;
}

function formatDuration(seconds: number) {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function localMarsTime(longitude: number) {
  const solHours = 24.6597;
  const hours = (((12 + (longitude / 360) * solHours) % solHours) + solHours) % solHours;
  const totalMinutes = Math.floor(hours * 60);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function CoordinateReadout({ onPosition }: { onPosition: (position: LatLng) => void }) {
  const map = useMapEvents({
    mousemove(event) {
      onPosition(event.latlng);
    },
    moveend() {
      onPosition(map.getCenter());
    },
  });
  return null;
}

function MarsScale() {
  const map = useMap();
  const [scale, setScale] = useState({ width: 76, label: "—" });

  useMapEvents({
    zoomend() {
      update();
    },
    moveend() {
      update();
    },
  });

  useEffect(() => {
    update();
  }, [map]);

  function update() {
    const latitude = map.getCenter().lat;
    const metersPerPixel =
      (59_300 * Math.max(0.0001, Math.cos((latitude * Math.PI) / 180))) /
      ((256 / 180) * 2 ** map.getZoom());
    const targetMeters = metersPerPixel * 90;
    const magnitude = 10 ** Math.floor(Math.log10(targetMeters));
    const normalized = targetMeters / magnitude;
    const nice = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
    const width = Math.min(110, nice / metersPerPixel);
    const formatted =
      nice >= 1000 ? `${Number((nice / 1000).toPrecision(2))} km` : `${Math.round(nice)} m`;

    if (Number.isFinite(latitude)) {
      setScale({ width, label: formatted });
    }
  }

  return (
    <div className="mars-scale" aria-label={`Approximate scale: ${scale.label}`}>
      <span className="scale-rule" style={{ width: `${scale.width}px` }} />
      <span>{scale.label}</span>
    </div>
  );
}

function findNearestCell(
  position: LatLng,
  grid: CostGridPayload,
): { row: number; column: number } {
  const radians = (position.lat * Math.PI) / 180;
  let nearest = { row: -1, column: -1 };
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let row = 0; row < grid.latitudesDeg.length; row += 1) {
    const latitudeDistance = (grid.latitudesDeg[row] - position.lat) * 111_195;
    for (let column = 0; column < grid.longitudesDeg.length; column += 1) {
      const longitudeDistance =
        (grid.longitudesDeg[column] - position.lng) * 111_195 * Math.cos(radians);
      const distance = latitudeDistance ** 2 + longitudeDistance ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { row, column };
      }
    }
  }

  return nearest;
}

function MapWaypointInteraction({
  grid,
  enabled,
  activeWaypoint,
  waypoints,
  onSetWaypoint,
  onMessage,
}: {
  grid: CostGridPayload | null;
  enabled: boolean;
  activeWaypoint: WaypointName;
  waypoints: Record<WaypointName, Waypoint | null>;
  onSetWaypoint: (name: WaypointName, position: LatLng) => boolean;
  onMessage: (message: string) => void;
}) {
  const map = useMapEvents({
    click(event) {
      if (!enabled) return;
      if (!grid) {
        onMessage("Terrain cost grid is not ready yet.");
        return;
      }
      onSetWaypoint(activeWaypoint, event.latlng);
    },
  });

  return (
    <>
      {(["start", "end"] as const).map((name) => {
        const waypoint = waypoints[name];
        if (!waypoint) return null;
        return (
          <Marker
            key={name}
            position={waypoint.position}
            draggable={enabled && Boolean(grid)}
            icon={WAYPOINT_ICONS[name]}
            eventHandlers={{
              dragend: (event) => {
                if (!enabled) return;
                const marker = event.target as L.Marker;
                const accepted = onSetWaypoint(name, marker.getLatLng());
                if (!accepted) {
                  const previous = waypoints[name];
                  if (previous) {
                    marker.setLatLng([previous.latitude, previous.longitude]);
                    map.panInside([previous.latitude, previous.longitude]);
                  }
                }
              },
            }}
          >
            <Popup>
              <strong>{name === "start" ? "START" : "END"} WAYPOINT</strong>
              <br />
              {formatCoordinate(waypoint.latitude, "N", "S")} ·{" "}
              {formatCoordinate(waypoint.longitude, "E", "W")}
              <br />
              MOLA elevation: {waypoint.elevationM.toFixed(0)} m
              <br />
              Drag to move · snapped to MOLA cell
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

function slopeColor(slopeDegrees: number): string {
  if (slopeDegrees < 5) return "#39b7a4";
  if (slopeDegrees < 10) return "#a5c96f";
  if (slopeDegrees < 18) return "#f0ca66";
  if (slopeDegrees < 25) return "#ec9259";
  return "#d65c60";
}

function parseHazardGrid(value: unknown): HazardGridPayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("Terrain service returned an invalid grid response.");
  }
  const grid = value as Record<string, unknown>;
  const isNumberArray = (candidate: unknown): candidate is number[] =>
    Array.isArray(candidate) &&
    candidate.every((item) => typeof item === "number" && Number.isFinite(item));
  const isNumberGrid = (candidate: unknown): candidate is number[][] =>
    Array.isArray(candidate) && candidate.every(isNumberArray);
  const isBooleanGrid = (candidate: unknown): candidate is boolean[][] =>
    Array.isArray(candidate) &&
    candidate.every(
      (row) => Array.isArray(row) && row.every((cell) => typeof cell === "boolean"),
    );

  if (
    typeof grid.siteId !== "string" ||
    grid.siteId !== site.id ||
    typeof grid.pixelResolutionDegrees !== "number" ||
    !Number.isFinite(grid.pixelResolutionDegrees) ||
    grid.pixelResolutionDegrees <= 0 ||
    !isNumberArray(grid.latitudesDeg) ||
    !isNumberArray(grid.longitudesDeg) ||
    !isNumberGrid(grid.elevationM) ||
    !isNumberGrid(grid.slopeDeg) ||
    !isBooleanGrid(grid.noGoMask) ||
    typeof grid.slopeLimitDeg !== "number" ||
    !Number.isFinite(grid.slopeLimitDeg) ||
    typeof grid.blockedCells !== "number" ||
    !Number.isInteger(grid.blockedCells) ||
    typeof grid.totalCells !== "number" ||
    !Number.isInteger(grid.totalCells)
  ) {
    throw new Error("Terrain service returned an invalid or mismatched grid response.");
  }

  const rows = grid.latitudesDeg.length;
  const columns = grid.longitudesDeg.length;
  const matchesGrid = (candidate: unknown[][]) =>
    candidate.length === rows && candidate.every((row) => row.length === columns);
  if (
    rows === 0 ||
    columns === 0 ||
    grid.totalCells !== rows * columns ||
    grid.blockedCells < 0 ||
    grid.blockedCells > grid.totalCells ||
    !matchesGrid(grid.elevationM) ||
    !matchesGrid(grid.slopeDeg) ||
    !matchesGrid(grid.noGoMask)
  ) {
    throw new Error("Terrain service returned inconsistent grid dimensions.");
  }

  return {
    pixelResolutionDegrees: grid.pixelResolutionDegrees,
    latitudesDeg: grid.latitudesDeg,
    longitudesDeg: grid.longitudesDeg,
    elevationM: grid.elevationM,
    slopeDeg: grid.slopeDeg,
    noGoMask: grid.noGoMask,
    slopeLimitDeg: grid.slopeLimitDeg,
    blockedCells: grid.blockedCells,
    totalCells: grid.totalCells,
  };
}

function parseRouteResponse(value: unknown): RouteModeResult[] {
  if (typeof value !== "object" || value === null || !("routes" in value)) {
    throw new Error("Routing service returned an invalid response.");
  }
  const payload = value as { siteId?: unknown; routes?: unknown };
  if (
    payload.siteId !== site.id ||
    !Array.isArray(payload.routes) ||
    payload.routes.length !== 3
  ) {
    throw new Error("Routing service returned a mismatched site or route set.");
  }

  const expectedModes: RouteMode[] = ["shortest", "safest", "science"];
  return payload.routes.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("Routing service returned an invalid route.");
    }
    const route = candidate as Record<string, unknown>;
    if (
      route.mode !== expectedModes[index] ||
      typeof route.distanceM !== "number" ||
      !Number.isFinite(route.distanceM) ||
      route.distanceM < 0 ||
      typeof route.weightedCostM !== "number" ||
      !Number.isFinite(route.weightedCostM) ||
      typeof route.steepestSlopeDeg !== "number" ||
      !Number.isFinite(route.steepestSlopeDeg) ||
      (route.algorithmUsed !== "astar" && route.algorithmUsed !== "dijkstra") ||
      typeof route.fallbackUsed !== "boolean" ||
      !Array.isArray(route.path) ||
      route.path.length === 0 ||
      typeof route.sciencePointsUsed !== "number" ||
      !Number.isInteger(route.sciencePointsUsed) ||
      typeof route.note !== "string" ||
      typeof route.walkingTimeSeconds !== "number" ||
      !Number.isFinite(route.walkingTimeSeconds) ||
      typeof route.ascentM !== "number" ||
      !Number.isFinite(route.ascentM) ||
      typeof route.descentM !== "number" ||
      !Number.isFinite(route.descentM) ||
      typeof route.oxygenLiters !== "number" ||
      !Number.isFinite(route.oxygenLiters) ||
      typeof route.powerWh !== "number" ||
      !Number.isFinite(route.powerWh) ||
      typeof route.waterLiters !== "number" ||
      !Number.isFinite(route.waterLiters) ||
      !Array.isArray(route.elevationProfile)
    ) {
      throw new Error("Routing service returned incomplete route data.");
    }

    const parsePoint = (candidatePoint: unknown): RoutePathPoint => {
      if (typeof candidatePoint !== "object" || candidatePoint === null) {
        throw new Error("Routing service returned an invalid path sample.");
      }
      const point = candidatePoint as Record<string, unknown>;
      if (
        typeof point.row !== "number" ||
        !Number.isInteger(point.row) ||
        typeof point.column !== "number" ||
        !Number.isInteger(point.column) ||
        typeof point.latitudeDeg !== "number" ||
        !Number.isFinite(point.latitudeDeg) ||
        typeof point.longitudeDeg !== "number" ||
        !Number.isFinite(point.longitudeDeg) ||
        typeof point.elevationM !== "number" ||
        !Number.isFinite(point.elevationM) ||
        typeof point.slopeDeg !== "number" ||
        !Number.isFinite(point.slopeDeg)
      ) {
        throw new Error("Routing service returned an invalid path sample.");
      }
      return {
        row: point.row,
        column: point.column,
        latitudeDeg: point.latitudeDeg,
        longitudeDeg: point.longitudeDeg,
        elevationM: point.elevationM,
        slopeDeg: point.slopeDeg,
      };
    };
    const path = route.path.map(parsePoint);
    const elevationProfile = route.elevationProfile.map((candidatePoint) => {
      const point = parsePoint(candidatePoint);
      if (
        typeof candidatePoint !== "object" ||
        candidatePoint === null ||
        !("distanceFromStartM" in candidatePoint) ||
        typeof candidatePoint.distanceFromStartM !== "number" ||
        !Number.isFinite(candidatePoint.distanceFromStartM) ||
        candidatePoint.distanceFromStartM < 0
      ) {
        throw new Error("Routing service returned an invalid elevation profile.");
      }
      return {
        ...point,
        distanceFromStartM: candidatePoint.distanceFromStartM,
      };
    });
    if (elevationProfile.length !== path.length) {
      throw new Error("Routing service returned mismatched route and profile samples.");
    }

    return {
      mode: route.mode as RouteMode,
      distanceM: route.distanceM,
      weightedCostM: route.weightedCostM,
      steepestSlopeDeg: route.steepestSlopeDeg,
      algorithmUsed: route.algorithmUsed,
      fallbackUsed: route.fallbackUsed,
      path,
      sciencePointsUsed: route.sciencePointsUsed,
      note: route.note,
      walkingTimeSeconds: route.walkingTimeSeconds,
      ascentM: route.ascentM,
      descentM: route.descentM,
      oxygenLiters: route.oxygenLiters,
      powerWh: route.powerWh,
      waterLiters: route.waterLiters,
      elevationProfile,
    };
  });
}

function FitSiteControl() {
  const map = useMap();

  const fitSite = useCallback(() => {
    map.fitBounds(
      [
        [site.bounds.south, site.bounds.west],
        [site.bounds.north, site.bounds.east],
      ],
      {
        padding: [36, 36],
        maxZoom: site.zoom.initial,
        animate: true,
        duration: 0.6,
      },
    );
  }, [map]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      map.invalidateSize({ pan: false });
      fitSite();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [fitSite, map]);

  return (
    <div className="fit-site-control">
      <button type="button" onClick={fitSite} aria-label="Fit the full Jezero Crater planning area in the map">
        <LocateFixed size={13} />
        FIT JEZERO
      </button>
    </div>
  );
}

const TerrainGridOverlay = memo(function TerrainGridOverlay({
  layerId,
  grid,
}: {
  layerId: "slope" | "hazards";
  grid: HazardGridPayload;
}) {
  const map = useMap();
  const enabled = useLayerStore((state) => state.enabled[layerId]);
  const opacity = useLayerStore((state) => state.opacity[layerId]);
  const order = useLayerStore((state) => state.order);

  useEffect(() => {
    if (!enabled) return;

    const paneName = `mars-${layerId}`;
    const pane = map.getPane(paneName) ?? map.createPane(paneName);
    pane.style.zIndex = String(410 + order.length - order.indexOf(layerId));

    const renderer = L.canvas({ pane: paneName, padding: 0.5 }).addTo(map);
    const cells = L.layerGroup().addTo(map);

    for (let row = 0; row < grid.latitudesDeg.length; row += 1) {
      for (let column = 0; column < grid.longitudesDeg.length; column += 1) {
        const blocked = grid.noGoMask[row][column];
        if (layerId === "hazards" && !blocked) continue;

        const latitude = grid.latitudesDeg[row];
        const longitude = grid.longitudesDeg[column];
        const halfCell = grid.pixelResolutionDegrees / 2;
        const options: PathOptions = {
          pane: paneName,
          renderer,
          stroke: layerId === "hazards",
          color: "#f05e61",
          weight: 0.7,
          fillColor: layerId === "hazards" ? "#d94f5d" : slopeColor(grid.slopeDeg[row][column]),
          fillOpacity: opacity,
          interactive: false,
        };
        L.rectangle(
          [
            [latitude - halfCell, longitude - halfCell],
            [latitude + halfCell, longitude + halfCell],
          ],
          options,
        ).addTo(cells);
      }
    }

    return () => {
      cells.remove();
      renderer.remove();
    };
  }, [enabled, grid, layerId, map, opacity, order]);

  return null;
});

function RouteLines({
  routes,
  selectedMode,
  highlightedPoint,
  onPointHover,
}: {
  routes: RouteModeResult[];
  selectedMode: RouteMode;
  highlightedPoint: HighlightedRoutePoint | null;
  onPointHover: (point: HighlightedRoutePoint | null) => void;
}) {
  const map = useMap();
  const [renderer, setRenderer] = useState<L.Renderer | null>(null);

  useEffect(() => {
    const pane = map.getPane("mars-routes") ?? map.createPane("mars-routes");
    pane.style.zIndex = "450";
    const svgRenderer = L.svg({ pane: "mars-routes", padding: 0.5 }).addTo(map);
    setRenderer(svgRenderer);
    return () => {
      svgRenderer.remove();
    };
  }, [map]);

  if (!renderer) return null;

  return (
    <>
      {[...routes.filter((route) => route.mode !== selectedMode), ...routes.filter((route) => route.mode === selectedMode)].map(
        (route) => (
          <Polyline
            key={route.mode}
            positions={route.path.map(
              (point) => [point.latitudeDeg, point.longitudeDeg] as [number, number],
            )}
            renderer={renderer}
            pathOptions={{
              color: ROUTE_COLORS[route.mode],
              opacity: route.mode === selectedMode ? 0.96 : 0.62,
              weight: route.mode === selectedMode ? 4 : 2.5,
              className: `mars-route-line mars-route-${route.mode}`,
              lineCap: "round",
              lineJoin: "round",
              interactive: true,
            }}
            eventHandlers={{
              mousemove: (event) => {
                const cursor = map.latLngToLayerPoint(event.latlng);
                let nearestIndex = 0;
                let nearestDistance = Number.POSITIVE_INFINITY;
                route.path.forEach((point, index) => {
                  const position = map.latLngToLayerPoint([
                    point.latitudeDeg,
                    point.longitudeDeg,
                  ]);
                  const distance = cursor.distanceTo(position);
                  if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestIndex = index;
                  }
                });
                onPointHover({ mode: route.mode, index: nearestIndex });
              },
              mouseout: () => onPointHover(null),
            }}
          />
        ),
      )}
      {highlightedPoint && (
        (() => {
          const route = routes.find((item) => item.mode === highlightedPoint.mode);
          const point = route?.path[highlightedPoint.index];
          return point ? (
            <CircleMarker
              center={[point.latitudeDeg, point.longitudeDeg]}
              radius={7}
              pathOptions={{
                color: "#f5ead5",
                weight: 2,
                fillColor: ROUTE_COLORS[route.mode],
                fillOpacity: 0.96,
              }}
              eventHandlers={{
                mousemove: () => onPointHover(highlightedPoint),
              }}
            />
          ) : null;
        })()
      )}
    </>
  );
}

function ElevationProfile({
  route,
  highlightedIndex,
  onHighlight,
}: {
  route: RouteModeResult;
  highlightedIndex: number | null;
  onHighlight: (index: number | null) => void;
}) {
  const profile = route.elevationProfile;
  const elevations = profile.map((point) => point.elevationM);
  const minimum = Math.min(...elevations);
  const maximum = Math.max(...elevations);
  const range = Math.max(1, maximum - minimum);
  const plotX = (index: number) =>
    profile.length < 2 ? 300 : 24 + (index / (profile.length - 1)) * 552;
  const plotY = (elevation: number) => 15 + ((maximum - elevation) / range) * 112;
  const line = profile
    .map((point, index) => `${index === 0 ? "M" : "L"}${plotX(index)},${plotY(point.elevationM)}`)
    .join(" ");
  const activeIndex = highlightedIndex ?? 0;
  const activePoint = profile[activeIndex];

  function updateFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || profile.length === 0) return;
    const svgX = ((event.clientX - bounds.left) / bounds.width) * 600;
    const index = Math.round(Math.max(0, Math.min(1, (svgX - 24) / 552)) * (profile.length - 1));
    onHighlight(index);
  }

  return (
    <div className="elevation-profile">
      <div className="profile-heading">
        <span>ELEVATION PROFILE <i>·</i> {ROUTE_LABELS[route.mode]}</span>
        <strong>{activePoint.elevationM.toFixed(0)} m <small>·</small> {formatDistance(activePoint.distanceFromStartM)}</strong>
      </div>
      <svg
        className="profile-chart"
        viewBox="0 0 600 160"
        role="img"
        aria-label={`${ROUTE_LABELS[route.mode].toLowerCase()} route elevation profile from ${minimum.toFixed(0)} to ${maximum.toFixed(0)} meters`}
        onPointerMove={updateFromPointer}
        onPointerLeave={() => onHighlight(null)}
      >
        <path className="profile-gridline" d="M24 15H576 M24 71H576 M24 127H576" />
        <path className="profile-area" d={`${line} L${plotX(profile.length - 1)},127 L${plotX(0)},127 Z`} />
        <path className="profile-line" d={line} style={{ stroke: ROUTE_COLORS[route.mode] }} />
        <circle
          className="profile-marker"
          cx={plotX(activeIndex)}
          cy={plotY(activePoint.elevationM)}
          r="5"
          style={{ fill: ROUTE_COLORS[route.mode] }}
        />
        <text x="24" y="146">{formatDistance(0)}</text>
        <text x="576" y="146" textAnchor="end">{formatDistance(route.distanceM)}</text>
        <text x="24" y="11">{maximum.toFixed(0)} m</text>
        <text x="24" y="138">{minimum.toFixed(0)} m</text>
      </svg>
      <label className="profile-sample-control">
        <span>SCRUB ROUTE SAMPLE</span>
        <input
          type="range"
          min={0}
          max={profile.length - 1}
          step={1}
          value={activeIndex}
          aria-label="Highlight route point on elevation profile and map"
          onChange={(event) => onHighlight(Number(event.currentTarget.value))}
        />
      </label>
    </div>
  );
}

function MarsMap() {
  const [position, setPosition] = useState<LatLng>(
    L.latLng(site.center.latitude, site.center.longitude),
  );
  const [tilesLoading, setTilesLoading] = useState(true);
  const [tileError, setTileError] = useState(false);
  const [mapMode, setMapMode] = useState<"2d" | "3d">("2d");
  const [cesiumComponent, setCesiumComponent] =
    useState<ComponentType<CesiumMapProps> | null>(null);
  const [threeDimensionalLoading, setThreeDimensionalLoading] = useState(false);
  const [viewerError, setViewerError] = useState("");
  const elevationEnabled = useLayerStore((state) => state.enabled.elevation);
  const elevationOpacity = useLayerStore((state) => state.opacity.elevation);
  const slopeEnabled = useLayerStore((state) => state.enabled.slope);
  const hazardsEnabled = useLayerStore((state) => state.enabled.hazards);
  const layerOrder = useLayerStore((state) => state.order);
  const [hazardGrid, setHazardGrid] = useState<HazardGridPayload | null>(null);
  const [terrainLoading, setTerrainLoading] = useState(false);
  const [terrainError, setTerrainError] = useState("");
  const [terrainRequestKey, setTerrainRequestKey] = useState(0);
  const terrainRequestId = useRef(0);
  const [costGrid, setCostGrid] = useState<CostGridPayload | null>(null);
  const [costGridLoading, setCostGridLoading] = useState(false);
  const [costGridError, setCostGridError] = useState("");
  const [costGridRequestKey, setCostGridRequestKey] = useState(0);
  const [waypoints, setWaypoints] = useState<Record<WaypointName, Waypoint | null>>({
    start: null,
    end: null,
  });
  const [activeWaypoint, setActiveWaypoint] = useState<WaypointName>("start");
  const [waypointMessage, setWaypointMessage] = useState("");
  const [selectionEnabled, setSelectionEnabled] = useState(true);
  const [routes, setRoutes] = useState<RouteModeResult[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteMode>("safest");
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [routeRequestKey, setRouteRequestKey] = useState(0);
  const [walkingSpeedMps, setWalkingSpeedMps] = useState(0.8);
  const [dustStorm, setDustStorm] = useState(false);
  const [timeOfDayHour, setTimeOfDayHour] = useState(12);
  const [highlightedPoint, setHighlightedPoint] =
    useState<HighlightedRoutePoint | null>(null);
  const [oxygenCapacity, setOxygenCapacity] = useState("");
  const [powerCapacity, setPowerCapacity] = useState("");
  const [waterCapacity, setWaterCapacity] = useState("");
  const [safetyMarginPercent, setSafetyMarginPercent] = useState(20);
  const [includeReturnTrip, setIncludeReturnTrip] = useState(true);
  const [goNoGoResult, setGoNoGoResult] = useState<GoNoGoResult | null>(null);
  const [goNoGoLoading, setGoNoGoLoading] = useState(false);
  const [goNoGoError, setGoNoGoError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setCostGridLoading(true);
    setCostGridError("");

    async function loadCostGrid() {
      try {
        const response = await fetch(`${API_BASE_URL}/cost-grid`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: site.id }),
          signal: controller.signal,
        });
        if (!response.ok) {
          let message = `Terrain cost service returned HTTP ${response.status}.`;
          const errorBody: unknown = await response.json().catch(() => null);
          if (
            typeof errorBody === "object" &&
            errorBody !== null &&
            "error" in errorBody &&
            typeof errorBody.error === "object" &&
            errorBody.error !== null &&
            "message" in errorBody.error &&
            typeof errorBody.error.message === "string"
          ) {
            message = errorBody.error.message;
          }
          throw new Error(message);
        }

        const value: unknown = await response.json();
        if (typeof value !== "object" || value === null) {
          throw new Error("Terrain service returned an invalid cost grid.");
        }
        const data = value as Record<string, unknown>;
        const isNumberArray = (candidate: unknown): candidate is number[] =>
          Array.isArray(candidate) &&
          candidate.every((cell) => typeof cell === "number" && Number.isFinite(cell));
        const isMatrix = <T,>(candidate: unknown, isCell: (cell: unknown) => cell is T): candidate is T[][] =>
          Array.isArray(candidate) &&
          candidate.every((row) => Array.isArray(row) && row.every(isCell));
        const isBoolean = (cell: unknown): cell is boolean => typeof cell === "boolean";
        const isElevation = (cell: unknown): cell is number =>
          typeof cell === "number" && Number.isFinite(cell);
        const isCost = (cell: unknown): cell is number | null =>
          cell === null || (typeof cell === "number" && Number.isFinite(cell));

        if (
          data.siteId !== site.id ||
          typeof data.pixelResolutionDegrees !== "number" ||
          !Number.isFinite(data.pixelResolutionDegrees) ||
          data.pixelResolutionDegrees <= 0 ||
          !isNumberArray(data.latitudesDeg) ||
          !isNumberArray(data.longitudesDeg) ||
          !isMatrix(data.elevationM, isElevation) ||
          !isMatrix(data.costM, isCost) ||
          !isMatrix(data.noGoMask, isBoolean)
        ) {
          throw new Error("Terrain service returned an invalid or mismatched cost grid.");
        }
        const rows = data.latitudesDeg.length;
        const columns = data.longitudesDeg.length;
        if (
          rows === 0 ||
          columns === 0 ||
          data.elevationM.length !== rows ||
          data.costM.length !== rows ||
          data.noGoMask.length !== rows ||
          data.elevationM.some((row) => row.length !== columns) ||
          data.costM.some((row) => row.length !== columns) ||
          data.noGoMask.some((row) => row.length !== columns)
        ) {
          throw new Error("Terrain service returned inconsistent cost-grid dimensions.");
        }

        const grid: CostGridPayload = {
          pixelResolutionDegrees: data.pixelResolutionDegrees,
          latitudesDeg: data.latitudesDeg,
          longitudesDeg: data.longitudesDeg,
          elevationM: data.elevationM,
          costM: data.costM,
          noGoMask: data.noGoMask,
        };
        if (
          grid.pixelResolutionDegrees <= 0 ||
          !Number.isFinite(grid.pixelResolutionDegrees) ||
          grid.noGoMask.some((row, rowIndex) =>
            row.some((blocked, columnIndex) => blocked === (grid.costM[rowIndex][columnIndex] !== null)),
          )
        ) {
          throw new Error("Terrain service returned inconsistent cell resolution or traversability.");
        }
        setCostGrid(grid);
      } catch (error) {
        if (controller.signal.aborted) return;
        setCostGridError(
          error instanceof Error ? error.message : "Could not load the terrain cost grid.",
        );
      } finally {
        if (!controller.signal.aborted) setCostGridLoading(false);
      }
    }

    void loadCostGrid();
    return () => controller.abort();
  }, [costGridRequestKey]);

  useEffect(() => {
    const startWaypoint = waypoints.start;
    const endWaypoint = waypoints.end;
    if (!startWaypoint || !endWaypoint || !costGrid || costGridLoading) {
      setRoutes([]);
      setRouteError("");
      setRouteLoading(false);
      return;
    }

    const controller = new AbortController();
    setRoutes([]);
    setRouteLoading(true);
    setRouteError("");
    setGoNoGoResult(null);
    setGoNoGoError("");
    const requestBody = JSON.stringify({
      siteId: site.id,
      walkingSpeedMS: walkingSpeedMps,
      dustStorm,
      start: {
        latitudeDeg: startWaypoint.latitude,
        longitudeDeg: startWaypoint.longitude,
      },
      end: {
        latitudeDeg: endWaypoint.latitude,
        longitudeDeg: endWaypoint.longitude,
      },
    });

    async function loadRoutes() {
      try {
        const response = await fetch(`${API_BASE_URL}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal,
        });
        if (!response.ok) {
          let message = `Route analysis service returned HTTP ${response.status}.`;
          const errorBody: unknown = await response.json().catch(() => null);
          if (
            typeof errorBody === "object" &&
            errorBody !== null &&
            "error" in errorBody &&
            typeof errorBody.error === "object" &&
            errorBody.error !== null &&
            "message" in errorBody.error &&
            typeof errorBody.error.message === "string"
          ) {
            message = errorBody.error.message;
          }
          throw new Error(message);
        }

        const nextRoutes = parseRouteResponse(await response.json());
        setRoutes(nextRoutes);
        setHighlightedPoint(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setRouteError(
          error instanceof Error ? error.message : "Could not compute route analysis.",
        );
      } finally {
        if (!controller.signal.aborted) setRouteLoading(false);
      }
    }

    void loadRoutes();
    return () => controller.abort();
  }, [
    costGrid,
    costGridLoading,
    routeRequestKey,
    dustStorm,
    walkingSpeedMps,
    waypoints.end,
    waypoints.start,
  ]);

  useEffect(() => {
    if (!slopeEnabled && !hazardsEnabled) {
      setTerrainError("");
      setTerrainLoading(false);
      return;
    }
    if (hazardGrid) return;

    const controller = new AbortController();
    const requestId = ++terrainRequestId.current;
    setTerrainLoading(true);
    setTerrainError("");

    async function loadHazardGrid() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/hazards?site_id=${encodeURIComponent(site.id)}&slope_limit_deg=25`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          let message = `Terrain service returned HTTP ${response.status}.`;
          const errorBody: unknown = await response.json().catch(() => null);
          if (
            typeof errorBody === "object" &&
            errorBody !== null &&
            "error" in errorBody &&
            typeof errorBody.error === "object" &&
            errorBody.error !== null &&
            "message" in errorBody.error &&
            typeof errorBody.error.message === "string"
          ) {
            message = errorBody.error.message;
          }
          throw new Error(message);
        }

        setHazardGrid(parseHazardGrid(await response.json()));
      } catch (error) {
        if (controller.signal.aborted) return;
        setTerrainError(
          error instanceof Error
            ? error.message
            : "Could not load MOLA terrain analysis from the API.",
        );
      } finally {
        if (requestId === terrainRequestId.current) setTerrainLoading(false);
      }
    }

    void loadHazardGrid();
    return () => {
      controller.abort();
      if (requestId === terrainRequestId.current) {
        terrainRequestId.current += 1;
        setTerrainLoading(false);
      }
    };
  }, [hazardGrid, hazardsEnabled, slopeEnabled, terrainRequestKey]);

  const handlePosition = useCallback((nextPosition: LatLng) => {
    setPosition(nextPosition);
  }, []);

  const handleTilesLoaded = useCallback(() => {
    setTilesLoading(false);
  }, []);

  const handleViewerError = useCallback((message: string) => {
    setViewerError(message);
    setTilesLoading(false);
    setMapMode("2d");
  }, []);

  const setWaypointAtPosition = useCallback(
    (name: WaypointName, position: LatLng): boolean => {
      if (!costGrid) {
        setWaypointMessage("Terrain cost grid is not ready yet.");
        return false;
      }
      if (
        position.lat < site.bounds.south ||
        position.lat > site.bounds.north ||
        position.lng < site.bounds.west ||
        position.lng > site.bounds.east
      ) {
        setWaypointMessage("Choose a point inside the configured Jezero terrain grid.");
        return false;
      }

      const cell = findNearestCell(position, costGrid);
      if (cell.row < 0 || cell.column < 0) {
        setWaypointMessage("No terrain cell is available at that position.");
        return false;
      }
      if (costGrid.noGoMask[cell.row][cell.column] || costGrid.costM[cell.row][cell.column] === null) {
        setWaypointMessage("That MOLA cell is blocked by the current slope screen. Choose another cell.");
        return false;
      }

      const waypoint: Waypoint = {
        ...cell,
        position: L.latLng(
          costGrid.latitudesDeg[cell.row],
          costGrid.longitudesDeg[cell.column],
        ),
        latitude: costGrid.latitudesDeg[cell.row],
        longitude: costGrid.longitudesDeg[cell.column],
        elevationM: costGrid.elevationM[cell.row][cell.column],
      };
      setWaypoints((current) => ({ ...current, [name]: waypoint }));
      setWaypointMessage(
        `${name === "start" ? "Start" : "End"} snapped to MOLA cell · elevation ${waypoint.elevationM.toFixed(0)} m.`,
      );
      if (name === "start" && !waypoints.end) setActiveWaypoint("end");
      return true;
    },
    [costGrid, waypoints.end],
  );

  const resetWaypoints = () => {
    setWaypoints({ start: null, end: null });
    setRoutes([]);
    setHighlightedPoint(null);
    setActiveWaypoint("start");
    setWaypointMessage("Waypoints cleared. Choose a start cell on the map.");
  };

  const formatWaypoint = (waypoint: Waypoint | null) =>
    waypoint
      ? `${waypoint.latitude.toFixed(4)}°, ${waypoint.longitude.toFixed(4)}° · ${waypoint.elevationM.toFixed(0)} m`
      : "NOT SET";

  async function toggleMapMode() {
    if (mapMode === "3d") {
      setMapMode("2d");
      return;
    }
    if (cesiumComponent) {
      setViewerError("");
      setTilesLoading(true);
      setMapMode("3d");
      return;
    }

    setThreeDimensionalLoading(true);
    setTilesLoading(true);
    setViewerError("");
    try {
      const module = await import("./CesiumMap");
      setCesiumComponent(() => module.default);
      setMapMode("3d");
    } catch (error) {
      setViewerError(
        error instanceof Error
          ? `3D globe could not be loaded: ${error.message}`
          : "3D globe could not be loaded. The 2D map remains available.",
      );
    } finally {
      setThreeDimensionalLoading(false);
    }
  }

  const eventHandlers = useMemo(
    () => ({
      loading: () => {
        setTilesLoading(true);
        setTileError(false);
      },
      load: () => setTilesLoading(false),
      tileerror: () => setTileError(true),
    }),
    [],
  );

  const CesiumMap = cesiumComponent;

  const activeRoute = routes.find((route) => route.mode === selectedRoute) ?? null;

  async function submitGoNoGo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRoute || !waypoints.start || !waypoints.end) return;
    setGoNoGoLoading(true);
    setGoNoGoError("");
    setGoNoGoResult(null);

    try {
      const response = await fetch(`${API_BASE_URL}/go-nogo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId: site.id,
          start: {
            latitudeDeg: waypoints.start.latitude,
            longitudeDeg: waypoints.start.longitude,
          },
          end: {
            latitudeDeg: waypoints.end.latitude,
            longitudeDeg: waypoints.end.longitude,
          },
          walkingSpeedMS: walkingSpeedMps,
          selectedRoute,
          oxygenAvailableLiters: Number(oxygenCapacity),
          powerAvailableWh: Number(powerCapacity),
          waterAvailableLiters: Number(waterCapacity),
          safetyMargin: safetyMarginPercent / 100,
          includeReturnTrip,
          dustStorm,
        }),
      });
      if (!response.ok) {
        let message = `GO/NO-GO service returned HTTP ${response.status}.`;
        const errorBody: unknown = await response.json().catch(() => null);
        if (
          typeof errorBody === "object" &&
          errorBody !== null &&
          "error" in errorBody &&
          typeof errorBody.error === "object" &&
          errorBody.error !== null &&
          "message" in errorBody.error &&
          typeof errorBody.error.message === "string"
        ) {
          message = errorBody.error.message;
        }
        throw new Error(message);
      }

      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("resources" in value)) {
        throw new Error("GO/NO-GO service returned an invalid response.");
      }
      const result = value as Record<string, unknown>;
      if (
        (result.selectedRoute !== "shortest" &&
          result.selectedRoute !== "safest" &&
          result.selectedRoute !== "science") ||
        result.selectedRoute !== selectedRoute ||
        (result.verdict !== "go" && result.verdict !== "no_go") ||
        typeof result.reason !== "string" ||
        !(result.limitingResource === null ||
          result.limitingResource === "oxygen" ||
          result.limitingResource === "power" ||
          result.limitingResource === "water") ||
        !(result.remainingMarginPercent === null ||
          (typeof result.remainingMarginPercent === "number" &&
            Number.isFinite(result.remainingMarginPercent))) ||
        typeof result.safetyMargin !== "number" ||
        !Number.isFinite(result.safetyMargin) ||
        typeof result.returnTripIncluded !== "boolean" ||
        typeof result.dustStorm !== "boolean" ||
        !Array.isArray(result.resources) ||
        result.resources.length !== 3 ||
        typeof result.suggestion !== "string" ||
        typeof result.modelNotice !== "string" ||
        typeof result.safetyNotice !== "string"
      ) {
        throw new Error("GO/NO-GO service returned incomplete resource results.");
      }
      const expectedResources: ResourceKind[] = ["oxygen", "power", "water"];
      const resources: ResourceCheck[] = result.resources.map((item, index) => {
        if (typeof item !== "object" || item === null) {
          throw new Error("GO/NO-GO service returned an invalid resource result.");
        }
        const check = item as Record<string, unknown>;
        if (
          (check.resource !== "oxygen" &&
            check.resource !== "power" &&
            check.resource !== "water") ||
          check.resource !== expectedResources[index] ||
          typeof check.unit !== "string" ||
          typeof check.available !== "number" ||
          !Number.isFinite(check.available) ||
          typeof check.oneWayEstimate !== "number" ||
          !Number.isFinite(check.oneWayEstimate) ||
          typeof check.tripEstimate !== "number" ||
          !Number.isFinite(check.tripEstimate) ||
          typeof check.bufferedRequirement !== "number" ||
          !Number.isFinite(check.bufferedRequirement) ||
          typeof check.remaining !== "number" ||
          !Number.isFinite(check.remaining) ||
          !(check.remainingMarginPercent === null ||
            (typeof check.remainingMarginPercent === "number" &&
              Number.isFinite(check.remainingMarginPercent))) ||
          typeof check.sufficient !== "boolean"
        ) {
          throw new Error("GO/NO-GO service returned invalid resource values.");
        }
        return {
          resource: check.resource,
          unit: check.unit,
          available: check.available,
          oneWayEstimate: check.oneWayEstimate,
          tripEstimate: check.tripEstimate,
          bufferedRequirement: check.bufferedRequirement,
          remaining: check.remaining,
          remainingMarginPercent: check.remainingMarginPercent,
          sufficient: check.sufficient,
        };
      });
      setGoNoGoResult({
        selectedRoute: result.selectedRoute,
        verdict: result.verdict,
        reason: result.reason,
        limitingResource: result.limitingResource,
        remainingMarginPercent: result.remainingMarginPercent,
        safetyMargin: result.safetyMargin,
        returnTripIncluded: result.returnTripIncluded,
        dustStorm: result.dustStorm,
        resources,
        suggestion: result.suggestion,
        modelNotice: result.modelNotice,
        safetyNotice: result.safetyNotice,
      });
    } catch (error) {
      setGoNoGoError(
        error instanceof Error ? error.message : "Could not evaluate suit resources.",
      );
    } finally {
      setGoNoGoLoading(false);
    }
  }

  return (
    <>
    <div className="map-frame">
      {mapMode === "2d" ? (
        <MapContainer
          className="mars-map"
          crs={marsCrs}
          center={[site.center.latitude, site.center.longitude]}
          zoom={site.zoom.initial}
          minZoom={site.zoom.minimum}
          maxZoom={site.zoom.maximum}
          maxBounds={[[-89.9, -179.9], [89.9, 179.9]]}
          maxBoundsViscosity={0.75}
          zoomControl={false}
          zoomSnap={0.25}
          zoomDelta={1}
          preferCanvas
          attributionControl
        >
          {layerOrder.map((id: LayerId) =>
            id === "elevation" ? (
              <Pane
                key={id}
                name="mars-elevation"
                style={{ zIndex: String(410 + layerOrder.length - layerOrder.indexOf(id)) }}
              >
                {elevationEnabled && (
                  <TileLayer
                    url={TILE_URL}
                    attribution='Imagery: <a href="https://trek.nasa.gov/mars/">NASA Mars Trek</a> · MGS MOLA color-shaded relief (463 m/pixel)'
                    minZoom={site.zoom.minimum}
                    maxZoom={site.zoom.maximum}
                    maxNativeZoom={7}
                    opacity={elevationOpacity}
                    pane="mars-elevation"
                    noWrap
                    eventHandlers={eventHandlers}
                  />
                )}
              </Pane>
            ) : null,
          )}
          {hazardGrid && (
            <>
              <TerrainGridOverlay layerId="slope" grid={hazardGrid} />
              <TerrainGridOverlay layerId="hazards" grid={hazardGrid} />
            </>
          )}
          <MapWaypointInteraction
            grid={costGrid}
            enabled={selectionEnabled && !costGridLoading && !costGridError}
            activeWaypoint={activeWaypoint}
            waypoints={waypoints}
            onSetWaypoint={setWaypointAtPosition}
            onMessage={setWaypointMessage}
          />
          <RouteLines
            routes={routes}
            selectedMode={selectedRoute}
            highlightedPoint={highlightedPoint}
            onPointHover={(point) => {
              if (point && point.mode !== selectedRoute) {
                setSelectedRoute(point.mode);
                setGoNoGoResult(null);
                setGoNoGoError("");
              }
              setHighlightedPoint(point);
            }}
          />
          <ZoomControl position="topright" />
          <FitSiteControl />
          <CoordinateReadout onPosition={handlePosition} />
          <MarsScale />
        </MapContainer>
      ) : (
        CesiumMap && (
          <CesiumMap
            onPosition={handlePosition}
            onError={handleViewerError}
            onTilesLoaded={handleTilesLoaded}
            elevationEnabled={elevationEnabled}
            elevationOpacity={elevationOpacity}
          />
        )
      )}
      {tilesLoading && elevationEnabled && (
        <div className="map-loading" role="status">
          <span className="loading-spinner" /> CONNECTING TO MARS TREK
        </div>
      )}
      {terrainLoading && (
        <div className="terrain-loading" role="status">
          <span className="loading-spinner" /> PROCESSING MGS MOLA TERRAIN
        </div>
      )}
      {terrainError && (
        <div className="terrain-error" role="alert">
          <strong>Terrain analysis unavailable.</strong>
          <span>{terrainError} Start the FastAPI service, then retry.</span>
          <button type="button" onClick={() => setTerrainRequestKey((key) => key + 1)}>
            RETRY TERRAIN REQUEST
          </button>
        </div>
      )}
      <section className="waypoint-panel" aria-label="Marswalk waypoints">
        <div className="waypoint-panel-heading">
          <span>WALK WAYPOINTS</span>
          <button
            type="button"
            className={`waypoint-select-toggle ${selectionEnabled ? "is-active" : ""}`}
            onClick={() => setSelectionEnabled((enabled) => !enabled)}
            aria-pressed={selectionEnabled}
            disabled={mapMode !== "2d" || !costGrid || costGridLoading || Boolean(costGridError)}
          >
            {mapMode === "3d" ? "2D ONLY" : selectionEnabled ? "SELECTING" : "PAUSED"}
          </button>
        </div>
        <div className="waypoint-actions">
          {(["start", "end"] as const).map((name) => (
            <button
              key={name}
              type="button"
              className={`waypoint-target waypoint-target-${name} ${activeWaypoint === name ? "is-current" : ""}`}
              onClick={() => {
                setActiveWaypoint(name);
                setWaypointMessage(`Choose a valid map cell for the ${name} waypoint.`);
              }}
              aria-pressed={activeWaypoint === name}
              disabled={mapMode !== "2d" || !costGrid || costGridLoading || Boolean(costGridError)}
            >
              <span>{name === "start" ? "S" : "E"}</span>
              SET {name.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            className="waypoint-reset"
            onClick={resetWaypoints}
            disabled={!waypoints.start && !waypoints.end}
            aria-label="Clear start and end waypoints"
          >
            CLEAR
          </button>
        </div>
        <div className="waypoint-values">
          <span>START</span>
          <strong>{formatWaypoint(waypoints.start)}</strong>
          <span>END</span>
          <strong>{formatWaypoint(waypoints.end)}</strong>
        </div>
        <p className="waypoint-status" role={costGridError ? "alert" : "status"} aria-live="polite">
          {costGridLoading
            ? "Loading traversability grid…"
            : costGridError
              ? `Terrain grid unavailable: ${costGridError}`
              : waypointMessage ||
                (selectionEnabled
                  ? `Click the map to set ${activeWaypoint.toUpperCase()}; drag markers to adjust.`
                  : "Waypoint selection paused.")}
        </p>
        {(waypoints.start || waypoints.end) && (
          <div className="route-compare">
            <div className="route-compare-heading">
              <span>ROUTE OPTIONS</span>
              {routeLoading && <span className="route-loading-label">CALCULATING</span>}
            </div>
            {routeError ? (
              <div className="route-error" role="alert">
                <span>{routeError}</span>
                <button type="button" onClick={() => setRouteRequestKey((key) => key + 1)}>
                  RETRY
                </button>
              </div>
            ) : routes.length > 0 ? (
              <>
                <div className="route-options" role="group" aria-label="Select route objective">
                  {routes.map((route) => (
                    <button
                      type="button"
                      key={route.mode}
                      className={`route-option ${selectedRoute === route.mode ? "is-selected" : ""}`}
                      aria-pressed={selectedRoute === route.mode}
                      onClick={() => {
                        setSelectedRoute(route.mode);
                        setHighlightedPoint(null);
                        setGoNoGoResult(null);
                        setGoNoGoError("");
                      }}
                    >
                      <span className="route-option-name">
                        <i style={{ backgroundColor: ROUTE_COLORS[route.mode] }} />
                        {ROUTE_LABELS[route.mode]}
                      </span>
                      <strong>{formatDistance(route.distanceM)}</strong>
                      <small>MAX {route.steepestSlopeDeg.toFixed(1)}° SLOPE</small>
                      <small>{formatDuration(route.walkingTimeSeconds)} · O₂ {route.oxygenLiters.toFixed(1)} L</small>
                    </button>
                  ))}
                </div>
                {selectedRoute === "science" && routes[2].sciencePointsUsed === 0 && (
                  <p className="route-science-note">NO VERIFIED SCIENCE SITES CONNECTED · NO POIS FABRICATED</p>
                )}
              </>
            ) : routeLoading ? (
              <p className="route-pending" role="status">ROUTING + ANALYZING COARSE MOLA GRID…</p>
            ) : null}
          </div>
        )}
        {costGridError && (
          <button
            type="button"
            className="waypoint-retry"
            onClick={() => setCostGridRequestKey((key) => key + 1)}
          >
            RETRY TERRAIN GRID
          </button>
        )}
      </section>
      {mapMode === "2d" && elevationEnabled && tileError && (
        <div className="map-error" role="status">
          <strong>Some Mars Trek tiles could not be loaded.</strong>
          <span>Pan and coordinates remain available. Check your connection or try again.</span>
        </div>
      )}
      <button
        className="map-mode-button"
        type="button"
        onClick={toggleMapMode}
        disabled={threeDimensionalLoading}
        aria-label={mapMode === "2d" ? "Switch to 3D globe" : "Switch to 2D map"}
        title={mapMode === "2d" ? "Switch to 3D globe" : "Switch to 2D map"}
      >
        {threeDimensionalLoading ? (
          <><span className="loading-spinner" /> LOADING 3D</>
        ) : mapMode === "2d" ? (
          <><Globe2 size={14} /> 3D GLOBE</>
        ) : (
          <><MapIcon size={14} /> 2D MAP</>
        )}
      </button>
      {viewerError && (
        <div className="map-error viewer-error" role="status">
          <strong>3D view unavailable.</strong>
          <span>{viewerError}</span>
        </div>
      )}
      <div className="map-coordinate-card" aria-live="polite">
        <span className="coordinate-label">CURSOR POSITION <i>·</i> PLANETOCENTRIC</span>
        <strong>{formatCoordinate(position.lat, "N", "S")}</strong>
        <strong>{formatCoordinate(position.lng, "E", "W")}</strong>
        <span className="coordinate-localtime">LOCAL MARS TIME EST. <b>{localMarsTime(position.lng)}</b></span>
      </div>
      {elevationEnabled && (
        <div className="map-data-note">
          <span className="map-data-dot" /> SHADED RELIEF IS NOT NUMERIC ELEVATION
        </div>
      )}
      {mapMode === "2d" && (slopeEnabled || hazardsEnabled) && hazardGrid && (
        <div className="terrain-quality-note" role="status" aria-live="polite">
          {hazardGrid.blockedCells === 0
            ? `0 CELLS FLAGGED ABOVE ${hazardGrid.slopeLimitDeg}° AT ~463 M/CELL · NOT EVIDENCE OF SAFETY`
            : `${hazardGrid.blockedCells}/${hazardGrid.totalCells} CELLS > ${hazardGrid.slopeLimitDeg}° · ~463 M/CELL`}
          {" · "}COARSE SCREEN ONLY · NOT OPERATIONAL SAFETY DATA
        </div>
      )}
      {mapMode === "3d" && (slopeEnabled || hazardsEnabled) && (
        <div className="terrain-3d-note" role="status">
          TERRAIN OVERLAYS ARE AVAILABLE IN THE 2D MAP VIEW
        </div>
      )}
      {mapMode === "3d" && (
        <div className="map-3d-note">
          GLOBE VIEW · DRAG TO ORBIT · SHIFT + DRAG TO TILT · NO ELEVATION TERRAIN
        </div>
      )}
      {mapMode === "2d" && (
        <div
          className="environment-shade"
          aria-hidden="true"
          style={{
            opacity: Math.max(
              0,
              Math.min(0.52, (Math.abs(timeOfDayHour - 12) / 12) * 0.52),
            ),
          }}
        />
      )}
      {mapMode === "3d" && (waypoints.start || waypoints.end) && (
        <div className="waypoint-3d-note" role="status">
          WAYPOINTS AND ROUTES ARE DISPLAYED IN THE 2D MAP
        </div>
      )}
    </div>
    <section className="environment-panel" aria-label="Illustrative environment controls">
      <div className="environment-panel-heading">
        <div>
          <span>LOCAL ENVIRONMENT <i>·</i> MODEL VALUES</span>
          <small>Time-of-day and weather controls are illustrative, not live Mars observations or tied to a mission epoch.</small>
        </div>
        <label className="dust-storm-toggle">
          <input
            type="checkbox"
            checked={dustStorm}
            onChange={(event) => {
              setDustStorm(event.currentTarget.checked);
              setGoNoGoResult(null);
              setGoNoGoError("");
            }}
          />
          <span>DUST STORM SIMULATION</span>
        </label>
      </div>
      <div className="environment-readouts">
        <div><span>ILLUSTRATIVE TIME OF DAY</span><strong>{String(Math.floor(timeOfDayHour)).padStart(2, "0")}:{String(Math.round((timeOfDayHour % 1) * 60)).padStart(2, "0")}</strong></div>
        <div><span>SOL</span><strong>UNSET · NO MISSION EPOCH</strong></div>
        <div><span>DAYLIGHT</span><strong>{timeOfDayHour >= 6 && timeOfDayHour < 18 ? "MODEL DAYLIGHT" : "MODEL NIGHT"}</strong></div>
        <div><span>TEMPERATURE</span><strong>{(-60 + 35 * Math.sin(((timeOfDayHour - 6) * Math.PI) / 12)).toFixed(0)}°C · MODEL</strong></div>
        <div><span>DUST / VISIBILITY</span><strong>{dustStorm ? "ELEVATED · SIMULATED" : "BASELINE · MODEL"}</strong></div>
      </div>
      <label className="environment-time-control">
        <span>SCRUB TIME OF DAY</span>
        <input
          type="range"
          min="0"
          max="23.75"
          step="0.25"
          value={timeOfDayHour}
          aria-label="Illustrative local time of day on Mars"
          onChange={(event) => setTimeOfDayHour(Number(event.currentTarget.value))}
        />
        <b>00:00</b><b>12:00</b><b>23:45</b>
      </label>
      {dustStorm && (
        <p className="environment-storm-note" role="status">
          SIMULATION ACTIVE · POWER USE +25% · SAFEST ROUTE USES HIGHER SLOPE / ROUGHNESS / HAZARD-PROXIMITY WEIGHTS · VISIBILITY PENALTY IS A MODEL PROXY
        </p>
      )}
    </section>
    {activeRoute && (
      <section className="route-analysis-panel" aria-label="Selected route analysis">
        <div className="route-analysis-header">
          <div>
            <span className="route-analysis-kicker">ROUTE ANALYSIS <i>·</i> {ROUTE_LABELS[activeRoute.mode]}</span>
            <p>{activeRoute.note}</p>
          </div>
          <label className="analysis-speed-control">
            <span>WALK SPEED</span>
            <strong>{walkingSpeedMps.toFixed(1)} <small>m/s</small></strong>
            <input
              type="range"
              min="0.2"
              max="2.0"
              step="0.1"
              value={walkingSpeedMps}
              aria-label="Model walking speed in meters per second"
              onChange={(event) => setWalkingSpeedMps(Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <div className="analysis-metrics">
          <div><span>DISTANCE</span><strong>{formatDistance(activeRoute.distanceM)}</strong></div>
          <div><span>WALK TIME</span><strong>{formatDuration(activeRoute.walkingTimeSeconds)}</strong></div>
          <div><span>STEEPEST</span><strong>{activeRoute.steepestSlopeDeg.toFixed(1)}°</strong></div>
          <div><span>ASCENT / DESCENT</span><strong>+{activeRoute.ascentM.toFixed(0)} / −{activeRoute.descentM.toFixed(0)} m</strong></div>
          <div><span>OXYGEN</span><strong>{activeRoute.oxygenLiters.toFixed(1)} L</strong></div>
          <div><span>POWER</span><strong>{activeRoute.powerWh.toFixed(1)} Wh</strong></div>
          <div><span>WATER</span><strong>{activeRoute.waterLiters.toFixed(2)} L</strong></div>
        </div>
        <ElevationProfile
          route={activeRoute}
          highlightedIndex={highlightedPoint?.mode === activeRoute.mode ? highlightedPoint.index : null}
          onHighlight={(index) =>
            setHighlightedPoint(index === null ? null : { mode: activeRoute.mode, index })
          }
        />
        <p className="analysis-model-note">
          MODEL ONLY · {walkingSpeedMps.toFixed(1)} m/s · 1.0 L O₂/min · {dustStorm ? "150" : "120"} W · 0.5 L water/hour · excludes stops and return trip
        </p>
        <form className="go-nogo-form" onSubmit={submitGoNoGo}>
          <div className="go-nogo-form-heading">
            <div>
              <span>SUIT RESOURCE CHECK <i>·</i> {ROUTE_LABELS[selectedRoute]}</span>
              <small>Enter available capacity; needs include configured reserve.</small>
            </div>
            <label className="safety-margin-control">
              <span>RESERVE</span>
              <strong>{safetyMarginPercent}%</strong>
              <input
                type="range"
                min="0"
                max="50"
                step="5"
                value={safetyMarginPercent}
                aria-label="Safety reserve percentage"
                onChange={(event) => {
                  setSafetyMarginPercent(Number(event.currentTarget.value));
                  setGoNoGoResult(null);
                  setGoNoGoError("");
                }}
              />
            </label>
          </div>
          <div className="resource-input-grid">
            <label>
              <span>OXYGEN AVAILABLE</span>
              <div><input
                type="number"
                min="0"
                step="any"
                required
                value={oxygenCapacity}
                placeholder="Enter capacity"
                aria-label="Available oxygen in liters"
                onChange={(event) => {
                  setOxygenCapacity(event.currentTarget.value);
                  setGoNoGoResult(null);
                  setGoNoGoError("");
                }}
              /><b>L</b></div>
            </label>
            <label>
              <span>POWER AVAILABLE</span>
              <div><input
                type="number"
                min="0"
                step="any"
                required
                value={powerCapacity}
                placeholder="Enter capacity"
                aria-label="Available power in watt-hours"
                onChange={(event) => {
                  setPowerCapacity(event.currentTarget.value);
                  setGoNoGoResult(null);
                  setGoNoGoError("");
                }}
              /><b>Wh</b></div>
            </label>
            <label>
              <span>WATER AVAILABLE</span>
              <div><input
                type="number"
                min="0"
                step="any"
                required
                value={waterCapacity}
                placeholder="Enter capacity"
                aria-label="Available water in liters"
                onChange={(event) => {
                  setWaterCapacity(event.currentTarget.value);
                  setGoNoGoResult(null);
                  setGoNoGoError("");
                }}
              /><b>L</b></div>
            </label>
          </div>
          <label className="return-trip-control">
            <input
              type="checkbox"
              checked={includeReturnTrip}
              onChange={(event) => {
                setIncludeReturnTrip(event.currentTarget.checked);
                setGoNoGoResult(null);
                setGoNoGoError("");
              }}
            />
            <span>Include return trip <small>(modeled as retracing the selected route)</small></span>
          </label>
          <button
            type="submit"
            className="go-nogo-submit"
            disabled={goNoGoLoading || !oxygenCapacity || !powerCapacity || !waterCapacity}
          >
            {goNoGoLoading ? <><span className="loading-spinner" /> CHECKING RESOURCES</> : "RUN GO / NO-GO CHECK"}
          </button>
        </form>
        {goNoGoError && <p className="go-nogo-error" role="alert">{goNoGoError}</p>}
        {goNoGoResult && (
          <section
            className={`go-nogo-result ${goNoGoResult.verdict === "go" ? "is-go" : "is-no-go"}`}
            aria-live="polite"
            aria-label={`Mission status: ${goNoGoResult.verdict === "go" ? "GO" : "NO-GO"}`}
          >
            <div className="go-nogo-result-header">
              <strong>{goNoGoResult.verdict === "go" ? "GO" : "NO-GO"}</strong>
              <span>{ROUTE_LABELS[goNoGoResult.selectedRoute]} ROUTE · {goNoGoResult.returnTripIncluded ? "ROUND TRIP" : "ONE WAY"} · {Math.round(goNoGoResult.safetyMargin * 100)}% RESERVE</span>
            </div>
            <p className="go-nogo-reason">{goNoGoResult.reason}</p>
            <div className="resource-check-grid">
              {goNoGoResult.resources.map((resource) => (
                <div
                  className={`resource-check ${resource.sufficient ? "is-sufficient" : "is-insufficient"}`}
                  key={resource.resource}
                >
                  <span>{resource.resource.toUpperCase()}</span>
                  <strong>{resource.remaining >= 0 ? "+" : "−"}{Math.abs(resource.remaining).toFixed(resource.unit === "Wh" ? 1 : 2)} {resource.unit}</strong>
                  <small>REMAINING AFTER RESERVE</small>
                  <small>NEED {resource.bufferedRequirement.toFixed(resource.unit === "Wh" ? 1 : 2)} / HAVE {resource.available.toFixed(resource.unit === "Wh" ? 1 : 2)} {resource.unit}</small>
                </div>
              ))}
            </div>
            <p className="go-nogo-suggestion">
              <b>{goNoGoResult.limitingResource
                ? `LIMITING RESOURCE · ${goNoGoResult.limitingResource.toUpperCase()}${goNoGoResult.remainingMarginPercent === null ? "" : ` · ${goNoGoResult.remainingMarginPercent >= 0 ? "+" : ""}${goNoGoResult.remainingMarginPercent.toFixed(1)}% OF BUFFERED NEED`}`
                : "NO RESOURCE CONSUMPTION ESTIMATED"}</b>
              <span>{goNoGoResult.suggestion}</span>
            </p>
            <p className="go-nogo-disclaimer">{goNoGoResult.modelNotice} {goNoGoResult.safetyNotice}</p>
          </section>
        )}
      </section>
    )}
    <section className="ai-copilot-section" id="ai-copilot" aria-labelledby="ai-copilot-title">
      <div className="ai-section-heading">
        <div>
          <span className="section-kicker">04 / MISSION INTELLIGENCE</span>
          <h2 id="ai-copilot-title">Learn from Past AI</h2>
          <p>Ask Gemini about the route and terrain screen, or switch objectives with a safe app command.</p>
        </div>
        <span className="ai-local-badge"><ShieldCheck size={13} /> SERVER-SIDE KEY · GEMINI API</span>
      </div>
      <MissionAssistant
        routes={routes}
        selectedRoute={selectedRoute}
        onSelectRoute={(mode) => {
          setSelectedRoute(mode);
          setHighlightedPoint(null);
          setGoNoGoResult(null);
          setGoNoGoError("");
        }}
        missionCheck={goNoGoResult
          ? {
              verdict: goNoGoResult.verdict === "go" ? "GO" : "NO-GO",
              reason: goNoGoResult.reason,
              limitingResource: goNoGoResult.limitingResource,
              returnTripIncluded: goNoGoResult.returnTripIncluded,
            }
          : null}
        hazard={hazardGrid
          ? {
              blockedCells: hazardGrid.blockedCells,
              totalCells: hazardGrid.totalCells,
              slopeLimitDeg: hazardGrid.slopeLimitDeg,
            }
          : null}
      />
    </section>
    </>
  );
}

export default MarsMap;
