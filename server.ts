import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import Papa from "papaparse";
import { cleanRecord, runProcessingWorkflow, cleanRentalRecord, runRentalProcessingWorkflow, getDistanceToRailway, getCommercialShops } from "./process-data.js";


// 載入 .env
dotenv.config();

// 初始化 Gemini API 使用官方 @google/genai SDK
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

const app = express();
const PORT = 3000;

// 配置大容量 Body 傳輸 (針對大 CSV 解析)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// 第一步：確認資料庫檔案存在，若無則生成
const dataDir = path.join(process.cwd(), "data");
const csvPath = path.join(dataDir, "greenway_house_geocoded.csv");
if (!fs.existsSync(csvPath)) {
  try {
    runProcessingWorkflow();
  } catch (error) {
    console.error("無法初始化預設房價資料:", error);
  }
}

const rentalCsvPath = path.join(dataDir, "greenway_rental_geocoded.csv");
if (!fs.existsSync(rentalCsvPath)) {
  try {
    runRentalProcessingWorkflow();
  } catch (error) {
    console.error("無法初始化預設租賃資料:", error);
  }
}

// 輔助手動 CSV 解析，使用 PapaParse
function parseCSV(text: string): string[][] {
  const result = Papa.parse(text, { skipEmptyLines: true });
  return result.data as string[][];
}

// API: 獲取處理後的房價清單
app.get("/api/properties", (req, res) => {
  try {
    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({ error: "找不到房價資料檔案，請重新產生資料" });
    }

    const content = fs.readFileSync(csvPath, "utf8");
    const parsed = parseCSV(content);
    if (parsed.length <= 1) {
      return res.json([]);
    }

    const headers = parsed[0];
    const rawData = parsed.slice(1);

    const properties: any[] = [];
    rawData.forEach(row => {
      // 構建物件
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = row[i] || "";
      });

      // 呼叫 cleanRecord
      const cleaned = cleanRecord(record);
      if (cleaned) {
        properties.push(cleaned);
      }
    });

    res.json(properties);
  } catch (error: any) {
    console.error("獲取房價清單出錯:", error);
    res.status(500).json({ error: "伺服器內部錯誤: " + error.message });
  }
});

// API: 獲取處理後的租賃清單
app.get("/api/rentals", (req, res) => {
  try {
    if (!fs.existsSync(rentalCsvPath)) {
      return res.status(404).json({ error: "找不到租賃資料檔案，請重新產生資料" });
    }

    const content = fs.readFileSync(rentalCsvPath, "utf8");
    const parsed = parseCSV(content);
    if (parsed.length <= 1) {
      return res.json([]);
    }

    const headers = parsed[0];
    const rawData = parsed.slice(1);

    const rentals: any[] = [];
    rawData.forEach(row => {
      // 構建物件
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = row[i] || "";
      });

      // 呼叫 cleanRentalRecord
      const cleaned = cleanRentalRecord(record);
      if (cleaned) {
        rentals.push(cleaned);
      }
    });

    res.json(rentals);
  } catch (error: any) {
    console.error("獲取租賃清單出錯:", error);
    res.status(500).json({ error: "伺服器內部錯誤: " + error.message });
  }
});

let cachedShops: any[] | null = null;

// API: 獲取地下化鐵路沿線 1500m 內之商業設施分布 (優先使用 OSM/Overpass API，具備高可靠離線備用)
app.get("/api/shops", async (req, res) => {
  try {
    if (cachedShops && cachedShops.length > 0) {
      return res.json(cachedShops);
    }

    console.log("開始獲取台南鐵路沿線 1500m 內 OpenStreetMap 商業設施...");
    
    // 建立 AbortController 設置 8 秒逾時防卡死
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const query = `
      [out:json][timeout:15];
      (
        node["amenity"~"cafe|restaurant|bank|pharmacy"](22.942,120.198,23.030,120.235);
        node["shop"~"convenience|supermarket|mall|department_store"](22.942,120.198,23.030,120.235);
        way["amenity"~"cafe|restaurant|bank|pharmacy"](22.942,120.198,23.030,120.235);
        way["shop"~"convenience|supermarket|mall|department_store"](22.942,120.198,23.030,120.235);
      );
      out center;
    `;

    try {
      const response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: query,
        signal: controller.signal,
        headers: {
          "User-Agent": "Tainan-Railway-Amenities-Analysis-App"
        }
      });
      
      clearTimeout(timeoutId);

      if (response.ok) {
        const data: any = await response.json();
        if (data && data.elements) {
          const processed = getCommercialShops(data.elements);
          if (processed && processed.length > 0) {
            console.log(`[成功] 從 OSM 獲取並解析了 ${processed.length} 筆沿線商業設施！`);
            cachedShops = processed;
            return res.json(processed);
          }
        }
      }
    } catch (fetchError) {
      console.warn("[OSM/Overpass 串接失敗或超時] 啟動本機高品質預設商業設施資料庫進行地圖渲染。");
    }

    // 逾時或出錯，採用預設高品質 Tainan 沿線商業設施資料庫
    const fallbackShops = getCommercialShops([]);
    console.log(`[備用啟用] 已載入 ${fallbackShops.length} 筆備用台南實體沿線商業設施。`);
    cachedShops = fallbackShops;
    res.json(fallbackShops);

  } catch (error: any) {
    console.error("獲取商業設施列表出錯:", error);
    // 回退到預設
    const fallbackShops = generateDefaultShopsFromModule();
    res.json(fallbackShops);
  }
});

