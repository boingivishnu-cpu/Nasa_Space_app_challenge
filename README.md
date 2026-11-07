# MARSWAY — Learn from Past

**Learn from Past** is MARSWAY's section-based mission dashboard. Its
animated, parallax starfield and dimensional Mars globe are decorative; the
interactive map remains the source-backed planning surface. The map
continues to show the real Jezero Crater site; the title is a product tagline,
not a change to the configured site or NASA data. MARSWAY is a planning app for
exploring a small area of Jezero Crater. The current increment provides NASA
Mars Trek shaded-relief imagery, PDS MOLA elevation samples, and derived slope
and coarse hazard-screen overlays, snapped waypoints, and three terrain-based
route options with elevation and illustrative walking-resource analysis.
GO/NO-GO planning compares user-entered suit capacities against illustrative
route resource estimates, including a configurable return trip and reserve.
These outputs are demonstration models, not operational safety guidance.

The interface uses numbered Explore, Plan, Learn, Community, and AI Copilot
sections, with touch-friendly press feedback and mobile navigation. Evidence
cards use connected data only. Community reports are not implemented,
so that section displays an empty state rather than invented posts.

## Requirements

- Node.js 20.19+ (or 22.12+) and npm
- Python 3.11+

## Run locally

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
npm install
py -3.11 -m venv backend\.venv
backend\.venv\Scripts\python -m pip install -r backend\requirements.txt
npm run dev
```

The root `dev:backend` script uses `backend\.venv` directly, so activating the
environment first is not required.

The frontend is at <http://localhost:5173>, the API is at
<http://localhost:8000>, and interactive API docs are at
<http://localhost:8000/docs>.
`localhost` and `127.0.0.1` dev/preview origins are enabled by default for
FastAPI CORS. If you use another frontend host or port, add its exact origin to
`MARSWAY_CORS_ORIGINS` in `.env`, then restart the API. The top-bar API badge
checks both `/health` and the configured Jezero `/site` endpoint every 15
seconds.

You can run one side independently with `npm run dev:frontend` or
`npm run dev:backend`. Use `npm run build` to build the frontend.

## Repository layout

```text
frontend/       React + Vite + TypeScript application
backend/        FastAPI application and Python dependencies
data/sites/     Site definitions; data provenance is documented alongside data
docs/           Architecture, assumptions, and demo documentation
```

## Site configuration

The initial site definition is `data/sites/jezero.json`. It defines a roughly
20 × 20 km planning footprint centered on Perseverance's landing area. Terrain
data is currently configured for Jezero; an additional site needs a matching,
verified numeric terrain product before the terrain API can serve it. The 2D
map initially fits the configured site's full bounds; use **Fit Jezero** to
restore that view after panning or zooming.

## Data sources and limitations

The base map uses the NASA Mars Trek WMTS global MGS MOLA color-shaded relief
mosaic (463 m/pixel). NASA's [Mars Trek WMTS documentation](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars)
documents the tile protocol and sample service URL. Coverage was checked at
Jezero for native zoom levels 5–7; higher native levels are unavailable there,
so the map overzooms the highest available tiles. This shaded-relief image is
not used as numeric elevation. Terrain analysis uses the numeric MGS MOLA
MEGDR PDS product [MEGT44N000HB](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt44n000hb.img).
The backend fetches only the configured site's raster rows; it computes slope
with Mars-aware cell spacing and screens cells above a 25° configurable
threshold. The 128-pixel/degree product is about 463 m north–south at Jezero,
so it cannot identify local hazards or certify route safety. Zero flagged
cells does not mean a route is safe. Slope and hazard overlays display in the
2D map; the optional, lazy-loaded CesiumJS globe currently shows base imagery
only. Verified science-site coordinates are not yet connected, and their layer
remains disabled rather than showing invented observations. Read
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) for product provenance, grid details,
and limitations.

## Validate the terrain API

With the virtual environment installed, run the focused terrain tests from the
repository root:

```powershell
.\backend\.venv\Scripts\python -m unittest backend.tests.test_terrain -v
```

With both development servers running, the **Slope** layer is enabled at 20%
opacity by default so the imagery remains visible; the UI requests
`/hazards?site_id=jezero&slope_limit_deg=25`. The optional **Hazard zones**
layer highlights cells above the threshold. The status label reports the
flagged-cell count and the coarse-resolution safety caveat. The **3D globe** is
imagery-only in this step.

The weighted traversal grid is available via `POST /cost-grid` or the
interactive API at <http://localhost:8000/docs>. For example:

```json
{
  "siteId": "jezero",
  "slopeLimitDeg": 25,
  "weights": {
    "slope": 0.8,
    "roughnessPer100m": 0.25,
    "scienceBonus": 0.35,
    "scienceRadiusM": 1000
  },
  "sciencePoints": []
}
```

Science points are optional caller-supplied coordinates and must lie within the
configured site. None are supplied by default because verified mission POIs are
not yet connected.

The 2D map also supports setting start/end waypoints from this cost grid. After
the grid loads, click **SET START** or **SET END**, then click a traversable
cell; markers snap to the nearest MOLA cell center and show its sampled
elevation. Drag markers to reposition them. A click that resolves to a blocked
cell is rejected with a message. The grid is regional (~463 m per cell), so
waypoint elevations and blocked status are only coarse MOLA screening values.

With both waypoints set, the map requests `POST /route` and draws shortest,
safest, and science-weighted routes in distinct colors. Select a route card to
emphasize that path. The endpoint accepts waypoint coordinates and optional
caller-supplied science points; `searchAlgorithm` can be set to `dijkstra` to
compare the baseline search with A*. A* falls back to Dijkstra if it cannot
produce a path. Diagonal steps use Mars-aware physical spacing and do not cut
between blocked corner cells. With no verified science points, the science
route explicitly reports that its POI bonus is unused. All results remain
coarse demonstration outputs and are not astronaut navigation guidance.

With two waypoints set, the frontend calls `POST /analyze`, which returns each
route with cumulative elevation samples, ascent/descent, walking time, and
modeled oxygen, power, and water estimates. The selected route's elevation
profile can be scrubbed with the pointer or keyboard slider; hovering a route
sample on the map updates the profile. Walking speed is adjustable in the
analysis panel and estimates recalculate when it changes. Default model
inputs are 0.8 m/s, 1.0 L O₂/min, 120 W, and 0.5 L water/hour. These rates are
illustrative, exclude stops and (for this analysis endpoint) the return trip,
and are not suit predictions. A model-only dust toggle raises power use by 25%.
The API supports overriding rates in `/docs`.

The **GO / NO-GO** check requires available oxygen (L), power (Wh), and water
(L) capacities; it does not prefill fictional suit inventory. It defaults to
including a retraced return trip and a 20% configurable reserve, then reports
the buffered need, remaining capacity, limiting resource, and a suggestion.
These are comparisons against the entered capacities using model rates only,
not operational mission approval. The API endpoint is `POST /go-nogo`.

The local environment panel lets you scrub an illustrative time of day and
toggle a dust-storm scenario. The time, daylight, and temperature are model
values; no sol is shown because there is no mission epoch. Dust mode increases
modeled power use by 25% and raises the safest route's terrain and
hazard-proximity penalties as a visibility-risk proxy. Neither setting uses
live weather or local-time observations. Use **3-MIN DEMO** in the top bar for
a manually advanced, five-step walkthrough (paced for three minutes) of the
map, terrain screening, waypoint selection, route comparison, and resource
check.

## Roadmap

The implementation follows the ten requested steps: project setup; map;
layers; hazard and cost grids; waypoint selection and routing; route/resource
analysis; GO/NO-GO; then science stops and demo polish. Verified Jezero science
stop coordinates are not bundled, so their layer remains disabled. The optional
3D globe is imagery-only; the 2D map remains the working terrain and route view.

## Gemini mission assistant

The copilot sends natural-language questions to the FastAPI `POST /ai/chat`
endpoint, which calls Gemini Flash. Set `MARSWAY_GEMINI_API_KEY` in the
repository-root `.env` and restart the backend to enable generated answers.
The key is server-side only; do not put it in `frontend/.env.local`, a `VITE_`
variable, or client source. The frontend checks `GET /ai/status` and clearly
shows when the backend is offline or the key is not configured.

The current prompt, a concise summary of available routes/hazards/resources,
and up to four previous exchanges are sent to the backend and to Google's
Gemini API for inference. Do not send sensitive information. The conversation
is held in browser memory only and is not persisted. Route-selection commands
such as “find the safest route” use a fixed client-side parser, and can only
select a route already returned by the route API; Gemini output cannot invoke
app actions. Gemini responses can be inaccurate and are not navigation,
operational, or safety advice. The endpoint, frontend integration, and mocked
provider behavior are tested locally; a live Gemini response requires a valid
user-supplied API key and network access.
