import {
	bearer,
	boundedBody,
	equal,
	HttpError,
	hash,
	response,
} from "./shared";

export interface Question {
	askId: string;
	choices: string[];
	allowText: boolean;
}

export interface AnswerShare {
	id: string;
	ready: boolean;
	questions?: Question[];
	answerHash?: string;
}

interface Answer {
	shareId: string;
	askId: string;
	key?: string;
	text?: string;
	revision: number;
	answeredAt: number;
	recordedAt?: number;
}

type AnswerEnv = { MEDIA: R2Bucket; ANSWER_LIMIT?: RateLimit };

export const NEEDS_CONTEXT = "needs_context";
const ASK_ID = /^[0-9A-Za-z_][0-9A-Za-z_-]{0,63}$/;
const ANSWER_KEY =
	/^answers\/[a-f0-9-]{36}\/[0-9A-Za-z_][0-9A-Za-z_-]{0,63}\.json$/;
const SHARE_ID = /^[a-f0-9-]{36}$/;
const KEYS = ["a", "b", "c", "d"];
const QUESTION_LIMIT = 20;
const TEXT_LIMIT = 2000;
const BODY_LIMIT = 16 * 1024;
const LIST_LIMIT = 40;
const encoder = new TextEncoder();

export function answerToken(readToken: string): Promise<string> {
	return hash(`share-answer/1:${readToken}`);
}

export function parseQuestions(value: unknown): Question[] {
	const invalid = () =>
		new HttpError(
			400,
			`Questions must be a list of 1 to ${QUESTION_LIMIT}, each with a distinct ask id and 2 to 4 distinct choice keys from a to d.`,
		);
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > QUESTION_LIMIT
	)
		throw invalid();
	const seen = new Set<string>();
	return value.map((item: unknown) => {
		if (typeof item !== "object" || item === null) throw invalid();
		const {
			askId,
			choices,
			allowText = false,
		} = item as Record<string, unknown>;
		if (
			typeof askId !== "string" ||
			!ASK_ID.test(askId) ||
			seen.has(askId) ||
			!Array.isArray(choices) ||
			choices.length < 2 ||
			choices.length > 4 ||
			!choices.every((key) => typeof key === "string" && KEYS.includes(key)) ||
			new Set(choices).size !== choices.length ||
			typeof allowText !== "boolean"
		)
			throw invalid();
		seen.add(askId);
		return { askId, choices: [...choices] as string[], allowText };
	});
}

const objectKey = (shareId: string, askId: string) =>
	`answers/${shareId}/${askId}.json`;

function allowedOrigin(request: Request): string | undefined {
	const origin = request.headers.get("Origin");
	// A page share is served with CSP sandbox, so its own requests carry the
	// opaque origin "null"; the bearer answer token is what authorizes them.
	if (origin === "null" || origin === new URL(request.url).origin)
		return origin;
}

function withCors(result: Response, origin: string): Response {
	const cors = new Response(result.body, result);
	cors.headers.set("Access-Control-Allow-Origin", origin);
	cors.headers.set("Vary", "Origin");
	return cors;
}

function wellFormed(text: string): boolean {
	try {
		encodeURIComponent(text);
		return true;
	} catch {
		return false;
	}
}

function cleanText(value: unknown): string | undefined {
	if (value === undefined || value === null) return;
	if (typeof value !== "string")
		throw new HttpError(400, "The written answer must be text.");
	if (encoder.encode(value).length > TEXT_LIMIT)
		throw new HttpError(
			413,
			`The written answer is limited to ${TEXT_LIMIT} bytes.`,
		);
	if (/[\u202a-\u202e\u2066-\u2069]/.test(value))
		throw new HttpError(400, "The written answer has control characters.");
	// zm cleans answer text this way before storing it; doing it here keeps the
	// relay's comparison with what zm holds exact.
	const text = value
		.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.trim();
	if (
		!wellFormed(text) ||
		[...text].some((char) => {
			const code = char.charCodeAt(0);
			return (
				(code < 32 && char !== "\n" && char !== "\t") ||
				(code >= 127 && code <= 159) ||
				(code >= 0x202a && code <= 0x202e) ||
				(code >= 0x2066 && code <= 0x2069)
			);
		})
	)
		throw new HttpError(400, "The written answer has control characters.");
	return text || undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
				await boundedBody(request, BODY_LIMIT),
			),
		);
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "Invalid JSON request.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new HttpError(400, "Invalid JSON request.");
	return value as Record<string, unknown>;
}

