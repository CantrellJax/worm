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
		const verb = args[1];
		const split = args.indexOf("--");
		const [id, key] = args.slice(split + 1);
		const ask = asks[id];
		if (!ask) return { ok: false, output: "not_found" };
		if (verb === "show") return { ok: true, output: JSON.stringify(ask) };
		if (verb === "answer") {
			if (ask.status !== "open") return { ok: false, output: "409 decided" };
			const textFlag = args.find((arg) => arg.startsWith("--text="));
			const text = textFlag
				? textFlag
						.slice(7)
						.replace(/\u200b/g, "")
						.trim()
				: null;
			ask.status = "answered";
			ask.decision = {
				decision: key ?? "other",
				text,
				answered_as: args[args.indexOf("--as") + 1],
			};
			return { ok: true, output: "{}", warning: "" };
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
			"--as",
			"contact",
			"--text=Made-up reason",
			"--",
			"ASK1",
			"b",
		],
		[
			"ask",
			"answer",
			"--as",
			"contact",
			"--text=The contact could not answer this on the page.",
			"--",
			"ASK2",
			"needs_context",
		],
		["ask", "answer", "--as", "contact", "--text=Only words", "--", "ASK3"],
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

test("relay pages past answers it has to skip, and zm's own text cleaning does not make a re-run skip", async () => {
	const asks = {};
	for (let i = 0; i < 45; i += 1) {
		const id = `ASKP${String(i).padStart(2, "0")}`;
		asks[id] = {
			...heldAsk(id, `Made-up question ${i}?`),
			status: "withdrawn",
		};
	}
	asks.ASKZ = heldAsk("ASKZ", "Made-up last question?");
	const { zm, calls } = fakeZm(asks);
	const ids = Object.keys(asks);
	const shares = [];
	for (let i = 0; i < ids.length; i += 20) {
		const chunk = ids.slice(i, i + 20);
		for (const id of chunk) asks[id].status = "open";
		const spec = specFromAsks(zm, chunk);
		for (const id of chunk) if (id !== "ASKZ") asks[id].status = "withdrawn";
		shares.push(await sharePage(api, ORIGIN, spec, { days: 1 }));
	}
	for (const [index, shared] of shares.entries())
		for (const id of ids.slice(index * 20, index * 20 + 20))
			await answer(shared.link, id, {
				key: "a",
				...(id === "ASKZ" ? { text: "Yes\u200b please" } : {}),
			});
	const first = await relay(api, zm, { log: () => {} });
	assert.equal(first.skipped >= 45, true);
	assert.equal(asks.ASKZ.decision.decision, "a");
	assert.equal(asks.ASKZ.decision.text, "Yes please");
	assert.equal(first.recorded >= 1, true);

	const extra = heldAsk("ASKY", "Made-up crash question?");
	asks.ASKY = extra;
	const shared = await sharePage(api, ORIGIN, specFromAsks(zm, ["ASKY"]), {
		days: 1,
	});
	const id = await answer(shared.link, "ASKY", {
		key: "b",
		text: "Fine\u200b by me",
	});
	zm(answerArgs({ askId: "ASKY", key: "b", text: "Fine\u200b by me" }));
	calls.length = 0;
	const rerun = await relay(api, zm, { share: id, log: () => {} });
	assert.equal(rerun.recorded, 1);
	assert.equal(calls.filter((args) => args[1] === "answer").length, 0);
});

test("relay refuses malformed answers from the server and never lets a field become a zm option", async () => {
	const { zm, calls } = fakeZm({ ASK1: heldAsk("ASK1", "Made-up?") });
	const hostile = [
		{
			shareId: "11111111-2222-3333-4444-555555555555",
			askId: "-P",
			key: "a",
			revision: 1,
		},
		{
			shareId: "11111111-2222-3333-4444-555555555555",
			askId: "ASK1",
			key: "--project=evil",
			revision: 1,
		},
		{ shareId: "../../shares/x", askId: "ASK1", key: "a", revision: 1 },
		{
			shareId: "11111111-2222-3333-4444-555555555555",
			askId: "ASK1",
			revision: 1,
		},
	];
	let pages = 0;
	const fakeApi = async (path) => {
		if (path.includes("/recorded")) throw new Error("must not mark");
		pages += 1;
		return { answers: hostile, more: true, next: `answers/x/${pages}.json` };
	};
	const result = await relay(fakeApi, zm, { log: () => {} });
	assert.equal(result.failed, hostile.length * pages);
	assert.equal(calls.length, 0);
	assert.equal(pages, 50);
	assert.equal(result.more, true);
	assert.deepEqual(
		answerArgs({ askId: "ASK1", key: "a", text: "--as owner -h" }),
		[
			"ask",
			"answer",
			"--as",
			"contact",
			"--text=--as owner -h",
			"--",
			"ASK1",
			"a",
		],
	);
});
