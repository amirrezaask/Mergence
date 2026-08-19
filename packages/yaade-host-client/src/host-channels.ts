import { HOST_ROUTE_CHANNELS } from "@yaade/rpc";

/** Host RPC channels implemented by the TypeScript host-server. */
export const HOST_CHANNELS = new Set<string>(HOST_ROUTE_CHANNELS);

/** @deprecated Use HOST_CHANNELS. */
export const RUST_HOST_CHANNELS = HOST_CHANNELS;
