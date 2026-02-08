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

// 模型定義 (升級至 2.5 系列)
const PRIMARY_MODEL = "gemini-2.5-flash-lite";
const BACKUP_MODEL = "gemini-2.5-flash";

const TIMEZONE = "Asia/Taipei";
const MAX_FULLTEXT_LENGTH = 20000;
const SLEEP_MS = 5000; // 基礎間隔維持在 5 秒

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
	{ type: "文化", url: "https://feeds.feedburner.com/rsscna/culture" },
	{ type: "運動", url: "https://feeds.feedburner.com/rsscna/sport" },
	{ type: "娛樂", url: "https://feeds.feedburner.com/rsscna/stars" },
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
	console.log("開始執行新聞爬取任務 (Gemini 2.5 雙軌模式)...");
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
				console.log(`\n處理中: ${title}`);

				const fullText = await fetchCnaArticleText(link);

				let summaryResult;
				if (!fullText || !isLikelyCnaArticleText(fullText)) {
					summaryResult = { status: "no_text_or_invalid" };
				} else {
					// 使用新的階梯式摘要邏輯
					summaryResult = await summarizeStepwise(fullText);
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

				// 如果摘要成功，嘗試過濾並發送 Discord
				if (summaryResult.status === "success") {
					await sendToDiscord(
						summaryResult.summary,
						link,
						title,
						cfg.type,
					);
				}

				existingLinks.add(link);

				// 基礎延遲加上小抖動，防止規律性觸發限制
				const jitter = Math.random() * 2000;
				await sleep(SLEEP_MS + jitter);
			}
		} catch (err) {
			console.error(`處理類別 ${cfg.type} 時發生錯誤:`, err.message);
		}
	}
	console.log("\n任務完成");
}

// =========================
// 摘要核心邏輯 (階梯式)
// =========================

async function summarizeStepwise(text) {
	// 階段一：嘗試使用 Lite 模型
	console.log(`[嘗試 1] 使用 ${PRIMARY_MODEL}...`);
	let result = await callGemini(text, PRIMARY_MODEL);

	// 階段二：如果 429，冷卻 20 秒後嘗試標準 Flash 模型
	if (result.status === "429_limit") {
		console.warn(`⚠️ 觸發 429 限制，進入 20 秒強制冷卻...`);
		await sleep(20000);
		console.log(`[嘗試 2] 切換至備用模型 ${BACKUP_MODEL}...`);
		result = await callGemini(text, BACKUP_MODEL);
	}

	return result;
}

async function callGemini(text, model) {
	const prompt = `你是專業的新聞編輯。請摘要以下內容，並忽略任何關於 App 下載、版權聲明等文字。
  
【格式】：必須回傳純 JSON，不要 Markdown：
{ "title": "標題", "points": ["點1", "點2", "點3"] }

內容：\n${text}`;

	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
				}),
			},
		);

		if (res.status === 429) return { status: "429_limit" };
		if (!res.ok) return { status: `HTTP_${res.status}` };

		const json = await res.json();
		let raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
		raw = raw.replace(/```json|```/g, "").trim();
		return { status: "success", summary: JSON.parse(raw) };
	} catch (e) {
		return { status: "error" };
	}
}

// =========================
// 工具函式
// =========================

function formatSummary(s) {
	return `${s.title}\n1. ${s.points[0] || ""}\n2. ${s.points[1] || ""}\n3. ${s.points[2] || ""}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
		});
		if (!res.ok) return "";
		const html = await res.text();
		const $ = cheerio.load(html);

		let rawText = "";

		// 1. 標準選取器 (優先順序：paragraph > article-body > article-content)
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

		// 2. 如果還是沒抓到，嘗試 JSON-LD (articleBody)
		if (!rawText.trim()) {
			const m = html.match(/"articleBody":"([\s\S]*?)"/i);
			if (m) rawText = decodeJsonText(m[1]);
		}

		// 3. 【核心補強】針對影片新聞頁面 (fallback 到所有 <p> 標籤)
		// 許多影片頁面內容分散在多個 <p> 標籤中，沒有包裹在上述 div 內
		if (!rawText.trim()) {
			const isVideoPage = /<video|iframe|data-video/i.test(html);
			if (isVideoPage) {
				console.log("偵測為影片新聞頁面，使用替代抓取邏輯...");
				$("p").each((_, el) => {
					const txt = $(el).text().trim();
					// 排除過短或雜訊標籤
					if (txt.length > 10) {
						rawText += txt + "\n";
					}
				});
			}
		}

		return cleanText(rawText).substring(0, MAX_FULLTEXT_LENGTH);
	} catch (e) {
		console.error(`擷取全文失敗 (${url}):`, e.message);
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
// Discord 發送邏輯
// =========================
async function sendToDiscord(summary, link, title, type) {
	const configRaw = process.env.DISCORD_CONFIG;
	if (!configRaw) return;

	try {
		const discordConfigs = JSON.parse(configRaw);
		// 使用 Map 來儲存「哪些 Webhook 需要發送」，Key 是 Webhook URL，這能保證唯一性
		const targetWebhooks = new Map();

		for (const config of discordConfigs) {
			// 檢查這組配置中的關鍵字，只要有一個中，就記錄這個 Webhook
			const matchedKeyword = config.keywords.find(
				(k) => title.includes(k) || summary.title.includes(k),
			);

			if (matchedKeyword) {
				// 將該 Webhook 存入 Map，並記錄是哪個關鍵字觸發的（選第一個命中的即可）
				if (!targetWebhooks.has(config.webhook)) {
					targetWebhooks.set(config.webhook, matchedKeyword);
				}
			}
		}

		// 針對過濾後的每個唯一 Webhook 進行發送
		for (const [webhook, keyword] of targetWebhooks) {
			console.log(`🎯 命中關鍵字 [${keyword}]，準備發送到 Discord...`);

			const payload = {
				embeds: [
					{
						title: `📍 關鍵字動態：${keyword}`,
						description: `**${title}**\n\n${formatSummary(summary)}`,
						url: link,
						color: 5814783,
						footer: { text: "CNA News Bot" },
						timestamp: new Date().toISOString(),
					},
				],
			};

			await fetch(webhook, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		}
	} catch (e) {
		console.error("Discord 傳送失敗:", e.message);
	}
}

main().catch(console.error);
