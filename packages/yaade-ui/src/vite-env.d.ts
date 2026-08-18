declare module "*.css" {
  const content: string
  export default content
}

declare module "*.png" {
  const src: string
  export default src
}

/** Vite `?worker&url` → URL string for `new Worker(url, { type: "module" })`. */
declare module "@pierre/diffs/worker/worker.js?worker&url" {
  const workerUrl: string
  export default workerUrl
}
