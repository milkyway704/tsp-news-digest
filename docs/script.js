// Google Sheets CSV 來源 URL
const SHEET_CSV_URL =
	"https://docs.google.com/spreadsheets/d/e/2PACX-1vTAekaazwwe7FMqVMs9bli76lWUoAE2DT4OoDWO6DtgeC9dwzQQZ3_lx44KVf1zKLKYiO-jxxssXFgL/pub?gid=263974729&single=true&output=csv";

let allRows = [];
let filteredNews = [];

// 取得 DOM 元素
const dateEl = document.getElementById("dateInput");
const sourceEl = document.getElementById("sourceFilter");
const typeEl = document.getElementById("typeFilter");
const keywordEl = document.getElementById("keywordInput");
const listEl = document.getElementById("newsList");
const detailEl = document.getElementById("newsDetail");
const prevDayBtn = document.getElementById("prevDay");
const nextDayBtn = document.getElementById("nextDay");

// 初始化
window.onload = () => {
	// 設定預設日期為今天
	const today = new Date().toISOString().split("T")[0];
	dateEl.value = today;

	// 綁定事件監聽器 (自動觸發)
	dateEl.addEventListener("change", applyFilters);

	sourceEl.addEventListener("change", () => {
		updateTypeOptions(); // 來源變動時，動態更新類型選單
		applyFilters();
	});

	typeEl.addEventListener("change", applyFilters);
	keywordEl.addEventListener("input", applyFilters); // 輸入關鍵字時即時過濾

	prevDayBtn.addEventListener("click", () => changeDay(-1));
	nextDayBtn.addEventListener("click", () => changeDay(1));

	fetchData();
};

async function fetchData() {
	try {
		Papa.parse(SHEET_CSV_URL, {
			download: true,
			header: false,
			complete: function (results) {
				// 排除標題列並確保資料有效
				allRows = results.data.slice(1).filter((r) => r[0]);
				updateSourceOptions();
				updateTypeOptions();
				applyFilters();
			},
		});
	} catch (e) {
		listEl.innerHTML = "讀取資料失敗，請檢查網址設定。";
	}
}

// 動態更新來源選單
function updateSourceOptions() {
	const sources = new Set();
	allRows.forEach((r) => {
		if (r[1]) sources.add(r[1]);
	});

	sourceEl.innerHTML = '<option value="all">所有來源</option>';
	Array.from(sources)
		.sort()
		.forEach((s) => sourceEl.add(new Option(s, s)));
}

// 根據所選來源，動態更新類型選單 (無需對照表)
function updateTypeOptions() {
	const selectedSource = sourceEl.value;
	const currentType = typeEl.value; // 保留當前選擇
	const availableTypes = new Set();

	allRows.forEach((r) => {
		const rowSource = r[1];
		const rowType = r[2];
		// 如果是全部來源，或是符合選定來源，則加入類型清單
		if (selectedSource === "all" || rowSource === selectedSource) {
			if (rowType) availableTypes.add(rowType);
		}
	});

	typeEl.innerHTML = '<option value="all">所有類型</option>';
	Array.from(availableTypes)
		.sort()
		.forEach((t) => typeEl.add(new Option(t, t)));

	// 恢復先前的類型選擇 (如果該類型仍在新選單中)
	if (Array.from(availableTypes).includes(currentType)) {
		typeEl.value = currentType;
	}
}

function applyFilters() {
	const targetDate = dateEl.value;
	const targetSource = sourceEl.value;
	const targetType = typeEl.value;
	const targetKey = keywordEl.value.toLowerCase();

	filteredNews = allRows.filter((r) => {
		const d = r[0];
		const s = r[1];
		const t = r[2];
		const title = r[3] || "";

		return (
			d === targetDate &&
			(targetSource === "all" || s === targetSource) &&
			(targetType === "all" || t === targetType) &&
			title.toLowerCase().includes(targetKey)
		);
	});

	renderList();
	// 切換篩選時，如果不是手機版，清空右側內容
	if (window.innerWidth > 900) {
		detailEl.innerHTML = "請選擇新聞以查看摘要";
	}
}

function renderList() {
	listEl.innerHTML = "";
	if (filteredNews.length === 0) {
		listEl.innerHTML =
			'<div style="padding:20px; color:#666;">該日期無符合的新聞。</div>';
		return;
	}

	filteredNews.forEach((news) => {
		const item = document.createElement("div");
		item.className = "news-item";
		item.innerHTML = `
            <div class="meta">${news[1]} · ${news[2]}</div>
            <div class="title">${news[3]}</div>
        `;
		item.onclick = () => onNewsClick(news, item);
		listEl.appendChild(item);
	});
}

function onNewsClick(news, element) {
	document
		.querySelectorAll(".news-item")
		.forEach((el) => el.classList.remove("active"));
	element.classList.add("active");

	const content = `
        <div class="title" style="font-size: 20px;">${news[3]}</div>
        <div class="meta" style="margin-top:8px;">${news[0]} | ${news[1]} | ${news[2]}</div>
        <hr style="border:0; border-top:1px solid #eee; margin:20px 0;">
        <div class="summary-content">${news[5] || "無摘要內容"}</div>
        <a class="link" href="${news[4]}" target="_blank">前往原文連結 ↗</a>
    `;

	if (window.innerWidth <= 900) {
		let box = element.querySelector(".mobile-summary");
		if (box) {
			box.remove();
		} else {
			box = document.createElement("div");
			box.className = "mobile-summary";
			box.innerHTML = `<div class="summary-content">${news[5]}</div><a class="link" href="${news[4]}" target="_blank">看原文</a>`;
			element.appendChild(box);
		}
	} else {
		detailEl.innerHTML = content;
	}
}

function changeDay(delta) {
	const d = new Date(dateEl.value);
	d.setDate(d.getDate() + delta);
	dateEl.value = d.toISOString().split("T")[0];
	applyFilters();
}