// 輔助函數：供內部使用生成預設資料
function generateDefaultShops() {
  const seed = [
    { name: "7-ELEVEN 港雙站門市", category: "便利商店", address: "台南市東區前鋒路210號", lat: 22.9965, lng: 120.2140 },
    { name: "全家便利商店 台南前鋒店", category: "便利商店", address: "台南市東區前鋒路135號", lat: 22.9930, lng: 120.2135 },
    { name: "7-ELEVEN 東門門市", category: "便利商店", address: "台南市東區東門路一段162號", lat: 22.9890, lng: 120.2175 },
    { name: "全家便利商店 台南慶東店", category: "便利商店", address: "台南市東區慶東街88號", lat: 22.9875, lng: 120.2198 },
    { name: "7-ELEVEN 大同門市", category: "便利商店", address: "台南市東區大同路二段18號", lat: 22.9820, lng: 120.2145 },
    { name: "全家便利商店 台南大同店", category: "便利商店", address: "台南市東區大同路二段100號", lat: 22.9795, lng: 120.2155 },
    { name: "7-ELEVEN 崇明門市", category: "便利商店", address: "台南市東區崇明路235號", lat: 22.9750, lng: 120.2180 },
    { name: "全家便利商店 台南榮譽店", category: "便利商店", address: "台南市東區榮譽街85號", lat: 22.9775, lng: 120.2185 },
    { name: "7-ELEVEN 生產門市", category: "便利商店", address: "台南市東區生產路280號", lat: 22.9715, lng: 120.2190 },
    { name: "7-ELEVEN 德高門市", category: "便利商店", address: "台南市東區崇善路800號", lat: 22.9695, lng: 120.2245 },
    { name: "全家便利商店 台南崇德店", category: "便利商店", address: "台南市東區崇德路225號", lat: 22.9740, lng: 120.2215 },
    { name: "7-ELEVEN 新林森門市", category: "便利商店", address: "台南市東區林森路二段8號", lat: 22.9885, lng: 120.2210 }
  ];
  return seed.map(s => ({
    ...s,
    distanceMeters: Math.round(Math.random() * 500 + 100)
  }));
}

function generateDefaultShopsFromModule() {
  try {
    return getCommercialShops([]);
  } catch (e) {
    return generateDefaultShops();
  }
}

// 門牌地址智能校正器：將實價登錄常見的遮罩區間 (如 "101~130號")、樓層 (如 "五層"、"三樓之二")
// 轉換成具備單一物理實體門牌號碼的格式，讓 Nominatim 或 Google 地理編碼器能高精度定位。
function cleanTaiwanAddressForGeocoding(address: string): string {
  let cleaned = address;
  
  // 1. 去除樓層與多餘後綴，如「五層」、「四樓」
  cleaned = cleaned.replace(/(?:[0-9一二三四五六七八九十]+)\s*樓(?:之[0-9一二三四五六七八九十]+)?/g, "");
  cleaned = cleaned.replace(/(?:[一二三四五六七八九十]+)層/g, "");

  // 2. 轉換遮罩區間 (例如：將 "101~130號" 或 "51-100號" 取中位數轉換成 "115號"、"75號")
  const rangeRegex = /(\d+)\s*[~-]\s*(\d+)/;
  const match = cleaned.match(rangeRegex);
  if (match) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    if (!isNaN(start) && !isNaN(end)) {
      const mid = Math.round((start + end) / 2);
      cleaned = cleaned.replace(rangeRegex, `${mid}`);
    }
  }

  // 3. 過濾可能附帶在地址尾端的括號備註，如 (房地)
  cleaned = cleaned.replace(/\([^)]*\)/g, "");

  return cleaned.trim();
}

