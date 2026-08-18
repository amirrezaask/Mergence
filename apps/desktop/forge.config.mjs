import path from "node:path"
import { fileURLToPath } from "node:url"
import { MakerDMG } from "@electron-forge/maker-dmg"
import { MakerZIP } from "@electron-forge/maker-zip"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { FuseV1Options, FuseVersion } from "@electron/fuses"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(__dirname, "../../dist/runtime")

export default {
  packagerConfig: {
    asar: true,
    name: "YAADE",
    executableName: "yaade",
    appBundleId: "dev.yaade.desktop",
    extraResource: [runtimeDir],
  },
  makers: [
    new MakerDMG({}, ["darwin"]),
    new MakerZIP({}, [process.platform]),
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
}
