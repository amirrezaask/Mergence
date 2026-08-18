"use strict"

const { contextBridge } = require("electron")

contextBridge.exposeInMainWorld(
  "yaadeDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
  }),
)