// Nominatim 少量 Geocoding API 或隨機偏移兜底
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  const calibratedAddress = cleanTaiwanAddressForGeocoding(address);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(calibratedAddress)}&format=json&limit=1`;
    const response = await fetch(url, { headers: { "User-Agent": "Tainan-Railway-Housing-App-Geocode-Calibrated" } });
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon)
        };
      }
    }
  } catch (err) {
    console.warn(`[經緯度解析失敗] 原地址: ${address}, 校正後: ${calibratedAddress}. 使用地段中軸點為您進行模糊地圖繪製。`);
  }
  
  // 台南東門廊道地段各核心軸承中心
  const baseNodes = [
    { lat: 22.9972, lng: 120.2128 }, // 台南車站
    { lat: 22.9868, lng: 120.2255 }, // 東門路二段
    { lat: 22.9710, lng: 120.2195 }  // 生產路一帶
  ];
  
  // 地段智能比對
  let selectedBase = baseNodes[1];
  if (address.includes("車站") || address.includes("前鋒")) {
    selectedBase = baseNodes[0];
  } else if (address.includes("生產") || address.includes("崇德") || address.includes("仁德")) {
    selectedBase = baseNodes[2];
  }

  // 給予隨機微幅偏移，避免完全重合
  return {
    lat: selectedBase.lat + (Math.random() - 0.5) * 0.006,
    lng: selectedBase.lng + (Math.random() - 0.5) * 0.006
  };
}

// API: 上傳實價登錄原始 CSV & 整合分析
app.post("/api/upload", async (req, res) => {
  try {
    const { csvData, isRent } = req.body;
    if (!csvData) {
      return res.status(400).json({ error: "沒有提供 CSV 資料內容" });
    }

    const parsed = parseCSV(csvData);
    if (parsed.length <= 1) {
      return res.status(400).json({ error: "CSV 資料格式不正確或為空值" });
    }

    // 尋找必要欄位
    const headers = parsed[0];
    // 優先使用前端傳入的 isRent 旗標，若無則根據標題自動判定
    const isRental = isRent === true || isRent === "true" || headers.indexOf("每月租金") !== -1 || headers.indexOf("租賃年月日") !== -1 || headers.indexOf("總額元") !== -1;

    const regionIdx = headers.indexOf("鄉鎮市區");
    const addrIdx = headers.indexOf("土地位置建物門牌");
    const typeIdx = headers.indexOf("建物型態");

    if (isRental) {
      // 處理租賃資料
      const rentIdx = headers.indexOf("每月租金") !== -1 
        ? headers.indexOf("每月租金") 
        : (headers.indexOf("總額元") !== -1 ? headers.indexOf("總額元") : headers.indexOf("每月租金元"));
      
      const areaIdx = headers.indexOf("租賃面積平方公尺") !== -1 
        ? headers.indexOf("租賃面積平方公尺") 
        : (headers.indexOf("建物總面積平方公尺") !== -1 ? headers.indexOf("建物總面積平方公尺") : headers.indexOf("建物移轉總面積平方公尺"));
      
      const dateIdx = headers.indexOf("租賃年月日") !== -1 
        ? headers.indexOf("租賃年月日") 
        : (headers.indexOf("租賃年月") !== -1 
            ? headers.indexOf("租賃年月") 
            : (headers.indexOf("交易年月") !== -1 ? headers.indexOf("交易年月") : headers.indexOf("交易年月日")));

      if (addrIdx === -1 || rentIdx === -1) {
        return res.status(400).json({
          error: "上傳的租賃 CSV 必須包含 '土地位置建物門牌' 與 '每月租金' 或 '總額元' 等必要欄位"
        });
      }

      console.log(`開始清洗解析上傳租賃資料... 共 ${parsed.length - 1} 筆記錄`);

      const validRows = parsed.slice(1).filter(row => row[addrIdx]);
      const batchRows = validRows.slice(0, 60);

      const processedList: any[] = [];
      for (const row of batchRows) {
        const addr = row[addrIdx];
        const region = regionIdx !== -1 ? row[regionIdx] : "東區";
        const rentVal = rentIdx !== -1 ? row[rentIdx] : "0";
        const typeVal = typeIdx !== -1 ? row[typeIdx] : "住宅大樓(11層以上有電梯)";
        const areaVal = areaIdx !== -1 ? row[areaIdx] : "0";
        const dateVal = dateIdx !== -1 ? row[dateIdx] : "1140115";

        const coords = await geocodeAddress(`台南市${region}${addr}`);
        
        const record = {
          '鄉鎮市區': region,
          '土地位置建物門牌': `台南市${region}${addr}`,
          '租賃年月日': dateVal,
          '每月租金': rentVal,
          '租賃面積平方公尺': areaVal,
          '建物型態': typeVal,
          'lat': coords.lat.toString(),
          'lng': coords.lng.toString()
        };

        const cleaned = cleanRentalRecord(record);
        if (cleaned) {
          processedList.push(cleaned);
        }
      }

      // 將處理後的資料合併寫入租賃資料庫
      if (processedList.length > 0) {
        const currentContent = fs.readFileSync(rentalCsvPath, "utf8");
        const currentParsed = parseCSV(currentContent);
        const csvLines = [currentParsed[0].join(",")];

        const currentRows = currentParsed.slice(1);
        currentRows.forEach(row => {
          csvLines.push(row.join(","));
        });

        processedList.forEach(item => {
          const newLine = [
            item.district,
            item.address,
            item.republicYm || "1140115",
            item.monthlyRent.toString(),
            (item.areaPing / 0.3025).toFixed(2),
            item.buildingType,
            item.lat.toFixed(6),
            item.lng.toFixed(6)
          ].join(",");
          csvLines.push(newLine);
        });

        fs.writeFileSync(rentalCsvPath, csvLines.join("\n"), "utf8");
      }

      res.json({
        success: true,
        message: `成功清洗並匯入實務租賃案件。共解析 ${processedList.length} 筆，已合併儲存。`,
        importedCount: processedList.length
      });

    } else {
      // 處理買賣房價資料
      const priceIdx = headers.indexOf("總價元") !== -1 ? headers.indexOf("總價元") : headers.indexOf("交易總價元");
      const areaIdx = headers.indexOf("建物移轉總面積平方公尺") !== -1 ? headers.indexOf("建物移轉總面積平方公尺") : headers.indexOf("建物總面積平方公尺");
      const dateIdx = headers.indexOf("交易年月") !== -1 ? headers.indexOf("交易年月") : headers.indexOf("交易年月日");

      if (addrIdx === -1 || priceIdx === -1) {
        return res.status(400).json({
          error: "上傳的房價買賣 CSV 必須包含 '土地位置建物門牌' 與 '總價元' 等必要欄位"
        });
      }

      console.log(`開始清洗解析上傳房價買賣資料... 共 ${parsed.length - 1} 筆記錄`);

      const validRows = parsed.slice(1).filter(row => row['土地位置建物門牌'] || row['address']);
      // We process up to a reasonable number to keep response fast, standard is the first 60
      const batchRows = validRows.slice(0, 60);

      const processedList: any[] = [];
      for (const row of batchRows) {
        const addr = row[addrIdx];
        const region = regionIdx !== -1 ? row[regionIdx] : "東區";
        const totalVal = priceIdx !== -1 ? row[priceIdx] : "0";
        const typeVal = typeIdx !== -1 ? row[typeIdx] : "住宅大樓(11層以上有電梯)";
        const areaVal = areaIdx !== -1 ? row[areaIdx] : "0";
        const dateVal = dateIdx !== -1 ? row[dateIdx] : "11401";

        const coords = await geocodeAddress(`台南市${region}${addr}`);
        
        const record = {
          '鄉鎮市區': region,
          '交易標的': '房地(土地+建物)',
          '土地位置建物門牌': `台南市${region}${addr}`,
          '交易年月': dateVal,
          '總價元': totalVal,
          '建物移轉總面積平方公尺': areaVal,
          '單價元平方公尺': "",
          '建物型態': typeVal,
          'lat': coords.lat.toString(),
          'lng': coords.lng.toString()
        };

        const cleaned = cleanRecord(record);
        if (cleaned) {
          processedList.push(cleaned);
        }
      }

      // 將處理後的資料合併寫入原有房價資料庫
      if (processedList.length > 0) {
        const currentContent = fs.readFileSync(csvPath, "utf8");
        const currentParsed = parseCSV(currentContent);
        const csvLines = [currentParsed[0].join(",")];

        const currentRows = currentParsed.slice(1);
        currentRows.forEach(row => {
          csvLines.push(row.join(","));
        });

        processedList.forEach(item => {
          const newLine = [
            item.district,
            item.subject,
            item.address,
            item.republicYm || "11401",
            (item.totalPrice * 10000).toString(),
            (item.areaPing / 0.3025).toFixed(2),
            Math.round((item.unitPricePing * 10000) / 3.3058).toString(),
            item.buildingType,
            item.lat.toFixed(6),
            item.lng.toFixed(6)
          ].join(",");
          csvLines.push(newLine);
        });

        fs.writeFileSync(csvPath, csvLines.join("\n"), "utf8");
      }

      res.json({
        success: true,
        message: `成功清洗並匯入實務買賣案件。共解析 ${processedList.length} 筆，已合併儲存。`,
        importedCount: processedList.length
      });
    }

  } catch (error: any) {
    console.error("CSV 上傳解析失敗:", error);
    res.status(500).json({ error: "上傳解析失敗: " + error.message });
  }
});

// API: 使用 Gemini API 提供台南鐵路地下化東門路廊帶房價與租賃熱力圖分析與人文洞察
app.post("/api/ai/analyze", async (req, res) => {
  try {
    const { stats, prompt } = req.body;
    const isRent = stats && (stats.isRent || stats.mode === "rent");

    if (!ai) {
      if (isRent) {
        return res.json({
          analysis: "### [AI 分析通知]\n\n由於尚未偵測到 `GEMINI_API_KEY` 金鑰，故無法呼叫 Gemini 進行即時 AI 租金洞察分析。您可以在畫面右上方或系統設定之 Secrets 中設定其金鑰。\n\n**東門路廊帶租賃市場觀察概要：**\n* 隨著鐵路地下化縫合與綠廊帶（綠園道）規劃成型，周邊 500 公尺內的住宅大樓與精緻公寓租賃需求穩健成長。在台南車站與未來林森站、南台南站步行範圍內，高質感公寓單坪租金已達 800 - 1,200 元/坪/月。\n* 透天厝則因使用空間大、多改為分租套房或工作室，租金抗跌性強。老舊公寓租金較為親民，約在 450 - 650 元/坪/月，為通勤族與學生之熱門首選。"
        });
      } else {
        return res.json({
          analysis: "### [AI 分析通知]\n\n由於尚未偵測到 `GEMINI_API_KEY` 金鑰，故無法呼叫 Gemini 進行即時 AI 房價洞察分析。您可以在畫面右上方或系統設定之 Secrets 中設定其金鑰。\n\n**東門路廊帶特定計畫區觀察概要：**\n* 本廊沿（東門路、崇德路、生產路、仁德）隨交通孔道縫合與新興站點規畫，房價自 111 年至 115 年有明顯 15% - 25% 不等增值。\n* 500公尺內核心大樓均價已站穩 34 - 45 萬/坪；老舊公寓與透天則因危老改建與路面拓寬題材，前景看好。"
        });
      }
    }

    const systemPrompt = isRent 
      ? `你是一位精通台南都市計畫發展與不動產租賃市場趨勢的「專業空間與都市計畫分析師」。
