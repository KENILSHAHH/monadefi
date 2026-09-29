// The one place that imports the Nansen risk engine (@app/risk, bundled into the plugin build).
// Swap this file if @app/risk changes its entry point.
export { applyVerdict, assessTrade, monitorPosition, POLICY } from "@app/risk";
