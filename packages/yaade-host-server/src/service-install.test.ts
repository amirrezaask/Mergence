import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { renderUserService } from "./service-install.js"

test("user service definitions do not use a shell command", () => {
  const definition = renderUserService({
    executable: "/opt/yaade-server",
    dataDir: "/tmp/yaade",
    args: ["run", "--data-dir", "/tmp/yaade"],
  })
  assert.match(definition, /yaade-server|YAADE durable agent daemon/i)
  assert.doesNotMatch(definition, /sh -c|cmd\.exe \/c/i)
})
