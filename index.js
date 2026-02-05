import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { google } from "googleapis";
import * as cheerio from "cheerio";

// =========================
// 設定
// =========================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "每日新聞";

const GEMINI_MODEL = "gemini-2.0-flash-lite";
const TIMEZONE = "Asia/Taipei";
const MAX_FULLTEXT_LENGTH = 20000;
const GEMINI_MAX_RETRY = 3; // 稍微增加重試次數
const SLEEP_MS = 4500; // 提高延遲至 4.5 秒，徹底避開免費版 15 RPM 限制

// =========================
// CNA RSS 配置
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
// Google Sheets API
// =========================

async function getSheetClient() {
	const auth = new google.auth.GoogleAuth({
		credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	});
	return google.sheets({ version: "v4", auth });
}

async function getExistingLinks(sheets) {
	try {
		const res = await sheets.spreadsheets.values.get({
			spreadsheetId: SHEET_ID,
			range: `${SHEET_NAME}!E2:E`,
		});
		return new Set((res.data.values || []).flat());
	} catch (e) {
		console.log("讀取現有連結失敗或工作表為空");
		return new Set();
	}
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
	console.log("開始執行新聞爬取任務...");
	const sheets = await getSheetClient();
	const existingLinks = await getExistingLinks(sheets);

	// 取得台灣日期
	const today = new Date(new Date().getTime() + 8 * 3600000)
		.toISOString()
		.slice(0, 10);
	console.log(`目標日期: ${today}`);

	for (const cfg of CNA_RSS_CONFIG) {
		console.log(`正在抓取 [${cfg.type}] 類別...`);
		try {
			const rssResponse = await fetch(cfg.url);
			const rssText = await rssResponse.text();
			const parsed = await parseStringPromise(rssText);
			const items = parsed.rss.channel[0].item || [];

			for (const item of items) {
				const link = item.link[0];
				if (!link || existingLinks.has(link)) continue;

				const pubDate = new Date(item.pubDate[0])
					.toISOString()
					.slice(0, 10);
				if (pubDate !== today) continue;

				const title = item.title[0];
				console.log(`處理中: ${title}`);

				const fullText = await fetchCnaArticleText(link);

				let summaryResult;
				if (!fullText || !isLikelyCnaArticleText(fullText)) {
					summaryResult = { status: "no_text_or_invalid" };
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
					fullText || "(無法擷取全文)",
				]);

				existingLinks.add(link);
				// 強制延遲，確保不衝撞 API 頻率限制
				await sleep(SLEEP_MS);
			}
		} catch (err) {
			console.error(`處理類別 ${cfg.type} 時發生錯誤:`, err.message);
		}
	}
	console.log("任務完成");
}

// =========================
// 文本處理工具
// =========================

function cleanText(text) {
	if (!text) return "";
	return text
		.replace(/中央社「一手新聞」\s*app/gi, "")
		.replace(
			/本網站之文字、圖片及影音，非經授權，不得轉載、公開播送或公開傳輸及利用。/g,
			"",
		)
		.replace(/（編輯：.*?）\d+$/g, "")
		.replace(/延伸閱讀.*$/gm, "")
		.replace(/相關新聞.*$/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchCnaArticleText(url) {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		if (!res.ok) return "";
		const html = await res.text();
		const $ = cheerio.load(html);

		let rawText = "";
		const selectors = [
			"div.paragraph",
			"div.article-body",
			"div.article-content",
		];
		for (const sel of selectors) {
			const found = $(sel);
			if (found.length > 0) {
				found.each((_, el) => {
					rawText += $(el).text() + "\n";
				});
				break;
			}
		}

		if (!rawText) {
			const m = html.match(/"articleBody":"([\s\S]*?)"/i);
			if (m) rawText = decodeJsonText(m[1]);
		}

		return cleanText(rawText).substring(0, MAX_FULLTEXT_LENGTH);
	} catch (e) {
		return "";
	}
}

function isLikelyCnaArticleText(text) {
	if (!text || text.length < 50) return false;
	const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
	return chineseChars.length / text.length > 0.25;
}

function decodeJsonText(s) {
	return s
		.replace(/\\"/g, '"')
		.replace(/\\n/g, "\n")
		.replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
			String.fromCharCode(parseInt(h, 16)),
		);
}

// =========================
// Gemini 摘要 (含 429 退避邏輯)
// =========================

async function summarizeWithRetry(text) {
	let wait = 6000;
	for (let i = 0; i < GEMINI_MAX_RETRY; i++) {
		try {
			const s = await callGemini(text);
			if (s && s.title && Array.isArray(s.points)) {
				return { status: "success", summary: s };
			}
		} catch (e) {
			if (e.message === "429") {
				console.log(`觸發 429 限制，等待 ${wait / 1000} 秒後重試...`);
				await sleep(wait);
				wait *= 2;
				continue;
			}
			console.error(`Gemini 錯誤: ${e.message}`);
			break;
		}
	}
	return { status: "api_error" };
}

async function callGemini(text) {
	const prompt = `你是專業的新聞編輯。請摘要以下內容，並忽略任何關於 App 下載、版權聲明等文字。
  
【格式】：必須回傳純 JSON，不要 Markdown：
{ "title": "標題", "points": ["點1", "點2", "點3"] }

內容：\n${text}`;

	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
		},
	);

	if (res.status === 429) throw new Error("429");
	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	const json = await res.json();
	let raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
	raw = raw.replace(/```json|```/g, "").trim();
	return JSON.parse(raw);
}

function formatSummary(s) {
	return `${s.title}\n1. ${s.points[0] || ""}\n2. ${s.points[1] || ""}\n3. ${s.points[2] || ""}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch(console.error);
