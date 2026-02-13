import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { google } from "googleapis";
import * as cheerio from "cheerio";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "每日新聞";
const PRIMARY_MODEL = "gemini-2.5-flash-lite";
const BACKUP_MODEL = "gemini-2.5-flash";
const MAX_FULLTEXT_LENGTH = 20000;
const SLEEP_MS = 5000;

const NEWS_SOURCES = [
	{
		source: "CNA",
		type: "政治",
		url: "https://feeds.feedburner.com/rsscna/politics",
	},
	{
		source: "CNA",
		type: "國際",
		url: "https://feeds.feedburner.com/rsscna/intworld",
	},
	{
		source: "CNA",
		type: "兩岸",
		url: "https://feeds.feedburner.com/rsscna/mainland",
	},
	{
		source: "CNA",
		type: "產經證券",
		url: "https://feeds.feedburner.com/rsscna/finance",
	},
	{
		source: "CNA",
		type: "科技",
		url: "https://feeds.feedburner.com/rsscna/technology",
	},
	{
		source: "CNA",
		type: "生活",
		url: "https://feeds.feedburner.com/rsscna/lifehealth",
	},
	{
		source: "CNA",
		type: "社會",
		url: "https://feeds.feedburner.com/rsscna/social",
	},
	{
		source: "CNA",
		type: "地方",
		url: "https://feeds.feedburner.com/rsscna/local",
	},
	{
		source: "CNA",
		type: "文化",
		url: "https://feeds.feedburner.com/rsscna/culture",
	},
	{
		source: "CNA",
		type: "運動",
		url: "https://feeds.feedburner.com/rsscna/sport",
	},
	{
		source: "CNA",
		type: "娛樂",
		url: "https://feeds.feedburner.com/rsscna/stars",
	},
	{ source: "CDNS", type: "台南", url: "https://www.cdns.com.tw/feed" },
];

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
		return new Set();
	}
}

// 恢復為最穩定的附加模式
async function appendRow(sheets, row) {
	await sheets.spreadsheets.values.append({
		spreadsheetId: SHEET_ID,
		range: `${SHEET_NAME}!A1`,
		valueInputOption: "USER_ENTERED", // 確保日期格式正確，不帶單引號
		requestBody: { values: [row] },
	});
}

async function smartFetch(url) {
	const headers = {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
		"Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
		Referer: "https://www.google.com/",
	};
	return await fetch(url, { headers });
}

async function main() {
	console.log("開始執行新聞爬取任務 (穩定 Append 版)...");
	const sheets = await getSheetClient();
	const existingLinks = await getExistingLinks(sheets);

	const nowTW = new Date(new Date().getTime() + 8 * 3600000);
	const today = nowTW.toISOString().slice(0, 10);
	const yesterday = new Date(nowTW.getTime() - 86400000)
		.toISOString()
		.slice(0, 10);

	console.log(`目標日期: ${today} (容錯範圍: ${yesterday})`);

	for (const cfg of NEWS_SOURCES) {
		console.log(`正在抓取 [${cfg.source} - ${cfg.type}]...`);
		try {
			let rssResponse = await smartFetch(cfg.url);
			let rssText = await rssResponse.text();

			if (cfg.source === "CDNS" && rssResponse.status === 403) {
				rssResponse = await smartFetch("https://www.cdns.com.tw/feed/");
				rssText = await rssResponse.text();
			}

			if (!rssText.includes("<rss") && !rssText.includes("<channel"))
				continue;

			const parsed = await parseStringPromise(rssText);
			const channel =
				parsed.rss && parsed.rss.channel
					? parsed.rss.channel[0]
					: parsed.channel
						? parsed.channel[0]
						: null;
			if (!channel) continue;

			const items = channel.item || [];

			for (const item of items) {
				const link = item.link[0];
				const title = item.title[0];
				if (!link || existingLinks.has(link)) continue;

				// 時區校正：判斷新聞發布日期
				const pubDateUTC = new Date(item.pubDate[0]);
				const pubDateTW = new Date(pubDateUTC.getTime() + 8 * 3600000);
				const itemDateStr = pubDateTW.toISOString().slice(0, 10);

				if (itemDateStr !== today && itemDateStr !== yesterday)
					continue;

				if (cfg.source === "CDNS") {
					const categories = item.category
						? item.category.map((c) =>
								typeof c === "string" ? c : c._ || "",
							)
						: [];
					if (!categories.some((cat) => cat.includes("台南")))
						continue;
				}

				console.log(`\n處理中: ${title} (${itemDateStr})`);
				const fullText = await fetchArticleText(link);
				let summaryResult =
					fullText && isLikelyChineseText(fullText)
						? await summarizeStepwise(fullText)
						: { status: "no_text" };

				const summaryText =
					summaryResult.status === "success"
						? formatSummary(summaryResult.summary)
						: `AI摘要失敗[${summaryResult.status}]`;
				const displayName =
					cfg.source === "CDNS" ? "中華日報" : "中央社";

				// 寫入資料：附加到最後一列
				await appendRow(sheets, [
					itemDateStr,
					displayName,
					cfg.type,
					title,
					link,
					summaryText,
					fullText || "(無法擷取)",
				]);

				if (summaryResult.status === "success") {
					await sendToDiscord(
						summaryResult.summary,
						link,
						title,
						cfg.type,
						fullText,
					);
				}

				existingLinks.add(link);
				await new Promise((r) =>
					setTimeout(r, SLEEP_MS + Math.random() * 2000),
				);
			}
		} catch (err) {
			console.error(`處理 ${cfg.source} 時發生錯誤:`, err.message);
		}
	}
	console.log("\n任務完成");
}

