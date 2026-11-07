export type LayerId = "elevation" | "slope" | "science" | "hazards";

export interface MapLayer {
  id: LayerId;
  name: string;
  shortName: string;
  source: string;
  sourceUrl?: string;
  description: string;
  legend: string;
  available: boolean;
}

export const MAP_LAYERS: MapLayer[] = [
  {
    id: "elevation",
    name: "Elevation relief",
    shortName: "MOLA SHADED RELIEF",
    source: "NASA MGS MOLA · Mars Trek WMTS",
    sourceUrl: "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars",
    description:
      "Color-shaded relief imagery. This mosaic is not a numeric elevation model and cannot provide elevation samples.",
    legend: "Shaded relief imagery · no numeric elevation scale",
    available: true,
  },
  {
    id: "slope",
    name: "Slope",
    shortName: "MOLA-DERIVED · ~463 M/CELL",
    source: "NASA MGS MOLA MEGDR · PDS",
    sourceUrl:
      "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt44n000hb.lbl",
    description:
      "Shown in the 2D map. Computed from verified MOLA topography using Mars-aware cell spacing. The global product interpolates bins without observations.",
    legend: "Low  →  steep · 463 m cells",
    available: true,
  },
  {
    id: "science",
    name: "Science sites",
    shortName: "MISSION POINTS OF INTEREST",
    source: "Mission records not connected",
    description:
      "No verified science-site coordinates are loaded. No sample points are shown as real mission observations.",
    legend: "No verified science sites loaded",
    available: false,
  },
  {
    id: "hazards",
    name: "Hazard zones",
    shortName: "SLOPE SCREEN · >25°",
    source: "Derived from NASA MGS MOLA",
    sourceUrl:
      "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt44n000hb.lbl",
    description:
      "Shown in the 2D map. Cells above the slope threshold are flagged. Coarse global MOLA cannot certify local traverse safety.",
    legend: "Slope > 25° · MOLA screening only",
    available: true,
  },
];
