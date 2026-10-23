import assert from "node:assert/strict"
import test from "node:test"
import {
    DEFAULT_STEALTH_CONFIG,
    DEPRECATED_CONFIG_KEYS,
    getDeprecatedConfigKeys,
    getInvalidConfigKeys,
    mergeStealth,
    resolveStealthLayer,
    validateConfigTypes,
    type StealthConfig,
} from "../lib/config"
import { resolveOutputScrubConfig, stripEchoesEnabled } from "../lib/v2/scrub"

const DEFAULTS: StealthConfig = DEFAULT_STEALTH_CONFIG

test("stealth defaults keep the invisibility layer on", () => {
    const layer = resolveStealthLayer({})
    assert.equal(layer, undefined)
    assert.deepEqual(mergeStealth(DEFAULTS, layer), DEFAULTS)
    assert.deepEqual(resolveOutputScrubConfig(DEFAULTS), {
        modelOutput: true,
        messageIds: true,
    })
    assert.equal(stripEchoesEnabled(DEFAULTS), true)
})

test("legacy compress scrub keys map onto the stealth section", () => {
    const layer = resolveStealthLayer({
        compress: {
            scrubModelOutput: false,
            scrubMessageIds: false,
        },
    })
    assert.deepEqual(layer, {
        enabled: undefined,
        scrubModelOutput: false,
        scrubMessageIds: false,
    })
    assert.deepEqual(mergeStealth(DEFAULTS, layer), {
        enabled: true,
        scrubModelOutput: false,
        scrubMessageIds: false,
    })
})

test("new stealth keys win over aliases in the same layer", () => {
    const layer = resolveStealthLayer({
        stealth: { scrubModelOutput: true },
        compress: { scrubModelOutput: false, scrubMessageIds: false },
    })
    assert.deepEqual(layer, {
        enabled: undefined,
        scrubModelOutput: true,
        scrubMessageIds: false,
    })
})

test("a partial stealth layer only overrides the keys it sets", () => {
    const merged = mergeStealth(DEFAULTS, { enabled: false })
    assert.deepEqual(merged, {
        enabled: false,
        scrubModelOutput: true,
        scrubMessageIds: true,
    })
})

test("the master switch disables every artifact cleanup", () => {
    const disabled: StealthConfig = {
        enabled: false,
        scrubModelOutput: true,
        scrubMessageIds: true,
    }
    assert.deepEqual(resolveOutputScrubConfig(disabled), {
        modelOutput: false,
        messageIds: false,
    })
    assert.equal(stripEchoesEnabled(disabled), false)
})

test("sub-keys can be disabled independently while stealth stays on", () => {
    assert.deepEqual(resolveOutputScrubConfig({ ...DEFAULTS, scrubModelOutput: false }), {
        modelOutput: false,
        messageIds: true,
    })
    assert.deepEqual(resolveOutputScrubConfig({ ...DEFAULTS, scrubMessageIds: false }), {
        modelOutput: true,
        messageIds: false,
    })
})

test("stealth keys are valid and legacy keys remain accepted", () => {
    const invalid = getInvalidConfigKeys({
        stealth: {
            enabled: true,
            scrubModelOutput: true,
            scrubMessageIds: true,
        },
        compress: {
            scrubModelOutput: true,
            scrubMessageIds: true,
        },
    })
    assert.deepEqual(invalid, [])
})

test("unknown stealth keys are rejected", () => {
    assert.deepEqual(getInvalidConfigKeys({ stealth: { scrubNudges: true } }), [
        "stealth.scrubNudges",
    ])
})

test("legacy scrub keys are reported as deprecated", () => {
    assert.deepEqual(getDeprecatedConfigKeys({ compress: { scrubModelOutput: false } }), [
        "compress.scrubModelOutput",
    ])
    assert.deepEqual(getDeprecatedConfigKeys({ stealth: { enabled: true } }), [])
    assert.equal(DEPRECATED_CONFIG_KEYS["compress.scrubMessageIds"], "stealth.scrubMessageIds")
})

test("stealth type validation accepts booleans and rejects other values", () => {
    assert.deepEqual(
        validateConfigTypes({
            stealth: { enabled: true, scrubModelOutput: false, scrubMessageIds: true },
        }),
        [],
    )

    const errors = validateConfigTypes({
        stealth: { enabled: "yes", scrubModelOutput: 1 },
    })
    assert.deepEqual(
        errors.map((error) => error.key),
        ["stealth.enabled", "stealth.scrubModelOutput"],
    )

    const objectErrors = validateConfigTypes({ stealth: [] })
    assert.deepEqual(
        objectErrors.map((error) => error.key),
        ["stealth"],
    )
})

test("legacy alias values are still type-checked", () => {
    const errors = validateConfigTypes({
        compress: { scrubModelOutput: "no", scrubMessageIds: 0 },
    })
    assert.deepEqual(
        errors.map((error) => error.key),
        ["compress.scrubModelOutput", "compress.scrubMessageIds"],
    )
})
