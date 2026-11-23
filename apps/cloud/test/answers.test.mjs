import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { binding, render, validate } from "../scripts/questions-page.mjs";

let runtime;
const owner = "synthetic-owner-token-with-at-least-32-bytes";
const ownerHeaders = { Authorization: `Bearer ${owner}` };
const ORIGIN = "https://sharing.test";
const encoder = new TextEncoder();
const ASK_ONE = "01SYNTHETICASK00000000000A";
const ASK_TWO = "01SYNTHETICASK00000000000B";
let nextIp = 1;
const freshIp = () => `198.51.100.${nextIp++}`;

before(async () => {
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			name: "answers-test",
			modules: true,
			scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
			compatibilityDate: "2026-10-25",
			r2Buckets: ["MEDIA"],
			ratelimits: {
				ANSWER_LIMIT: { namespace_id: "3", simple: { limit: 12, period: 60 } },
			},
			bindings: { UPLOAD_TOKEN: owner },
		}),
	);
});
after(async () => runtime?.dispose());

const request = (path, init = {}) =>
	runtime.dispatchFetch(`${ORIGIN}${path}`, init);

const answerToken = (readToken) =>
	createHash("sha256").update(`share-answer/1:${readToken}`).digest("hex");

const spec = {
	title: "Synthetic clinic questions",
	intro: "A few made-up questions for a test.",
	html: "<table><tr><th>Shift</th><th>Team</th></tr><tr><td>Night</td><td>Blue</td></tr></table>",
	questions: [
		{
			askId: ASK_ONE,
			question: "Which made-up schedule should the test team use?",
			choices: [
				{ key: "a", label: "Schedule one" },
				{ key: "b", label: "Schedule two" },
				{ key: "c", label: "Schedule three" },
			],
			recommended: "b",
			allowText: true,
		},
		{
			askId: ASK_TWO,
			question: "Should the synthetic report go out weekly?",
			choices: [
				{ key: "a", label: "Yes" },
				{ key: "b", label: "No" },
			],
			allowText: false,
		},
	],
};

async function share(questions = binding(spec), options = {}) {
	const bytes = encoder.encode(render(spec));
	const created = await request("/api/v1/shares", {
		method: "POST",
		headers: ownerHeaders,
		body: JSON.stringify({
			title: "Synthetic questions",
			contentType: "text/html",
			size: bytes.length,
			expiresInDays: 1,
			questions,
			...options,
		}),
	});
	assert.equal(created.status, 201, await created.clone().text());
	const body = await created.json();
	const part = await request(`/api/v1/shares/${body.id}/parts/1`, {
		method: "PUT",
		headers: ownerHeaders,
		body: bytes,
	});
	const done = await request(`/api/v1/shares/${body.id}/complete`, {
		method: "POST",
		headers: ownerHeaders,
		body: JSON.stringify({ parts: [await part.json()] }),
	});
	assert.equal(done.status, 200);
	const readToken = body.sharePath.split("#")[1];
	const ip = freshIp();
	const path = `/api/v1/shares/${body.id}`;
	const answer = answerToken(readToken);
	const send = (
		payload,
		{ token = answer, origin = "null", address = freshIp() } = {},
	) =>
		request(`${path}/answers`, {
			method: "POST",
			headers: {
				...(origin === "none" ? {} : { Origin: origin }),
				"CF-Connecting-IP": address,
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
	const read = ({ token = answer, origin = "null" } = {}) =>
		request(`${path}/answers`, {
			headers: {
				Origin: origin,
				"CF-Connecting-IP": ip,
				Authorization: `Bearer ${token}`,
			},
		});
	return { id: body.id, path, readToken, answer, send, read };
}

const pendingFor = async (id, state = "pending") => {
	const response = await request(`/api/v1/answers?share=${id}&state=${state}`, {
		headers: ownerHeaders,
	});
	assert.equal(response.status, 200);
	return (await response.json()).answers;
};

test("questions: only an HTML page share can carry them, and they are validated", async () => {
	const base = { title: "x", size: 10, expiresInDays: 1 };
	const create = (body) =>
		request("/api/v1/shares", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ ...base, ...body }),
		});
	assert.equal(
		(await create({ contentType: "image/png", questions: binding(spec) }))
			.status,
		400,
	);
	for (const questions of [
		[],
		"nope",
		[{ askId: ASK_ONE, choices: ["a"] }],
		[{ askId: ASK_ONE, choices: ["a", "e"] }],
		[{ askId: ASK_ONE, choices: ["a", "a"] }],
		[{ askId: ASK_ONE, choices: ["a", "b", "c", "d", "a"] }],
		[{ askId: "../etc", choices: ["a", "b"] }],
		[{ askId: "x".repeat(65), choices: ["a", "b"] }],
		[
			{ askId: ASK_ONE, choices: ["a", "b"] },
			{ askId: ASK_ONE, choices: ["a", "b"] },
		],
		[{ askId: ASK_ONE, choices: ["a", "b"], allowText: "yes" }],
		Array.from({ length: 21 }, (_, i) => ({
			askId: `ASK${i}`,
			choices: ["a", "b"],
		})),
	]) {
		assert.equal(
			(await create({ contentType: "text/html", questions })).status,
			400,
			JSON.stringify(questions),
		);
	}
	assert.equal(
		(await create({ contentType: "text/html", questions: binding(spec) }))
			.status,
		201,
	);
});

