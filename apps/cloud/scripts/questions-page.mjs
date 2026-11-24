#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEYS = ["a", "b", "c", "d"];
export const NEEDS_CONTEXT_NOTE =
	"The contact could not answer this on the page.";
const ASK_ID = /^[0-9A-Za-z_][0-9A-Za-z_-]{0,63}$/;
const BLOCKED =
	/<!--|<\s*\/?\s*(script|iframe|frame|object|embed|base|meta|link|form|plaintext|xmp|textarea|noscript|noembed|noframes|title|style|select|template)\b/i;

const escape = (value) =>
	String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

function text(value, name, limit, optional = false) {
	if (optional && (value === undefined || value === null || value === ""))
		return "";
	if (typeof value !== "string" || !value.trim() || value.length > limit)
		throw new Error(`${name} must be text of 1 to ${limit} characters.`);
	return value.trim();
}

function fragment(value, name) {
	if (value === undefined || value === null || value === "") return "";
	if (typeof value !== "string" || value.length > 200_000)
		throw new Error(
			`${name} must be an HTML string of at most 200,000 characters.`,
		);
	if (BLOCKED.test(value))
		throw new Error(
			`${name} may not contain comments or script, frame, object, embed, base, meta, link, form, plaintext, xmp, textarea, noscript, title, style, select or template tags.`,
		);
	return value;
}

export function validate(spec) {
	if (typeof spec !== "object" || spec === null)
		throw new Error("The spec must be a JSON object.");
	const questions = spec.questions;
	if (
		!Array.isArray(questions) ||
		questions.length < 1 ||
		questions.length > 20
	)
		throw new Error("questions must list 1 to 20 questions.");
	const seen = new Set();
	return {
		title: text(spec.title, "title", 200),
		intro: text(spec.intro, "intro", 4000, true),
		html: fragment(spec.html, "html"),
		questions: questions.map((item, index) => {
			const where = `questions[${index}]`;
			if (typeof item !== "object" || item === null)
				throw new Error(`${where} must be an object.`);
			if (typeof item.askId !== "string" || !ASK_ID.test(item.askId))
				throw new Error(`${where}.askId must be a zm ask id.`);
			if (seen.has(item.askId))
				throw new Error(`${where}.askId appears twice.`);
			seen.add(item.askId);
			if (
				!Array.isArray(item.choices) ||
				item.choices.length < 2 ||
				item.choices.length > 4
			)
				throw new Error(`${where}.choices must list 2 to 4 choices.`);
			const keys = new Set();
			const choices = item.choices.map((choice, position) => {
				const key = choice?.key ?? KEYS[position];
				if (!KEYS.includes(key) || keys.has(key))
					throw new Error(
						`${where}.choices keys must be distinct, from a to d.`,
					);
				keys.add(key);
				return {
					key,
					label: text(
						choice?.label,
						`${where}.choices[${position}].label`,
						400,
					),
				};
			});
			const recommended = item.recommended ?? item.recommend ?? "";
			if (recommended && !keys.has(recommended))
				throw new Error(`${where}.recommended must be one of its choice keys.`);
			if (item.allowText !== undefined && typeof item.allowText !== "boolean")
				throw new Error(`${where}.allowText must be true or false.`);
			return {
				askId: item.askId,
				question: text(item.question, `${where}.question`, 2000),
				choices,
				recommended,
				allowText: item.allowText ?? true,
				html: fragment(item.html, `${where}.html`),
			};
		}),
	};
}

export function binding(spec) {
	return validate(spec).questions.map((question) => ({
		askId: question.askId,
		choices: question.choices.map((choice) => choice.key),
		allowText: question.allowText,
	}));
}

const STYLE = `*{box-sizing:border-box}
body{margin:0;font:17px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d1d1f;background:#f5f5f7}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5em;line-height:1.2;margin:8px 0 12px}
.intro{white-space:pre-wrap;margin:0 0 16px}
.notice{background:#fff4e5;border:1px solid #f0b45a;border-radius:10px;padding:12px;margin:0 0 16px}
.notice[hidden]{display:none}
section.q{background:#fff;border-radius:14px;padding:16px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{font-weight:600;font-size:1.05em;padding:0;margin:0 0 10px;white-space:pre-wrap}
.extra{overflow-x:auto;margin:0 0 12px}
.extra table{border-collapse:collapse;font-size:.92em}
.extra td,.extra th{border:1px solid #d2d2d7;padding:6px 8px;text-align:left;vertical-align:top}
label.choice{display:flex;gap:12px;align-items:flex-start;padding:12px;margin:8px 0;border:1px solid #d2d2d7;border-radius:10px;cursor:pointer;min-height:48px}
label.choice:has(input:checked){border-color:#0071e3;background:#eef6ff}
label.choice input{width:22px;height:22px;margin:1px 0 0;flex:none}
.key{font-weight:600;text-transform:uppercase}
.tag{display:inline-block;font-size:.78em;background:#e8f5e9;color:#1b5e20;border-radius:6px;padding:1px 6px;margin-left:6px}
.cant{color:#515154}
textarea{width:100%;min-height:84px;font:inherit;padding:10px;border:1px solid #d2d2d7;border-radius:10px;margin-top:8px}
.row{display:flex;gap:12px;align-items:center;margin-top:8px;flex-wrap:wrap}
button{font:inherit;padding:10px 16px;border-radius:10px;border:0;background:#0071e3;color:#fff;min-height:44px}
button:disabled{background:#a1a1a6}
.status{font-size:.92em;color:#515154}
.status.saved{color:#1b7f3b;font-weight:600}
.status.error{color:#b00020}
.count{font-size:.85em;color:#86868b}`;

