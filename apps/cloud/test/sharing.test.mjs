import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let runtime;
const owner = "synthetic-owner-token-with-at-least-32-bytes";
const headers = { Authorization: `Bearer ${owner}` };
const deployment = JSON.parse(
	readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const brand = JSON.parse(
	readFileSync(
		new URL("../../../crates/fork-brand/brand.json", import.meta.url),
		"utf8",
	),
);
function runtimeOptions(uploadToken = owner) {
	return convertV4MiniflareOptions({
		name: "sharing-test",
		modules: true,
		scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
		compatibilityDate: "2026-10-25",
		r2Buckets: ["MEDIA"],
		assets: {
			routerConfig: { has_user_worker: true },
			assetConfig: { html_handling: deployment.assets.html_handling },
			directory: fileURLToPath(new URL("../public", import.meta.url)),
			binding: "ASSETS",
			run_worker_first: true,
		},
		bindings: { UPLOAD_TOKEN: uploadToken },
	});
}
before(async () => {
	runtime = new Miniflare(runtimeOptions());
});
after(async () => runtime?.dispose());

async function request(path, init = {}) {
	return runtime.dispatchFetch(`https://sharing.test${path}`, init);
}

async function create(bytes, options = {}) {
	const response = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "Synthetic walk",
			contentType: "video/mp4",
			size: bytes.length,
			expiresInDays: 7,
			...options,
		}),
	});
	assert.equal(response.status, 201, await response.clone().text());
	const share = await response.json();
	const parts = [];
	for (let offset = 0; offset < bytes.length; offset += share.partSize) {
		const partNumber = parts.length + 1;
		const part = await request(
			`/api/v1/shares/${share.id}/parts/${partNumber}`,
			{
				method: "PUT",
				headers,
				body: bytes.subarray(offset, offset + share.partSize),
			},
		);
		assert.equal(part.status, 200, await part.clone().text());
		parts.push(await part.json());
	}
	const done = await request(`/api/v1/shares/${share.id}/complete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ parts }),
	});
	assert.equal(done.status, 200, await done.clone().text());
	return share;
}

test("owner authorization is required and arbitrary active content is rejected", async () => {
	assert.equal(
		(await request("/api/v1/shares", { method: "POST" })).status,
		401,
	);
	assert.equal(
		(
			await request("/api/v1/shares", {
				method: "POST",
				headers: { Authorization: "Bearer wrong" },
			})
		).status,
		401,
	);
	for (const contentType of [
		"text/html",
		"image/svg+xml",
		"application/json",
	]) {
		const response = await request("/api/v1/shares", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "unsafe", size: 4, contentType }),
		});
		assert.equal(response.status, 400);
	}
});

test("multipart bytes survive upload, public reads require a capability, video supports ranges and HEAD", async () => {
	const bytes = new Uint8Array(9 * 1024 * 1024 + 13).fill(7);
	bytes[8 * 1024 * 1024] = 91;
	const share = await create(bytes);
	const path = `/api/v1/shares/${share.id}`;
	assert.equal((await request(`${path}/metadata`)).status, 404);
	assert.equal((await request(`${path}/media`)).status, 404);
	const read = {
		Authorization: `Bearer ${new URL(`https://sharing.test${share.sharePath}`).hash.slice(1)}`,
	};
	const response = await request(`${path}/media`, {
		headers: { ...read, Range: "bytes=8388608-8388610" },
	});
	assert.equal(response.status, 206);
	assert.equal(
		response.headers.get("Content-Range"),
		`bytes 8388608-8388610/${bytes.length}`,
	);
	assert.deepEqual(
		new Uint8Array(await response.arrayBuffer()),
		new Uint8Array([91, 7, 7]),
	);
	const head = await request(`${path}/media`, {
		method: "HEAD",
		headers: read,
	});
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("Content-Length"), `${bytes.length}`);
	assert.equal((await head.arrayBuffer()).byteLength, 0);
	assert.equal(
		(
			await request(`${path}/media`, {
				headers: { ...read, Range: "bytes=999999999-" },
			})
		).status,
		416,
	);
	assert.equal(
		(
			await request(`${path}/media`, {
				headers: { ...read, Range: "bytes=0-1,3-4" },
			})
		).status,
		416,
	);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("media plays from a query token for a cross-origin video element and honors revocation and expiry", async () => {
	const bytes = new Uint8Array([10, 20, 30, 40, 50]);
	const share = await create(bytes);
	const path = `/api/v1/shares/${share.id}/media`;
	const token = share.sharePath.split("#")[1];
	const full = await request(`${path}?token=${token}`);
	assert.equal(full.status, 200);
	assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
	assert.equal(full.headers.get("Content-Type"), "video/mp4");
	assert.equal(full.headers.get("Referrer-Policy"), "no-referrer");
	assert.equal(full.headers.get("X-Content-Type-Options"), "nosniff");
	assert.match(full.headers.get("Cache-Control"), /private/);
	assert.equal(full.headers.get("Access-Control-Allow-Origin"), "*");
	assert.equal(full.headers.get("Access-Control-Allow-Credentials"), null);
	const ranged = await request(`${path}?token=${token}`, {
		headers: { Range: "bytes=1-2" },
	});
	assert.equal(ranged.status, 206);
	assert.equal(ranged.headers.get("Content-Range"), "bytes 1-2/5");
	assert.deepEqual(
		new Uint8Array(await ranged.arrayBuffer()),
		new Uint8Array([20, 30]),
	);
	assert.equal((await request(path)).status, 404);
	assert.equal((await request(`${path}?token=`)).status, 404);
	assert.equal((await request(`${path}?token=wrong${token}`)).status, 404);
	const metadata = `/api/v1/shares/${share.id}/metadata`;
	assert.equal((await request(`${metadata}?token=${token}`)).status, 404);
	const lapsing = await create(bytes);
	const lapsingToken = lapsing.sharePath.split("#")[1];
	const lapsingPath = `/api/v1/shares/${lapsing.id}/media?token=${lapsingToken}`;
	assert.equal((await request(lapsingPath)).status, 200);
	const bucket = await runtime.getR2Bucket("MEDIA");
	const manifest = await (await bucket.get(`shares/${lapsing.id}.json`)).json();
	manifest.expiresAt = Date.now() - 1;
	await bucket.put(`shares/${lapsing.id}.json`, JSON.stringify(manifest));
	assert.equal((await request(lapsingPath)).status, 404);
	assert.equal(
		(
			await request(`/api/v1/shares/${share.id}`, {
				method: "DELETE",
				headers,
			})
		).status,
		204,
	);
	assert.equal((await request(`${path}?token=${token}`)).status, 404);
});

test("viewer exchanges a fragment capability for a scoped HttpOnly cookie, revoke blocks existing cookies", async () => {
	const share = await create(new Uint8Array([1, 2, 3]), {
		contentType: "image/png",
	});
	const path = `/api/v1/shares/${share.id}`;
	const token = share.sharePath.split("#")[1];
	const access = await request(`${path}/access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(access.status, 204);
	const cookie = access.headers.get("Set-Cookie");
	assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
	assert.match(cookie, new RegExp(`Path=${path}/`));
	const cookieHeaders = { Cookie: cookie.split(";")[0] };
	assert.equal(
		(await request(`${path}/media`, { headers: cookieHeaders })).status,
		200,
	);
	assert.equal(
		(await request(path, { method: "DELETE", headers: cookieHeaders })).status,
		401,
	);
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal(
		(await request(`${path}/media`, { headers: cookieHeaders })).status,
		404,
	);
	assert.equal(
		(
			await request(`${path}/access`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			})
		).status,
		404,
	);
});