test("answers: the recipient saves, replaces and reads back answers; the owner lists and records them", async () => {
	const page = await share();
	const empty = await page.read();
	assert.equal(empty.status, 200);
	assert.equal(empty.headers.get("Access-Control-Allow-Origin"), "null");
	assert.deepEqual(await empty.json(), { answers: [] });

	const first = await page.send({ askId: ASK_ONE, key: "a" });
	assert.equal(first.status, 200, await first.clone().text());
	assert.equal(first.headers.get("Access-Control-Allow-Origin"), "null");
	assert.equal((await first.json()).revision, 1);

	const second = await page.send({
		askId: ASK_ONE,
		key: "c",
		text: "  Synthetic note\r\nwith two lines  ",
	});
	assert.equal(second.status, 200);
	const replaced = await second.json();
	assert.equal(replaced.revision, 2);
	assert.equal(replaced.key, "c");
	assert.equal(replaced.text, "Synthetic note\nwith two lines");

	const cant = await page.send({ askId: ASK_TWO, key: "needs_context" });
	assert.equal(cant.status, 200);

	const mine = (await (await page.read()).json()).answers;
	assert.deepEqual(
		mine.map((a) => [a.askId, a.key, a.recorded]),
		[
			[ASK_ONE, "c", false],
			[ASK_TWO, "needs_context", false],
		],
	);

	const listed = await pendingFor(page.id);
	assert.equal(listed.length, 2);
	const one = listed.find((a) => a.askId === ASK_ONE);
	assert.equal(one.shareId, page.id);
	assert.equal(one.text, "Synthetic note\nwith two lines");
	const everywhere = await request("/api/v1/answers", {
		headers: ownerHeaders,
	});
	assert.ok(
		(await everywhere.json()).answers.some(
			(a) => a.shareId === page.id && a.askId === ASK_TWO,
		),
	);

	const mark = (askId, revision) =>
		request(`/api/v1/answers/${page.id}/${askId}/recorded`, {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ revision }),
		});
	const stale = await mark(ASK_ONE, 1);
	assert.equal(stale.status, 409);
	assert.equal((await stale.json()).answer.revision, 2);
	const marked = await mark(ASK_ONE, 2);
	assert.equal(marked.status, 200);
	assert.equal((await marked.json()).recorded, true);
	assert.equal((await mark(ASK_ONE, 2)).status, 200);
	assert.equal((await mark(ASK_ONE, 1)).status, 409);
	assert.equal((await mark("01NOSUCHASK", 1)).status, 404);

	const late = await page.send({ askId: ASK_ONE, key: "a" });
	assert.equal(late.status, 409);
	assert.equal(late.headers.get("Access-Control-Allow-Origin"), "null");
	assert.deepEqual(
		(await pendingFor(page.id)).map((a) => a.askId),
		[ASK_TWO],
	);
	assert.deepEqual(
		(await pendingFor(page.id, "recorded")).map((a) => [a.askId, a.key]),
		[[ASK_ONE, "c"]],
	);
	const after = (await (await page.read()).json()).answers;
	assert.equal(after.find((a) => a.askId === ASK_ONE).recorded, true);
});

