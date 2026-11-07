import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import L from "leaflet";
import site from "../../data/sites/jezero.json";
import "cesium/Build/Cesium/Widgets/widgets.css";

const TILE_URL =
  import.meta.env.VITE_MARS_TILES_URL ??
  "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg";

interface CesiumMapProps {
  onPosition: (position: L.LatLng) => void;
  onError: (message: string) => void;
  onTilesLoaded: () => void;
  elevationEnabled: boolean;
  elevationOpacity: number;
}

function CesiumMap({
  onPosition,
  onError,
  onTilesLoaded,
  elevationEnabled,
  elevationOpacity,
}: CesiumMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageryLayerRef = useRef<Cesium.ImageryLayer | null>(null);

  useEffect(() => {
    if (!imageryLayerRef.current) return;
    imageryLayerRef.current.show = elevationEnabled;
    imageryLayerRef.current.alpha = elevationOpacity;
  }, [elevationEnabled, elevationOpacity]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let widget: Cesium.CesiumWidget | undefined;
    let stopPositionListener = () => {};
    let stopTileErrorListener = () => {};
    let stopTileLoadListener = () => {};

    try {
      const marsEllipsoid = new Cesium.Ellipsoid(3_396_190, 3_396_190, 3_376_200);
      const activeWidget = new Cesium.CesiumWidget(container, {
        ellipsoid: marsEllipsoid,
        baseLayer: false,
        skyBox: false,
        skyAtmosphere: false,
        requestRenderMode: true,
        useBrowserRecommendedResolution: true,
        contextOptions: {
          webgl: {
            preserveDrawingBuffer: false,
            powerPreference: "low-power",
          },
        },
      });
      widget = activeWidget;
      activeWidget.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
      activeWidget.scene.globe.baseColor = Cesium.Color.fromCssColorString("#171d22");
      activeWidget.scene.globe.showGroundAtmosphere = false;

      const tileTemplate = TILE_URL.replace("{z}", "{TileMatrix}")
        .replace("{y}", "{TileRow}")
        .replace("{x}", "{TileCol}");
      const provider = new Cesium.WebMapTileServiceImageryProvider({
        url: tileTemplate,
        layer: "Mars_MGS_MOLA_ClrShade_merge_global_463m",
        style: "default",
        format: "image/jpeg",
        tileMatrixSetID: "default028mm",
        tilingScheme: new Cesium.GeographicTilingScheme({
          ellipsoid: marsEllipsoid,
          numberOfLevelZeroTilesX: 2,
          numberOfLevelZeroTilesY: 1,
        }),
        tileMatrixLabels: Array.from({ length: 8 }, (_, level) => String(level)),
        maximumLevel: 7,
        ellipsoid: marsEllipsoid,
        credit: new Cesium.Credit("NASA Mars Trek · MGS MOLA shaded relief"),
      });
      imageryLayerRef.current = activeWidget.imageryLayers.addImageryProvider(provider);
      imageryLayerRef.current.show = elevationEnabled;
      imageryLayerRef.current.alpha = elevationOpacity;
      stopTileErrorListener = provider.errorEvent.addEventListener(() => {
        onError("NASA Mars Trek tiles failed in 3D mode. Switched back to the 2D map.");
      });
      let sawPendingTiles = false;
      stopTileLoadListener = activeWidget.scene.globe.tileLoadProgressEvent.addEventListener(
        (pendingTiles: number) => {
          if (pendingTiles > 0) {
            sawPendingTiles = true;
          } else if (sawPendingTiles) {
            onTilesLoaded();
          }
        },
      );

      activeWidget.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          site.center.longitude,
          site.center.latitude,
          100_000,
          marsEllipsoid,
        ),
        orientation: {
          heading: 0,
          pitch: -Math.PI / 3,
          roll: 0,
        },
        duration: 0,
      });

      const pointerHandler = new Cesium.ScreenSpaceEventHandler(activeWidget.canvas);
      pointerHandler.setInputAction(
        (movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
          const cartesian = activeWidget.scene.camera.pickEllipsoid(
            movement.endPosition,
            activeWidget.scene.globe.ellipsoid,
          );
          if (!cartesian) return;
          const cartographic = Cesium.Cartographic.fromCartesian(
            cartesian,
            activeWidget.scene.globe.ellipsoid,
          );
          onPosition(
            L.latLng(
              Cesium.Math.toDegrees(cartographic.latitude),
              Cesium.Math.toDegrees(cartographic.longitude),
            ),
          );
        },
        Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      );
      stopPositionListener = () => pointerHandler.destroy();

      const handleVisibility = () => {
        activeWidget.useDefaultRenderLoop = !document.hidden;
        if (!document.hidden) activeWidget.resize();
      };
      document.addEventListener("visibilitychange", handleVisibility);

      return () => {
        document.removeEventListener("visibilitychange", handleVisibility);
        stopPositionListener();
        stopTileErrorListener();
        stopTileLoadListener();
        imageryLayerRef.current = null;
        activeWidget.destroy();
      };
    } catch (error) {
      onError(
        error instanceof Error
          ? `3D globe unavailable: ${error.message}`
          : "3D globe unavailable. Switched back to the 2D map.",
      );
    }

    return () => {
      stopPositionListener();
      stopTileErrorListener();
      stopTileLoadListener();
      imageryLayerRef.current = null;
      if (widget && !widget.isDestroyed()) widget.destroy();
    };
  }, [onError, onPosition, onTilesLoaded]);

  return <div className="cesium-map" ref={containerRef} aria-label="Interactive 3D Mars globe" />;
}

export default CesiumMap;