test("expired shares and incomplete or incorrectly sized uploads cannot be published", async () => {
	const response = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "partial",
			size: 9,
			contentType: "video/mp4",
		}),
	});
	const share = await response.json();
	const path = `/api/v1/shares/${share.id}`;
	assert.equal(
		(
			await request(`${path}/parts/1`, {
				method: "PUT",
				headers,
				body: new Uint8Array(8),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(`${path}/parts/2`, {
				method: "PUT",
				headers,
				body: new Uint8Array(9),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(`${path}/complete`, {
				method: "POST",
				headers,
				body: JSON.stringify({ parts: [] }),
			})
		).status,
		400,
	);
	const bucket = await runtime.getR2Bucket("MEDIA");
	const object = await bucket.get(`shares/${share.id}.json`);
	const manifest = await object.json();
	manifest.expiresAt = Date.now() - 1;
	await bucket.put(`shares/${share.id}.json`, JSON.stringify(manifest));
	assert.equal(
		(
			await request(`${path}/parts/1`, {
				method: "PUT",
				headers,
				body: new Uint8Array(9),
			})
		).status,
		404,
	);
});

test("viewer preserves the share path and serves the viewer without a redirect", async () => {
	const result = await request("/s/00000000-0000-0000-0000-000000000000", {
		redirect: "manual",
	});
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("Location"), null);
	const page = await result.text();
	assert.match(page, /Opening shared recording/);
	assert.match(page, new RegExp(`Shared with ${brand.display_name}`));
	assert.doesNotMatch(page, /%app%/);
});

test("a share link that picked up trailing punctuation redirects to the clean viewer path", async () => {
	const id = "00000000-0000-0000-0000-000000000000";
	for (const tail of [
		"%5D",
		"]",
		")",
		"].",
		"%5D.",
		"%5D%2E",
		".,",
		"%29%3B",
	]) {
		const result = await request(`/s/${id}${tail}`, { redirect: "manual" });
		assert.equal(result.status, 302, tail);
		assert.equal(result.headers.get("Location"), `/s/${id}`, tail);
	}
	for (const path of [
		`/s/${id}x`,
		`/s/${id.slice(1)}%5D`,
		"/s/%5D",
		`/s/${id}/%5D`,
	]) {
		const result = await request(path, { redirect: "manual" });
		assert.equal(result.status === 302, false, path);
		assert.equal(result.headers.get("Location"), null, path);
	}
});

test("the viewer card is generic: no share's title or existence reaches a request without the key", async () => {
	const share = await create(new Uint8Array([1, 2, 3]), {
		title: "Private quarterly numbers",
	});
	const real = await (await request(`/s/${share.id}`)).text();
	const unknown = await (
		await request("/s/00000000-0000-0000-0000-000000000000")
	).text();
	assert.equal(real, unknown);
	assert.doesNotMatch(real, /Private quarterly numbers/);
	assert.match(real, /<meta property="og:title" content="Shared recording">/);
	assert.match(real, /<meta property="og:description" content="[^"]+">/);
	assert.match(real, /<meta property="og:type" content="website">/);
	assert.match(
		real,
		/<meta name="twitter:card" content="summary_large_image">/,
	);
	assert.match(real, /<meta name="description" content="[^"]+">/);
	assert.match(
		real,
		/<meta property="og:image" content="https:\/\/sharing\.test\/card\.png">/,
	);
	assert.doesNotMatch(real, /%origin%/);
	const image = await request("/card.png");
	assert.equal(image.status, 200);
	assert.equal(image.headers.get("Content-Type"), "image/png");
	const bytes = new Uint8Array(await image.arrayBuffer());
	assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
});

test("the viewer script drops stray characters from the id and the key before using them", async () => {
	const id = "11111111-2222-3333-4444-555555555555";
	const key = "a1b2c3";
	const calls = [];
	const done = new Promise((resolve) => {
		const fetch = async (url, init) => {
			calls.push({ url, auth: init?.headers?.Authorization });
			resolve();
			return { ok: false };
		};
		const element = () => ({ textContent: "", hidden: true });
		vm.runInNewContext(
			readFileSync(new URL("../public/viewer.js", import.meta.url), "utf8"),
			{
				location: { pathname: `/s/${id}%5D`, hash: `#${key}%5D.` },
				document: { title: "", getElementById: element },
				fetch,
			},
		);
	});
	await done;
	assert.equal(calls[0].url, `/api/v1/shares/${id}/access`);
	assert.equal(calls[0].auth, `Bearer ${key}`);
});

const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there.\n";

test("captions: only the owner writes them, readers need the same access as the video, and the metadata says they exist", async () => {
	const share = await create(new Uint8Array([1, 2, 3]));
	const path = `/api/v1/shares/${share.id}`;
	const token = share.sharePath.split("#")[1];
	const read = { Authorization: `Bearer ${token}` };
	const metadata = async () =>
		(await request(`${path}/metadata`, { headers: read })).json();
	assert.equal((await metadata()).captions, false);
	assert.equal(
		(await request(`${path}/captions`, { headers: read })).status,
		404,
	);

	const put = (extra, body = vtt) =>
		request(`${path}/captions`, {
			method: "PUT",
			headers: { "Content-Type": "text/vtt", ...extra },
			body,
		});
	// Not the owner: no credential, a wrong one, or the read capability.
	assert.equal((await put({})).status, 401);
	assert.equal((await put({ Authorization: "Bearer wrong" })).status, 401);
	assert.equal((await put(read)).status, 401);
	assert.equal((await metadata()).captions, false);

	// Owner of another share record is refused like any foreign share.
	const bucket = await runtime.getR2Bucket("MEDIA");
	const record = await (await bucket.get(`shares/${share.id}.json`)).json();
	await bucket.put(
		`shares/${share.id}.json`,
		JSON.stringify({ ...record, owner: "someone-else" }),
	);
	assert.equal((await put(headers)).status, 404);
	await bucket.put(`shares/${share.id}.json`, JSON.stringify(record));

	// Content that is not UTF-8 WebVTT, or too large, is refused.
	assert.equal((await put(headers, "<html>")).status, 400);
	assert.equal(
		(await put(headers, new Uint8Array([0x57, 0xff, 0xfe]))).status,
		400,
	);
	assert.equal(
		(await put(headers, `WEBVTT\n${"a".repeat(256 * 1024)}`)).status,
		413,
	);
	assert.equal((await metadata()).captions, false);

	assert.equal((await put(headers)).status, 204);
	assert.equal((await metadata()).captions, true);

	// Reading needs the same access as the video, by bearer or by cookie.
	assert.equal((await request(`${path}/captions`)).status, 404);
	assert.equal(
		(
			await request(`${path}/captions`, {
				headers: { Authorization: "Bearer wrong" },
			})
		).status,
		404,
	);
	const bearerRead = await request(`${path}/captions`, { headers: read });
	assert.equal(bearerRead.status, 200);
	assert.equal(
		bearerRead.headers.get("Content-Type"),
		"text/vtt; charset=utf-8",
	);
	assert.equal(await bearerRead.text(), vtt);
	const access = await request(`${path}/access`, {
		method: "POST",
		headers: read,
	});
	const cookie = { Cookie: access.headers.get("Set-Cookie").split(";")[0] };
	assert.equal(
		(await request(`${path}/captions`, { headers: cookie })).status,
		200,
	);
	assert.equal(
		(await request(`${path}/captions`, { method: "DELETE", headers: cookie }))
			.status,
		401,
	);

	// The owner can remove them without revoking the video; revoking removes them too.
	assert.equal(
		(await request(`${path}/captions`, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal((await metadata()).captions, false);
	assert.equal((await put(headers)).status, 204);
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal(await bucket.head(`captions/${share.id}`), null);
	assert.equal(
		(await request(`${path}/captions`, { headers: read })).status,
		404,
	);
	assert.equal((await put(headers)).status, 404);
});

test("captions need a finished video share", async () => {
	const pending = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "pending",
			contentType: "video/mp4",
			size: 5,
		}),
	});
	const { id } = await pending.json();
	const early = await request(`/api/v1/shares/${id}/captions`, {
		method: "PUT",
		headers,
		body: vtt,
	});
	assert.equal(early.status, 409);
	const image = await create(new Uint8Array([1, 2, 3]), {
		contentType: "image/png",
	});
	const late = await request(`/api/v1/shares/${image.id}/captions`, {
		method: "PUT",
		headers,
		body: vtt,
	});
	assert.equal(late.status, 409);
});

