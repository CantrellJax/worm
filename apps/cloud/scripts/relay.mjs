import { execFileSync } from "node:child_process";
import { NEEDS_CONTEXT_NOTE } from "./questions-page.mjs";

export function zmCli(bin = process.env.ZM_BIN ?? "zm") {
	return (args) => {
		try {
			return {
				ok: true,
				output: execFileSync(bin, args, {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}),
			};
		} catch (error) {
			return {
				ok: false,
				output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim(),
			};
		}
	};
}

export function showAsk(zm, askId) {
	const result = zm(["ask", "show", askId, "--json"]);
	if (!result.ok) throw new Error(`zm ask show ${askId}: ${result.output}`);
	return JSON.parse(result.output);
}

function sentText(answer) {
	return (
		answer.text ?? (answer.key === "needs_context" ? NEEDS_CONTEXT_NOTE : null)
	);
}

export function answerArgs(answer) {
	const args = ["ask", "answer", answer.askId];
	if (answer.key) args.push(answer.key);
	const text = sentText(answer);
	if (text) args.push("--text", text);
	args.push("--as", "contact");
	return args;
}

function sameDecision(decision, answer) {
	if (!decision || decision.answered_as !== "contact") return false;
	const expected = answer.key ?? "other";
	return (
		decision.decision === expected &&
		(decision.text ?? null) === sentText(answer)
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
	const seen = new Set();
	for (;;) {
		const { answers, more } = await api(`/api/v1/answers?${query}`);
		const fresh = answers.filter(
			(answer) =>
				!seen.has(`${answer.shareId}/${answer.askId}/${answer.revision}`),
		);
		summary.more = !!more && fresh.length === 0;
		if (!fresh.length) break;
		for (const answer of fresh) {
			seen.add(`${answer.shareId}/${answer.askId}/${answer.revision}`);
			await relayOne(api, zm, answer, { dryRun, log, summary });
		}
		if (!more) break;
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
	}
	try {
		await api(
			`/api/v1/answers/${answer.shareId}/${encodeURIComponent(answer.askId)}/recorded`,
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
