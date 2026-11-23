import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

before(async () => {
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			name: "pages-test",
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
			bindings: { UPLOAD_TOKEN: owner },
		}),
	);
});
after(async () => runtime?.dispose());

const request = (path, init = {}) =>
	runtime.dispatchFetch(`https://sharing.test${path}`, init);

const PAGE_LIMIT = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const sha256 = (text) =>
	`'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const directives = (policy) =>
	Object.fromEntries(
		policy.split(";").map((part) => {
			const [name, ...values] = part.trim().split(/\s+/);
			return [name, values.join(" ")];
		}),
	);

async function prepare(options) {
	return request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({ title: "Synthetic page", ...options }),
	});
}

async function upload(html, options = {}) {
	const bytes = encoder.encode(html);
	const created = await prepare({
		contentType: "text/html",
		size: bytes.length,
		expiresInDays: 1,
		...options,
	});
	assert.equal(created.status, 201, await created.clone().text());
	const share = await created.json();
	const part = await request(`/api/v1/shares/${share.id}/parts/1`, {
		method: "PUT",
		headers,
		body: bytes,
	});
	assert.equal(part.status, 200);
	const done = await request(`/api/v1/shares/${share.id}/complete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ parts: [await part.json()] }),
	});
	assert.equal(done.status, 200);
	const token = share.sharePath.split("#")[1];
	const path = `/api/v1/shares/${share.id}`;
	const access = await request(`${path}/access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(access.status, 204);
	const setCookie = access.headers.get("Set-Cookie");
	return {
		...share,
		token,
		path,
		setCookie,
		cookie: { Cookie: setCookie.split(";")[0] },
	};
}

const synthetic = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic</title>
<style>table{border:1px solid #000}</style></head><body>
<table><tr><td>Synthetic Person</td></tr></table>
<script>document.body.dataset.ready="1"</script>
<script src="https://cdn.example.com/x.js"></script>
<script>\r\nwindow.answer = 42;\r\n</script>
</body></html>`;

test("type allowlist: an HTML page is accepted up to 8 MiB, other active content and larger pages are refused", async () => {
	assert.equal(
		(await prepare({ contentType: "text/html", size: PAGE_LIMIT })).status,
		201,
	);
	assert.equal(
		(await prepare({ contentType: "text/html", size: PAGE_LIMIT + 1 })).status,
		400,
	);
	for (const contentType of [
		"text/html; charset=utf-8",
		"TEXT/HTML",
		"application/xhtml+xml",
		"image/svg+xml",
		"text/javascript",
		"application/pdf",
	]) {
		assert.equal((await prepare({ contentType, size: 4 })).status, 400);
	}
	assert.equal(
		(await prepare({ contentType: "video/mp4", size: PAGE_LIMIT + 1 }))
			.status,
		201,
	);
});

test("page: the link's cookie opens the page as itself, with a page-specific CSP", async () => {
	const share = await upload(synthetic);
	const response = await request(`${share.path}/page`, {
		headers: share.cookie,
	});
	assert.equal(response.status, 200);
	assert.equal(await response.text(), synthetic);
	assert.equal(
		response.headers.get("Content-Type"),
		"text/html; charset=utf-8",
	);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
	assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(response.headers.get("X-Frame-Options"), "DENY");
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
	assert.equal(response.headers.get("Set-Cookie"), null);
	const policy = directives(response.headers.get("Content-Security-Policy"));
	assert.deepEqual(Object.keys(policy).sort(), [
		"base-uri",
		"connect-src",
		"default-src",
		"font-src",
		"form-action",
		"frame-ancestors",
		"img-src",
		"media-src",
		"script-src",
		"style-src",
	]);
	assert.equal(policy["default-src"], "'none'");
	assert.equal(policy["connect-src"], "'self'");
	assert.equal(policy["form-action"], "'self'");
	assert.equal(policy["frame-ancestors"], "'none'");
	assert.equal(policy["base-uri"], "'none'");
	assert.equal(policy["style-src"], "'unsafe-inline'");
	assert.equal(policy["img-src"], "data: blob:");
	assert.equal(policy["font-src"], "data:");
	assert.equal(
		policy["script-src"],
		[
			sha256('document.body.dataset.ready="1"'),
			sha256("\nwindow.answer = 42;\n"),
		].join(" "),
	);
	for (const value of Object.values(policy)) {
		assert.doesNotMatch(value, /https?:|\*|unsafe-eval/);
	}
	assert.doesNotMatch(policy["script-src"], /unsafe-inline|'self'/);
	const head = await request(`${share.path}/page`, {
		method: "HEAD",
		headers: share.cookie,
	});
	assert.equal(head.status, 200);
	assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("page: a page without scripts runs none, and the global CSP still covers everything else", async () => {
	const share = await upload(
		"<!doctype html><style>p{color:red}</style><p>Synthetic</p>",
	);
	const response = await request(`${share.path}/page`, {
		headers: share.cookie,
	});
	assert.equal(
		directives(response.headers.get("Content-Security-Policy"))["script-src"],
		"'none'",
	);
	const viewer = await request(`/s/${share.id}`);
	assert.match(
		viewer.headers.get("Content-Security-Policy"),
		/script-src 'self'; style-src 'self'/,
	);
});

test("page: only a holder of the link reads it, never from a URL token, and other shares have no page", async () => {
	const share = await upload("<p>Synthetic</p>");
	assert.equal((await request(`${share.path}/page`)).status, 404);
	assert.equal(
		(await request(`${share.path}/page?token=${share.token}`)).status,
		404,
	);
	assert.equal(
		(
			await request(`${share.path}/page`, {
				headers: { Cookie: `capux_read=${"0".repeat(64)}` },
			})
		).status,
		404,
	);
	assert.equal(
		(
			await request(`${share.path}/page`, {
				headers: { Authorization: `Bearer ${share.token}` },
			})
		).status,
		200,
	);
	const media = await request(`${share.path}/media?token=${share.token}`);
	assert.equal(media.status, 200);
	assert.equal(media.headers.get("Content-Disposition"), "attachment");
	assert.equal(
		media.headers.get("Content-Security-Policy"),
		"sandbox; default-src 'none'",
	);
	const created = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({ title: "img", contentType: "image/png", size: 3 }),
	});
	const image = await created.json();
	const part = await request(`/api/v1/shares/${image.id}/parts/1`, {
		method: "PUT",
		headers,
		body: new Uint8Array([1, 2, 3]),
	});
	await request(`/api/v1/shares/${image.id}/complete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ parts: [await part.json()] }),
	});
	assert.equal(
		(
			await request(`/api/v1/shares/${image.id}/page`, {
				headers: {
					Authorization: `Bearer ${image.sharePath.split("#")[1]}`,
				},
			})
		).status,
		404,
	);
});

test("page: a 1-day link expires with its cookie and revoking it closes the page at once", async () => {
	const before = Date.now();
	const share = await upload("<p>Synthetic</p>", { expiresInDays: 1 });
	assert.ok(share.expiresAt >= before + 86400000);
	assert.ok(share.expiresAt <= Date.now() + 86400000);
	const maxAge = Number(/Max-Age=(\d+)/.exec(share.setCookie)[1]);
	assert.ok(maxAge > 86000 && maxAge <= 86400);
	assert.match(share.setCookie, /HttpOnly; Secure; SameSite=Strict/);
	assert.match(share.setCookie, new RegExp(`Path=${share.path}/`));

	const lapsing = await upload("<p>Synthetic</p>");
	const bucket = await runtime.getR2Bucket("MEDIA");
	const manifest = await (await bucket.get(`shares/${lapsing.id}.json`)).json();
	manifest.expiresAt = Date.now() - 1;
	await bucket.put(`shares/${lapsing.id}.json`, JSON.stringify(manifest));
	assert.equal(
		(await request(`${lapsing.path}/page`, { headers: lapsing.cookie }))
			.status,
		404,
	);

	assert.equal(
		(await request(`${share.path}/page`, { headers: share.cookie })).status,
		200,
	);
	assert.equal(
		(await request(share.path, { method: "DELETE", headers: share.cookie }))
			.status,
		401,
	);
	assert.equal(
		(await request(share.path, { method: "DELETE", headers })).status,
		204,
	);
	const revoked = await request(`${share.path}/page`, {
		headers: share.cookie,
	});
	assert.equal(revoked.status, 404);
	assert.doesNotMatch(await revoked.text(), /Synthetic/);
	assert.equal(await bucket.head(`media/${share.id}`), null);
});

test("page: no preview card or title is built for a page share", async () => {
	const share = await upload("<title>Synthetic Person</title><p>x</p>", {
		title: "Synthetic Person tables",
	});
	const png = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
	]);
	const card = await request(`${share.path}/card`, {
		method: "PUT",
		headers,
		body: png,
	});
	assert.equal(card.status, 409);
	await runtime.getR2Bucket("MEDIA").then((bucket) =>
		bucket.put(`cards/${share.id}`, png, {
			httpMetadata: { contentType: "image/png" },
		}),
	);
	assert.equal((await request(`/s/${share.id}/card`)).status, 404);
	const viewer = await (await request(`/s/${share.id}`)).text();
	const generic = await (
		await request("/s/00000000-0000-0000-0000-000000000000")
	).text();
	assert.equal(viewer, generic);
	assert.doesNotMatch(viewer, /Synthetic Person/);
});

test("the viewer sends a page share's holder straight to the page", async () => {
	const id = "11111111-2222-3333-4444-555555555555";
	const calls = [];
	let replaced;
	const done = new Promise((resolve) => {
		replaced = resolve;
	});
	vm.runInNewContext(
		readFileSync(new URL("../public/viewer.js", import.meta.url), "utf8"),
		{
			location: {
				pathname: `/s/${id}`,
				hash: "#abc",
				replace: (url) => replaced(url),
			},
			document: {
				title: "",
				getElementById: () => ({ textContent: "" }),
				createElement: () => ({}),
			},
			fetch: async (url, init) => {
				calls.push([url, init?.method ?? "GET"]);
				return url.endsWith("/metadata")
					? {
							ok: true,
							json: async () => ({
								title: "T",
								contentType: "text/html",
								expiresAt: 1,
							}),
						}
					: { ok: true };
			},
			Object,
			Date,
		},
	);
	assert.equal(await done, `/api/v1/shares/${id}/page`);
	assert.deepEqual(calls, [
		[`/api/v1/shares/${id}/access`, "POST"],
		[`/api/v1/shares/${id}/metadata`, "GET"],
	]);
});