test("the viewer adds a captions track only when the share has captions", async () => {
	const id = "11111111-2222-3333-4444-555555555555";
	const run = async (captions, contentType = "video/mp4") => {
		const appended = [];
		// openShare ends by un-hiding the media element, so that is the signal it is done.
		let finish;
		const done = new Promise((resolve) => {
			finish = resolve;
		});
		const media = {
			append: (track) => appended.push(track),
			set hidden(value) {
				if (value === false) finish();
			},
		};
		const text = () => ({ textContent: "" });
		const fetch = async (url) =>
			url.endsWith("/metadata")
				? {
						ok: true,
						json: async () => ({
							title: "T",
							contentType,
							expiresAt: 1,
							captions,
						}),
					}
				: { ok: true };
		vm.runInNewContext(
			readFileSync(new URL("../public/viewer.js", import.meta.url), "utf8"),
			{
				location: { pathname: `/s/${id}`, hash: "#abc" },
				document: {
					title: "",
					getElementById: (name) =>
						name === "video" || name === "image" ? media : text(),
					createElement: () => ({}),
				},
				fetch,
				Object,
				Date,
			},
		);
		await done;
		return appended;
	};
	const [track] = await run(true);
	assert.deepEqual(
		{ ...track },
		{
			kind: "captions",
			label: "English",
			srclang: "en",
			src: `/api/v1/shares/${id}/captions`,
			default: true,
		},
	);
	assert.deepEqual(await run(false), []);
	assert.deepEqual(await run(undefined), []);
	assert.deepEqual(await run(true, "image/png"), []);
});

