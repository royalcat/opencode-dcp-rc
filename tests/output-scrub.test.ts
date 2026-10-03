import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import {
    AisdkPartScrubber,
    DcpStreamScrubber,
    ProviderPayloadScrubber,
    createSseScrubTransform,
    installResponseScrubHook,
    scrubJsonBody,
    stripAisdkResultContent,
    stripDcpArtifacts,
    wrapScrubResponse,
    type OutputScrubConfig,
} from "../lib/v2/scrub"

const ALL: OutputScrubConfig = { modelOutput: true, messageIds: true }

function streamChunks(scrubber: DcpStreamScrubber, chunks: string[]): string {
    let out = ""
    for (const chunk of chunks) {
        out += scrubber.push(chunk)
    }
    return out + scrubber.flush()
}

test("DcpStreamScrubber removes whole reminder blocks", () => {
    const text = "Before <dcp-system-reminder>\nkeep out\n</dcp-system-reminder> after"
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), [text]), "Before  after")
})

test("DcpStreamScrubber removes tags split across chunk boundaries", () => {
    const text = "start <dcp-system-reminder>hidden</dcp-system-reminder> end"
    for (let split = 0; split <= text.length; split += 1) {
        const out = streamChunks(new DcpStreamScrubber(ALL), [
            text.slice(0, split),
            text.slice(split),
        ])
        assert.equal(out, "start  end", `split at ${split}`)
    }
})

test("DcpStreamScrubber matches tags case-insensitively", () => {
    assert.equal(
        streamChunks(new DcpStreamScrubber(ALL), [
            "a <DCP-System-Reminder>hidden</Dcp-Whatever> b",
        ]),
        "a  b",
    )
})

test("DcpStreamScrubber drops unpaired tags and releases an unfinished body", () => {
    assert.equal(
        streamChunks(new DcpStreamScrubber(ALL), ["a <dcp-message-id>m0042</dcp-message-id> b"]),
        "a  b",
    )
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["a <dcp-message-id>tail"]), "a tail")
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["a <dcp"]), "a ")
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["a </dcp"]), "a ")
})

test("DcpStreamScrubber fails open when no closing tag arrives", () => {
    const out = streamChunks(new DcpStreamScrubber(ALL), [`<dcp-x>${"y".repeat(9000)}`])
    assert.equal(out, "y".repeat(9000))
})

test("DcpStreamScrubber removes line-standalone compact ids", () => {
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["hello\n@521@\nworld"]), "hello\nworld")
    assert.equal(
        streamChunks(new DcpStreamScrubber(ALL), ["hello\n@blocked@ [medium] \nworld"]),
        "hello\nworld",
    )
    assert.equal(
        streamChunks(new DcpStreamScrubber(ALL), ["hello @521@ world"]),
        "hello @521@ world",
    )
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["@b12@\n"]), "")
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["@521@ x"]), "@521@ x")
})

test("DcpStreamScrubber removes compact ids split across chunks", () => {
    const text = "a\n@521@\nb"
    for (let split = 1; split < text.length; split += 1) {
        const out = streamChunks(new DcpStreamScrubber(ALL), [
            text.slice(0, split),
            text.slice(split),
        ])
        assert.equal(out, "a\nb", `split at ${split}`)
    }
})

test("DcpStreamScrubber flush drops complete ids and keeps incomplete ones", () => {
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["hello\n@52@"]), "hello\n")
    assert.equal(streamChunks(new DcpStreamScrubber(ALL), ["hello\n@52"]), "hello\n@52")
})

test("scrub config toggles each behavior independently", () => {
    const tagsOnly: OutputScrubConfig = { modelOutput: true, messageIds: false }
    const idsOnly: OutputScrubConfig = { modelOutput: false, messageIds: true }
    assert.equal(streamChunks(new DcpStreamScrubber(tagsOnly), ["<dcp-x>hi</dcp-x>\n@7@"]), "\n@7@")
    assert.equal(
        streamChunks(new DcpStreamScrubber(idsOnly), ["<dcp-x>hi</dcp-x>\n@7@"]),
        "<dcp-x>hi</dcp-x>\n",
    )
})

