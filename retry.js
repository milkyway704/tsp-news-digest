import { google } from "googleapis";
import fetch from "node-fetch";

// =========================
// 設定
// =========================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "每日新聞";

// 同步主程式模型
const PRIMARY_MODEL = "gemini-2.5-flash-lite";
const BACKUP_MODEL = "gemini-2.5-flash";

const RETRY_TARGET_TEXT = "AI摘要失敗";
const MAX_RETRY_PER_RUN = 20;
const BASE_SLEEP_MS = 8000;

// =========================
// Google Sheets Client
// =========================
async function getSheetClient() {
	const auth = new google.auth.GoogleAuth({
		credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	});
	return google.sheets({ version: "v4", auth });
}

// =========================
// 主流程
// =========================
async function retryFailedSummaries() {
	console.log("開始執行階梯式重試任務...");
	const sheets = await getSheetClient();

	// 讀取 A 到 G 欄位 (G 為全文)
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: `${SHEET_NAME}!A:G`,
	});

	const rows = res.data.values;
	if (!rows || rows.length <= 1) return;

	let retriedCount = 0;

	for (let i = 1; i < rows.length; i++) {
		if (retriedCount >= MAX_RETRY_PER_RUN) break;

		// 欄位索引：0:日期, 1:來源, 2:類別, 3:標題, 4:網址, 5:摘要, 6:全文
		const sourceName = rows[i][1] || "";
		const newsType = rows[i][2] || "";
		const title = rows[i][3] || "";
		const link = rows[i][4] || "";
		const summaryCell = rows[i][5] || "";
		const fullText = rows[i][6] || "";

		if (summaryCell.includes(RETRY_TARGET_TEXT) && fullText.length > 50) {
			console.log(`\n--- 重試處理: [${sourceName}] ${title} ---`);

			let finalResult = null;
			finalResult = await callGemini(fullText, PRIMARY_MODEL);

			if (finalResult.status === "429_limit") {
				console.log(`觸發 429，冷卻 20 秒後嘗試備用模型...`);
				await new Promise((r) => setTimeout(r, 20000));
				finalResult = await callGemini(fullText, BACKUP_MODEL);
			}

			if (finalResult.status === "success") {
				const formattedSummary = formatSummary(finalResult.summary);

				// 1. 更新試算表
				await sheets.spreadsheets.values.update({
					spreadsheetId: SHEET_ID,
					range: `${SHEET_NAME}!F${i + 1}`,
					valueInputOption: "RAW",
					requestBody: { values: [[formattedSummary]] },
				});

				// 2. 【新增】重試成功後，補發 Discord 推播
				// 這樣原本因為摘要失敗而沒發出的通知就能補上
				await sendToDiscord(
					finalResult.summary,
					link,
					title,
					newsType,
					fullText,
				);

				console.log(`✅ 第 ${i + 1} 列更新並補發 Discord 成功！`);
			} else {
				console.log(`❌ 第 ${i + 1} 列最終失敗: ${finalResult.status}`);
			}

			retriedCount++;
			await new Promise((r) =>
				setTimeout(r, BASE_SLEEP_MS + Math.random() * 4000),
			);
		}
	}
	console.log(`\n重試任務結束。`);
}

// =========================
// 補推 Discord 邏輯 (需與主程式 sendToDiscord 一致)
// =========================
async function sendToDiscord(summaryObj, link, title, type, fullText) {
	const configRaw = process.env.DISCORD_CONFIG;
	if (!configRaw) return;
	try {
		const discordConfigs = JSON.parse(configRaw);
		const points = summaryObj.points || [];
		const summaryString = points.join(" ");

		for (const config of discordConfigs) {
			// 類別檢查
			const isTargetType =
				!config.targetTypes ||
				config.targetTypes.length === 0 ||
				config.targetTypes.includes(type);
			if (!isTargetType) continue;

			// 關鍵字檢查
			const matchedKeyword = config.keywords.find(
				(k) =>
					title.includes(k) ||
					summaryString.includes(k) ||
					(fullText && fullText.includes(k)),
			);

			if (matchedKeyword) {
				const payload = {
					embeds: [
						{
							title: `📍 (重試補發) ${matchedKeyword}：${title}`,
							url: link,
							description: `**✨ 新聞摘要：**\n${points
								.slice(0, 3)
								.map((p, i) => `${i + 1}. ${p}`)
								.join("\n")}`,
							color: 16776960, // 黃色區分補發
							fields: [
								{ name: "新聞類別", value: type, inline: true },
							],
							timestamp: new Date().toISOString(),
						},
					],
				};
				await fetch(config.webhook, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
			}
		}
	} catch (e) {
		console.error("Discord 補發失敗:", e.message);
	}
}

async function callGemini(text, model) {
	const prompt = `你是專業的新聞編輯。請摘要以下內容，回傳純 JSON：
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

function formatSummary(s) {
	if (!s.points) return String(s);
	return `${s.title}\n1. ${s.points[0] || ""}\n2. ${s.points[1] || ""}\n3. ${s.points[2] || ""}`;
}

retryFailedSummaries().catch(console.error);
