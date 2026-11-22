const STRAY = new Set("])}>.,;:!?'\"");

// Same rule as trimStray in src/shared.ts: a message app can glue closing
// punctuation onto a pasted link, which the fragment never lets the server fix.
function trimStray(value) {
	let end = value.length;
	for (;;) {
		if (end > 0 && STRAY.has(value[end - 1])) {
			end -= 1;
			continue;
		}
		const encoded = /%([0-9a-fA-F]{2})$/.exec(value.slice(0, end));
		if (encoded && STRAY.has(String.fromCharCode(Number(`0x${encoded[1]}`)))) {
			end -= 3;
			continue;
		}
		return value.slice(0, end);
	}
}

async function openShare() {
	const id = trimStray(location.pathname).split("/").at(-1);
	const base = `/api/v1/shares/${id}`;
	const token = trimStray(location.hash.slice(1));
	if (token) {
		const access = await fetch(`${base}/access`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			credentials: "same-origin",
		});
		if (!access.ok)
			throw new Error("This link has expired, was revoked, or is incomplete.");
	}
	const response = await fetch(`${base}/metadata`, {
		credentials: "same-origin",
	});
	if (!response.ok)
		throw new Error(
			"Open the full sharing link to view this recording. It may have expired or been revoked.",
		);
	const share = await response.json();
	document.title = document.title.replace("Shared recording", share.title);
	document.getElementById("title").textContent = share.title;
	document.getElementById("status").textContent =
		`Available until ${new Date(share.expiresAt).toLocaleString()}`;
	const element = document.getElementById(
		share.contentType === "video/mp4" ? "video" : "image",
	);
	element.src = `${base}/media`;
	if (share.captions && share.contentType === "video/mp4") {
		const track = document.createElement("track");
		Object.assign(track, {
			kind: "captions",
			label: "English",
			srclang: "en",
			src: `${base}/captions`,
			default: true,
		});
		element.append(track);
	}
	element.hidden = false;
}
openShare().catch((error) => {
	document.getElementById("title").textContent = "Recording unavailable";
	document.getElementById("status").textContent = error.message;
});
