#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binding, render } from "./questions-page.mjs";
import { relay, specFromAsks, zmCli } from "./relay.mjs";

const USAGE = `Usage: questions.mjs <command> [options]
  share <spec.json> [--days 1-30] [--title text]   build the page and share it; prints the link
  ask-page <ask id>... [--title text] [--intro text] [--html-file f] [--days 1-30] [--out spec.json]
      build the page from open zm asks held for a contact and share it (--out: write the spec only)
  relay [--share ID] [--dry-run]   record each pending answer in zm as the contact's, then mark it recorded
  pending [--share ID] [--state pending|recorded|all]   answers waiting to be recorded (JSON)
  recorded <share id> <ask id> <revision>   mark one answer recorded
  revoke <share id>   end the link (answers already given stay readable to the owner)
Options: --host https://server (default: the sharing config). The owner credential
comes from CAP_UX_UPLOAD_TOKEN or the macOS keychain entry the app saves.`;

const FLAGS = new Set(["--dry-run"]);

export function options(args) {
	const positional = [];
	const named = {};
	for (let i = 0; i < args.length; i += 1) {
		if (FLAGS.has(args[i])) named[args[i].slice(2)] = true;
		else if (args[i].startsWith("--")) {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error(`${args[i]} needs a value.`);
			named[args[i].slice(2)] = value;
			i += 1;
		} else positional.push(args[i]);
	}
	return { positional, named };
}

export function host(named = {}) {
	const configured =
		named.host ??
		process.env.WORM_SHARE_HOST ??
		JSON.parse(
			readFileSync(
				process.env.CAP_UX_SHARING_CONFIG ??
					join(homedir(), ".config/cap-ux/sharing.json"),
				"utf8",
			),
		).endpoint;
	const url = new URL(configured);
	if (
		url.protocol !== "https:" &&
		!["localhost", "127.0.0.1"].includes(url.hostname)
	)
		throw new Error("The sharing server must use HTTPS.");
	return url.origin;
}

function credential(origin) {
	if (process.env.CAP_UX_UPLOAD_TOKEN) return process.env.CAP_UX_UPLOAD_TOKEN;
	return execFileSync(
		"security",
		[
			"find-generic-password",
			"-s",
			"com.cantrell.cap-ux.sharing",
			"-a",
			origin,
			"-w",
		],
		{ encoding: "utf8" },
	).trim();
}

export function client(origin) {
	const token = credential(origin);
	return async (path, init = {}) => {
		const response = await fetch(`${origin}${path}`, {
			...init,
			redirect: "error",
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body && typeof init.body === "string"
					? { "Content-Type": "application/json" }
					: {}),
				...init.headers,
			},
		});
		const body = response.status === 204 ? {} : await response.json();
		if (!response.ok) {
			const error = new Error(
				`${init.method ?? "GET"} ${path}: ${response.status} ${body.error ?? ""}`.trim(),
			);
			error.status = response.status;
			error.body = body;
			throw error;
		}
		return body;
	};
}

export async function sharePage(api, origin, spec, { days = 1, title } = {}) {
	const html = new TextEncoder().encode(render(spec));
	const created = await api("/api/v1/shares", {
		method: "POST",
		body: JSON.stringify({
			title: title ?? "Questions",
			contentType: "text/html",
			size: html.length,
			expiresInDays: Number(days),
			questions: binding(spec),
		}),
	});
	try {
		const part = await api(`/api/v1/shares/${created.id}/parts/1`, {
			method: "PUT",
			body: html,
			headers: { "Content-Type": "application/octet-stream" },
		});
		await api(`/api/v1/shares/${created.id}/complete`, {
			method: "POST",
			body: JSON.stringify({ parts: [part] }),
		});
	} catch (error) {
		await api(`/api/v1/shares/${created.id}`, { method: "DELETE" }).catch(
			() => {},
		);
		throw error;
	}
	return {
		id: created.id,
		expiresAt: new Date(created.expiresAt).toISOString(),
		link: `${origin}${created.sharePath}`,
	};
}

export async function pending(api, { share, state = "pending" } = {}) {
	const query = new URLSearchParams({ state });
	if (share) query.set("share", share);
	return api(`/api/v1/answers?${query}`);
}

export function recorded(api, shareId, askId, revision) {
	return api(
		`/api/v1/answers/${encodeURIComponent(shareId)}/${encodeURIComponent(askId)}/recorded`,
		{ method: "POST", body: JSON.stringify({ revision: Number(revision) }) },
	);
}

export function revoke(api, shareId) {
	return api(`/api/v1/shares/${encodeURIComponent(shareId)}`, {
		method: "DELETE",
	});
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const { positional, named } = options(rest);
	if (!command || command === "--help" || command === "-h") {
		console.log(USAGE);
		return;
	}
	if (command === "ask-page" && named.out) {
		const spec = specFromAsks(zmCli(), positional, {
			...named,
			html: named["html-file"] && readFileSync(named["html-file"], "utf8"),
		});
		writeFileSync(named.out, `${JSON.stringify(spec, null, 2)}\n`);
		console.log(
			`wrote ${named.out}; share it with: questions.mjs share ${named.out}`,
		);
		return;
	}
	const origin = host(named);
	const api = client(origin);
	if (command === "ask-page" && positional.length > 0) {
		const spec = specFromAsks(zmCli(), positional, {
			...named,
			html: named["html-file"] && readFileSync(named["html-file"], "utf8"),
		});
		const shared = await sharePage(api, origin, spec, named);
		console.log(
			`id: ${shared.id}\nexpires: ${shared.expiresAt}\nlink: ${shared.link}`,
		);
	} else if (command === "relay" && positional.length === 0) {
		const summary = await relay(api, zmCli(), {
			share: named.share,
			dryRun: !!named["dry-run"],
		});
		console.log(
			`recorded ${summary.recorded}, skipped ${summary.skipped}, failed ${summary.failed}${summary.more ? "; more are waiting, run it again" : ""}`,
		);
		if (summary.failed) process.exitCode = 1;
	} else if (command === "share" && positional.length === 1) {
		const spec = JSON.parse(readFileSync(positional[0], "utf8"));
		const shared = await sharePage(api, origin, spec, named);
		console.log(
			`id: ${shared.id}\nexpires: ${shared.expiresAt}\nlink: ${shared.link}`,
		);
	} else if (command === "pending" && positional.length === 0)
		console.log(JSON.stringify(await pending(api, named), null, 2));
	else if (command === "recorded" && positional.length === 3)
		console.log(JSON.stringify(await recorded(api, ...positional), null, 2));
	else if (command === "revoke" && positional.length === 1) {
		await revoke(api, positional[0]);
		console.log("revoked");
	} else {
		console.error(USAGE);
		process.exit(2);
	}
}

if (fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? ""))
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
