import brand from "../../../crates/fork-brand/brand.json";
import { ID as FEEDBACK_ID, feedback } from "./feedback";
import { recovery } from "./recovery";
import {
	bearer,
	boundedBody,
	equal,
	HttpError,
	hash,
	response,
	trimStray,
} from "./shared";

type RuntimeEnv = Env & { UPLOAD_TOKEN?: string; FEEDBACK_SITES?: string };

interface Share {
	id: string;
	owner: string;
	readHash: string;
	title: string;
	contentType: string;
	size: number;
	uploadId: string;
	expiresAt: number;
	ready: boolean;
}

const PART_SIZE = 8 * 1024 * 1024;
const CAPTIONS_LIMIT = 256 * 1024;
const CARD_LIMIT = 2 * 1024 * 1024;
const PAGE_LIMIT = PART_SIZE;
const PAGE_SCRIPT_LIMIT = 32;
const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// The rrweb replay rebuilds the recorded page in a sandboxed iframe with the
// page's inlined CSS and style attributes, which need inline styles; scripts
// stay self-only and recorded images from other origins are not fetched.
const REWIND_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const rewindPage = (pathname: string) =>
	pathname.startsWith("/rewind/") &&
	FEEDBACK_ID.test(pathname.slice("/rewind/".length));
const VIEWER_PATH = /^\/s\/([a-f0-9-]{36})$/;
const CARD_PATH = /^\/s\/([a-f0-9-]{36})\/card$/;
const PAGE_TYPE = "text/html";
const TYPES = new Set(["video/mp4", "image/png", "image/jpeg", PAGE_TYPE]);
const MEDIA_PAGE_CSP = "sandbox; default-src 'none'";

function pageCsp(scriptHashes: string[]): string {
	const scripts = scriptHashes.length
		? scriptHashes.map((value) => `'sha256-${value}'`).join(" ")
		: "'none'";
	return [
		"default-src 'none'",
		`script-src ${scripts}`,
		"style-src 'unsafe-inline'",
		"img-src data: blob:",
		"font-src data:",
		"media-src data: blob:",
		"connect-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
	].join("; ");
}

async function inlineScriptHashes(html: string): Promise<string[]> {
	const scripts: string[] = [];
	let current: string | undefined;
	await new HTMLRewriter()
		.on("script", {
			element(element) {
				current = element.hasAttribute("src") ? undefined : "";
				element.onEndTag(() => {
					if (current !== undefined) scripts.push(current);
					current = undefined;
				});
			},
			text(chunk) {
				if (current !== undefined) current += chunk.text;
			},
		})
		.transform(new Response(html))
		.arrayBuffer();
	const unique = new Set<string>();
	for (const script of scripts) {
		if (unique.size >= PAGE_SCRIPT_LIMIT) break;
		// Browsers hash the script after the parser turns CRLF and CR into LF.
		const text = script.replace(/\r\n?/g, "\n");
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		);
		unique.add(btoa(String.fromCharCode(...digest)));
	}
	return [...unique];
}

async function owner(request: Request, env: RuntimeEnv): Promise<string> {
	if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32) {
		throw new HttpError(
			503,
			"Sharing has not been configured by the server owner.",
		);
	}
	const token = bearer(request);
	if (!(await equal(token, env.UPLOAD_TOKEN)))
		throw new HttpError(401, "Invalid upload credential.");
	return "self-hosted-owner";
}

async function json(request: Request): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(
			new TextDecoder().decode(await boundedBody(request, 256 * 1024)),
		);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error();
		return value as Record<string, unknown>;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "Invalid JSON request.");
	}
}

async function load(env: RuntimeEnv, id: string): Promise<Share> {
	if (await env.MEDIA.head(`revoked/${id}`))
		throw new HttpError(404, "Share unavailable.");
	const object = await env.MEDIA.get(`shares/${id}.json`);
	if (!object) throw new HttpError(404, "Share unavailable.");
	const share = await object.json<Share>();
	if (share.expiresAt <= Date.now())
		throw new HttpError(404, "Share unavailable.");
	return share;
}

