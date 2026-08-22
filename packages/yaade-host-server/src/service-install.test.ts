import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { renderUserService } from "./service-install.js"

test("user service definitions do not terminal a shell command", () => {
  const definition = renderUserService({
    executable: "/opt/yaade-server",
    dataDir: "/tmp/yaade",
    args: ["run", "--data-dir", "/tmp/yaade"],
  })
  assert.match(definition, /yaade-server|YAADE host service/i)
  assert.doesNotMatch(definition, /sh -c|cmd\.exe \/c/i)
})
