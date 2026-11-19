const encoder = new TextEncoder();

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

const STRAY = new Set("])}>.,;:!?'\"");

// A message app can glue closing punctuation onto a pasted link, as a literal
// character or percent-encoded (%5D); the share id and key never contain these.
export function trimStray(value: string): string {
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

export function response(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export async function hash(value: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(value)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export async function equal(left: string, right: string): Promise<boolean> {
	const [a, b] = await Promise.all([hash(left), hash(right)]);
	return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

export function bearer(request: Request): string {
	return request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
}

export async function boundedBody(
	request: Request,
	limit: number,
): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) throw new HttpError(400, "A request body is required.");
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit)
				throw new HttpError(413, "Request exceeds the allowed size.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}
	return body;
}