// One constant script, so the server's per-script hash never depends on the
// questions; everything it needs is read from the markup.
const SCRIPT = `(function(){
var token=(/(?:^#|&)answer=([0-9a-f]{64})(?:&|$)/.exec(location.hash)||[])[1];
var endpoint=location.pathname.replace(/\\/page$/,"/answers");
var sections=[].slice.call(document.querySelectorAll("section.q"));
function status(s,text,kind){var el=s.querySelector(".status");el.textContent=text;el.className="status"+(kind?" "+kind:"");}
function lock(s,locked){[].forEach.call(s.querySelectorAll("input,textarea,button"),function(el){el.disabled=locked;});}
function call(method,body){return fetch(endpoint,{method:method,credentials:"omit",headers:body?{"Authorization":"Bearer "+token,"Content-Type":"application/json"}:{"Authorization":"Bearer "+token},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return{};}).then(function(j){if(!r.ok){var e=new Error(j.error||"Could not save. Try again.");e.status=r.status;throw e;}return j;});});}
function show(s,a){if(a.key){var input=s.querySelector('input[value="'+a.key+'"]');if(input)input.checked=true;}var box=s.querySelector("textarea");if(box&&a.text!==null&&document.activeElement!==box)box.value=a.text;if(a.recorded){lock(s,true);status(s,"Saved and received. Thank you.","saved");}else status(s,"Saved","saved");}
function save(s){var picked=s.querySelector("input:checked");var box=s.querySelector("textarea");var text=box?box.value.trim():"";if(!picked&&!text){status(s,"Pick a choice or write an answer.","error");return;}var body={askId:s.dataset.ask};if(picked)body.key=picked.value;if(text)body.text=text;status(s,"Saving\\u2026");call("POST",body).then(function(a){show(s,a);}).catch(function(e){if(e.status===409)lock(s,true);status(s,e.message,"error");});}
sections.forEach(function(s){
[].forEach.call(s.querySelectorAll("input[type=radio]"),function(input){input.addEventListener("change",function(){save(s);});});
var box=s.querySelector("textarea");var button=s.querySelector("button");var count=s.querySelector(".count");
if(box){box.addEventListener("input",function(){var n=new TextEncoder().encode(box.value).length;count.textContent=n+" / 2000";status(s,"Not saved yet");});}
if(button)button.addEventListener("click",function(){save(s);});
});
if(!token){document.getElementById("notice").hidden=false;sections.forEach(function(s){lock(s,true);});return;}
call("GET").then(function(r){(r.answers||[]).forEach(function(a){var s=sections.filter(function(x){return x.dataset.ask===a.askId;})[0];if(s)show(s,a);});}).catch(function(e){document.getElementById("notice").textContent=e.message;document.getElementById("notice").hidden=false;});
})();`;

export function render(spec) {
	const page = validate(spec);
	const questions = page.questions
		.map((question, index) => {
			const name = `q${index}`;
			const choices = question.choices
				.map(
					(choice) =>
						`<label class="choice"><input type="radio" name="${name}" value="${choice.key}"><span><span class="key">${choice.key})</span> ${escape(choice.label)}${choice.key === question.recommended ? '<span class="tag">Suggested</span>' : ""}</span></label>`,
				)
				.join("\n");
			const cant = `<label class="choice cant"><input type="radio" name="${name}" value="needs_context"><span>I can't answer this${question.allowText ? " (say why below)" : ""}</span></label>`;
			const box = question.allowText
				? `<textarea maxlength="2000" aria-label="Your answer in your own words" placeholder="Anything to add? (optional)"></textarea>`
				: "";
			const row = `<div class="row">${question.allowText ? '<button type="button">Save note</button>' : ""}<span class="status" role="status" aria-live="polite"></span>${question.allowText ? '<span class="count"></span>' : ""}</div>`;
			return `<section class="q" data-ask="${escape(question.askId)}"><fieldset><legend>${index + 1}. ${escape(question.question)}</legend>
${question.html ? `<div class="extra">${question.html}</div>\n` : ""}${choices}
${cant}
${box}${row}</fieldset></section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)}</title>
<style>${STYLE}</style></head><body><main>
<h1>${escape(page.title)}</h1>
${page.intro ? `<p class="intro">${escape(page.intro)}</p>\n` : ""}<p class="notice" id="notice" hidden>Open the full link from your message to answer these questions.</p>
<p class="intro">Each answer saves when you tap a choice. You can change it until it has been received.</p>
${page.html ? `<div class="extra">${page.html}</div>\n` : ""}${questions}
</main><script>${SCRIPT}</script></body></html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [input, flag, output] = process.argv.slice(2);
	if (!input || (flag && flag !== "-o") || (flag && !output)) {
		console.error("Usage: questions-page.mjs <spec.json> [-o page.html]");
		process.exit(2);
	}
	try {
		const html = render(JSON.parse(readFileSync(input, "utf8")));
		if (output) writeFileSync(output, html);
		else process.stdout.write(html);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