test("answers: a wrong token, ask id, key, oversize or disallowed text is refused and stores nothing", async () => {
	const page = await share();
	const other = await share();
	const refused = async (response, status) => {
		assert.equal(response.status, status, await response.clone().text());
		assert.equal(response.headers.get("Access-Control-Allow-Origin"), "null");
	};
	await refused(
		await page.send({ askId: ASK_ONE, key: "a" }, { token: "0".repeat(64) }),
		401,
	);
	await refused(
		await page.send({ askId: ASK_ONE, key: "a" }, { token: page.readToken }),
		401,
	);
	await refused(
		await page.send({ askId: ASK_ONE, key: "a" }, { token: other.answer }),
		401,
	);
	await refused(
		await page.send({ askId: ASK_ONE, key: "a" }, { token: owner }),
		401,
	);
	await refused(await page.send({ askId: "01NOTONTHISPAGE", key: "a" }), 400);
	await refused(await page.send({ askId: ASK_TWO, key: "c" }), 400);
	await refused(await page.send({ askId: ASK_ONE, key: "e" }), 400);
	await refused(await page.send({ askId: ASK_ONE, key: "A" }), 400);
	await refused(await page.send({ askId: ASK_ONE, key: 1 }), 400);
	await refused(await page.send({ askId: ASK_ONE }), 400);
	await refused(await page.send({ askId: ASK_ONE, text: "   " }), 400);
	await refused(
		await page.send({ askId: ASK_ONE, key: "a", text: "é".repeat(1001) }),
		413,
	);
	await refused(
		await page.send({ askId: ASK_ONE, key: "a", text: "x\u0000y" }),
		400,
	);
	await refused(
		await page.send({ askId: ASK_TWO, key: "a", text: "no text here" }),
		400,
	);
	await refused(await page.send("{not json"), 400);
	await refused(await page.send("[]"), 400);
	await refused(
		await page.send({ askId: ASK_ONE, key: "a", text: "x".repeat(20000) }),
		413,
	);
	assert.deepEqual(await pendingFor(page.id, "all"), []);
	assert.equal(
		(await page.send({ askId: ASK_ONE, key: "a", text: "é".repeat(1000) }))
			.status,
		200,
	);
	assert.equal(
		(await page.send({ askId: ASK_ONE, text: "Only words, no choice" })).status,
		200,
	);
	assert.equal(
		(
			await page.send({
				askId: ASK_TWO,
				key: "needs_context",
				text: "Synthetic reason",
			})
		).status,
		200,
	);
});

test("answers: other origins and requests without an Origin are refused, and preflight is only for the page", async () => {
	const page = await share();
	for (const origin of [
		"https://attacker.example",
		"https://sharing.test.attacker.example",
		"http://sharing.test",
		"none",
	]) {
		const response = await page.send({ askId: ASK_ONE, key: "a" }, { origin });
		assert.equal(response.status, 403, String(origin));
		assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
	}
	assert.equal(
		(await page.read({ origin: "https://attacker.example" })).status,
		403,
	);
	const preflight = (origin) =>
		request(`${page.path}/answers`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization, content-type",
			},
		});
	const ok = await preflight("null");
	assert.equal(ok.status, 204);
	assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "null");
	assert.match(ok.headers.get("Access-Control-Allow-Headers"), /Authorization/);
	assert.doesNotMatch(
		ok.headers.get("Access-Control-Allow-Credentials") ?? "",
		/true/,
	);
	assert.equal((await preflight("https://attacker.example")).status, 403);
	assert.equal(
		(await page.send({ askId: ASK_ONE, key: "a" }, { origin: ORIGIN })).status,
		200,
	);
	assert.deepEqual(await pendingFor(page.id, "all").then((a) => a.length), 1);
});