test("captions uploaded while the share is being revoked are not kept", async () => {
	const share = await create(new Uint8Array([1, 2, 3]));
	const path = `/api/v1/shares/${share.id}`;
	const encoder = new TextEncoder();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let started;
	const begun = new Promise((resolve) => {
		started = resolve;
	});
	const body = new ReadableStream({
		async start(controller) {
			controller.enqueue(encoder.encode("WEBVTT\n\n"));
			started();
			await gate;
			controller.enqueue(encoder.encode("00:00.000 --> 00:01.000\nlate\n"));
			controller.close();
		},
	});
	const pending = request(`${path}/captions`, {
		method: "PUT",
		headers,
		body,
		duplex: "half",
	});
	await begun;
	// The request must be past its share lookup and waiting on the body, so the
	// revoke lands mid-upload. Nothing observable marks that, hence a short wait; if
	// it were too short the PUT would 404 at the lookup and the test would pass
	// without the fix, so the mutation check in the PR notes matters.
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		204,
	);
	release();
	assert.equal((await pending).status, 404);
	const bucket = await runtime.getR2Bucket("MEDIA");
	assert.equal(await bucket.head(`captions/${share.id}`), null);
});

const png = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const unknownId = "00000000-0000-0000-0000-000000000000";
const trickyTitle = `Q3 "plan" <b>&co's</b>`;
const decode = (value) =>
	value
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&#x27;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
const putCard = (id, extra, body = png) =>
	request(`/api/v1/shares/${id}/card`, { method: "PUT", body, headers: extra });