test("stripDcpArtifacts removes tags and id-only lines statelessly", () => {
    assert.equal(stripDcpArtifacts("a <dcp-x>b</dcp-x> c\n@9@\nd", ALL), "a  c\nd")
    assert.equal(stripDcpArtifacts("inline @9@ stays", ALL), "inline @9@ stays")
    assert.equal(stripDcpArtifacts("@9@", ALL), "")
    assert.equal(
        stripDcpArtifacts("<dcp-x>b</dcp-x>", { modelOutput: false, messageIds: true }),
        "<dcp-x>b</dcp-x>",
    )
})

test("ProviderPayloadScrubber handles OpenAI Responses events", () => {
    const scrubber = new ProviderPayloadScrubber(ALL)
    const first = {
        type: "response.output_text.delta",
        item_id: "i1",
        output_index: 0,
        content_index: 0,
        delta: "hello <dcp-sys",
    }
    assert.equal(scrubber.scrub(first), true)
    assert.equal(first.delta, "hello ")
    const second = {
        type: "response.output_text.delta",
        item_id: "i1",
        output_index: 0,
        content_index: 0,
        delta: "tem>x</dcp-system> world",
    }
    assert.equal(scrubber.scrub(second), true)
    assert.equal(second.delta, " world")

    const done = {
        type: "response.output_text.done",
        item_id: "i1",
        text: "a <dcp-x>b</dcp-x>",
    }
    assert.equal(scrubber.scrub(done), true)
    assert.equal(done.text, "a ")

    const args = {
        type: "response.function_call_arguments.delta",
        item_id: "f1",
        delta: '{"path":"<dcp-x>"}',
    }
    assert.equal(scrubber.scrub(args), false)
    assert.equal(args.delta, '{"path":"<dcp-x>"}')

    const item = {
        type: "response.output_item.done",
        item: { type: "message", content: [{ type: "output_text", text: "x\n@5@\ny" }] },
    }
    assert.equal(scrubber.scrub(item), true)
    assert.equal(item.item.content[0]!.text, "x\ny")

    const completed = {
        type: "response.completed",
        response: {
            output: [
                {
                    type: "message",
                    content: [{ type: "output_text", text: "done <dcp-a>x</dcp-a>" }],
                },
            ],
        },
    }
    assert.equal(scrubber.scrub(completed), true)
    assert.equal(completed.response.output[0]!.content[0]!.text, "done ")
})

test("ProviderPayloadScrubber handles Anthropic events", () => {
    const scrubber = new ProviderPayloadScrubber(ALL)
    const first = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "a\n@12" },
    }
    assert.equal(scrubber.scrub(first), true)
    assert.equal(first.delta.text, "a\n")
    const second = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "@\nb" },
    }
    assert.equal(scrubber.scrub(second), true)
    assert.equal(second.delta.text, "b")

    const thinking = {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "x <dcp-a>y</dcp-a>z" },
    }
    assert.equal(scrubber.scrub(thinking), true)
    assert.equal(thinking.delta.thinking, "x z")

    const tool = {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "<dcp-x>" },
    }
    assert.equal(scrubber.scrub(tool), false)
    assert.equal(tool.delta.partial_json, "<dcp-x>")

    const full = {
        type: "message",
        content: [
            { type: "text", text: "hi <dcp-a>x</dcp-a>" },
            { type: "thinking", thinking: "t <dcp-a>y</dcp-a>" },
        ],
    }
    assert.equal(scrubber.scrub(full), true)
    assert.equal(full.content[0]!.text, "hi ")
    assert.equal(full.content[1]!.thinking, "t ")
})