test("answers: revoke and expiry end answering; the owner still reads answers given before", async () => {
	const page = await share();
	assert.equal((await page.send({ askId: ASK_ONE, key: "b" })).status, 200);
	assert.equal(
		(await request(page.path, { method: "DELETE", headers: ownerHeaders }))
			.status,
		204,
	);
	const revoked = await page.send({ askId: ASK_ONE, key: "a" });
	assert.equal(revoked.status, 404);
	assert.equal((await page.read()).status, 404);
	assert.deepEqual(
		(await pendingFor(page.id)).map((a) => [a.askId, a.key]),
		[[ASK_ONE, "b"]],
	);

	const lapsing = await share();
	const bucket = await runtime.getR2Bucket("MEDIA");
	const manifest = await (await bucket.get(`shares/${lapsing.id}.json`)).json();
	manifest.expiresAt = Date.now() - 1;
	await bucket.put(`shares/${lapsing.id}.json`, JSON.stringify(manifest));
	assert.equal((await lapsing.send({ askId: ASK_ONE, key: "a" })).status, 404);
});

test("answers: a page share without questions and an unpublished share take no answers", async () => {
	const bytes = encoder.encode("<p>Synthetic</p>");
	const created = await request("/api/v1/shares", {
		method: "POST",
		headers: ownerHeaders,
		body: JSON.stringify({
			title: "plain",
			contentType: "text/html",
			size: bytes.length,
			expiresInDays: 1,
		}),
	});
	const plain = await created.json();
	const token = answerToken(plain.sharePath.split("#")[1]);
	const post = (id) =>
		request(`/api/v1/shares/${id}/answers`, {
			method: "POST",
			headers: {
				Origin: "null",
				Authorization: `Bearer ${token}`,
				"CF-Connecting-IP": freshIp(),
			},
			body: JSON.stringify({ askId: ASK_ONE, key: "a" }),
		});
	assert.equal((await post(plain.id)).status, 404);
	const unpublished = await request("/api/v1/shares", {
		method: "POST",
		headers: ownerHeaders,
		body: JSON.stringify({
			title: "q",
			contentType: "text/html",
			size: 10,
			expiresInDays: 1,
			questions: binding(spec),
		}),
	});
	assert.equal((await post((await unpublished.json()).id)).status, 404);
});

