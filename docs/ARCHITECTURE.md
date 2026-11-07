# Architecture

MARSWAY is a small monorepo with a Vite/React/TypeScript browser client and an
async FastAPI service. Site definitions and future static mission data live
outside both application packages so alternate locations can be configured
without changing route logic.

```text
Browser (frontend) ── HTTP/JSON ── FastAPI (backend)
        │                                │
        └── site config / map layers ─── data/sites/
```

The frontend is the reliable Leaflet 2D-first interface, with an optional
lazy-loaded CesiumJS Mars globe using the same Mars Trek WMTS tiles. The 3D
globe does not imply elevation terrain data is available. The API is the home for
validated site, terrain, hazard, cost-grid, route, analysis, and resource
endpoints. Expensive grid preparation should be cached at the service layer.
NASA source endpoints and model assumptions must remain distinguishable.

Layer catalog metadata is defined in `frontend/src/layers.ts`; visibility,
opacity, and layer ordering are held in a Zustand store. A layer without a
verified dataset remains disabled rather than drawing fabricated features.
The Leaflet view fetches the validated site hazard grid from FastAPI when slope
or hazard overlays are enabled, checks its dimensions and site ID, and renders
cells in shared planetocentric coordinates. Numeric raster retrieval and slope
processing live in `backend/app/services/terrain.py`; the bounded MOLA crop is
cached in process memory. The Cesium view remains imagery-only and calls out
that overlays are available in 2D.

The cost-grid endpoint is implemented in
`backend/app/services/cost_grid.py`, with Pydantic request/response models in
`backend/app/models/terrain.py`. It combines the cached elevation/slope grid
with request-provided science points and returns both per-cell components and
the final costs. No verified science-point source is wired into the browser yet.
The Step 6 Leaflet waypoint interaction loads this grid, snaps clicks/drags to
its cell centers, and rejects blocked or out-of-site cells; waypoint state is
currently client-side only.

## Current setup

- `frontend/`: Vite React app and TypeScript build.
- `backend/app/`: FastAPI application, CORS configured by environment.
- `data/sites/`: site JSON configuration.
- `docs/`: architecture, assumptions, and demo material.
- Root npm scripts run the frontend and backend together.