test("ProviderPayloadScrubber handles OpenAI chat events", () => {
    const scrubber = new ProviderPayloadScrubber(ALL)
    const delta = { choices: [{ index: 0, delta: { content: "ok <dcp-a>no</dcp-a>" } }] }
    assert.equal(scrubber.scrub(delta), true)
    assert.equal(delta.choices[0]!.delta.content, "ok ")

    const reasoning = { choices: [{ index: 0, delta: { reasoning_content: "@3@\n" } }] }
    assert.equal(scrubber.scrub(reasoning), true)
    assert.equal(reasoning.choices[0]!.delta.reasoning_content, "")

    const full = { choices: [{ index: 0, message: { content: "a <dcp-x>b</dcp-x>" } }] }
    assert.equal(scrubber.scrub(full), true)
    assert.equal(full.choices[0]!.message.content, "a ")

    const tool = {
        choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "<dcp-x>" } }] } }],
    }
    assert.equal(scrubber.scrub(tool), false)
    assert.equal(tool.choices[0]!.delta.tool_calls[0]!.function.arguments, "<dcp-x>")
})

test("ProviderPayloadScrubber handles Google parts", () => {
    const scrubber = new ProviderPayloadScrubber(ALL)
    const payload = {
        candidates: [{ content: { parts: [{ text: "x\n@1@\ny" }] }, finishReason: "STOP" }],
    }
    assert.equal(scrubber.scrub(payload), true)
    assert.equal(payload.candidates[0]!.content.parts[0]!.text, "x\ny")
})

async function runTransform(stream: any, chunks: string[]): Promise<string> {
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    const decoder = new TextDecoder()
    let out = ""
    const reading = (async () => {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            out += decoder.decode(value, { stream: true })
        }
        out += decoder.decode()
    })()
    for (const chunk of chunks) {
        await writer.write(new TextEncoder().encode(chunk))
    }
    await writer.close()
    await reading
    return out
}

test("sse scrub transform scrubs recognized events and passes others through", async () => {
    const events = [
        'event: message\ndata: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"<dcp-system-reminder>hi"}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"</dcp-system-reminder> done"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","delta":"<dcp-x>"}\n\n',
        "data: [DONE]\n\n",
    ].join("")
    const mid = Math.floor(events.length / 2)
    const out = await runTransform(createSseScrubTransform(ALL), [
        events.slice(0, mid),
        events.slice(mid),
    ])
    assert.ok(!out.includes("dcp-system-reminder"))
    assert.ok(out.includes('"delta":" done"'))
    assert.ok(out.includes('"delta":"<dcp-x>"'))
    assert.ok(out.includes("data: [DONE]"))
    assert.ok(out.includes("event: message"))
})

test("sse scrub transform passes malformed payloads through unchanged", async () => {
    const input = "data: {oops\n\ndata: [DONE]\n\n"
    const out = await runTransform(createSseScrubTransform(ALL), [input])
    assert.equal(out, input)
})

test("sse scrub transform handles CRLF boundaries", async () => {
    const input = 'data: {"choices":[{"index":0,"delta":{"content":"<dcp-x>a</dcp-x> b"}}]}\r\n\r\n'
    const out = await runTransform(createSseScrubTransform(ALL), [input])
    assert.ok(!out.includes("dcp-x"))
    assert.ok(out.includes('"content":" b"'))
    assert.ok(out.endsWith("\r\n\r\n"))
})

test("scrubJsonBody scrubs non-streamed JSON payloads", () => {
    const body = JSON.stringify({
        choices: [{ message: { content: "hi <dcp-a>x</dcp-a>", role: "assistant" } }],
    })
    const out = scrubJsonBody(body, ALL)
    assert.equal(JSON.parse(out).choices[0].message.content, "hi ")
    assert.equal(scrubJsonBody('{"nested":true}', ALL), '{"nested":true}')
    assert.equal(scrubJsonBody("not json", ALL), "not json")
})