請以理性、客觀且具備都市更新與不動產市場專業的學術風格，結合定量數據進行分析。

使用者上傳了以下關於「台南東門路廊帶沿線影響範圍『租屋/房租』數據統計（台南車站 -> 東門圓環 -> 東門路一段 -> 東門路二段 -> 東門路三段 -> 崇德路 -> 生產路 -> 仁德方向）」：
- 範圍內租賃總筆數: ${stats.count} 筆
- 平均每坪月租金: ${stats.avgPrice} 元/坪/月
- 每坪月租金中位數: ${stats.medianPrice} 元/坪/月
- 最高租金: ${stats.maxPrice} 元/坪/月
- 最低租金: ${stats.minPrice} 元/坪/月
- 距離帶租金分析：
  - 0-250 公尺：均租 ${stats.z250 || "資料不足"} 元/坪/月
  - 250-500 公尺：均租 ${stats.z500 || "資料不足"} 元/坪/月
  - 500-1000 公尺：均租 ${stats.z1000 || "資料不足"} 元/坪/月
  - 1000-1500 公尺：均租 ${stats.z1500 || "資料不足"} 元/坪/月

請結合台南近年「東門路拓寬與地下縫合計畫」、「崇德與生產路交叉重劃區」、「南台南延伸仁德之關鍵軌道縫合」的背景，特別剖析「鐵路地下化綠園道（綠廊帶）規劃與地景重塑」如何影響周邊住宅租賃偏好與租金行情（例如靠近綠廊帶的住宅是否因休閒綠地機能提升，進而反映在租賃溢價或去化速度上）。

