import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { shouldRenderTraitsControls } from "../TraitsPicker.js"
import {
  createModelCapabilities,
  getProviderOptionDescriptors,
} from "./model.js"
import { getCatalogModels } from "./models-catalog.js"

describe("composer model catalog traits", () => {
  it("exposes fastMode for mock-fast and reasoning for mock-deep", () => {
    const models = getCatalogModels("mock")
    const fast = models.find(model => model.slug === "mock-fast")
    const deep = models.find(model => model.slug === "mock-deep")
    assert.ok(fast?.capabilities)
    assert.ok(deep?.capabilities)

    const fastDescriptors = getProviderOptionDescriptors({
      caps: fast.capabilities!,
      selections: undefined,
    })
    assert.ok(fastDescriptors.some(descriptor => descriptor.id === "fastMode"))

    const deepDescriptors = getProviderOptionDescriptors({
      caps: deep.capabilities!,
      selections: undefined,
    })
    assert.ok(
      deepDescriptors.some(descriptor => descriptor.id === "reasoningEffort"),
    )
  })

  it("shouldRenderTraitsControls is false without a model", () => {
    assert.equal(
      shouldRenderTraitsControls({
        provider: "mock",
        models: getCatalogModels("mock"),
        model: null,
        prompt: "",
        modelOptions: undefined,
      }),
      false,
    )
  })

  it("shouldRenderTraitsControls is true after selecting mock-fast", () => {
    assert.equal(
      shouldRenderTraitsControls({
        provider: "mock",
        models: getCatalogModels("mock"),
        model: "mock-fast",
        prompt: "",
        modelOptions: undefined,
      }),
      true,
    )
  })

  it("createModelCapabilities clones descriptors", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "fastMode",
          label: "Fast Mode",
          type: "boolean",
          currentValue: false,
        },
      ],
    })
    assert.equal(caps.optionDescriptors?.[0]?.id, "fastMode")
  })
})
