import { google } from "googleapis";
import fetch from "node-fetch";

// =========================
// 設定
// =========================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "每日新聞";
const GEMINI_MODEL = "gemini-2.0-flash-lite";

const RETRY_TARGET_TEXT = "AI摘要失敗";
const MAX_RETRY_PER_RUN = 30; // 稍微放寬數量
const SLEEP_MS = 5000; // 重試間隔拉長，避開尖峰

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
	console.log("開始執行摘要重試任務...");
	const sheets = await getSheetClient();

	// 1. 讀取現有資料
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: `${SHEET_NAME}!A:G`,
	});

	const rows = res.data.values;
	if (!rows || rows.length <= 1) {
		console.log("工作表為空，無需重試。");
		return;
	}

	let retriedCount = 0;

	// 從第 2 列開始 (Index 1)
	for (let i = 1; i < rows.length; i++) {
		if (retriedCount >= MAX_RETRY_PER_RUN) break;

		const summaryCell = rows[i][5] || ""; // F 欄：摘要
		const fullText = rows[i][6] || ""; // G 欄：全文

		if (summaryCell.includes(RETRY_TARGET_TEXT) && fullText.length > 50) {
			console.log(`正在重試第 ${i + 1} 列...`);

			const result = await callGemini(fullText);

			if (result.status === "success") {
				const formattedSummary = formatSummary(result.summary);

				// 更新 Sheet 中特定的儲存格 (F 欄是第 6 欄)
				await sheets.spreadsheets.values.update({
					spreadsheetId: SHEET_ID,
					range: `${SHEET_NAME}!F${i + 1}`,
					valueInputOption: "RAW",
					requestBody: { values: [[formattedSummary]] },
				});
				console.log(`第 ${i + 1} 列更新成功！`);
			} else {
				console.log(`第 ${i + 1} 列重試依然失敗: ${result.status}`);
			}

			retriedCount++;
			await new Promise((r) => setTimeout(r, SLEEP_MS));
		}
	}
	console.log(`重試任務結束，共處理 ${retriedCount} 則。`);
}

async function callGemini(text) {
	const prompt = `你是專業的新聞編輯。請摘要以下內容。回傳純 JSON 格式：
{ "title": "標題", "points": ["重點1", "重點2", "重點3"] }
新聞內容：\n${text}`;

	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
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

function formatSummary(s) {
	return `${s.title}\n1. ${s.points[0] || ""}\n2. ${s.points[1] || ""}\n3. ${s.points[2] || ""}`;
}

retryFailedSummaries().catch(console.error);