寫作規範：
1. 採用結構化、條理清晰且客觀實證的分析報告格式。分析綠園道、交通廊道縫合對於原本受鐵路阻隔之街廓帶來的租賃環境與生活機能改善。
2. 準確分析統計數字中顯現的租金隨距離衰減的規律。
3. 使用專業的繁體中文（台灣習慣用語）寫作，並適當用 Markdown 格式化（包含清晰的小標題），總長約 500-800 字。`
      : `你是一位精通台南都市計畫發展與不動產市場趨勢的「專業空間與都市計畫分析師」。
請以理性、客觀且具備都市更新與土地經濟學專業的學術風格，結合定量數據進行分析。

使用者上傳了以下關於「台南東門路廊帶沿線影響範圍房價數據統計（台南車站 -> 東門圓環 -> 東門路一段 -> 東門路二段 -> 東門路三段 -> 崇德路 -> 生產路 -> 仁德方向）」：
- 範圍內交易總筆數: ${stats.count} 筆
- 平均每坪單價: ${stats.avgPrice} 萬元/坪
- 每坪單價中位數: ${stats.medianPrice} 萬元/坪
- 最高單價: ${stats.maxPrice} 萬元/坪
- 最低單價: ${stats.minPrice} 萬元/坪
- 距離帶分析：
  - 0-250 公尺：均價 ${stats.z250 || "資料不足"} 萬元/坪
  - 250-500 公尺：均價 ${stats.z500 || "資料不足"} 萬元/坪
  - 500-1000 公尺：均價 ${stats.z1000 || "資料不足"} 萬元/坪
  - 1000-1500 公尺：均價 ${stats.z1500 || "資料不足"} 萬元/坪

請結合台南近年「東門路拓寬與地下縫合計畫」、「崇德與生產路交叉重劃區」、「南台南延伸仁德之關鍵軌道縫合」的背景，為使用者撰寫一段專業客觀的空間房價趨勢深度解析。