async function readable(
	request: Request,
	share: Share,
	queryToken = "",
): Promise<string> {
	const cookie = request.headers
		.get("Cookie")
		?.split(";")
		.map((value) => value.trim())
		.find((value) => value.startsWith("capux_read="))
		?.slice(11);
	const token = bearer(request) || cookie || queryToken;
	if (!share.ready || !(await equal(await hash(token), share.readHash)))
		throw new HttpError(404, "Share unavailable.");
	return token;
}

async function create(request: Request, env: RuntimeEnv): Promise<Response> {
	const ownerId = await owner(request, env);
	const body = await json(request);
	const { title, size, contentType } = body;
	const days = body.expiresInDays ?? 7;
	if (
		typeof title !== "string" ||
		title.length > 240 ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		size > 20 * 1024 ** 3 ||
		typeof contentType !== "string" ||
		!TYPES.has(contentType) ||
		(contentType === PAGE_TYPE && size > PAGE_LIMIT) ||
		typeof days !== "number" ||
		!Number.isInteger(days) ||
		days < 1 ||
		days > 30
	) {
		throw new HttpError(
			400,
			"Choose a video, image or HTML page (at most 8 MiB), a valid size, and an expiry from 1 to 30 days.",
		);
	}
	const id = crypto.randomUUID();
	const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const upload = await env.MEDIA.createMultipartUpload(`media/${id}`, {
		httpMetadata: { contentType },
	});
	const share: Share = {
		id,
		owner: ownerId,
		readHash: await hash(token),
		title: title.trim() || `${brand.display_name} recording`,
		contentType,
		size,
		uploadId: upload.uploadId,
		expiresAt: Date.now() + days * 86400000,
		ready: false,
	};
	await env.MEDIA.put(`shares/${id}.json`, JSON.stringify(share));
	return response(
		{
			id,
			partSize: PART_SIZE,
			sharePath: `/s/${id}#${token}`,
			expiresAt: share.expiresAt,
		},
		201,
	);
}

function byteRange(
	header: string | null,
	size: number,
): { offset: number; length: number } | undefined {
	if (!header) return;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2]))
		throw new HttpError(416, "Invalid byte range.");
	let start: number;
	let end: number;
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix < 1)
			throw new HttpError(416, "Invalid byte range.");
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	}
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	)
		throw new HttpError(416, "Invalid byte range.");
	return { offset: start, length: end - start + 1 };
}

