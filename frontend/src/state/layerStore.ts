import { create } from "zustand";
import { MAP_LAYERS, type LayerId } from "../layers";

interface LayerState {
  enabled: Record<LayerId, boolean>;
  opacity: Record<LayerId, number>;
  order: LayerId[];
  setEnabled: (id: LayerId, enabled: boolean) => void;
  setOpacity: (id: LayerId, opacity: number) => void;
  moveLayer: (id: LayerId, direction: -1 | 1) => void;
}

const availableLayers = new Set(
  MAP_LAYERS.filter((layer) => layer.available).map((layer) => layer.id),
);

export const useLayerStore = create<LayerState>((set) => ({
  enabled: {
    elevation: true,
    slope: true,
    science: false,
    hazards: false,
  },
  opacity: {
    elevation: 1,
    slope: 0.2,
    science: 1,
    hazards: 0.7,
  },
  order: ["hazards", "science", "slope", "elevation"],
  setEnabled: (id, enabled) => {
    if (!availableLayers.has(id)) return;
    set((state) => ({ enabled: { ...state.enabled, [id]: enabled } }));
  },
  setOpacity: (id, opacity) => {
    if (!availableLayers.has(id)) return;
    set((state) => ({
      opacity: { ...state.opacity, [id]: Math.max(0, Math.min(1, opacity)) },
    }));
  },
  moveLayer: (id, direction) =>
    set((state) => {
      const currentIndex = state.order.indexOf(id);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= state.order.length) {
        return state;
      }

      const order = [...state.order];
      [order[currentIndex], order[nextIndex]] = [order[nextIndex], order[currentIndex]];
      return { order };
    }),
}));