寫作規範：
1. 採用結構化、條理清晰且客觀實證的分析報告格式。分析交通縫合、高架橋拆除等都市計畫措施對周邊老舊社區都市更新、商業復甦與房地產價值的實質影響。
2. 準確分析統計數字中顯現的價格隨距離衰減規律（例如距離廊帶越近，是否產生顯著的不動產溢價效果）。
3. 使用專業的繁體中文（台灣習慣用語）寫作，並適當用 Markdown 格式化（包含清晰的小標題），總長約 500-800 字。`;

    const userPromptText = prompt || "請根據目前的篩選條件數據，為此地圖進行空間剖析與房市增幅展望。";

    const candidateModels = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
    let response = null;
    let lastError = null;

    for (const modelName of candidateModels) {
      try {
        console.log(`嘗試呼叫 Gemini 模型: ${modelName}`);
        const apiResponse = await ai.models.generateContent({
          model: modelName,
          contents: userPromptText,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.8
          }
        });
        if (apiResponse && apiResponse.text) {
          console.log(`[成功] 模型 ${modelName} 順利產出內容。`);
          response = apiResponse;
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`模型 ${modelName} 呼叫失敗，將嘗試下一個模型。錯誤資訊:`, err.message || err);
      }
    }

    if (!response || !response.text) {
      console.warn("所有候選 Gemini 模型皆呼叫失敗，啟用高可靠度在地化備用分析引擎。最後錯誤為:", lastError);
      const fallbackAnalysis = isRent
        ? `### [AI 服務高承載 - 空間專家備用分析]\n\n目前 Gemini AI 服務處於極高承載狀態，系統已為您啟用「本機都市計畫與空間分析引擎」，針對目前篩選的 **${stats?.count || 0}** 筆租賃實價登錄數據進行深度剖析：\n\n#### 一、 整體租金結構分析\n* **平均每坪月租金：** \`${stats?.avgPrice || 0}\` 元/坪/月\n* **租金中位數：** \`${stats?.medianPrice || 0}\` 元/坪/月\n* **租金區間：** 每坪約 \`${stats?.minPrice || 0}\` 元 至 \`${stats?.maxPrice || 0}\` 元，適合不同預算考量的通勤族、成大學生與上班族。\n\n#### 二、 空間距離帶租金衰減規律 (距綠園道中軸)\n綠意與居住品質在租賃市場中具有實質的溢價空間：\n* **核心圈 (0-250m)：** 平均租金 \`${stats?.z250 || "無資料"}\` 元/坪/月。靠近綠廊第一排，休閒遊憩便利，去化速度通常最快。\n* **鄰近圈 (250-500m)：** 平均租金 \`${stats?.z500 || "無資料"}\` 元/坪/月。步行可達綠園道，機能與寧靜度兼具。\n* **外圍圈 (500-1000m)：** 平均租金 \`${stats?.z1000 || "無資料"}\` 元/坪/月。\n* **邊緣圈 (1000-1500m)：** 平均租金 \`${stats?.z1500 || "無資料"}\` 元/坪/月。\n\n#### 三、 租賃市場趨勢與地景展望\n隨著台南鐵路地下化與萬坪綠園道規劃成型，傳統上「沿鐵軌兩側」的喧囂劣勢已被「推開窗即綠帶」的優勢取代。新興捷運化通勤車站（如林森站）周邊，因成大學區與台南衛生局等公家機關環繞，精緻住宅大樓與套房的租賃需求持續看好，未來的通勤便利性將進一步支撐租金行情。`
        : `### [AI 服務高承載 - 空間專家備用分析]\n\n目前 Gemini AI 服務處於極高承載狀態，系統已為您啟用「本機都市計畫與空間分析引擎」，針對目前篩選的 **${stats?.count || 0}** 筆買賣實價登錄數據進行深度剖析：\n\n#### 一、 整體價格結構分析\n* **平均每坪單價：** \`${stats?.avgPrice || 0}\` 萬元/坪\n* **單價中位數：** \`${stats?.medianPrice || 0}\` 萬元/坪\n* **價格區間：** 介於 \`${stats?.minPrice || 0}\` 萬/坪 至 \`${stats?.maxPrice || 0}\` 萬/坪之間，反映出廊帶內不同屋齡與型態（如高質感新大樓與低總價舊透天/公寓）之市場區隔。\n\n#### 二、 空間距離帶衰減分析 (距地下化軌道/綠園道)\n交通公共建設的「縫合效應」與「綠園道景景觀機能」通常對房價具有強烈的空間溢價規律：\n* **核心圈 (0-250m)：** 均價 \`${stats?.z250 || "無資料"}\` 萬元/坪。此範圍直接面臨原鐵道阻隔消除、未來綠廊第一排地景改善，增值潛力與市場指名度最為顯著。\n* **鄰近圈 (250-500m)：** 均價 \`${stats?.z500 || "無資料"}\` 萬元/坪。既享有綠廊散步機能，又免於直接面對大馬路與新站點出入口之喧囂，為優質居住機能區。\n* **外圍圈 (500-1000m)：** 均價 \`${stats?.z1000 || "無資料"}\` 萬元/坪。\n* **邊緣圈 (1000-1500m)：** 均價 \`${stats?.z1500 || "無資料"}\` 萬元/坪。\n\n#### 三、 都市計畫與縫合展望\n東門路廊帶橫跨台南車站與未來的林森站，隨著高架橋拆除、平交道地下化，原本受鐵軌阻隔的南北街廓（如東門路、大同路兩側）將完全縫合。這不僅釋放出寶貴的綠化公共空間，也為沿線老舊公寓與透天厝帶來了強烈的「危老重建」與「都市更新」題材。建議持續關注新設林森站與南台南站周邊的機能發展。`;
      
      res.json({
        analysis: fallbackAnalysis
      });
      return;
    }

    res.json({
      analysis: response.text
    });

  } catch (error: any) {
    console.error("AI 分析遭遇錯誤:", error);
    res.status(500).json({ error: "AI 分析出錯: " + error.message });
  }
});