async function summarizeStepwise(text) {
	let result = await callGemini(text, PRIMARY_MODEL);
	if (result.status === "429_limit") {
		await new Promise((r) => setTimeout(r, 20000));
		result = await callGemini(text, BACKUP_MODEL);
	}
	return result;
}

async function callGemini(text, model) {
	const prompt = `你是專業的新聞編輯。請摘要以下內容，回傳純 JSON：{ "title": "標題", "points": ["點1", "點2", "點3"] }\n內容：\n${text}`;
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
		const json = await res.json();
		let raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
		raw = raw.replace(/```json|```/g, "").trim();
		return { status: "success", summary: JSON.parse(raw) };
	} catch (e) {
		return { status: "error" };
	}
}

async function fetchArticleText(url) {
	try {
		const res = await smartFetch(url);
		if (!res.ok) return "";
		const html = await res.text();
		const $ = cheerio.load(html);
		let rawText = "";
		const selectors = [
			"div.paragraph",
			"div.entry-content",
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
		if (!rawText.trim()) {
			const m = html.match(/"articleBody":"([\s\S]*?)"/i);
			if (m) rawText = decodeJsonText(m[1]);
		}
		return cleanText(rawText).substring(0, MAX_FULLTEXT_LENGTH);
	} catch (e) {
		return "";
	}
}

function cleanText(text) {
	return text
		? text
				.replace(/中央社「一手新聞」\s*app/gi, "")
				.replace(
					/本網站之文字、圖片及影音，非經授權，不得轉載、公開播送或公開傳輸及利用。/g,
					"",
				)
				.replace(/\s+/g, " ")
				.trim()
		: "";
}

function decodeJsonText(s) {
	return s
		.replace(/\\"/g, '"')
		.replace(/\\n/g, "\n")
		.replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
			String.fromCharCode(parseInt(h, 16)),
		);
}

function isLikelyChineseText(text) {
	const chineseChars = (text || "").match(/[\u4e00-\u9fff]/g) || [];
	return chineseChars.length / (text.length || 1) > 0.25;
}

function formatSummary(s) {
	return `${s.title}\n1. ${s.points[0] || ""}\n2. ${s.points[1] || ""}\n3. ${s.points[2] || ""}`;
}

async function sendToDiscord(summaryObj, link, title, type, fullText = "") {
	const configRaw = process.env.DISCORD_CONFIG;
	if (!configRaw) return;
	try {
		const discordConfigs = JSON.parse(configRaw);
		const targetWebhooks = new Map();
		const summaryString = Array.isArray(summaryObj.points)
			? summaryObj.points.join(" ")
			: "";
		for (const config of discordConfigs) {
			if (
				config.targetTypes &&
				config.targetTypes.length > 0 &&
				!config.targetTypes.includes(type)
			)
				continue;
			const matchedKeyword = config.keywords.find(
				(k) =>
					title.includes(k) ||
					summaryString.includes(k) ||
					fullText.includes(k),
			);
			if (matchedKeyword)
				targetWebhooks.set(config.webhook, matchedKeyword);
		}
		for (const [webhook, keyword] of targetWebhooks) {
			const payload = {
				embeds: [
					{
						title: `📍 ${keyword}動態：${title}`,
						url: link,
						description: `**✨ 新聞摘要：**\n${summaryObj.points
							.slice(0, 3)
							.map((p, i) => `${i + 1}. ${p}`)
							.join("\n")}`,
						color: 3447003,
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
	} catch (e) {}
}

main().catch(console.error);