test("wrapScrubResponse keeps status and drops content-length", async () => {
    const original = new Response(
        JSON.stringify({
            choices: [{ message: { role: "assistant", content: "a <dcp-x>b</dcp-x> c" } }],
        }),
        {
            status: 201,
            statusText: "Created",
            headers: { "content-type": "application/json", "x-test": "1" },
        },
    )
    const wrapped = wrapScrubResponse(original, ALL)
    assert.notEqual(wrapped, original)
    assert.equal(wrapped.status, 201)
    assert.equal(wrapped.statusText, "Created")
    assert.equal(wrapped.headers.get("content-length"), null)
    assert.equal(wrapped.headers.get("x-test"), "1")
    assert.equal((await wrapped.json()).choices[0].message.content, "a  c")

    const binary = new Response("abc", { headers: { "content-type": "application/octet-stream" } })
    assert.equal(wrapScrubResponse(binary, ALL), binary)
})

test("AisdkPartScrubber scrubs deltas and flushes leftovers", () => {
    const scrubber = new AisdkPartScrubber(ALL)
    const first = scrubber.process({ type: "text-delta", id: "t1", text: "a\n@5" })
    assert.equal(first.length, 1)
    assert.equal(first[0].text, "a\n")
    const second = scrubber.process({ type: "text-delta", id: "t1", text: "@\nb" })
    assert.equal(second.length, 1)
    assert.equal(second[0].text, "b")
    const end = scrubber.process({ type: "text-end", id: "t1" })
    assert.deepEqual(end, [{ type: "text-end", id: "t1" }])

    const reasoning = scrubber.process({
        type: "reasoning-delta",
        id: "r1",
        text: "x <dcp-a>y</dcp-a>z",
    })
    assert.equal(reasoning[0].text, "x z")

    const tool = scrubber.process({ type: "tool-input-delta", id: "x", delta: "<dcp-x>" })
    assert.deepEqual(tool, [{ type: "tool-input-delta", id: "x", delta: "<dcp-x>" }])
})

test("AisdkPartScrubber re-emits held text before the end event", () => {
    const scrubber = new AisdkPartScrubber(ALL)
    const delta = scrubber.process({ type: "text-delta", id: "t2", text: "tail\n@9" })
    assert.equal(delta[0].text, "tail\n")
    const end = scrubber.process({ type: "text-end", id: "t2", text: "tail\n@9" })
    assert.equal(end.length, 2)
    assert.equal(end[0].type, "text-delta")
    assert.equal(end[0].text, "@9")
    assert.equal(end[1].type, "text-end")
    assert.equal(end[1].text, "tail\n@9")
})

test("stripAisdkResultContent leaves tool calls untouched", () => {
    const result = {
        content: [
            { type: "text", text: "a <dcp-x>b</dcp-x>" },
            { type: "tool-call", input: "<dcp-x>" },
        ],
    }
    stripAisdkResultContent(result, ALL)
    assert.equal(result.content[0]!.text, "a ")
    assert.equal(result.content[1]!.input, "<dcp-x>")
})

test("installResponseScrubHook wraps responses and respects the kill switch", async () => {
    const handlers: Array<(event: any) => any> = []
    const ctx = {
        session: {
            hook: async (_name: string, fn: (event: any) => any) => {
                handlers.push(fn)
            },
        },
    } as any
    await installResponseScrubHook(ctx, { modelOutput: true, messageIds: false }, new Logger(false))
    assert.equal(handlers.length, 1)
    const original = new Response(JSON.stringify({ output_text: "hi <dcp-x>bye</dcp-x>" }), {
        headers: { "content-type": "application/json" },
    })
    const event: any = { response: original }
    await handlers[0]!(event)
    assert.notEqual(event.response, original)
    assert.equal((await event.response.json()).output_text, "hi ")

    const disabled: Array<unknown> = []
    const offCtx = {
        session: {
            hook: async (_name: string, fn: unknown) => {
                disabled.push(fn)
            },
        },
    } as any
    await installResponseScrubHook(
        offCtx,
        { modelOutput: false, messageIds: false },
        new Logger(false),
    )
    assert.equal(disabled.length, 0)
})
