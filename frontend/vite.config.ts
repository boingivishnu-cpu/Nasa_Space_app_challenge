import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [
    react(),
    cesium({
      rebuildCesium: true,
      cesiumBuildRootPath: "../node_modules/cesium/Build",
      cesiumBuildPath: "../node_modules/cesium/Build/Cesium/",
    }),
  ],
  server: {
    host: "0.0.0.0",
  },
});
