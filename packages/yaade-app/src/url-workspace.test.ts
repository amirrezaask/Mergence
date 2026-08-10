import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isHqPathname,
  isReservedWorkspacePathname,
  joinProjectPath,
  projectBreadcrumbs,
  projectRootFromLocation,
  projectRouteFromSearch,
  projectRouteUrl,
  resolveHomeRelativePath,
  knownProjectIdFromPathname,
  urlPathForKnownProject,
  urlPathForProjectRoot,
  workspaceDocumentTitle,
} from "./url-workspace.js"

describe("url-workspace", () => {
  it("resolves home-relative paths", () => {
    assert.equal(
      resolveHomeRelativePath("/Users/me", "/dev/consultation"),
      "/Users/me/dev/consultation",
    )
    assert.equal(resolveHomeRelativePath("/Users/me", "/"), "/Users/me")
    assert.equal(resolveHomeRelativePath("/Users/me", ""), "/Users/me")
  })

  it("blocks path traversal escaping home", () => {
    assert.equal(
      resolveHomeRelativePath("/Users/me", "/../../etc/passwd"),
      "/Users/me/etc/passwd",
    )
  })

  it("treats api and assets as reserved", () => {
    assert.equal(isReservedWorkspacePathname("/api/v1/rpc"), true)
    assert.equal(isReservedWorkspacePathname("/ws"), true)
    assert.equal(isReservedWorkspacePathname("/dev/consultation"), false)
  })

  it("maps location to project root", () => {
    assert.equal(
      projectRootFromLocation("/Users/me", "/dev/foo"),
      "/Users/me/dev/foo",
    )
    assert.equal(projectRootFromLocation("/Users/me", "/api/v1/x"), null)
    assert.equal(projectRootFromLocation("/Users/me", "/"), null)
    assert.equal(projectRootFromLocation("/Users/me", "/~"), "/Users/me")
    assert.equal(isHqPathname("/"), true)
  })

  it("builds titles and reverse URL paths", () => {
    assert.equal(
      workspaceDocumentTitle("/Users/me/dev/foo", "/Users/me"),
      "foo",
    )
    assert.equal(workspaceDocumentTitle("/Users/me", "/Users/me"), "me")
    assert.equal(urlPathForProjectRoot("/Users/me/dev/foo", "/Users/me"), "/dev/foo")
    assert.equal(urlPathForProjectRoot("/Users/me", "/Users/me"), "/~")
    assert.equal(urlPathForKnownProject("external id"), "/_project/external%20id")
    assert.equal(knownProjectIdFromPathname("/_project/external%20id"), "external id")
  })

  it("builds home-relative breadcrumbs with sibling parents", () => {
    const crumbs = projectBreadcrumbs("/Users/me/dev/yaade", "/Users/me")
    assert.deepEqual(
      crumbs.map(c => ({
        label: c.label,
        absolutePath: c.absolutePath,
        parentPath: c.parentPath,
      })),
      [
        {
          label: "~",
          absolutePath: "/Users/me",
          parentPath: "/Users",
        },
        {
          label: "dev",
          absolutePath: "/Users/me/dev",
          parentPath: "/Users/me",
        },
        {
          label: "yaade",
          absolutePath: "/Users/me/dev/yaade",
          parentPath: "/Users/me/dev",
        },
      ],
    )
  })

  it("builds a single home crumb", () => {
    const crumbs = projectBreadcrumbs("/Users/me", "/Users/me")
    assert.equal(crumbs.length, 1)
    assert.equal(crumbs[0]?.label, "~")
    assert.equal(crumbs[0]?.absolutePath, "/Users/me")
  })

  it("joins project paths", () => {
    assert.equal(joinProjectPath("/Users/me/dev", "yaade"), "/Users/me/dev/yaade")
    assert.equal(joinProjectPath("/", "tmp"), "/tmp")
  })

  it("defaults bare project routes to Git and maps legacy agent/terminal views to running", () => {
    assert.deepEqual(projectRouteFromSearch(""), {
      view: "history",
      workspaceId: null,
      checkoutKey: null,
      processId: null,
    })
    assert.equal(projectRouteFromSearch("?s=ses-1").view, "running")
    assert.equal(projectRouteFromSearch("?view=agents").view, "running")
    assert.equal(projectRouteFromSearch("?view=terminals").view, "running")
    assert.equal(
      projectRouteFromSearch("?view=running&agent=run-1").processId,
      "run-1",
    )
    assert.equal(
      projectRouteFromSearch("?view=running&terminal=term-1").processId,
      "term-1",
    )
  })

  it("round-trips deep-linked workspaces, checkouts, and processes", () => {
    assert.equal(
      projectRouteUrl("/dev/yaade", {
        view: "editors",
        workspaceId: "ses-editors",
      }),
      "/dev/yaade?view=editors&s=ses-editors",
    )
    assert.equal(
      projectRouteUrl("/dev/yaade", {
        view: "running",
        workspaceId: "ses-1",
        processId: "run-1",
      }),
      "/dev/yaade?view=running&s=ses-1&process=run-1",
    )
    assert.equal(
      projectRouteUrl("/dev/yaade", {
        view: "running",
        workspaceId: "ses-1",
        checkoutKey: "wt-key",
      }),
      "/dev/yaade?view=running&s=ses-1&checkout=wt-key",
    )
    assert.deepEqual(
      projectRouteFromSearch("?view=changes&checkout=wt-key"),
      {
        view: "changes",
        workspaceId: null,
        checkoutKey: "wt-key",
        processId: null,
      },
    )
    assert.equal(
      projectRouteUrl("/dev/yaade", {
        view: "running",
        workspaceId: null,
        processId: "terminal-1",
      }),
      "/dev/yaade?view=running&process=terminal-1",
    )
  })
})
