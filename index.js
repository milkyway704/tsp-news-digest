import fetch from "node-fetch";
import cheerio from "cheerio";
import { parseStringPromise } from "xml2js";
import { google } from "googleapis";

// =========================
// 設定
// =========================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "每日新聞";

const GEMINI_MODEL = "gemini-2.0-flash-lite";
const TIMEZONE = "Asia/Taipei";
const MAX_FULLTEXT_LENGTH = 20000;
const GEMINI_MAX_RETRY = 2;
const SLEEP_MS = 1000;

// =========================
// CNA RSS
// =========================

const CNA_RSS_CONFIG = [
	{ type: "政治", url: "https://feeds.feedburner.com/rsscna/politics" },
	{ type: "國際", url: "https://feeds.feedburner.com/rsscna/intworld" },
	{ type: "兩岸", url: "https://feeds.feedburner.com/rsscna/mainland" },
	{ type: "產經證券", url: "https://feeds.feedburner.com/rsscna/finance" },
	{ type: "科技", url: "https://feeds.feedburner.com/rsscna/technology" },
	{ type: "生活", url: "https://feeds.feedburner.com/rsscna/lifehealth" },
	{ type: "社會", url: "https://feeds.feedburner.com/rsscna/social" },
	{ type: "地方", url: "https://feeds.feedburner.com/rsscna/local" },
];

// =========================
// Google Sheets
// =========================

async function getSheetClient() {
	const auth = new google.auth.GoogleAuth({
		credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	});

	return google.sheets({ version: "v4", auth });
}

async function getExistingLinks(sheets) {
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: `${SHEET_NAME}!E2:E`,
	});

	return new Set((res.data.values || []).flat());
}

async function appendRow(sheets, row) {
	await sheets.spreadsheets.values.append({
		spreadsheetId: SHEET_ID,
		range: `${SHEET_NAME}!A:G`,
		valueInputOption: "RAW",
		requestBody: { values: [row] },
	});
}

// =========================
// 主流程
// =========================

async function main() {
	const sheets = await getSheetClient();
	const existingLinks = await getExistingLinks(sheets);
	const today = new Date().toISOString().slice(0, 10);

	for (const cfg of CNA_RSS_CONFIG) {
		const rss = await fetch(cfg.url).then((r) => r.text());
		const parsed = await parseStringPromise(rss);
		const items = parsed.rss.channel[0].item || [];

		for (const item of items) {
			const link = item.link[0];
			if (!link || existingLinks.has(link)) continue;

			const pubDate = new Date(item.pubDate[0])
				.toISOString()
				.slice(0, 10);
			if (pubDate !== today) continue;

			const title = item.title[0];
			const fullText = await fetchCnaArticleText(link);

			let summaryResult;
			if (!fullText) {
				summaryResult = { status: "no_text" };
			} else {
				summaryResult = await summarizeWithRetry(fullText);
			}

			const summaryText =
				summaryResult.status === "success"
					? formatSummary(summaryResult.summary)
					: `AI摘要失敗[${summaryResult.status}]，請手動處理`;

			await appendRow(sheets, [
				today,
				"中央社",
				cfg.type,
				title,
				link,
				summaryText,
				fullText,
			]);

			existingLinks.add(link);
			await sleep(SLEEP_MS);
		}
	}
}

main().catch(console.error);

// =========================
// CNA 正文擷取（hybrid）
// =========================

async function fetchCnaArticleText(url) {
	const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
	if (!res.ok) return "";

	const html = await res.text();

	// ① paragraph / article-body
	let text = extract(html, ["div.paragraph", "div.article-body"]);

	// ② JSON articleBody
	if (!text) {
		const m = html.match(/"articleBody":"([\s\S]*?)"/i);
		if (m) {
			text = decodeJsonText(m[1]);
		}
	}

	// ③ article-content
	if (!text) {
		text = extract(html, ["div.article-content"]);
	}

	// ④ video fallback
	if (!text && /video|iframe/i.test(html)) {
		text = extract(html, ["p"]);
	}

	if (!text) return "";

	text = text.substring(0, MAX_FULLTEXT_LENGTH);
	return isLikelyCnaArticle(text) ? text : "";
}

function extract(html, selectors) {
	const $ = cheerio.load(html);
	let text = "";

	for (const sel of selectors) {
		$(sel).each((_, el) => {
			text += $(el).text() + "\n";
		});
	}
	return text.trim();
}

function decodeJsonText(s) {
	return s
		.replace(/\\"/g, '"')
		.replace(/\\n/g, "\n")
		.replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
			String.fromCharCode(parseInt(h, 16)),
		)
		.trim();
}

function isLikelyCnaArticle(text) {
	const chinese = text.match(/[\u4e00-\u9fff]/g) || [];
	if (chinese.length / text.length < 0.25) return false;
	return true;
}

// =========================
// Gemini
// =========================

async function summarizeWithRetry(text) {
	let wait = 3000;

	for (let i = 0; i < GEMINI_MAX_RETRY; i++) {
		try {
			const s = await callGemini(text);
			if (isValidSummary(s)) {
				return { status: "success", summary: s };
			}
			return { status: "empty" };
		} catch {
			await sleep(wait);
			wait *= 2;
		}
	}
	return { status: "api_error" };
}

async function callGemini(text) {
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text }] }],
			}),
		},
	);

	if (res.status === 429) throw new Error("429");

	const json = await res.json();
	let raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
	raw = raw.replace(/```json|```/g, "");
	return JSON.parse(raw);
}

function isValidSummary(s) {
	return s && s.title && Array.isArray(s.points);
}

function formatSummary(s) {
	return `${s.title}
1. ${s.points[0] || ""}
2. ${s.points[1] || ""}
3. ${s.points[2] || ""}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
