# Assumptions and data provenance

This file distinguishes configured/model values from measurements. Do not label
sample or model values as real mission observations in the interface.

## Initial site

- The initial site is Jezero Crater, configured around Perseverance's landing
  area with a compact approximately 20 × 20 km bounding region.
- `data/sites/jezero.json` records its initial center, footprint, zoom range, and
  coordinate convention. Validate operational bounds and tile coverage against
  official data before using them for navigation or safety decisions.

## Base map data

- The base map is NASA Mars Trek's `Mars_MGS_MOLA_ClrShade_merge_global_463m`
  color-shaded relief WMTS layer. The official Trek API documentation describes
  the WMTS URL format and provides sample tile URLs.
- NASA Mars Trek tile availability was checked at Jezero for native zooms 5–7;
  the tested site tile returned 404 at native zooms 8–9. The UI therefore caps
  native tile loading at zoom 7 and may overzoom those tiles for closer views.
- A shaded-relief image is a visualization, not an elevation sample; the app
  labels it as imagery and does not infer numeric elevations from its colors.

## Numeric MOLA terrain and derived layers

- Numeric elevation is retrieved separately from the MGS MOLA MEGDR PDS product
  `MEGT44N000HB`, not from the shaded-relief tiles. The PDS product label
  describes signed 16-bit, big-endian elevations in meters at 128 pixels per
  degree.
- Source: [PDS MOLA product](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt44n000hb.img);
  product metadata: [PDS label](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt44n000hb.lbl).
  The application requests only the raster rows intersecting the configured
  site, plus the neighboring samples needed for slope calculation. It rejects
  responses if the PDS server does not honor the requested byte range.
- The configured 128-pixel/degree spacing is about 463 m north–south and about
  439 m east–west at Jezero's latitude. The 44 × 46 site crop is consequently a
  coarse regional screen, not rover-scale or astronaut-scale terrain data.
- A live read of the current Jezero configuration returned 44 × 46 cells, with
  0 of 2,024 cells above 25 degrees and a maximum derived slope of about
  23.0 degrees. This is only a result at MOLA's coarse resolution, not a safety
  clearance or evidence that smaller hazards are absent.
- Slope is calculated with NumPy's central differences using the Mars radius
  and latitude-adjusted east–west spacing. The demo hazard rule flags cells
  whose computed slope is strictly greater than 25 degrees. The threshold is an
  illustrative configurable API parameter, not a certified limit.
- Empty MOLA observation bins are documented by the product as interpolated.
  Interpolated source values do not reveal local rocks, sand, slopes, or other
  hazards. Zero cells flagged at this resolution is not evidence that a
  traverse is safe. The UI displays this caveat alongside the result.
- `GET /elevation` returns the cropped numeric elevation grid;
  `GET /hazards?site_id=jezero&slope_limit_deg=25` returns elevations, slope,
  and the Boolean no-go mask in shared planetocentric site coordinates. The
  processed site grid is cached in memory per API process; it is re-fetched
  after a process restart.
- The 2D Leaflet view displays slope and flagged hazard cells using the same
  grid coordinates. The optional Cesium globe currently displays base imagery
  only; the UI explicitly notes that terrain overlays are available in 2D.

## Cost-grid model

- `POST /cost-grid` produces a cell-by-cell weighted grid from the cached MOLA
  elevation and slope. The per-cardinal-cell base distance is the geometric
  mean of the MOLA east-west and north-south spacing. A later diagonal
  pathfinder must scale traversal by the actual step distance.
- Cost is base distance plus a squared, threshold-normalized slope penalty and
  a 3 × 3 neighborhood relief penalty (local max elevation minus local min
  elevation), less a science-proximity bonus. The proximity signal is a
  Gaussian of the distance to the nearest supplied point. Costs are floored at
  10% of base distance to remain positive. Cells above the slope threshold are
  blocked and returned with `null` traversal cost.
