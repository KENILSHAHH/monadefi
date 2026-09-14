// Perpl on Monad for the server. The logic is in @app/perpl (shared with the MetaMask plugin and the mobile app).
// This module points it at the configured Monad RPC. It reads the variable directly: config() caches on its first call,
// and this module loads before anything else sets the environment.
import { configurePerpl } from "@app/perpl";

configurePerpl({ rpcUrl: process.env.RPC_MONAD || undefined });

export * from "@app/perpl";