const page = async (id) => (await request(`/s/${id}`)).text();

test("card: only the owner stores one, only a bounded JPEG or PNG is accepted, and the owner can replace and remove it", async () => {
	const share = await create(new Uint8Array([1, 2, 3]), {
		title: trickyTitle,
	});
	const path = `/api/v1/shares/${share.id}`;
	const read = { Authorization: `Bearer ${share.sharePath.split("#")[1]}` };
	const metadata = async () =>
		(await request(`${path}/metadata`, { headers: read })).json();
	assert.equal((await metadata()).card, false);

	assert.equal((await putCard(share.id, {})).status, 401);
	assert.equal(
		(await putCard(share.id, { Authorization: "Bearer wrong" })).status,
		401,
	);
	assert.equal((await putCard(share.id, read)).status, 401);
	assert.equal((await metadata()).card, false);

	const bucket = await runtime.getR2Bucket("MEDIA");
	const record = await (await bucket.get(`shares/${share.id}.json`)).json();
	await bucket.put(
		`shares/${share.id}.json`,
		JSON.stringify({ ...record, owner: "someone-else" }),
	);
	assert.equal((await putCard(share.id, headers)).status, 404);
	await bucket.put(`shares/${share.id}.json`, JSON.stringify(record));

	assert.equal(
		(await putCard(share.id, headers, "<svg onload=alert(1)>")).status,
		400,
	);
	assert.equal(
		(await putCard(share.id, headers, new Uint8Array([0x89, 0x50, 0x4e]))).status,
		400,
	);
	const oversize = new Uint8Array(2 * 1024 * 1024 + 1);
	oversize.set(png);
	assert.equal((await putCard(share.id, headers, oversize)).status, 413);
	assert.equal((await metadata()).card, false);

	const limit = new Uint8Array(2 * 1024 * 1024);
	limit.set(jpeg);
	assert.equal((await putCard(share.id, headers, limit)).status, 204);
	assert.equal((await putCard(share.id, headers, png)).status, 204);
	assert.equal((await metadata()).card, true);

	const cardPath = `/s/${share.id}/card`;
	const served = await request(cardPath, { redirect: "manual" });
	assert.equal(served.status, 200);
	assert.equal(served.headers.get("Content-Type"), "image/png");
	assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);
	const head = await request(cardPath, { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("Content-Type"), "image/png");
	assert.equal(head.headers.get("Content-Length"), `${png.length}`);
	assert.equal((await head.arrayBuffer()).byteLength, 0);
	assert.equal(
		(await request(`${cardPath}.`, { redirect: "manual" })).status === 302,
		false,
	);

	assert.equal((await putCard(share.id, headers, jpeg)).status, 204);
	assert.equal(
		(await request(cardPath)).headers.get("Content-Type"),
		"image/jpeg",
	);

	const del = (extra) =>
		request(`${path}/card`, { method: "DELETE", headers: extra });
	assert.equal((await del({})).status, 401);
	assert.equal((await del(read)).status, 401);
	assert.equal((await metadata()).card, true);
	assert.equal((await del(headers)).status, 204);
	assert.equal((await metadata()).card, false);
	assert.equal((await request(cardPath)).status, 404);
});