- Default illustrative weights are slope `0.8`, roughness `0.25` per 100 m of
  neighborhood relief, and science bonus `0.35` within a 1,000 m Gaussian
  radius. They are returned with the grid and can be overridden in the request;
  they are not empirically calibrated or certified astronaut-planning values.
- Science points are optional request inputs, validated to fall inside the
  configured site bounds. The application has no verified science-point
  dataset connected yet, so the default grid uses no science bonus and invents
  no mission locations.
- Component arrays and the cost definition accompany every response so callers
  can inspect how a cell's score was produced. Cost values are a planning
  heuristic on coarse, interpolated MOLA data, not safety claims.

## Waypoint selection

- The 2D map obtains coordinates, numeric MOLA elevations, and traversability
  from `POST /cost-grid`. User clicks and marker drags resolve to the nearest
  grid-cell center using local latitude-adjusted geographic distance.
- A selected cell is accepted only if it lies within the configured site
  bounds and is not marked no-go (its cost is non-null). Blocked/out-of-site
  selections leave the existing waypoint unchanged and display an explanation.
- Waypoint elevation is the MOLA cell sample, not a local landing/footing
  measurement. The ~463 m resolution remains unsuitable for operational
  astronaut navigation or hazard certification.
- Waypoints are held in frontend state and sent to `POST /route` once both
  valid selections exist. The service validates site bounds and snaps each
  coordinate to the nearest unblocked cell center.

## Route finding

- `POST /route` returns shortest, safest, and science-weighted alternatives
  over the same MOLA-derived grid. It reports each path's cell samples,
  physical distance, weighted terrain cost, steepest sampled slope, search
  algorithm, and whether Dijkstra fallback was used.
- A* uses an admissible straight-line physical-distance heuristic. Dijkstra is
  available through the request's `searchAlgorithm` for comparison and is the
  fallback if A* does not return a path. Both searches use eight-direction
  neighbors with Mars-aware east-west and north-south spacing; diagonal moves
  cannot pass between two blocked side cells.
- The shortest mode minimizes physical travel distance. Safest adds squared
  normalized slope, local-relief, and near-hazard penalties. Science uses the
  cost-grid terrain weights and a Gaussian proximity bonus for explicitly
  supplied science-point coordinates. Costs are illustrative heuristics, not
  measured energy expenditure or calibrated astronaut mobility.
- No science-point dataset is connected by default. When none are supplied,
  the science alternative has no POI bonus and the API/UI state that fact; the
  app does not generate or imply real mission targets.
- The route endpoint and map display include the coarse-MOLA safety caveat.
  At ~463 m per cell, results cannot identify small hazards or provide
  operational astronaut navigation/safety guidance. The A* to Dijkstra retry
  handles search failure but does not increase data fidelity or certify a
  route.

## Model values

- `POST /analyze` recalculates shortest, safest, and science route statistics
  for the supplied waypoints. It returns total distance, cumulative elevation
  samples, ascent/descent, steepest sampled slope, estimated walk time, and
  modeled resource use. It recomputes routes from the shared cached terrain;
  it does not treat frontend-supplied path data as authoritative.
- Default walk speed is `0.8 m/s`, oxygen use is `1.0 L/min`, power is `120 W`,
  and water use is `0.5 L/hour`. They are explicitly illustrative model
  parameters, not certified astronaut/suit measurements. The speed is
  adjustable in the UI (0.2–2.0 m/s) and API (greater than 0 through 5 m/s);
  the API accepts validated overrides for all four values.
- Resource estimates multiply route walking time by the configured rate.
  They exclude science-stop time, setup/egress, rest, environmental effects,
  and the return trip; they are not predictions of suit performance. The
  elevation profile's cumulative distance uses physical Mars-aware cell
  spacing. Ascent and descent sum only positive and negative changes between
  the sampled route elevations.
- `POST /go-nogo` recomputes analysis for the selected route and compares
  entered oxygen (L), power (Wh), and water (L) capacities against modeled
  needs. The default check includes a return retracing the same route at the
  same modeled rates, then applies a 20% reserve. The reserve is configurable
  in the UI (0–50%) and API (0–100%). A user can explicitly disable return-trip
  inclusion through the API; the UI enables it by default and describes the
  return assumption.
