import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { sharePage } from "../scripts/questions.mjs";
import { answerArgs, relay, specFromAsks } from "../scripts/relay.mjs";

let runtime;
const owner = "synthetic-owner-token-with-at-least-32-bytes";
const ORIGIN = "https://sharing.test";

before(async () => {
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			name: "relay-test",
			modules: true,
			scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
			compatibilityDate: "2026-10-25",
			r2Buckets: ["MEDIA"],
			bindings: { UPLOAD_TOKEN: owner },
		}),
	);
});
after(async () => runtime?.dispose());

const api = async (path, init = {}) => {
	const response = await runtime.dispatchFetch(`${ORIGIN}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${owner}`, ...init.headers },
	});
	const body = response.status === 204 ? {} : await response.json();
	if (!response.ok) throw new Error(`${response.status} ${body.error}`);
	return body;
};

function fakeZm(asks) {
	const calls = [];
	const zm = (args) => {
		calls.push(args);
		const [, verb, id] = args;
		const ask = asks[id];
		if (!ask) return { ok: false, output: "not_found" };
		if (verb === "show") return { ok: true, output: JSON.stringify(ask) };
		if (verb === "answer") {
			if (ask.status !== "open") return { ok: false, output: "409 decided" };
			const key = args[3] && !args[3].startsWith("--") ? args[3] : undefined;
			const textAt = args.indexOf("--text");
			const text = textAt > 0 ? args[textAt + 1] : null;
			ask.status = "answered";
			ask.decision = {
				decision: key ?? "other",
				text,
				answered_as: args[args.indexOf("--as") + 1],
			};
			return { ok: true, output: "{}" };
		}
		return { ok: false, output: "unknown" };
	};
	return { zm, calls };
}

const card = (question) => ({
	question,
	recommend: "b",
	choices: [
		{ key: "a", label: "Made-up first" },
		{ key: "b", label: "Made-up second" },
	],
});
const heldAsk = (id, question) => ({
	id,
	status: "open",
	for: { group: "Synthetic Clinic", contact: "Test contact" },
	card: card(question),
});

async function answer(link, askId, body) {
	const url = new URL(link);
	const id = url.pathname.split("/").at(-1);
	const token = createHash("sha256")
		.update(`share-answer/1:${url.hash.slice(1)}`)
		.digest("hex");
	const response = await runtime.dispatchFetch(
		`${ORIGIN}/api/v1/shares/${id}/answers`,
		{
			method: "POST",
			headers: {
				Origin: "null",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ askId, ...body }),
		},
	);
	assert.equal(response.status, 200, await response.clone().text());
	return id;
}

test("ask-page reads each ask's card, and refuses asks that are not open or not held for a contact", () => {
	const asks = {
		ASK1: heldAsk("ASK1", "Made-up question one?"),
		ASK2: { ...heldAsk("ASK2", "Made-up question two?"), status: "answered" },
		ASK3: { ...heldAsk("ASK3", "Made-up question three?"), for: null },
	};
	const { zm } = fakeZm(asks);
	const spec = specFromAsks(zm, ["ASK1"], { title: "Synthetic" });
	assert.deepEqual(spec.questions, [
		{
			askId: "ASK1",
			question: "Made-up question one?",
			choices: [
				{ key: "a", label: "Made-up first" },
				{ key: "b", label: "Made-up second" },
			],
			recommended: "b",
			allowText: true,
		},
	]);
	assert.throws(() => specFromAsks(zm, ["ASK2"]), /answered, not open/);
	assert.throws(() => specFromAsks(zm, ["ASK3"]), /outside contact/);
	assert.throws(() => specFromAsks(zm, ["NOPE"]), /not_found/);
	assert.throws(() => specFromAsks(zm, []), /at least one/);
});

test("relay answers each pending ask as the contact, marks it recorded, and records nothing twice", async () => {
	const asks = {
		ASK1: heldAsk("ASK1", "Made-up question one?"),
		ASK2: heldAsk("ASK2", "Made-up question two?"),
		ASK3: heldAsk("ASK3", "Made-up question three?"),
		ASK4: heldAsk("ASK4", "Made-up question four?"),
	};
	const { zm, calls } = fakeZm(asks);
	const spec = specFromAsks(zm, Object.keys(asks), { title: "Synthetic" });
	const shared = await sharePage(api, ORIGIN, spec, { days: 1 });
	const id = await answer(shared.link, "ASK1", {
		key: "b",
		text: "Made-up reason",
	});
	await answer(shared.link, "ASK2", { key: "needs_context" });
	await answer(shared.link, "ASK3", { text: "Only words" });
	asks.ASK4.status = "withdrawn";
	await answer(shared.link, "ASK4", { key: "a" });
	calls.length = 0;

	const lines = [];
	const dry = await relay(api, zm, {
		share: id,
		dryRun: true,
		log: (l) => lines.push(l),
	});
	assert.equal(dry.recorded, 0);
	assert.ok(calls.every((args) => args[1] === "show"));
	assert.equal((await api(`/api/v1/answers?share=${id}`)).answers.length, 4);

	const first = await relay(api, zm, { share: id, log: (l) => lines.push(l) });
	assert.deepEqual(
		{ recorded: first.recorded, skipped: first.skipped, failed: first.failed },
		{ recorded: 3, skipped: 1, failed: 0 },
	);
	const answered = calls.filter((args) => args[1] === "answer");
	assert.deepEqual(answered, [
		[
			"ask",
			"answer",
			"ASK1",
			"b",
			"--text",
			"Made-up reason",
			"--as",
			"contact",
		],
		[
			"ask",
			"answer",
			"ASK2",
			"needs_context",
			"--text",
			"The contact could not answer this on the page.",
			"--as",
			"contact",
		],
		["ask", "answer", "ASK3", "--text", "Only words", "--as", "contact"],
	]);
	assert.deepEqual(asks.ASK1.decision, {
		decision: "b",
		text: "Made-up reason",
		answered_as: "contact",
	});
	assert.deepEqual(
		(await api(`/api/v1/answers?share=${id}`)).answers.map((a) => a.askId),
		["ASK4"],
	);

	calls.length = 0;
	const again = await relay(api, zm, { share: id, log: () => {} });
	assert.equal(again.recorded, 0);
	assert.equal(calls.filter((args) => args[1] === "answer").length, 0);
});

test("relay re-run after zm took the answer but marking failed only marks it", async () => {
	const asks = { ASK9: heldAsk("ASK9", "Made-up question nine?") };
	const { zm, calls } = fakeZm(asks);
	const shared = await sharePage(api, ORIGIN, specFromAsks(zm, ["ASK9"]), {
		days: 1,
	});
	const id = await answer(shared.link, "ASK9", { key: "a" });
	zm(answerArgs({ askId: "ASK9", key: "a", text: null }));
	calls.length = 0;
	const result = await relay(api, zm, { share: id, log: () => {} });
	assert.equal(result.recorded, 1);
	assert.equal(calls.filter((args) => args[1] === "answer").length, 0);
});