async function stored(
	env: AnswerEnv,
	shareId: string,
	askId: string,
): Promise<{ answer: Answer; etag: string } | undefined> {
	const object = await env.MEDIA.get(objectKey(shareId, askId));
	if (!object) return;
	return { answer: await object.json<Answer>(), etag: object.etag };
}

function view(answer: Answer) {
	return {
		askId: answer.askId,
		key: answer.key ?? null,
		text: answer.text ?? null,
		revision: answer.revision,
		answeredAt: answer.answeredAt,
		recorded: answer.recordedAt !== undefined,
	};
}

async function submit(
	request: Request,
	env: AnswerEnv,
	share: AnswerShare,
	questions: Question[],
): Promise<Response> {
	const body = await readBody(request);
	const question = questions.find((item) => item.askId === body.askId);
	if (!question)
		throw new HttpError(400, "That question is not part of this page.");
	const key = body.key ?? undefined;
	if (
		key !== undefined &&
		(typeof key !== "string" ||
			!(question.choices.includes(key) || key === NEEDS_CONTEXT))
	)
		throw new HttpError(400, "That choice is not offered for this question.");
	const text = cleanText(body.text);
	if (text !== undefined && !question.allowText && key !== NEEDS_CONTEXT)
		throw new HttpError(400, "This question takes a choice only.");
	if (key === undefined && text === undefined)
		throw new HttpError(400, "Pick a choice or write an answer.");
	const earlier = await stored(env, share.id, question.askId);
	if (earlier?.answer.recordedAt !== undefined)
		throw new HttpError(
			409,
			"This answer has already been recorded and can no longer change.",
		);
	const answer: Answer = {
		shareId: share.id,
		askId: question.askId,
		...(key === undefined ? {} : { key }),
		...(text === undefined ? {} : { text }),
		revision: (earlier?.answer.revision ?? 0) + 1,
		answeredAt: Date.now(),
	};
	const written = await env.MEDIA.put(
		objectKey(share.id, question.askId),
		JSON.stringify(answer),
		{
			customMetadata: { state: "pending" },
			onlyIf: earlier
				? { etagMatches: earlier.etag }
				: { etagDoesNotMatch: "*" },
		},
	);
	if (!written)
		throw new HttpError(409, "This answer changed meanwhile. Try again.");
	return response(view(answer));
}

async function current(
	env: AnswerEnv,
	share: AnswerShare,
	questions: Question[],
): Promise<Response> {
	const answers = await Promise.all(
		questions.map((question) => stored(env, share.id, question.askId)),
	);
	return response({
		answers: answers.flatMap((item) => (item ? [view(item.answer)] : [])),
	});
}

export async function recipientAnswers(
	request: Request,
	env: AnswerEnv,
	shareId: string,
	load: () => Promise<AnswerShare>,
): Promise<Response> {
	const origin = allowedOrigin(request);
	if (!origin)
		throw new HttpError(403, "Answers are accepted only from the page itself.");
	try {
		if (request.method === "OPTIONS")
			return withCors(
				new Response(null, {
					status: 204,
					headers: {
						"Access-Control-Allow-Methods": "GET, POST",
						"Access-Control-Allow-Headers": "Authorization, Content-Type",
						"Access-Control-Max-Age": "600",
					},
				}),
				origin,
			);
		if (request.method !== "GET" && request.method !== "POST")
			throw new HttpError(405, "Method not allowed.");
		const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
		const limit = await env.ANSWER_LIMIT?.limit({ key: `${shareId} ${ip}` });
		if (limit?.success === false)
			throw new HttpError(429, "Too many answers at once. Wait a minute.");
		const share = await load();
		if (!share.ready || !share.questions?.length || !share.answerHash)
			throw new HttpError(404, "Share unavailable.");
		if (!(await equal(await hash(bearer(request)), share.answerHash)))
			throw new HttpError(401, "Open the full link to answer.");
		const result =
			request.method === "POST"
				? await submit(request, env, share, share.questions)
				: await current(env, share, share.questions);
		return withCors(result, origin);
	} catch (error) {
		if (error instanceof HttpError)
			return withCors(response({ error: error.message }, error.status), origin);
		throw error;
	}
}