- Each resource's buffered requirement is one-way modeled use × trip factor ×
  (1 + reserve). The remaining amount is entered capacity minus this
  requirement. Remaining-margin percent is relative to the buffered
  requirement; the limiting resource is the one with the least available to
  buffered-requirement ratio. A resource exactly meeting the requirement
  qualifies as sufficient. A zero-use resource has no percentage margin.
- No sample suit capacities are prefilled. The result is a model comparison
  against user-entered capacity, not telemetry, a medical/engineering
  prediction, or authorization to perform a traverse. A GO result still
  requires qualified mission review and does not override the coarse-MOLA
  limitation.
- The optional dust scenario increases modeled power use by 25% and, for the
  safest route only, raises slope, neighborhood-relief, and hazard-proximity
  weights. The proximity-weight increase is a visibility-risk proxy, not a
  visibility forecast or measured dust effect. Oxygen and water rates are
  unchanged. These factors are demonstration assumptions, not empirically
  calibrated values.
- The local environment control's selected time, daylight category, and
  temperature curve are illustrative. No sol is assigned because no mission
  epoch is configured; the selected time is not derived from longitude or live
  ephemerides. The map's separate local Mars time readout is an estimate based
  on cursor longitude only.
- The dust toggle does not use a weather feed or alter map visibility. It
  updates route/resource model inputs and displays a simulated dust status.
- The current 25-degree screening threshold is configurable through the
  hazards and route APIs. Walking speed, resource-consumption rates, safety
  margin, and hazard thresholds are planning assumptions, not certified
  astronaut limits.
- The profile chart and map share the selected route's samples: chart pointer
  movement or its keyboard-accessible range control highlights a sample on
  the 2D map, and hovering a route segment selects the nearest sample in the
  profile. The optional 3D globe remains imagery-only.
- Verified mission science-site coordinates are not yet connected. The science
  layer remains disabled rather than showing invented observations.
- A computed route or GO result is a demo planning aid and must not be presented
  as operational mission guidance.

## Guided demo

- The five-step walkthrough in the frontend has a suggested total pacing of
  three minutes (35, 35, 40, 40, and 30 seconds). It is manually advanced, not a
  timed presentation; users may spend longer on map interactions.
- The walkthrough demonstrates existing map, terrain, route, and resource
  controls. It does not create science targets or make unsupported data appear
  available.

## Gemini mission assistant

- The AI Copilot calls the backend `POST /ai/chat` endpoint. The backend proxies
  requests to Google's Gemini `generateContent` API using the server-side
  `MARSWAY_GEMINI_API_KEY`; the key is never sent to or embedded in the frontend.
  `GET /ai/status` reports the configured model and whether a non-empty key is
  present, but does not verify that the key is valid.
- Configure the key in the repository-root `.env` and restart FastAPI. The
  frontend surfaces backend-offline and key-not-configured states. A successful
  live response additionally depends on a valid key, network connectivity,
  Google API availability, and applicable account quotas. Mocked tests do not
  certify live provider availability.
- Each request sends the user's current question, up to four prior exchanges,
  and a bounded summary of loaded route, hazard, and resource state. This
  information is sent to Google for inference; users should not enter sensitive
  data. Conversation state remains in browser memory and is cleared on reload.
- Route selection phrases are recognized by a deterministic, fixed client-side
  parser and only select routes already calculated by the app. Gemini output is
  never interpreted as an application command.
- The backend system instruction asks Gemini to stick to supplied app facts,
  avoid inventing observations, and identify the coarse MOLA/suit-model limits.
  This does not guarantee factual accuracy. Assistant output is explanatory
  only and must not be used for navigation, operational planning, or safety
  decisions.
- Provider: [Google Gemini API](https://ai.google.dev/gemini-api/docs). Default
  model: `gemini-2.5-flash`, configurable with `MARSWAY_GEMINI_MODEL`.
