import assert from "node:assert/strict"
import test from "node:test"
import {
    addCompressionUsage,
    addCompressionUsageTotals,
    emptyCompressionUsage,
    estimatedCompressionUsage,
    normalizeCompressionUsageTotals,
    normalizeProviderUsage,
} from "../lib/compress/usage"
import { parseProviderUsageFromBody } from "../lib/v2/usage"

test("normalizeProviderUsage reads the AI SDK v3 usage shape", () => {
    const usage = normalizeProviderUsage({
        inputTokens: { total: 100, noCache: 40, cacheRead: 50, cacheWrite: 10 },
        outputTokens: { total: 20, text: 15, reasoning: 5 },
    })
    assert.deepEqual(usage, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
        source: "provider",
    })
})

test("normalizeProviderUsage falls back to component sums and rejects empty usage", () => {
    assert.deepEqual(normalizeProviderUsage({ inputTokens: { cacheRead: 7 }, outputTokens: {} }), {
        inputTokens: 7,
        outputTokens: 0,
        cacheReadTokens: 7,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        source: "provider",
    })
    // A total smaller than its parts is widened to the parts.
    assert.equal(
        normalizeProviderUsage({ inputTokens: { total: 3, noCache: 10 }, outputTokens: {} })
            ?.inputTokens,
        10,
    )
    // Reasoning counts towards the output total even without `text`.
    assert.equal(
        normalizeProviderUsage({ inputTokens: {}, outputTokens: { reasoning: 9 } })?.outputTokens,
        9,
    )
    assert.equal(normalizeProviderUsage(undefined), undefined)
    assert.equal(normalizeProviderUsage({}), undefined)
    assert.equal(normalizeProviderUsage({ inputTokens: {}, outputTokens: {} }), undefined)
})

test("estimated usage and totals accumulate across requests", () => {
    const estimated = estimatedCompressionUsage(500, 40)
    assert.deepEqual(estimated, {
        inputTokens: 500,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        source: "estimated",
    })

    let totals = addCompressionUsage(emptyCompressionUsage(), estimated)
    totals = addCompressionUsage(totals, {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 3,
        reasoningTokens: 4,
        source: "provider",
    })

    assert.deepEqual(totals, {
        calls: 2,
        providerCalls: 1,
        estimatedCalls: 1,
        inputTokens: 510,
        outputTokens: 42,
        cacheReadTokens: 1,
        cacheWriteTokens: 3,
        reasoningTokens: 4,
    })
    assert.deepEqual(addCompressionUsageTotals(totals, emptyCompressionUsage()), totals)
})

test("parseProviderUsageFromBody reads OpenAI responses SSE", () => {
    const body = [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"hi"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":20},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":105}}}',
    ].join("\n")
    assert.deepEqual(parseProviderUsageFromBody(body), {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        source: "provider",
    })
})

test("parseProviderUsageFromBody reads OpenAI chat SSE", () => {
    const body = [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"usage":{"prompt_tokens":200,"prompt_tokens_details":{"cached_tokens":50},"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":10}}}',
        "data: [DONE]",
    ].join("\n")
    assert.deepEqual(parseProviderUsageFromBody(body), {
        inputTokens: 200,
        outputTokens: 30,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        reasoningTokens: 10,
        source: "provider",
    })
})

test("parseProviderUsageFromBody merges Anthropic stream events", () => {
    const body = [
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":34,"cache_creation_input_tokens":5,"output_tokens":1}}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","usage":{"output_tokens":40}}',
    ].join("\n")
    assert.deepEqual(parseProviderUsageFromBody(body), {
        inputTokens: 51,
        outputTokens: 40,
        cacheReadTokens: 34,
        cacheWriteTokens: 5,
        reasoningTokens: 0,
        source: "provider",
    })
})

test("parseProviderUsageFromBody reads Google usageMetadata and rejects usage-free bodies", () => {
    const body =
        '{"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7,"cachedContentTokenCount":3,"thoughtsTokenCount":2}}'
    assert.deepEqual(parseProviderUsageFromBody(body), {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        source: "provider",
    })
    assert.equal(parseProviderUsageFromBody('{"id":"x","choices":[]}'), undefined)
    assert.equal(parseProviderUsageFromBody(""), undefined)
    assert.equal(parseProviderUsageFromBody("data: [DONE]"), undefined)
})

test("persisted usage totals load with backward-compatible defaults", () => {
    assert.deepEqual(normalizeCompressionUsageTotals(undefined), emptyCompressionUsage())
    assert.deepEqual(normalizeCompressionUsageTotals({ calls: 3, inputTokens: 9 }), {
        calls: 3,
        providerCalls: 0,
        estimatedCalls: 0,
        inputTokens: 9,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
    })
    // Invalid values never poison the totals.
    assert.deepEqual(
        normalizeCompressionUsageTotals({ calls: -1, inputTokens: Number.NaN, outputTokens: 4.6 }),
        {
            calls: 0,
            providerCalls: 0,
            estimatedCalls: 0,
            inputTokens: 0,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
    )
})
