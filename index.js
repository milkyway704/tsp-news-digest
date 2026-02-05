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
const GEMINI_MAX_RETRY = 2;
const SLEEP_MS = 1000;

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
				await sleep(SLEEP_MS);
			}
		} catch (err) {
			console.error(`處理類別 ${cfg.type} 時發生錯誤:`, err.message);
		}
	}
	console.log("任務完成");
}

// =========================
// 文本清洗工具
// =========================

function cleanText(text) {
	if (!text) return "";
	return (
		text
			// 移除中央社版權宣告與 App 推廣
			.replace(/中央社「一手新聞」\s*app/gi, "")
			.replace(
				/本網站之文字、圖片及影音，非經授權，不得轉載、公開播送或公開傳輸及利用。/g,
				"",
			)
			// 移除文章末尾的編輯資訊與代碼（例如：1150205）
			.replace(/（編輯：.*?）\d+$/g, "")
			// 移除常見的「相關新聞」與「延伸閱讀」整行文字（避免觸發過濾）
			.replace(/延伸閱讀.*$/gm, "")
			.replace(/相關新聞.*$/gm, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

// =========================
// 中央社正文擷取與過濾
// =========================

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

		// 重點：先清洗掉可能干擾判斷的「關鍵字」
		const cleaned = cleanText(rawText);
		return cleaned.substring(0, MAX_FULLTEXT_LENGTH);
	} catch (e) {
		return "";
	}
}

function isLikelyCnaArticleText(text) {
	if (!text || text.length < 50) return false;

	// 改良點：不再因為「延伸閱讀」關鍵字就整篇丟棄
	// 改為檢查「中文密度」，只要這篇像人話，就送去摘要
	const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
	const ratio = chineseChars.length / text.length;

	return ratio > 0.25;
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
// Gemini 摘要
// =========================

async function summarizeWithRetry(text) {
	let wait = 3000;
	for (let i = 0; i < GEMINI_MAX_RETRY; i++) {
		try {
			const s = await callGemini(text);
			if (s && s.title && Array.isArray(s.points)) {
				return { status: "success", summary: s };
			}
		} catch (e) {
			console.log(`Gemini 重試中... (${i + 1})`);
			await sleep(wait);
			wait *= 2;
		}
	}
	return { status: "api_error" };
}

async function callGemini(text) {
	// 在 Prompt 中明確要求忽略版權文字
	const prompt = `你是專業的新聞編輯。請摘要以下內容，並忽略任何關於 App 下載、版權聲明、編輯名稱等無關文字。
  
【輸出格式】：必須回傳純 JSON 格式如下，不要包含 Markdown 標籤：
{ "title": "新聞標題", "points": ["重點1", "重點2", "重點3"] }

新聞內容：\n${text}`;

	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
		},
	);

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