test("card: a share that is not published cannot have one, an image share can", async () => {
	const pending = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "pending",
			contentType: "video/mp4",
			size: 5,
		}),
	});
	const { id } = await pending.json();
	assert.equal((await putCard(id, headers)).status, 409);
	assert.equal((await request(`/s/${id}/card`)).status, 404);
	const image = await create(new Uint8Array([1, 2, 3]), {
		contentType: "image/png",
	});
	assert.equal((await putCard(image.id, headers)).status, 204);
	assert.equal((await request(`/s/${image.id}/card`)).status, 200);
	assert.equal((await putCard(unknownId, headers)).status, 404);
});

test("card: the viewer page shows the title and card only for a live share that has one", async () => {
	const generic = await page(unknownId);
	const share = await create(new Uint8Array([1, 2, 3]), {
		title: trickyTitle,
	});
	assert.equal(await page(share.id), generic);

	assert.equal((await putCard(share.id, headers)).status, 204);
	const carded = await page(share.id);
	assert.notEqual(carded, generic);
	assert.doesNotMatch(carded, /<b>/);
	assert.doesNotMatch(carded, /%origin%|%app%/);
	const attribute = (property) =>
		decode(
			new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`).exec(
				carded,
			)[1],
		);
	assert.equal(attribute("og:title"), trickyTitle);
	assert.equal(attribute("twitter:title"), trickyTitle);
	assert.equal(
		decode(/<title>([^<]*)<\/title>/.exec(carded)[1]),
		trickyTitle,
	);
	const absolute = `https://sharing.test/s/${share.id}/card`;
	assert.equal(attribute("og:image"), absolute);
	assert.equal(attribute("twitter:image"), absolute);
	assert.equal(attribute("og:image:type"), "image/png");
	assert.doesNotMatch(carded, /og:image:width|og:image:height/);
	assert.match(carded, /<meta property="og:description" content="[^"]+">/);
	assert.match(carded, /<script src="\/viewer\.js" defer>/);
	assert.equal(await page(unknownId), generic);

	const uncarded = await create(new Uint8Array([1, 2, 3]), {
		title: "Never shown",
	});
	assert.equal(await page(uncarded.id), generic);

	assert.equal((await putCard(share.id, headers, jpeg)).status, 204);
	assert.match(await page(share.id), /og:image:type" content="image\/jpeg"/);

	const path = `/api/v1/shares/${share.id}`;
	assert.equal(
		(await request(`${path}/card`, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal(await page(share.id), generic);
	assert.equal((await request(`/s/${share.id}/card`)).status, 404);
});

test("card: revoking or expiring a share takes its title and image back", async () => {
	const generic = await page(unknownId);
	const missing = await request(`/s/${unknownId}/card`);
	assert.equal(missing.status, 404);
	const missingBody = await missing.text();
	const bucket = await runtime.getR2Bucket("MEDIA");

	const revoked = await create(new Uint8Array([1, 2, 3]));
	assert.equal((await putCard(revoked.id, headers)).status, 204);
	assert.equal(
		(
			await request(`/api/v1/shares/${revoked.id}`, {
				method: "DELETE",
				headers,
			})
		).status,
		204,
	);
	assert.equal(await bucket.head(`cards/${revoked.id}`), null);
	assert.equal(await page(revoked.id), generic);
	assert.equal(await (await request(`/s/${revoked.id}/card`)).text(), missingBody);
	assert.equal((await putCard(revoked.id, headers)).status, 404);

	const lapsing = await create(new Uint8Array([1, 2, 3]));
	assert.equal((await putCard(lapsing.id, headers)).status, 204);
	assert.equal((await request(`/s/${lapsing.id}/card`)).status, 200);
	const manifest = await (await bucket.get(`shares/${lapsing.id}.json`)).json();
	manifest.expiresAt = Date.now() - 1;
	await bucket.put(`shares/${lapsing.id}.json`, JSON.stringify(manifest));
	assert.equal(await page(lapsing.id), generic);
	const expired = await request(`/s/${lapsing.id}/card`);
	assert.equal(expired.status, 404);
	assert.equal(await expired.text(), missingBody);
	assert.equal((await request(`/s/${lapsing.id}/card`, { method: "HEAD" })).status, 404);
});

test("a card uploaded while the share is being revoked is not kept", async () => {
	const share = await create(new Uint8Array([1, 2, 3]));
	const path = `/api/v1/shares/${share.id}`;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let started;
	const begun = new Promise((resolve) => {
		started = resolve;
	});
	const body = new ReadableStream({
		async start(controller) {
			controller.enqueue(png);
			started();
			await gate;
			controller.enqueue(new Uint8Array([9, 9, 9]));
			controller.close();
		},
	});
	const pending = request(`${path}/card`, {
		method: "PUT",
		headers,
		body,
		duplex: "half",
	});
	await begun;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		204,
	);
	release();
	assert.equal((await pending).status, 404);
	const bucket = await runtime.getR2Bucket("MEDIA");
	assert.equal(await bucket.head(`cards/${share.id}`), null);
	assert.equal((await request(`/s/${share.id}/card`)).status, 404);
});

test("the cloud home page works with exact HTML asset routing", async () => {
	const result = await request("/", { redirect: "manual" });
	assert.equal(result.status, 200);
	const page = await result.text();
	assert.match(page, /Show what happened/);
	assert.match(page, new RegExp(`<title>${brand.display_name}</title>`));
	assert.ok(page.includes(`href="${brand.repo_url}"`));
	assert.ok(page.includes(`${brand.repo_url}/tree/main/apps/cloud`));
	assert.doesNotMatch(page, /%app%/);
	assert.doesNotMatch(page, /%repo%/);
});

test("credential rotation preserves ownership and revocation rights", async () => {
	const share = await create(new Uint8Array([1, 2, 3]));
	const rotated = "another-synthetic-owner-credential-long-enough";
	await runtime.setOptions(runtimeOptions(rotated));
	const path = `/api/v1/shares/${share.id}`;
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		401,
	);
	assert.equal(
		(
			await request(path, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${rotated}` },
			})
		).status,
		204,
	);
	const capability = share.sharePath.split("#")[1];
	assert.equal(
		(
			await request(`${path}/media`, {
				headers: { Authorization: `Bearer ${capability}` },
			})
		).status,
		404,
	);
});