test("answers: the owner API needs the owner credential and validates its input", async () => {
	const page = await share();
	await page.send({ askId: ASK_ONE, key: "a" });
	for (const token of [page.answer, page.readToken, ""]) {
		assert.equal(
			(
				await request("/api/v1/answers", {
					headers: { Authorization: `Bearer ${token}` },
				})
			).status,
			401,
		);
		assert.equal(
			(
				await request(`/api/v1/answers/${page.id}/${ASK_ONE}/recorded`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}` },
					body: JSON.stringify({ revision: 1 }),
				})
			).status,
			401,
		);
	}
	assert.equal(
		(await request("/api/v1/answers?share=../x", { headers: ownerHeaders }))
			.status,
		400,
	);
	assert.equal(
		(await request("/api/v1/answers?state=open", { headers: ownerHeaders }))
			.status,
		400,
	);
	assert.equal(
		(
			await request(`/api/v1/answers/${page.id}/${ASK_ONE}/recorded`, {
				method: "POST",
				headers: ownerHeaders,
				body: JSON.stringify({ revision: "1" }),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(`/api/v1/answers/${page.id}/${ASK_ONE}/recorded`, {
				headers: ownerHeaders,
			})
		).status,
		405,
	);
});

test("answers: one recipient address is rate limited", async () => {
	const page = await share();
	const address = freshIp();
	const statuses = [];
	for (let i = 0; i < 14; i += 1)
		statuses.push(
			(await page.send({ askId: ASK_ONE, key: i % 2 ? "a" : "b" }, { address }))
				.status,
		);
	assert.ok(statuses.slice(0, 12).every((status) => status === 200));
	assert.equal(statuses.at(-1), 429);
});

test("answers: the server never logs answers or page content", () => {
	for (const file of ["answers.ts", "index.ts", "shared.ts"]) {
		const source = readFileSync(
			new URL(`../src/${file}`, import.meta.url),
			"utf8",
		);
		const logs = source.match(/console\.\w+\([^;]*;/gs) ?? [];
		for (const call of logs)
			assert.doesNotMatch(call, /text|answer|body|html/i);
	}
});

test("page: a page share runs sandboxed in an opaque origin, without COOP", async () => {
	const page = await share();
	const access = await request(`${page.path}/access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${page.readToken}` },
	});
	const cookie = access.headers.get("Set-Cookie").split(";")[0];
	const response = await request(`${page.path}/page`, {
		headers: { Cookie: cookie },
	});
	assert.equal(response.status, 200);
	const policy = response.headers.get("Content-Security-Policy");
	assert.match(policy, /; sandbox allow-scripts allow-forms$/);
	assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation/);
	assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), null);
	const metadata = await request(`${page.path}/metadata`, {
		headers: { Cookie: cookie },
	});
	assert.equal((await metadata.json()).questions, true);
});

test("the viewer hands a questions page the derived answer token, never the read key", async () => {
	const id = "11111111-2222-3333-4444-555555555555";
	const run = (questions) => {
		let replaced;
		const done = new Promise((resolve) => {
			replaced = resolve;
		});
		vm.runInNewContext(
			readFileSync(new URL("../public/viewer.js", import.meta.url), "utf8"),
			{
				location: {
					pathname: `/s/${id}`,
					hash: "#readkey",
					replace: (url) => replaced(url),
				},
				document: {
					title: "",
					getElementById: () => ({ textContent: "" }),
					createElement: () => ({}),
				},
				fetch: async (url) =>
					url.endsWith("/metadata")
						? {
								ok: true,
								json: async () => ({
									contentType: "text/html",
									questions,
								}),
							}
						: { ok: true },
				crypto,
				TextEncoder,
				Uint8Array,
				Array,
				Object,
				Date,
			},
		);
		return done;
	};
	assert.equal(
		await run(true),
		`/api/v1/shares/${id}/page#answer=${answerToken("readkey")}`,
	);
	assert.equal(await run(false), `/api/v1/shares/${id}/page`);
});

test("page kit: one self-contained page with every question, escaped text and one constant script", () => {
	const html = render(spec);
	assert.match(html, /<meta name="viewport"/);
	assert.doesNotMatch(html, /\s(?:src|href)=/);
	assert.doesNotMatch(html, /https?:\/\//);
	assert.equal(html.match(/<script>/g).length, 1);
	assert.equal(html.match(/<section class="q"/g).length, 2);
	assert.match(html, new RegExp(`data-ask="${ASK_ONE}"`));
	assert.match(html, /value="needs_context"/);
	assert.match(html, /Suggested/);
	assert.match(html, /<td>Night<\/td>/);
	assert.equal(html.match(/<textarea/g).length, 1);
	const script = (page) => /<script>([\s\S]*)<\/script>/.exec(page)[1];
	const other = render({
		...spec,
		title: "Other",
		questions: [spec.questions[1]],
	});
	assert.equal(script(html), script(other));
	const hostile = render({
		...spec,
		title: "<img src=x onerror=alert(1)>",
		questions: [
			{
				...spec.questions[0],
				question: "</legend><script>alert(1)</script>",
				choices: [
					{ key: "a", label: '"><b>x' },
					{ key: "b", label: "ok" },
				],
			},
		],
	});
	assert.equal(hostile.match(/<script>/g).length, 1);
	assert.doesNotMatch(hostile, /<img|<b>x/);
	for (const html of [
		"<script>x</script>",
		"<SCRIPT src=x>",
		"< iframe>",
		"<form action=x>",
		"<meta http-equiv=refresh>",
		"<base href=x>",
	])
		assert.throws(() => validate({ ...spec, html }), /may not contain/);
	assert.throws(
		() =>
			validate({
				...spec,
				questions: [{ ...spec.questions[0], recommended: "d" }],
			}),
		/recommended/,
	);
	assert.deepEqual(binding(spec), [
		{ askId: ASK_ONE, choices: ["a", "b", "c"], allowText: true },
		{ askId: ASK_TWO, choices: ["a", "b"], allowText: false },
	]);
});
