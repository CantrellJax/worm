import { spawnSync } from "node:child_process";
import { NEEDS_CONTEXT_NOTE } from "./questions-page.mjs";

const ASK_ID = /^[0-9A-Za-z_][0-9A-Za-z_-]{0,63}$/;
const SHARE_ID = /^[a-f0-9-]{36}$/;
const KEYS = new Set(["a", "b", "c", "d", "needs_context"]);
const PAGE_LIMIT = 50;

export function zmCli(bin = process.env.ZM_BIN ?? "zm") {
	return (args) => {
		const run = spawnSync(bin, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
		});
		return {
			ok: run.status === 0,
			output:
				run.status === 0
					? run.stdout
					: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() ||
						String(run.error ?? `exit ${run.status}`),
			warning: run.status === 0 ? (run.stderr ?? "").trim() : "",
		};
	};
}

export function showAsk(zm, askId) {
	if (!ASK_ID.test(askId)) throw new Error("not a zm ask id");
	const result = zm(["ask", "show", "--json", "--", askId]);
	if (!result.ok) throw new Error(`zm ask show ${askId}: ${result.output}`);
	const ask = JSON.parse(result.output);
	if (typeof ask !== "object" || ask === null || ask.id !== askId)
		throw new Error(`zm ask show ${askId} returned no such ask`);
	return ask;
}

function validAnswer(answer) {
	return (
		typeof answer === "object" &&
		answer !== null &&
		typeof answer.askId === "string" &&
		ASK_ID.test(answer.askId) &&
		typeof answer.shareId === "string" &&
		SHARE_ID.test(answer.shareId) &&
		Number.isSafeInteger(answer.revision) &&
		(answer.key === null || answer.key === undefined || KEYS.has(answer.key)) &&
		(answer.text === null ||
			answer.text === undefined ||
			typeof answer.text === "string") &&
		(!!answer.key || !!answer.text)
	);
}

function sentText(answer) {
	return (
		answer.text ?? (answer.key === "needs_context" ? NEEDS_CONTEXT_NOTE : null)
	);
}

export function answerArgs(answer) {
	const text = sentText(answer);
	const args = ["ask", "answer", "--as", "contact"];
	if (text) args.push(`--text=${text}`);
	args.push("--", answer.askId);
	if (answer.key) args.push(answer.key);
	return args;
}

const cleaned = (text) =>
	text
		?.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.trim() || null;

function sameDecision(decision, answer) {
	if (!decision || decision.answered_as !== "contact") return false;
	const expected = answer.key ?? "other";
	return (
		decision.decision === expected &&
		cleaned(decision.text) === cleaned(sentText(answer))
	);
}

export async function relay(
	api,
	zm,
	{ share, dryRun = false, log = console.log } = {},
) {
	const query = new URLSearchParams({ state: "pending" });
	if (share) query.set("share", share);
	const summary = { recorded: 0, skipped: 0, failed: 0, more: false };
	for (let page = 0; ; page += 1) {
		if (page === PAGE_LIMIT) {
			summary.more = true;
			break;
		}
		const { answers, more, next } = await api(`/api/v1/answers?${query}`);
		for (const answer of Array.isArray(answers) ? answers : []) {
			if (!validAnswer(answer)) {
				log("FAILED an answer the server returned is malformed; skipped");
				summary.failed += 1;
				continue;
			}
			await relayOne(api, zm, answer, { dryRun, log, summary });
		}
		if (!more || typeof next !== "string" || next === query.get("after")) break;
		query.set("after", next);
	}
	return summary;
}

async function relayOne(api, zm, answer, { dryRun, log, summary }) {
	const label = `${answer.askId} (share ${answer.shareId}, revision ${answer.revision})`;
	let ask;
	try {
		ask = showAsk(zm, answer.askId);
	} catch (error) {
		log(`FAILED ${label}: ${error.message}`);
		summary.failed += 1;
		return;
	}
	const alreadyRelayed = sameDecision(ask.decision, answer);
	if (!alreadyRelayed && ask.status !== "open") {
		log(`SKIPPED ${label}: the ask is ${ask.status}; the answer stays pending`);
		summary.skipped += 1;
		return;
	}
	if (dryRun) {
		log(
			alreadyRelayed
				? `WOULD MARK ${label}: zm already holds this answer`
				: `WOULD RUN zm ${answerArgs(answer)
						.map((arg) => JSON.stringify(arg))
						.join(" ")}`,
		);
		return;
	}
	if (!alreadyRelayed) {
		const result = zm(answerArgs(answer));
		if (!result.ok) {
			log(`FAILED ${label}: zm ask answer: ${result.output}`);
			summary.failed += 1;
			return;
		}
		if (result.warning) log(`NOTE ${label}: zm said: ${result.warning}`);
	}
	try {
		await api(
			`/api/v1/answers/${encodeURIComponent(answer.shareId)}/${encodeURIComponent(answer.askId)}/recorded`,
			{
				method: "POST",
				body: JSON.stringify({ revision: answer.revision }),
			},
		);
		log(`RECORDED ${label}${alreadyRelayed ? " (zm already had it)" : ""}`);
		summary.recorded += 1;
	} catch (error) {
		log(
			`FAILED ${label}: zm has the answer but marking it recorded failed: ${error.message}`,
		);
		summary.failed += 1;
	}
}

export function specFromAsks(zm, askIds, { title, intro, html } = {}) {
	if (!askIds.length) throw new Error("Name at least one ask id.");
	const questions = askIds.map((askId) => {
		const ask = showAsk(zm, askId);
		if (ask.status !== "open")
			throw new Error(`Ask ${askId} is ${ask.status}, not open.`);
		if (!ask.for)
			throw new Error(
				`Ask ${askId} is not held for an outside contact (zm ask new --for).`,
			);
		const card = ask.card;
		if (!card?.question || !Array.isArray(card.choices))
			throw new Error(`Ask ${askId} has no note card.`);
		return {
			askId,
			question: card.question,
			choices: card.choices.map((choice, index) => ({
				key: choice.key ?? "abcd"[index],
				label: choice.label,
			})),
			...(card.recommend ? { recommended: card.recommend } : {}),
			allowText: true,
		};
	});
	return {
		title: title ?? "A few questions",
		...(intro ? { intro } : {}),
		...(html ? { html } : {}),
		questions,
	};
}
