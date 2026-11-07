import { ArrowDown, ArrowUp, Layers3, LockKeyhole } from "lucide-react";
import { MAP_LAYERS } from "./layers";
import { useLayerStore } from "./state/layerStore";

function LayerPanel() {
  const enabled = useLayerStore((state) => state.enabled);
  const opacity = useLayerStore((state) => state.opacity);
  const order = useLayerStore((state) => state.order);
  const setEnabled = useLayerStore((state) => state.setEnabled);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const moveLayer = useLayerStore((state) => state.moveLayer);
  const layers = order.map((id) => MAP_LAYERS.find((layer) => layer.id === id)!);

  return (
    <section className="sidebar-section layers-section" aria-labelledby="layers-heading">
      <div className="sidebar-kicker" id="layers-heading">
        <Layers3 size={13} /> MAP DATA LAYERS
      </div>
      <p className="layers-intro">Shared Mars site coordinates · order top to bottom</p>
      <div className="layer-list">
        {layers.map((layer, index) => {
          const isEnabled = enabled[layer.id];
          const disabled = !layer.available;

          return (
            <article
              className={`layer-control ${isEnabled ? "layer-control-enabled" : ""} ${disabled ? "layer-control-pending" : ""}`}
              key={layer.id}
            >
              <div className="layer-control-header">
                <span className={`layer-indicator layer-indicator-${layer.id}`} aria-hidden="true" />
                <div className="layer-control-title">
                  <strong>{layer.name}</strong>
                  <small>{layer.shortName}</small>
                </div>
                <div className="layer-actions">
                  <button
                    className="layer-order-button"
                    type="button"
                    onClick={() => moveLayer(layer.id, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${layer.name} up in layer order`}
                    title="Move up"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    className="layer-order-button"
                    type="button"
                    onClick={() => moveLayer(layer.id, 1)}
                    disabled={index === layers.length - 1}
                    aria-label={`Move ${layer.name} down in layer order`}
                    title="Move down"
                  >
                    <ArrowDown size={12} />
                  </button>
                </div>
                <button
                  type="button"
                  className={`layer-switch ${isEnabled ? "is-on" : ""}`}
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={`${layer.name} layer`}
                  aria-describedby={`layer-status-${layer.id}`}
                  disabled={disabled}
                  onClick={() => setEnabled(layer.id, !isEnabled)}
                  title={disabled ? "Unavailable until verified data is connected" : undefined}
                >
                  <span />
                </button>
              </div>
              <div className="layer-source-line">
                <span className={`availability-dot ${layer.available ? "availability-ready" : ""}`} />
                {layer.available && layer.sourceUrl ? (
                  <a href={layer.sourceUrl} target="_blank" rel="noreferrer">
                    {layer.source}
                  </a>
                ) : (
                  <span>{layer.available ? layer.source : "SOURCE PENDING"}</span>
                )}
                {!layer.available && <LockKeyhole size={10} aria-hidden="true" />}
              </div>
              <p className="layer-detail" id={`layer-status-${layer.id}`}>
                {layer.description}
              </p>
              {layer.id === "science" && (
                <details className="science-data-details">
                  <summary>WHY IS THIS LAYER EMPTY?</summary>
                  <p>
                    No verified Jezero science-stop coordinates and source-mission
                    records are bundled yet. The layer stays disabled instead of
                    implying sample locations are NASA observations.
                  </p>
                </details>
              )}
              <label className="opacity-control">
                <span>OPACITY</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={Math.round(opacity[layer.id] * 100)}
                  disabled={disabled || !isEnabled}
                  aria-label={`${layer.name} opacity`}
                  aria-valuetext={`${Math.round(opacity[layer.id] * 100)} percent`}
                  onChange={(event) =>
                    setOpacity(layer.id, Number(event.currentTarget.value) / 100)
                  }
                />
                <b>{Math.round(opacity[layer.id] * 100)}%</b>
              </label>
              <div className={`layer-legend ${layer.available ? "layer-legend-relief" : ""}`}>
                {layer.available ? (
                  layer.id === "elevation" ? (
                    <>
                      <span className="relief-legend-swatch" />
                      <span>{layer.legend}</span>
                    </>
                  ) : layer.id === "slope" ? (
                    <>
                      <span className="slope-legend-swatch" />
                      <span>{layer.legend}</span>
                    </>
                  ) : (
                    <>
                      <span className="hazard-legend-swatch" />
                      <span>{layer.legend}</span>
                    </>
                  )
                ) : (
                  <>
                    <span className="legend-pending-mark">—</span>
                    <span>{layer.legend}</span>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="layer-coordinate-note">
        Layers align to the same planetocentric Mars coordinates. Missing source data stays
        disabled until verified.
      </p>
    </section>
  );
}

export default LayerPanel;