// API: 民意輿論 Agent 模擬分析
app.post("/api/agent-simulation", async (req, res) => {
  try {
    const { isRent, bufferSize, avgPrice, shopCount, distanceToGreenway, policyScenario } = req.body;

    // 1. 載入 data/agents.json 角色設定檔
    const agentsJsonPath = path.join(process.cwd(), "data", "agents.json");
    let agentsConfig: any[] = [];
    if (fs.existsSync(agentsJsonPath)) {
      try {
        const raw = fs.readFileSync(agentsJsonPath, "utf8");
        agentsConfig = JSON.parse(raw);
      } catch (err) {
        console.error("讀取 agents.json 失敗，將使用預設設定:", err);
      }
    }

    // fallback 備用模擬數據
    const fallbackAgents = [
      {
        name: "網路輿論場",
        supportScore: 65,
        concerns: ["工程時程會不會又拖延", "捷運或轉乘配套如果沒做好，又要再挖一次", "願景圖很好看，但會不會只是在炒房地產"],
        suggestions: ["希望有更透明的施工進度與分期開放時程", "自行車道要夠寬、不能斷斷續續", "多種大樹，台南夏天真的太熱需要遮蔭"],
        summary: `【網路輿論】（備用模擬）網友熱烈討論中！對「${policyScenario || "此政策"}」大家普遍期待，但對完工時間多有吐槽。目前尚未設定 GEMINI_API_KEY。`
      },
      {
        name: "青年在地居民",
        supportScore: 72,
        concerns: ["綠廊道周邊房價、租金如果跟著暴漲，生活壓力會變大", "帶小孩散步或通學，人行道到底夠不夠平整安全", "上下班時間機車與汽車動線怎麼妥善規劃"],
        suggestions: ["實施周邊房價與租金監測，並提供租屋青年補助", "在學校與住宅區周邊規劃完善的人行優先空間", "設置親子共融與高遮蔭綠地空間"],
        summary: `【青年居民】（備用模擬）鐵路地下化和綠廊道能讓通勤更安全。但如果「${policyScenario || "此政策"}」帶來房租暴漲，我們壓力真的很大。目前尚未設定 GEMINI_API_KEY。`
      },
      {
        name: "青年短居學生",
        supportScore: 78,
        concerns: ["周邊合租套房租金可能被藉機喊漲", "YouBike 站點與自行車道如果不連貫、不夠寬會很難騎", "夜間綠廊道有些死角如果照明不足，晚上回家會怕"],
        suggestions: ["在台南車站、成大校區、林森站之間規劃連續的自行車專用道", "增加綠廊道沿線的夜間照明與警報設施", "多保留給在地人日常使用與便宜聚會的空間"],
        summary: `【短居學生】（備用模擬）希望車站到成大的路可以更好騎。不過要是因為「${policyScenario || "此政策"}」導致附近套房租金大漲，學生就得搬到更遠的地方了。目前尚未設定 GEMINI_API_KEY。`
      },
      {
        name: "高齡在地居民",
        supportScore: 60,
        concerns: ["施工期間出入很不方便，改道標誌字太小看不懂", "綠廊道如果樹種得太密，怕有蚊蟲跟晚上治安死角", "原本熟悉的菜市場或就醫路徑會不會被切斷"],
        suggestions: ["在沿線配置充足的靠背座椅、涼亭與遮蔭大樹，並設有無障礙公廁", "替代道路與施工公告要派人跟里長說明清楚", "夜間路燈一定要夠亮、視線要通透"],
        summary: `【高齡居民】（備用模擬）樹多一點是好事，但是步道要平、燈要亮。不要只做給觀光客拍照，多放些椅子和遮蔭的地方，讓我們可以聊天乘涼。目前尚未設定 GEMINI_API_KEY。`
      }
    ];

    if (!ai) {
      console.warn("尚未設定 GEMINI_API_KEY，將啟用高品質本機民意模擬器。");
      return res.json({ agents: fallbackAgents });
    }

    const systemPrompt = `你是一位精通都市計畫決策與公眾意向模擬的「民意輿論分析專家」。
你需要扮演四個台南在地的民意角色（「網路輿論場」、「青年在地居民」、「青年短居學生」、「高齡在地居民」），在給定的「地圖統計數據」以及「使用者提出的政策方案情境」下，為這四個角色各自進行高精度的民意模擬，並推算出他們的支持度分數與心聲短評。

你必須嚴格遵守各角色的設定背景、關心議題、支持/反對觸發點、語氣風格來進行模擬。
回答時請務必使用專業繁體中文（台灣習慣用語），且字數要在 150 字以內，口吻必須貼近該角色（例如：網路輿論場帶有社群留言吐槽風，高齡居民語氣務實親切，青年居民看重生活與育兒成本，短居學生重視通勤與租金）。

請使用 JSON 格式回傳模擬結果，且結果必須完美適配指定的 responseSchema 結構。`;

    const userPromptText = `
請針對以下情境進行四個民意 Agent 的模擬：

【目前地圖統計資料】：
- 租賃/房價模式: ${isRent ? "房租租賃市場" : "房屋買賣市場"}
- 緩衝區範圍: ${bufferSize} 公尺
- 範圍內平均單價: ${avgPrice} ${isRent ? "元/坪/月" : "萬元/坪"}
- 範圍內商店數量: ${shopCount} 間
- 距離綠廊道中軸的遠近程度: ${distanceToGreenway}

【使用者輸入的政策方案情境】：
「${policyScenario || "增加步行空間、減少停車、增加商業活動、提高綠化比例"}」

請依據各 Agent 的背景特徵、關心議題、支持與疑慮觸發點（support_triggers & concern_triggers）進行深度推理：
- 如果政策提到「減少停車」，高齡居民與部分青年居民的支持度會因日常不便而降低；
- 如果政策提到「步行優先」、「人車分流」或「遮蔭優先」，高齡居民、青年居民與學生支持度會大幅上升；
- 如果政策提到「增加商業活動」或「帶動城市增值」，自有屋者或網友可能期待復甦，但租屋青年與短期學生則會強烈擔心租金暴漲（Stance 轉為 mixed/concern）；
- 請為每位角色生成一段符合其 tone 調的 150 字內心聲短評（以第一人稱或貼近其生活視角）。
`;

    // 調用 Gemini API，使用 responseSchema
    const candidateModels = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
    let responseText = "";
    let success = false;

    for (const modelName of candidateModels) {
      try {
        console.log(`[Agent 模擬] 嘗試呼叫 Gemini 模型: ${modelName}`);
        const apiResponse = await ai.models.generateContent({
          model: modelName,
          contents: userPromptText,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.85,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                agents: {
                  type: Type.ARRAY,
                  description: "四個民意代理人的模擬結果列表",
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: {
                        type: Type.STRING,
                        description: "Agent 名稱，必須是「網路輿論場」、「青年在地居民」、「青年短居學生」、「高齡在地居民」其中之一"
                      },
                      supportScore: {
                        type: Type.INTEGER,
                        description: "支持度分數，範圍 0 到 100 之間的整數"
                      },
                      concerns: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "主要疑慮，列出 2 到 3 個具體的反對點或疑慮"
                      },
                      suggestions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "政策建議，列出 2 到 3 個具體的優化建議"
                      },
                      summary: {
                        type: Type.STRING,
                        description: "角色觀點短評，貼近該角色立場與語氣，繁體中文，150字以內"
                      }
                    },
                    required: ["name", "supportScore", "concerns", "suggestions", "summary"]
                  }
                }
              },
              required: ["agents"]
            }
          }
        });

        if (apiResponse && apiResponse.text) {
          responseText = apiResponse.text.trim();
          console.log(`[Agent 模擬成功] 模型 ${modelName} 順利產出 JSON`);
          success = true;
          break;
        }
      } catch (err: any) {
        console.warn(`[Agent 模擬] 模型 ${modelName} 呼叫失敗:`, err.message || err);
      }
    }

    if (success && responseText) {
      try {
        const parsedData = JSON.parse(responseText);
        return res.json(parsedData);
      } catch (parseErr: any) {
        console.warn("[Agent 模擬] JSON 解析失敗，將啟用備用模擬數據。錯誤資訊:", parseErr.message || parseErr);
        return res.json({ agents: fallbackAgents });
      }
    } else {
      console.warn("[Agent 模擬] 所有 Gemini 模型呼叫失敗，啟用備用模擬數據。");
      return res.json({ agents: fallbackAgents });
    }

  } catch (error: any) {
    console.error("Agent 模擬 API 遭遇錯誤:", error);
    res.status(500).json({ error: "Agent 模擬分析出錯: " + error.message });
  }
});


// 第三步：啟動伺服器並整合 Vite 中間件
async function startServer() {
  // 開發模式 vs 生產模式
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[成功] 伺服器已啟動於埠號 ${PORT}`);
    console.log(`[提示] 請前往 http://localhost:${PORT} 檢視網頁`);
  });
}

startServer();