async function list(env: AnswerEnv, url: URL): Promise<Response> {
	const share = url.searchParams.get("share");
	const state = url.searchParams.get("state") ?? "pending";
	const after = url.searchParams.get("after");
	if (
		(share !== null && !SHARE_ID.test(share)) ||
		(after !== null && !ANSWER_KEY.test(after)) ||
		!["pending", "recorded", "all"].includes(state)
	)
		throw new HttpError(
			400,
			"Use share=ID, state=pending, recorded or all, and after=the next value from a previous page.",
		);
	const prefix = share ? `answers/${share}/` : "answers/";
	const keys: string[] = [];
	let cursor: string | undefined;
	let more = false;
	do {
		const page = await env.MEDIA.list({
			prefix,
			cursor,
			...(after && !cursor ? { startAfter: after } : {}),
			include: ["customMetadata"],
		});
		const objects = page.objects;
		for (let i = 0; i < objects.length; i += 1) {
			const object = objects[i];
			if (state !== "all" && object.customMetadata?.state !== state) continue;
			if (keys.length === LIST_LIMIT) {
				more = true;
				break;
			}
			keys.push(object.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
		if (more) break;
	} while (cursor);
	const answers = await Promise.all(
		keys.map(async (key) => {
			const object = await env.MEDIA.get(key);
			return object ? await object.json<Answer>() : undefined;
		}),
	);
	return response({
		answers: answers.flatMap((answer) =>
			answer
				? [
						{
							shareId: answer.shareId,
							...view(answer),
							recordedAt: answer.recordedAt ?? null,
						},
					]
				: [],
		),
		more,
		next: more ? (keys.at(-1) ?? null) : null,
	});
}

async function markRecorded(
	request: Request,
	env: AnswerEnv,
	shareId: string,
	askId: string,
): Promise<Response> {
	const { revision } = await readBody(request);
	if (typeof revision !== "number" || !Number.isSafeInteger(revision))
		throw new HttpError(400, "Name the revision you recorded.");
	const earlier = await stored(env, shareId, askId);
	if (!earlier) throw new HttpError(404, "No answer for that question.");
	if (earlier.answer.recordedAt !== undefined) {
		if (earlier.answer.revision !== revision)
			throw new HttpError(409, "A different revision was recorded.");
		return response({
			shareId,
			...view(earlier.answer),
			recordedAt: earlier.answer.recordedAt,
		});
	}
	if (earlier.answer.revision !== revision)
		return response(
			{
				error: "The answer changed after you read it. Read it again.",
				answer: { shareId, ...view(earlier.answer) },
			},
			409,
		);
	const answer = { ...earlier.answer, recordedAt: Date.now() };
	const written = await env.MEDIA.put(
		objectKey(shareId, askId),
		JSON.stringify(answer),
		{
			customMetadata: { state: "recorded" },
			onlyIf: { etagMatches: earlier.etag },
		},
	);
	if (!written)
		throw new HttpError(
			409,
			"The answer changed after you read it. Read it again.",
		);
	return response({ shareId, ...view(answer), recordedAt: answer.recordedAt });
}

export async function ownerAnswers(
	request: Request,
	env: AnswerEnv,
	url: URL,
): Promise<Response> {
	if (url.pathname === "/api/v1/answers" && request.method === "GET")
		return list(env, url);
	const match =
		/^\/api\/v1\/answers\/([a-f0-9-]{36})\/([0-9A-Za-z_-]{1,64})\/recorded$/.exec(
			url.pathname,
		);
	if (match && request.method === "POST")
		return markRecorded(request, env, match[1], match[2]);
	if (match || url.pathname === "/api/v1/answers")
		throw new HttpError(405, "Method not allowed.");
	throw new HttpError(404, "Not found.");
}