async function media(
	request: Request,
	env: RuntimeEnv,
	share: Share,
): Promise<Response> {
	await readable(
		request,
		share,
		new URL(request.url).searchParams.get("token") ?? "",
	);
	const range =
		request.method === "HEAD"
			? undefined
			: byteRange(request.headers.get("Range"), share.size);
	const object =
		request.method === "HEAD"
			? await env.MEDIA.head(`media/${share.id}`)
			: await env.MEDIA.get(`media/${share.id}`, { range });
	if (!object) throw new HttpError(404, "Share unavailable.");
	const headers = new Headers({
		"Content-Type": share.contentType,
		"Content-Length": `${range?.length ?? object.size}`,
		"Accept-Ranges": "bytes",
		ETag: object.httpEtag,
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers":
			"Accept-Ranges, Content-Length, Content-Range, Content-Type",
	});
	if (share.contentType === PAGE_TYPE) {
		headers.set("Content-Disposition", "attachment");
		headers.set("Content-Security-Policy", MEDIA_PAGE_CSP);
	}
	if (range)
		headers.set(
			"Content-Range",
			`bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
		);
	return new Response(
		"body" in object && object.body instanceof ReadableStream
			? object.body
			: null,
		{ status: range ? 206 : 200, headers },
	);
}

async function servePage(
	request: Request,
	env: RuntimeEnv,
	share: Share,
): Promise<Response> {
	await readable(request, share);
	if (share.contentType !== PAGE_TYPE)
		throw new HttpError(404, "Share unavailable.");
	const object = await env.MEDIA.get(`media/${share.id}`);
	if (!object) throw new HttpError(404, "Share unavailable.");
	const html = new TextDecoder().decode(await object.arrayBuffer());
	return new Response(request.method === "HEAD" ? null : html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": pageCsp(await inlineScriptHashes(html)),
			"X-Frame-Options": "DENY",
			"Cross-Origin-Opener-Policy": "same-origin",
		},
	});
}

async function putCaptions(
	request: Request,
	env: RuntimeEnv,
	share: Share,
): Promise<Response> {
	if (!share.ready || share.contentType !== "video/mp4")
		throw new HttpError(409, "Captions need a published video.");
	const bytes = await boundedBody(request, CAPTIONS_LIMIT);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		throw new HttpError(400, "Captions must be UTF-8 WebVTT.");
	}
	if (!/^\uFEFF?WEBVTT(?:[ \t\r\n]|$)/.test(text))
		throw new HttpError(400, "Captions must be UTF-8 WebVTT.");
	await env.MEDIA.put(`captions/${share.id}`, bytes, {
		httpMetadata: { contentType: "text/vtt; charset=utf-8" },
	});
	// A revoke that landed while the body streamed has already deleted captions/ID.
	if (await env.MEDIA.head(`revoked/${share.id}`)) {
		await env.MEDIA.delete(`captions/${share.id}`);
		throw new HttpError(404, "Share unavailable.");
	}
	return new Response(null, { status: 204 });
}

async function captions(
	request: Request,
	env: RuntimeEnv,
	share: Share,
): Promise<Response> {
	await readable(request, share);
	const object = await env.MEDIA.get(`captions/${share.id}`);
	if (!object) throw new HttpError(404, "Share unavailable.");
	return new Response(object.body, {
		headers: { "Content-Type": "text/vtt; charset=utf-8" },
	});
}

function cardType(bytes: Uint8Array): string | undefined {
	const starts = (magic: number[]) =>
		bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
}

async function putCard(
	request: Request,
	env: RuntimeEnv,
	share: Share,
): Promise<Response> {
	if (!share.ready || share.contentType === PAGE_TYPE)
		throw new HttpError(
			409,
			"A preview card needs a published video or image share.",
		);
	const bytes = await boundedBody(request, CARD_LIMIT);
	const type = cardType(bytes);
	if (!type)
		throw new HttpError(400, "A preview card must be a JPEG or PNG image.");
	await env.MEDIA.put(`cards/${share.id}`, bytes, {
		httpMetadata: { contentType: type },
	});
	// A revoke that landed while the body streamed has already deleted cards/ID.
	if (await env.MEDIA.head(`revoked/${share.id}`)) {
		await env.MEDIA.delete(`cards/${share.id}`);
		throw new HttpError(404, "Share unavailable.");
	}
	return new Response(null, { status: 204 });
}

async function liveCard(
	env: RuntimeEnv,
	id: string,
): Promise<{ share: Share; type: string } | undefined> {
	try {
		const share = await load(env, id);
		const type =
			share.ready && share.contentType !== PAGE_TYPE
				? (await env.MEDIA.head(`cards/${id}`))?.httpMetadata?.contentType
				: undefined;
		return type ? { share, type } : undefined;
	} catch {
		// A storage error must not fail the viewer page for people who hold the key.
		return undefined;
	}
}

async function cardImage(
	request: Request,
	env: RuntimeEnv,
	id: string,
): Promise<Response> {
	if (!(await liveCard(env, id)))
		throw new HttpError(404, "Share unavailable.");
	const object =
		request.method === "HEAD"
			? await env.MEDIA.head(`cards/${id}`)
			: await env.MEDIA.get(`cards/${id}`);
	if (!object) throw new HttpError(404, "Share unavailable.");
	return new Response(
		"body" in object && object.body instanceof ReadableStream
			? object.body
			: null,
		{
			headers: {
				"Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
				"Content-Length": `${object.size}`,
			},
		},
	);
}

function withCard(
	page: Response,
	origin: string,
	id: string,
	card: { share: Share; type: string },
): Response {
	// The rewriter only escapes quotes in attribute values, so `&` would be read
	// back as the start of an entity.
	const escaped = (value: string) =>
		value
			.replaceAll("&", "&amp;")
			.replaceAll('"', "&quot;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");
	const content = (value: string) => ({
		element(element: Element) {
			element.setAttribute("content", escaped(value));
		},
	});
	const drop = {
		element(element: Element) {
			element.remove();
		},
	};
	const image = `${origin}/s/${id}/card`;
	return new HTMLRewriter()
		.on("title", {
			element(element) {
				element.setInnerContent(card.share.title);
			},
		})
		.on('meta[property="og:title"]', content(card.share.title))
		.on('meta[name="twitter:title"]', content(card.share.title))
		.on('meta[property="og:image"]', content(image))
		.on('meta[name="twitter:image"]', content(image))
		.on('meta[property="og:image:type"]', content(card.type))
		.on('meta[property="og:image:width"]', drop)
		.on('meta[property="og:image:height"]', drop)
		.transform(page);
}

async function route(request: Request, env: RuntimeEnv): Promise<Response> {
	const url = new URL(request.url);
	if (
		url.pathname === "/api/v1/recovery" ||
		url.pathname.startsWith("/api/v1/recovery/")
	)
		return recovery(request, env.MEDIA, await owner(request, env));
	if (
		url.pathname === "/api/v1/feedback" ||
		url.pathname.startsWith("/api/v1/feedback/")
	)
		return feedback(request, env, () => owner(request, env));
	if (url.pathname === "/healthz")
		return response({ product: "capux", protocol: 1 });
	if (url.pathname === "/api/v1/shares" && request.method === "POST")
		return create(request, env);
	const match =
		/^\/api\/v1\/shares\/([a-f0-9-]{36})(?:\/(access|media|page|metadata|captions|card|complete|parts\/(\d+)))?$/.exec(
			url.pathname,
		);
	if (match) {
		const [, id, action, part] = match;
		const writing =
			request.method === "DELETE" ||
			(request.method === "PUT" &&
				(action === "captions" || action === "card")) ||
			action === "complete" ||
			part !== undefined;
		const ownerId = writing ? await owner(request, env) : undefined;
		const share = await load(env, id);
		if (ownerId && !(await equal(ownerId, share.owner)))
			throw new HttpError(404, "Share unavailable.");
		if (request.method === "DELETE" && action === "captions") {
			await env.MEDIA.delete(`captions/${id}`);
			return new Response(null, { status: 204 });
		}
		if (request.method === "DELETE" && action === "card") {
			await env.MEDIA.delete(`cards/${id}`);
			return new Response(null, { status: 204 });
		}
		if (request.method === "DELETE" && !action) {
			await env.MEDIA.put(`revoked/${id}`, "revoked");
			if (!share.ready)
				await env.MEDIA.resumeMultipartUpload(
					`media/${id}`,
					share.uploadId,
				).abort();
			await env.MEDIA.delete([`media/${id}`, `captions/${id}`, `cards/${id}`]);
			return new Response(null, { status: 204 });
		}
		if (request.method === "PUT" && action === "captions")
			return putCaptions(request, env, share);
		if (request.method === "PUT" && action === "card")
			return putCard(request, env, share);
		if (request.method === "GET" && action === "captions")
			return captions(request, env, share);
		if (request.method === "PUT" && part) {
			if (share.ready) throw new HttpError(409, "Share already published.");
			const number = Number(part);
			const count = Math.ceil(share.size / PART_SIZE);
			if (!Number.isInteger(number) || number < 1 || number > count)
				throw new HttpError(400, "Invalid part number.");
			const expected =
				number === count ? share.size - PART_SIZE * (count - 1) : PART_SIZE;
			const bytes = await boundedBody(request, PART_SIZE);
			if (bytes.length !== expected)
				throw new HttpError(400, "Incorrect part size.");
			return response(
				await env.MEDIA.resumeMultipartUpload(
					`media/${id}`,
					share.uploadId,
				).uploadPart(number, bytes),
			);
		}
		if (request.method === "POST" && action === "complete") {
			if (share.ready) return response({ id, ready: true });
			const { parts } = await json(request);
			if (
				!Array.isArray(parts) ||
				parts.length !== Math.ceil(share.size / PART_SIZE) ||
				!parts.every(
					(item, index) =>
						item &&
						item.partNumber === index + 1 &&
						typeof item.etag === "string" &&
						item.etag.length < 256,
				)
			)
				throw new HttpError(
					400,
					"A complete ordered list of uploaded parts is required.",
				);
			const object = await env.MEDIA.resumeMultipartUpload(
				`media/${id}`,
				share.uploadId,
			).complete(parts);
			if (object.size !== share.size)
				throw new HttpError(409, "Uploaded size does not match.");
			await load(env, id);
			share.ready = true;
			await env.MEDIA.put(`shares/${id}.json`, JSON.stringify(share));
			return response({ id, ready: true });
		}
		if (request.method === "POST" && action === "access") {
			const token = await readable(request, share);
			const secure = url.protocol === "https:" ? "; Secure" : "";
			return new Response(null, {
				status: 204,
				headers: {
					"Set-Cookie": `capux_read=${token}; Path=/api/v1/shares/${id}/; HttpOnly${secure}; SameSite=Strict; Max-Age=${Math.floor((share.expiresAt - Date.now()) / 1000)}`,
				},
			});
		}
		if (["GET", "HEAD"].includes(request.method) && action === "media")
			return media(request, env, share);
		if (["GET", "HEAD"].includes(request.method) && action === "page")
			return servePage(request, env, share);
		if (request.method === "GET" && action === "metadata") {
			await readable(request, share);
			return response({
				id,
				title: share.title,
				contentType: share.contentType,
				size: share.size,
				expiresAt: share.expiresAt,
				captions: !!(await env.MEDIA.head(`captions/${id}`)),
				card: !!(await env.MEDIA.head(`cards/${id}`)),
			});
		}
		throw new HttpError(405, "Method not allowed.");
	}
	if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
	const cardMatch = CARD_PATH.exec(url.pathname);
	if (cardMatch && ["GET", "HEAD"].includes(request.method))
		return cardImage(request, env, cardMatch[1]);
	const cleanPath = trimStray(url.pathname);
	if (cleanPath !== url.pathname && VIEWER_PATH.test(cleanPath))
		return new Response(null, {
			status: 302,
			headers: { Location: cleanPath },
		});
	const viewerId = VIEWER_PATH.exec(url.pathname)?.[1];
	if (viewerId) url.pathname = "/viewer.html";
	if (rewindPage(url.pathname)) url.pathname = "/rewind.html";
	if (url.pathname === "/") url.pathname = "/index.html";
	const asset = await env.ASSETS.fetch(new Request(url, request));
	if (!url.pathname.endsWith(".html") || !asset.ok) return asset;
	const headers = new Headers(asset.headers);
	headers.delete("content-length");
	headers.delete("etag");
	const page = new Response(
		(await asset.text())
			.replaceAll("%app%", brand.display_name)
			.replaceAll("%repo%", brand.repo_url)
			.replaceAll("%origin%", url.origin),
		{ status: asset.status, headers },
	);
	const card = viewerId ? await liveCard(env, viewerId) : undefined;
	return viewerId && card ? withCard(page, url.origin, viewerId, card) : page;
}

export default {
	async fetch(request, env) {
		let result: Response;
		try {
			result = await route(request, env);
		} catch (error) {
			if (error instanceof HttpError)
				result = response({ error: error.message }, error.status);
			else {
				console.error(
					JSON.stringify({
						event: "sharing_failed",
						type: error instanceof Error ? error.name : "unknown",
					}),
				);
				result = response(
					{ error: "Sharing request failed. Your local recording is safe." },
					500,
				);
			}
		}
		const secured = new Response(result.body, result);
		secured.headers.set("Cache-Control", "private, no-store");
		secured.headers.set("Referrer-Policy", "no-referrer");
		secured.headers.set("X-Content-Type-Options", "nosniff");
		if (!secured.headers.has("Content-Security-Policy"))
			secured.headers.set(
				"Content-Security-Policy",
				rewindPage(new URL(request.url).pathname) ? REWIND_CSP : CSP,
			);
		return secured;
	},
} satisfies ExportedHandler<RuntimeEnv>;
