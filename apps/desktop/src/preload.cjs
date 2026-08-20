"use strict"

const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld(
  "yaadeDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    loadServerDefinitions: () => ipcRenderer.invoke("yaade:servers:load"),
    /** @param {unknown} servers */
    saveServerDefinitions: servers =>
      ipcRenderer.invoke("yaade:servers:save", servers),
  }),
)
