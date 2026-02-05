import { google } from "googleapis";
import fetch from "node-fetch";

// =========================
// 設定
// =========================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "每日新聞";

const PRIMARY_MODEL = "gemini-2.0-flash-lite";
const BACKUP_MODEL = "gemini-1.5-flash";

const RETRY_TARGET_TEXT = "AI摘要失敗";
const MAX_RETRY_PER_RUN = 20;
const BASE_SLEEP_MS = 8000; // 基礎間隔提升至 8 秒，確保穩定

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
	console.log("開始執行階梯式重試任務（含 429 強制冷卻）...");
	const sheets = await getSheetClient();

	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SHEET_ID,
		range: `${SHEET_NAME}!A:G`,
	});

	const rows = res.data.values;
	if (!rows || rows.length <= 1) return;

	let retriedCount = 0;

	for (let i = 1; i < rows.length; i++) {
		if (retriedCount >= MAX_RETRY_PER_RUN) break;

		const summaryCell = rows[i][5] || "";
		const fullText = rows[i][6] || "";

		if (summaryCell.includes(RETRY_TARGET_TEXT) && fullText.length > 50) {
			console.log(`\n--- 正在處理第 ${i + 1} 列 ---`);

			let finalResult = null;

			// 【階段一】嘗試使用 2.0 Flash-Lite
			console.log(`[嘗試 1] 使用 ${PRIMARY_MODEL}...`);
			finalResult = await callGemini(fullText, PRIMARY_MODEL);

			// 【階段二】如果 429，強制進入長冷卻，再換模型
			if (finalResult.status === "429_limit") {
				console.warn(
					`⚠️ 觸發 429 限制。雖然 Quota 充足，但可能觸發併發保護。`,
				);
				console.log(`系統強制冷卻 20 秒，請稍候...`);
				await new Promise((r) => setTimeout(r, 20000)); // 強制重置流量計數器

				console.log(`[嘗試 2] 切換至備用模型 ${BACKUP_MODEL}...`);
				finalResult = await callGemini(fullText, BACKUP_MODEL);
			}

			// 最終結果寫入處理
			if (finalResult.status === "success") {
				const formattedSummary = formatSummary(finalResult.summary);
				await sheets.spreadsheets.values.update({
					spreadsheetId: SHEET_ID,
					range: `${SHEET_NAME}!F${i + 1}`,
					valueInputOption: "RAW",
					requestBody: { values: [[formattedSummary]] },
				});
				console.log(`✅ 第 ${i + 1} 列更新成功！`);
			} else {
				console.log(`❌ 第 ${i + 1} 列最終失敗: ${finalResult.status}`);
				// 只有在非 429 的情況下才更新失敗標記，如果是 429 則保留讓下次重試
				if (finalResult.status !== "429_limit") {
					await sheets.spreadsheets.values.update({
						spreadsheetId: SHEET_ID,
						range: `${SHEET_NAME}!F${i + 1}`,
						valueInputOption: "RAW",
						requestBody: {
							values: [
								[
									`AI摘要失敗[${finalResult.status}]，請手動處理`,
								],
							],
						},
					});
				}
			}

			retriedCount++;
			// 每篇新聞處理完後的抖動冷卻
			const jitter = Math.random() * 4000;
			console.log(`完成。等待下一則...`);
			await new Promise((r) => setTimeout(r, BASE_SLEEP_MS + jitter));
		}
	}
	console.log(`\n任務執行結束。`);
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
	return `${s.title}\n1. ${s.points[0] || ""}\n2. ${s.points[1] || ""}\n3. ${s.points[2] || ""}`;
}

retryFailedSummaries().catch(console.error);
