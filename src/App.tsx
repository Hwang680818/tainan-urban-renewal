import React, { useEffect, useState, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as turf from "@turf/turf";
import { 
  Plus, 
  MapPin, 
  Filter, 
  TrendingUp, 
  Sparkles, 
  BookOpen, 
  FileUp, 
  RefreshCw, 
  Sliders, 
  Info, 
  Check, 
  Compass, 
  Eye, 
  Layers,
  Award
} from "lucide-react";

// 台南鐵路地下化縱貫線軌道核心軸線數據 (Lat/Lng 順序給 Leaflet / Map 繪圖與前端 Turf 計算使用)
const RAILWAY_CORE_AXIS: [number, number][] = [
  [23.0163, 120.2134], // 永康與北區交界引道 (北端起點 - 中華路鐵路橋)
  [23.0075, 120.2127], // 北區開元路段 (開元陸橋)
  [23.0030, 120.2125], // 東豐路平交道段
  [22.9972, 120.2126], // 台南車站
  [22.9926, 120.2133], // 青年路平交道段
  [22.9898, 120.2142], // 東門路一段平交道段 (東門陸橋)
  [22.9859, 120.2161], // 府連東路/健康路平交道段
  [22.9837, 120.2173], // 林森車站 (林森路一段)
  [22.9782, 120.2181], // 榮譽街平交道段
  [22.9740, 120.2184], // 中華東路三段 (中華陸橋)
  [22.9712, 120.2188], // 南台南車站 (生產路)
  [22.9560, 120.2198]  // 南引道 (保安方向終點)
];

interface Property {
  district: string;
  subject: string;
  address: string;
  date: string;
  republicYm?: string;
  year: number;
  totalPrice: number; // 萬元
  areaPing: number; // 坪
  unitPricePing: number; // 萬/坪
  buildingType: string;
  lat: number;
  lng: number;
  distanceMeters: number;
}

interface Rental {
  district: string;
  address: string;
  date: string;
  republicYm?: string;
  year: number;
  monthlyRent: number; // 元
  areaPing: number; // 坪
  unitRentPing: number; // 元/坪/月
  buildingType: string;
  lat: number;
  lng: number;
  distanceMeters: number;
}

let CustomHeatLayerClass: any = null;

function getCustomHeatLayerClass() {
  if (CustomHeatLayerClass) return CustomHeatLayerClass;

  CustomHeatLayerClass = (L.Layer || (L as any).Class).extend({
    options: {
      minOpacity: 0.05,
      maxZoom: 18,
      radius: 25,
      blur: 15,
      gradient: {
        0.4: "rgba(59, 130, 246, 0.7)", // soft blue
        0.6: "rgba(16, 185, 129, 0.8)", // bright green
        0.8: "rgba(245, 158, 11, 0.9)", // bright orange
        1.0: "rgba(239, 68, 68, 0.95)"  // rich red
      }
    },

    initialize: function(latlngs: any[], options: any) {
      this._latlngs = latlngs;
      L.setOptions(this, options);
    },

    setLatLngs: function(latlngs: any[]) {
      this._latlngs = latlngs;
      return this.redraw();
    },

    onAdd: function(map: any) {
      this._map = map;
      if (!this._canvas) {
        this._initCanvas();
      }
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on("moveend", this._reset, this);
      this._reset();
    },

    onRemove: function(map: any) {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      map.off("moveend", this._reset, this);
    },

    _initCanvas: function() {
      const canvas = this._canvas = L.DomUtil.create("canvas", "leaflet-heatmap-layer leaflet-zoom-animated");
      const size = this._map.getSize();
      canvas.width = size.x;
      canvas.height = size.y;
      
      const animated = this._map.options.zoomAnimation && L.Browser.any3d;
      L.DomUtil.addClass(canvas, animated ? "leaflet-zoom-animated" : "leaflet-zoom-hide");
    },

    _reset: function() {
      if (!this._map) return;
      const size = this._map.getSize();
      const lt = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, lt);
      
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this.redraw();
    },

    redraw: function() {
      if (!this._map || !this._canvas) return this;
      const ctx = this._canvas.getContext("2d");
      if (!ctx) return this;
      
      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      
      const r = this.options.radius;
      const blur = this.options.blur;
      const r2 = r + blur;
      
      // Create radial gradient node
      const tpl = document.createElement("canvas");
      tpl.width = tpl.height = r2 * 2;
      const tplCtx = tpl.getContext("2d")!;
      const grad = tplCtx.createRadialGradient(r2, r2, r, r2, r2, r2);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      tplCtx.fillStyle = grad;
      tplCtx.beginPath();
      tplCtx.arc(r2, r2, r2, 0, Math.PI * 2, true);
      tplCtx.closePath();
      tplCtx.fill();
      
      // Alpha layer canvas
      const alphaCanvas = document.createElement("canvas");
      alphaCanvas.width = this._canvas.width;
      alphaCanvas.height = this._canvas.height;
      const actx = alphaCanvas.getContext("2d")!;
      
      this._latlngs.forEach((p: any) => {
        const containerPoint = this._map.latLngToContainerPoint([p[0], p[1]]);
        const weight = p[2] || 1;
        actx.globalAlpha = Math.max(weight, this.options.minOpacity);
        actx.drawImage(tpl, containerPoint.x - r2, containerPoint.y - r2);
      });
      
      // Colorize alpha layer
      const imgData = actx.getImageData(0, 0, alphaCanvas.width, alphaCanvas.height);
      const data = imgData.data;
      
      // Gradient helper
      const gradCanvas = document.createElement("canvas");
      gradCanvas.width = 1;
      gradCanvas.height = 256;
      const gctx = gradCanvas.getContext("2d")!;
      const paletteGrad = gctx.createLinearGradient(0, 0, 0, 256);
      for (const [key, val] of Object.entries(this.options.gradient)) {
        paletteGrad.addColorStop(Number(key), val as string);
      }
      gctx.fillStyle = paletteGrad;
      gctx.fillRect(0, 0, 1, 256);
      const palette = gctx.getImageData(0, 0, 1, 256).data;
      
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha > 0) {
          const offset = alpha * 4;
          data[i] = palette[offset];
          data[i + 1] = palette[offset + 1];
          data[i + 2] = palette[offset + 2];
          data[i + 3] = alpha * 0.75;
        }
      }
      
      ctx.putImageData(imgData, 0, 0);
      return this;
    }
  });

  return CustomHeatLayerClass;
}

function createCustomHeatLayer(latlngs: any[], options: any) {
  const Cls = getCustomHeatLayerClass();
  return new Cls(latlngs, options);
}

export default function App() {
  // Application State
  const [properties, setProperties] = useState<Property[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [activeTab, setActiveTab] = useState<"price" | "rent" | "opinion">("price");
  const [effectiveDataMode, setEffectiveDataMode] = useState<"price" | "rent">("price");
  const [filteredProperties, setFilteredProperties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Agent 模擬狀態
  const [policyScenario, setPolicyScenario] = useState<string>("增加步行空間、減少停車、增加商業活動、提高綠化比例");
  const [simulationLoading, setSimulationLoading] = useState<boolean>(false);
  const [simulationResults, setSimulationResults] = useState<any[] | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  // Filters State
  const [selectedYear, setSelectedYear] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [minHousePrice, setMinHousePrice] = useState<number>(15);
  const [maxHousePrice, setMaxHousePrice] = useState<number>(100); // 萬/坪
  const [minRentPrice, setMinRentPrice] = useState<number>(300);
  const [maxRentPrice, setMaxRentPrice] = useState<number>(2000); // 元/坪/月
  const [bufferDistance, setBufferDistance] = useState<number>(1000); // 公尺

  // 動態計算資料庫中實際存在的最值 (避免拉桿出現未呈現/不符合真實資料的金額區間)
  const priceBounds = React.useMemo(() => {
    if (properties.length === 0) return { min: 15, max: 100 };
    const prices = properties.map(p => p.unitPricePing).filter(p => !isNaN(p) && p > 0);
    if (prices.length === 0) return { min: 15, max: 100 };
    return {
      min: Math.floor(Math.min(...prices)),
      max: Math.ceil(Math.max(...prices))
    };
  }, [properties]);

  const rentBounds = React.useMemo(() => {
    if (rentals.length === 0) return { min: 300, max: 2000 };
    const rents = rentals.map(r => r.unitRentPing).filter(r => !isNaN(r) && r > 0);
    if (rents.length === 0) return { min: 300, max: 2000 };
    return {
      min: Math.floor(Math.min(...rents)),
      max: Math.ceil(Math.max(...rents))
    };
  }, [rentals]);

  // 當真實資料載入完畢，主動將房價/房租區間拉桿的初始上下限設為實際資料的最大最小值
  useEffect(() => {
    if (properties.length > 0) {
      setMinHousePrice(priceBounds.min);
      setMaxHousePrice(priceBounds.max);
    }
  }, [properties, priceBounds]);

  useEffect(() => {
    if (rentals.length > 0) {
      setMinRentPrice(rentBounds.min);
      setMaxRentPrice(rentBounds.max);
    }
  }, [rentals, rentBounds]);
  
  // Layer Visibility
  const [showHeatMap, setShowHeatMap] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const [showBuffer, setShowBuffer] = useState(true);
  const [showCoreLine, setShowCoreLine] = useState(true);
  const [heatmapPluginLoaded, setHeatmapPluginLoaded] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  // AI Prompt & Analysis State
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResponse, setAiResponse] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);

  // CSV Upload State
  const [uploadStatus, setUploadStatus] = useState<{ type: "success" | "error" | "info" | null; msg: string | null }>({
    type: null,
    msg: null
  });
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Map References
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routePolylineRef = useRef<L.Polyline | null>(null);
  const bufferGeoJsonRef = useRef<L.GeoJSON | null>(null);
  const pointsLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const stationsLayerRef = useRef<L.LayerGroup | null>(null);
  const heatLayerRef = useRef<any>(null);
  const shopsLayerGroupRef = useRef<L.LayerGroup | null>(null);

  // 商業設施 & concentric 緩衝圖層狀態
  const [shops, setShops] = useState<any[]>([]);
  const [showShops, setShowShops] = useState(true);
  const [selectedShopCategories, setSelectedShopCategories] = useState<string[]>([
    "便利商店",
    "超市",
    "咖啡廳",
    "餐廳",
    "百貨商場",
    "銀行",
    "藥局"
  ]);
  const [showBuffer500, setShowBuffer500] = useState(false);
  const [showBuffer1000, setShowBuffer1000] = useState(true);
  const [showBuffer1500, setShowBuffer1500] = useState(false);

  // Stats Derived
  const stats = React.useMemo(() => {
    if (filteredProperties.length === 0) {
      return {
        count: 0,
        avgPrice: 0,
        medianPrice: 0,
        maxPrice: 0,
        minPrice: 0,
        z250: 0,
        z500: 0,
        z1000: 0,
        z1500: 0,
        c250: 0,
        c500: 0,
        c1000: 0,
        c1500: 0,
        isRent: effectiveDataMode === "rent"
      };
    }
    const prices = filteredProperties
      .map(p => effectiveDataMode === "price" ? p.unitPricePing : p.unitRentPing)
      .filter(p => typeof p === "number" && !isNaN(p))
      .sort((a, b) => a - b);
    
    const count = prices.length;
    const avgPrice = count ? Math.round(prices.reduce((sum, p) => sum + p, 0) / count * 10) / 10 : 0;
    const medianPrice = count ? prices[Math.floor(count / 2)] : 0;
    const maxPrice = count ? Math.max(...prices) : 0;
    const minPrice = count ? Math.min(...prices) : 0;

    // Distance band decay calculations (using the 4 requested bands)
    const p250 = filteredProperties.filter(p => p.distanceMeters <= 250);
    const p500 = filteredProperties.filter(p => p.distanceMeters > 250 && p.distanceMeters <= 500);
    const p1000 = filteredProperties.filter(p => p.distanceMeters > 500 && p.distanceMeters <= 1000);
    const p1500 = filteredProperties.filter(p => p.distanceMeters > 1000 && p.distanceMeters <= 1500);

    const getAvg = (list: any[]) => {
      if (!list.length) return 0;
      const validVals = list
        .map(p => effectiveDataMode === "price" ? p.unitPricePing : p.unitRentPing)
        .filter(v => typeof v === "number" && !isNaN(v));
      if (!validVals.length) return 0;
      const sum = validVals.reduce((acc, v) => acc + v, 0);
      return Math.round((sum / validVals.length) * 10) / 10;
    };

    return {
      count,
      avgPrice,
      medianPrice,
      maxPrice,
      minPrice,
      z250: getAvg(p250),
      z500: getAvg(p500),
      z1000: getAvg(p1000),
      z1500: getAvg(p1500),
      c250: p250.length,
      c500: p500.length,
      c1000: p1000.length,
      c1500: p1500.length,
      isRent: effectiveDataMode === "rent"
    };
  }, [filteredProperties, effectiveDataMode]);

  // 依據目前選取之緩衝圈大小動態篩選商業設施
  const activeFilterDistance = showBuffer1500 ? 1500 : (showBuffer1000 ? 1000 : (showBuffer500 ? 500 : 1000));

  const filteredShops = React.useMemo(() => {
    return shops.filter(shop => shop.distanceMeters <= activeFilterDistance);
  }, [shops, activeFilterDistance]);

  const displayedShops = React.useMemo(() => {
    if (!showShops) return [];
    return filteredShops.filter(shop => selectedShopCategories.includes(shop.category));
  }, [filteredShops, showShops, selectedShopCategories]);

  const shopStats = React.useMemo(() => {
    const total = filteredShops.length;
    const convenience = filteredShops.filter(s => s.category === "便利商店").length;
    const cafe = filteredShops.filter(s => s.category === "咖啡廳").length;
    const restaurant = filteredShops.filter(s => s.category === "餐廳").length;
    const mall = filteredShops.filter(s => s.category === "百貨商場").length;
    const supermarket = filteredShops.filter(s => s.category === "超市").length;
    const bank = filteredShops.filter(s => s.category === "銀行").length;
    const pharmacy = filteredShops.filter(s => s.category === "藥局").length;

    // 生活機能指數加權計算 (0~100分)
    // 依據：便利商店(x6), 餐廳(x4), 咖啡廳(x3), 超市(x8), 銀行(x3) 數量加權
    const rawScore = (convenience * 6) + (restaurant * 4) + (cafe * 3) + (supermarket * 8) + (bank * 3);
    // 歸一化得分，在 1500m 範圍下若滿額 110 點計為 100 分滿分
    const indexScore = Math.min(100, Math.round((rawScore / 110) * 100));

    return {
      total,
      convenience,
      cafe,
      restaurant,
      mall,
      supermarket,
      bank,
      pharmacy,
      indexScore
    };
  }, [filteredShops]);

  // Fetch properties and rentals from backend
  const fetchAllData = async () => {
    setLoading(true);
    try {
      const [propRes, rentRes, shopRes] = await Promise.all([
        fetch("/api/properties"),
        fetch("/api/rentals"),
        fetch("/api/shops")
      ]);
      
      if (!propRes.ok) throw new Error("買賣資料獲取失敗，請確認伺服器狀態");
      if (!rentRes.ok) throw new Error("租賃資料獲取失敗，請確認伺服器狀態");
      if (!shopRes.ok) throw new Error("生活機能設施獲取失敗");
      
      const propData: Property[] = await propRes.json();
      const rentData: Rental[] = await rentRes.json();
      const shopData: any[] = await shopRes.json();
      
      setProperties(propData);
      setRentals(rentData);
      setShops(shopData);
      setError(null);
    } catch (err: any) {
      setError(err.message || "載入失敗");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllData();
    if (typeof window !== "undefined") {
      (window as any).L = L;
      setHeatmapPluginLoaded(true);
    }
  }, []);

  // Initialize Leaflet Map once
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // 解決 React StrictMode 重入導致的 DOM _leaflet_id 未清理問題
    // @ts-ignore
    if (mapContainerRef.current._leaflet_id) {
      // @ts-ignore
      mapContainerRef.current._leaflet_id = null;
    }

    // Create the map instance
    const map = L.map(mapContainerRef.current, {
      zoomControl: false
    }).setView([22.986, 120.215], 14);

    // Light, muted classic map layer style suitable for an aesthetic classic design (aesthetic earth palette)
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "© OpenStreetMap contributors © CARTO"
    }).addTo(map);

    // Custom Zoom Controller (bottom-right)
    L.control.zoom({ position: "bottomright" }).addTo(map);

    mapRef.current = map;
    pointsLayerGroupRef.current = L.layerGroup().addTo(map);
    stationsLayerRef.current = L.layerGroup().addTo(map);

    setMapReady(true);

    return () => {
      setMapReady(false);
      
      if (routePolylineRef.current) {
        try { routePolylineRef.current.remove(); } catch (e) {}
        routePolylineRef.current = null;
      }
      if (bufferGeoJsonRef.current) {
        try { bufferGeoJsonRef.current.remove(); } catch (e) {}
        bufferGeoJsonRef.current = null;
      }
      if (pointsLayerGroupRef.current) {
        try { pointsLayerGroupRef.current.remove(); } catch (e) {}
        pointsLayerGroupRef.current = null;
      }
      if (stationsLayerRef.current) {
        try { stationsLayerRef.current.remove(); } catch (e) {}
        stationsLayerRef.current = null;
      }
      if (heatLayerRef.current) {
        try { heatLayerRef.current.remove(); } catch (e) {}
        heatLayerRef.current = null;
      }
      if (mapRef.current) {
        try {
          mapRef.current.off();
          mapRef.current.remove();
        } catch (err) {
          console.warn("Leaflet map cleanup ignored error:", err);
        }
        mapRef.current = null;
      }
    };
  }, []);

  // Sync Leaflet base and overlay layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // 1. Draw Core Project Alignment (台南鐵路地下化縱貫線軌道)
    if (routePolylineRef.current) {
      map.removeLayer(routePolylineRef.current);
    }

    if (stationsLayerRef.current) {
      stationsLayerRef.current.clearLayers();
    }
    
    if (showCoreLine) {
      routePolylineRef.current = L.polyline(RAILWAY_CORE_AXIS, {
        color: "#dc2626", // Bold vivid red as requested
        weight: 6,
        opacity: 0.95,
        lineCap: "round"
      }).addTo(map);

      routePolylineRef.current.bindPopup(`
        <div style="font-family: 'Noto Serif TC', serif; line-height: 1.6;">
          <h3 style="margin: 0 0 4px; font-weight: 600; color: #9e462e;">台南鐵路地下化縱貫線軸線</h3>
          <p style="margin: 0; font-size: 13px;">本線段為實際縱貫線鐵路地下化工程核心軸線，包含台南車站、未來新增的林森車站及南台南車站。為都市機能縫合與綠廊道規劃之核心中軸。</p>
        </div>
      `);

      // Draw Station Markers
      if (stationsLayerRef.current) {
        // Tainan Station
        const tainanIcon = L.divIcon({
          html: `
            <div style="position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <div class="custom-tainan-station-pulse" style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; color: white;">
                <span style="font-size: 12px; transform: translateY(-0.5px);">🚂</span>
              </div>
              <div class="custom-tainan-station-label" style="position: absolute; bottom: 28px; text-shadow: 0 1px 2px rgba(0,0,0,0.35);">
                ⭐ 台南火車站 (地下化古蹟保存站)
              </div>
            </div>
          `,
          className: "",
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        const tainanMarker = L.marker([22.9972, 120.2126], { icon: tainanIcon });
        tainanMarker.bindPopup(`
          <div style="font-family: 'Noto Serif TC', serif; line-height: 1.6; padding: 4px; color: #2b2a25; width: 230px;">
            <h3 style="margin: 0 0 6px; font-weight: 700; color: #9e462e; border-bottom: 2px solid #dfd8bc; padding-bottom: 4px; font-size: 14px;">
              🚉 國定古蹟：台南火車站
            </h3>
            <p style="margin: 0 0 6px; font-size: 12px; text-align: justify; color: #333;">
              台南車站為台南市的核心交通門戶。目前正推動「鐵路地下化」地景工程，採<b>「新舊共存」</b>手法完整保留巴洛克式經典近代國定古蹟站體，並於其下方興建現代化雙層地下新站區。
            </p>
            <p style="margin: 0; font-size: 11px; color: #5d614e; border-top: 1px dashed #dfd8bc; padding-top: 4px;">
              📍 鐵道核心軸線中心座標：22.9972° N, 120.2126° E
            </p>
          </div>
        `);
        stationsLayerRef.current.addLayer(tainanMarker);

        // Linsen Station
        const linsenIcon = L.divIcon({
          html: `
            <div style="position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <div class="custom-station-pulse" style="width: 14px; height: 14px; border-radius: 50%;"></div>
              <div class="custom-station-label" style="position: absolute; bottom: 20px; text-shadow: 0 1px 1px rgba(0,0,0,0.15);">
                林森車站 (未來新站)
              </div>
            </div>
          `,
          className: "",
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });

        const linsenMarker = L.marker([22.9837, 120.2173], { icon: linsenIcon });
        linsenMarker.bindPopup(`
          <div style="font-family: 'Noto Serif TC', serif; line-height: 1.6; padding: 4px; color: #2b2a25; width: 220px;">
            <h3 style="margin: 0 0 6px; font-weight: 700; color: #9e462e; border-bottom: 2px solid #dfd8bc; padding-bottom: 4px; font-size: 13px;">
              🚉 增設站：林森車站 (Linsen Station)
            </h3>
            <p style="margin: 0 0 6px; font-size: 12px; text-align: justify; color: #333;">
              地下化新增之通勤車站，座落於林森路一段（鄰近成大校區、衛生局旁）。未來將結合地上綠園廊道景觀，大幅提振成大商圈及周邊社區的綠能通勤機能。
            </p>
            <p style="margin: 0; font-size: 11px; color: #5d614e; border-top: 1px dashed #dfd8bc; padding-top: 4px;">
              📍 鐵道軸線座標：22.9837° N, 120.2173° E
            </p>
          </div>
        `);
        stationsLayerRef.current.addLayer(linsenMarker);

        // South Tainan Station
        const southTainanIcon = L.divIcon({
          html: `
            <div style="position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              <div class="custom-station-pulse" style="width: 14px; height: 14px; border-radius: 50%;"></div>
              <div class="custom-station-label" style="position: absolute; bottom: 20px; text-shadow: 0 1px 1px rgba(0,0,0,0.15);">
                南台南車站 (未來新站)
              </div>
            </div>
          `,
          className: "",
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });

        const southTainanMarker = L.marker([22.9712, 120.2188], { icon: southTainanIcon });
        southTainanMarker.bindPopup(`
          <div style="font-family: 'Noto Serif TC', serif; line-height: 1.6; padding: 4px; color: #2b2a25; width: 220px;">
            <h3 style="margin: 0 0 6px; font-weight: 700; color: #9e462e; border-bottom: 2px solid #dfd8bc; padding-bottom: 4px; font-size: 13px;">
              🚉 增設站：南台南車站 (South Tainan)
            </h3>
            <p style="margin: 0 0 6px; font-size: 12px; text-align: justify; color: #333;">
              日治時期曾設有貨運车站，地下化工程將於原址（生產路旁）重新啟用通勤客運機能，銜接台南副都市中心計畫。
            </p>
            <p style="margin: 0; font-size: 11px; color: #5d614e; border-top: 1px dashed #dfd8bc; padding-top: 4px;">
              📍 鐵道軸線座標：22.9712° N, 120.2188° E
            </p>
          </div>
        `);
        stationsLayerRef.current.addLayer(southTainanMarker);
      }
    }

    // 2. Draw Buffer Zone Area (1km Buffer Area)
    if (bufferGeoJsonRef.current) {
      map.removeLayer(bufferGeoJsonRef.current);
    }

    if (showBuffer) {
      const turfLine = turf.lineString(RAILWAY_CORE_AXIS.map(([lat, lng]) => [lng, lat]));
      const buffer = turf.buffer(turfLine, bufferDistance / 1000, { units: "kilometers" });
      
      bufferGeoJsonRef.current = L.geoJSON(buffer, {
        style: {
          color: "#9e462e",
          weight: 1.5,
          opacity: 0.25,
          fillColor: "#efead8", // Muted warm linen
          fillOpacity: 0.35
        }
      }).addTo(map);
    }

    // Concentric Buffers
    // 500m Buffer
    // @ts-ignore
    if (map.buffer500Layer) {
      // @ts-ignore
      map.removeLayer(map.buffer500Layer);
      // @ts-ignore
      map.buffer500Layer = null;
    }
    if (showBuffer500) {
      const turfLine = turf.lineString(RAILWAY_CORE_AXIS.map(([lat, lng]) => [lng, lat]));
      const b = turf.buffer(turfLine, 0.5, { units: "kilometers" });
      // @ts-ignore
      map.buffer500Layer = L.geoJSON(b, {
        style: {
          color: "#16a34a",
          weight: 1.2,
          opacity: 0.4,
          fillColor: "#4ade80",
          fillOpacity: 0.08
        }
      }).addTo(map);
    }

    // 1000m Buffer
    // @ts-ignore
    if (map.buffer1000Layer) {
      // @ts-ignore
      map.removeLayer(map.buffer1000Layer);
      // @ts-ignore
      map.buffer1000Layer = null;
    }
    if (showBuffer1000) {
      const turfLine = turf.lineString(RAILWAY_CORE_AXIS.map(([lat, lng]) => [lng, lat]));
      const b = turf.buffer(turfLine, 1.0, { units: "kilometers" });
      // @ts-ignore
      map.buffer1000Layer = L.geoJSON(b, {
        style: {
          color: "#ea580c",
          weight: 1.2,
          opacity: 0.4,
          fillColor: "#fbe0c3",
          fillOpacity: 0.06
        }
      }).addTo(map);
    }

    // 1500m Buffer
    // @ts-ignore
    if (map.buffer1500Layer) {
      // @ts-ignore
      map.removeLayer(map.buffer1500Layer);
      // @ts-ignore
      map.buffer1500Layer = null;
    }
    if (showBuffer1500) {
      const turfLine = turf.lineString(RAILWAY_CORE_AXIS.map(([lat, lng]) => [lng, lat]));
      const b = turf.buffer(turfLine, 1.5, { units: "kilometers" });
      // @ts-ignore
      map.buffer1500Layer = L.geoJSON(b, {
        style: {
          color: "#2563eb",
          weight: 1.2,
          opacity: 0.4,
          fillColor: "#bfdbfe",
          fillOpacity: 0.04
        }
      }).addTo(map);
    }

    // Adjust view limits on first load
    if (properties.length > 0 && map.getZoom() === 14) {
      map.fitBounds(L.polyline(RAILWAY_CORE_AXIS).getBounds(), { padding: [50, 50] });
    }

  }, [bufferDistance, showBuffer, showCoreLine, properties, mapReady, showBuffer500, showBuffer1000, showBuffer1500]);

  // Handle Filtration and Dynamic Rendering of Points & Heatmap
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const currentData = effectiveDataMode === "price" ? properties : rentals;

    // Filter properties client-side
    const filtered = currentData.filter(p => {
      const matchYear = selectedYear === "all" || p.year.toString() === selectedYear;
      const matchType = selectedType === "all" || p.buildingType === selectedType;
      
      const priceVal = effectiveDataMode === "price" ? (p as any).unitPricePing : (p as any).unitRentPing;
      const minPriceLimit = effectiveDataMode === "price" ? minHousePrice : minRentPrice;
      const maxPriceLimit = effectiveDataMode === "price" ? maxHousePrice : maxRentPrice;
      const matchPrice = priceVal >= minPriceLimit && priceVal <= maxPriceLimit;
      
      const matchDistance = p.distanceMeters <= bufferDistance;
      return matchYear && matchType && matchPrice && matchDistance;
    });

    setFilteredProperties(filtered);

    // A. Re-Render Scatter Elements
    if (pointsLayerGroupRef.current) {
      pointsLayerGroupRef.current.clearLayers();
    }

    if (showPoints && pointsLayerGroupRef.current) {
      filtered.forEach(p => {
        // Color mapping: Warm reds for high, muted sands for medium, olive/sage for affordable
        let color = "#5d614e"; // Muted Olive
        const val = effectiveDataMode === "price" ? (p as any).unitPricePing : (p as any).unitRentPing;
        if (effectiveDataMode === "price") {
          if (val >= 45) {
            color = "#c35a3e"; // Terracotta
          } else if (val >= 35) {
            color = "#d98a6c"; // Soft Sand-red
          } else if (val >= 25) {
            color = "#dfd8bc"; // Soft linen gold
          } else {
            color = "#7b8a74"; // Sage Green
          }
        } else {
          // Rental prices generally range from 300 to 1800 元/坪/月
          if (val >= 1000) {
            color = "#c35a3e"; // Glazed Pottery Red (high)
          } else if (val >= 750) {
            color = "#d98a6c"; // Soft orange/amber (mid)
          } else if (val >= 500) {
            color = "#dfd8bc"; // Soft linen gold (mid-low)
          } else {
            color = "#7b8a74"; // Grass Green (low)
          }
        }

        let radius = 6;
        if (effectiveDataMode === "price") {
          radius = Math.max(4, Math.min(14, 4 + ((p as any).unitPricePing - 15) * 0.15));
        } else {
          radius = Math.max(4, Math.min(14, 4 + ((p as any).unitRentPing - 300) * 0.007));
        }

        const marker = L.circleMarker([p.lat, p.lng], {
          radius: radius,
          fillColor: color,
          fillOpacity: 0.85,
          color: "#ffffff",
          weight: 1.5,
        });

        const popupContent = effectiveDataMode === "price" ? `
          <div style="font-family: 'Noto Serif TC', serif; font-size:13px; line-height: 1.6; color: #32302a; width: 220px;">
            <div style="font-weight: 700; border-bottom: 2px solid #c35a3e; padding-bottom: 5px; margin-bottom: 8px; font-size:14px; color: #9e462e;">
              📍實價登錄買賣交易
            </div>
            <div style="margin-bottom: 4px;"><b>行政區：</b>${p.district}</div>
            <div style="margin-bottom: 4px;"><b>土地位置建物門牌：</b>${p.address}</div>
            <div style="margin-bottom: 4px;"><b>交易年月：</b>${p.date}</div>
            <div style="margin-bottom: 4px;"><b>建物型態：</b>${p.buildingType}</div>
            <div style="margin-top: 6px; padding: 6px; background: #faf7f0; border: 1px solid #dfd8bc; border-radius: 4px; text-align: center; font-weight:600;">
              <div style="font-size: 11px; color: #555;">交易總價：<span style="color: #222; font-size: 12px;">${(p as any).totalPrice} 萬元</span> (${p.areaPing} 坪)</div>
              <div style="font-size: 14px; color:#c35a3e; margin-top:3px; font-weight: 700;">每坪單價：${(p as any).unitPricePing} 萬/坪</div>
            </div>
            <div style="font-size: 11px; color: #5d614e; text-align: left; margin-top: 8px; border-top: 1px dashed #dfd8bc; padding-top: 6px;">
              🚂 距離鐵軌核心軸線：<b>${p.distanceMeters} 公尺</b>
            </div>
          </div>
        ` : `
          <div style="font-family: 'Noto Serif TC', serif; font-size:13px; line-height: 1.6; color: #32302a; width: 220px;">
            <div style="font-weight: 700; border-bottom: 2px solid #1e3a8a; padding-bottom: 5px; margin-bottom: 8px; font-size:14px; color: #1e3a8a;">
              🔑實價登錄租賃交易
            </div>
            <div style="margin-bottom: 4px;"><b>行政區：</b>${p.district}</div>
            <div style="margin-bottom: 4px;"><b>土地位置建物門牌：</b>${p.address}</div>
            <div style="margin-bottom: 4px;"><b>租賃年月：</b>${p.date}</div>
            <div style="margin-bottom: 4px;"><b>建物型態：</b>${p.buildingType}</div>
            <div style="margin-top: 6px; padding: 6px; background: #faf7f0; border: 1px solid #dfd8bc; border-radius: 4px; text-align: center; font-weight:600;">
              <div style="font-size: 11px; color: #555;">每月租金：<span style="color: #222; font-size: 12px;">${(p as any).monthlyRent} 元</span> (${p.areaPing} 坪)</div>
              <div style="font-size: 14px; color:#1e3a8a; margin-top:3px; font-weight: 700;">每坪租金：${(p as any).unitRentPing} 元/坪/月</div>
            </div>
            <div style="font-size: 11px; color: #5d614e; text-align: left; margin-top: 8px; border-top: 1px dashed #dfd8bc; padding-top: 6px;">
              🚂 距離鐵軌核心軸線：<b>${p.distanceMeters} 公尺</b>
            </div>
          </div>
        `;

        marker.bindPopup(popupContent);
        pointsLayerGroupRef.current?.addLayer(marker);
      });
    }

    // B. Re-Render Heatmap Layer
    if (heatLayerRef.current) {
      map.removeLayer(heatLayerRef.current);
    }

    if (showHeatMap && filtered.length > 0 && heatmapPluginLoaded) {
      // Leaflet.heat takes [lat, lng, intensity]
      const heatData = filtered.map(p => {
        const val = effectiveDataMode === "price" ? (p as any).unitPricePing : (p as any).unitRentPing;
        const intensity = effectiveDataMode === "price" 
          ? Math.min(val / 70, 1.0) 
          : Math.min(val / 1500, 1.0);
        return [p.lat, p.lng, intensity];
      });

      // @ts-ignore
      heatLayerRef.current = createCustomHeatLayer(heatData, {
        radius: 30,
        blur: 20,
        maxZoom: 16,
        gradient: {
          0.2: "#7b8a74", // Sage low
          0.5: "#dfd8bc", // Muted linen med
          0.8: "#d98a6c", // Soft peach high
          1.0: "#c35a3e"  // Terracotta extreme
        }
      }).addTo(map);
    }

  }, [properties, rentals, effectiveDataMode, selectedYear, selectedType, minHousePrice, maxHousePrice, minRentPrice, maxRentPrice, bufferDistance, showHeatMap, showPoints, heatmapPluginLoaded, mapReady]);

  // Handle rendering of commercial facilities (沿線商業設施分布)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (shopsLayerGroupRef.current) {
      shopsLayerGroupRef.current.clearLayers();
    } else {
      shopsLayerGroupRef.current = L.layerGroup().addTo(map);
    }

    if (showShops && shopsLayerGroupRef.current) {
      displayedShops.forEach(shop => {
        // Color mapping and emojis for each category
        let colorClass = "bg-green-600";
        let emoji = "🏪";
        
        switch (shop.category) {
          case "便利商店":
            colorClass = "bg-green-600";
            emoji = "🏪";
            break;
          case "超市":
            colorClass = "bg-emerald-700";
            emoji = "🛒";
            break;
          case "咖啡廳":
            colorClass = "bg-[#7c2d12]"; // warm brown
            emoji = "☕";
            break;
          case "餐廳":
            colorClass = "bg-orange-500";
            emoji = "🍔";
            break;
          case "百貨商場":
            colorClass = "bg-purple-600";
            emoji = "🏬";
            break;
          case "銀行":
            colorClass = "bg-blue-600";
            emoji = "🏦";
            break;
          case "藥局":
            colorClass = "bg-red-500";
            emoji = "💊";
            break;
        }

        const shopIcon = L.divIcon({
          html: `
            <div class="flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] ${colorClass} shadow-md border-2 border-white transform hover:scale-125 transition-transform duration-200">
              <span>${emoji}</span>
            </div>
          `,
          className: "",
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        const marker = L.marker([shop.lat, shop.lng], { icon: shopIcon });
        marker.bindPopup(`
          <div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; padding: 4px; color: #2b2a25; width: 200px;">
            <h4 style="margin: 0 0 4px; font-weight: 700; color: #1e293b; font-size: 13px;">${shop.name}</h4>
            <div style="font-size: 11px; margin-bottom: 4px;">
              <span style="background-color: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-weight: 500; color: #475569;">${shop.category}</span>
            </div>
            <p style="margin: 0 0 4px; font-size: 11px; color: #64748b;">📍 ${shop.address}</p>
            <p style="margin: 0; font-size: 11px; font-weight: 600; color: #b45309; border-top: 1px dashed #e2e8f0; padding-top: 4px;">
              📏 距綠園道中軸：${Math.round(shop.distanceMeters)} 公尺
            </p>
          </div>
        `);
        shopsLayerGroupRef.current?.addLayer(marker);
      });
    }
  }, [displayedShops, showShops, mapReady]);

  // Unique attribute aggregators for filters
  const uniqueYears = React.useMemo(() => {
    const currentData = effectiveDataMode === "price" ? properties : rentals;
    return Array.from(new Set(currentData.map(p => p.year))).sort((a: any, b: any) => Number(b) - Number(a));
  }, [properties, rentals, effectiveDataMode]);

  const uniqueTypes = React.useMemo(() => {
    const currentData = effectiveDataMode === "price" ? properties : rentals;
    return Array.from(new Set(currentData.map(p => p.buildingType))).sort();
  }, [properties, rentals, effectiveDataMode]);

  // Request AI Insights
  const askAI = async (customPrompt?: string) => {
    setAiLoading(true);
    setAiResponse("");
    const defaultPrompt = effectiveDataMode === "price"
      ? "請根據目前的篩選條件數據，為此地圖進行空間買賣價格剖析與增幅展望。"
      : "請根據目前的篩選條件數據，為此地圖進行空間租賃行情剖析與租金衰減展望。";
    const promptToSend = customPrompt || aiPrompt || defaultPrompt;

    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stats: {
            count: stats.count,
            avgPrice: stats.avgPrice,
            medianPrice: stats.medianPrice,
            maxPrice: stats.maxPrice,
            minPrice: stats.minPrice,
            z250: stats.z250,
            z500: stats.z500,
            z750: stats.z750,
            z1000: stats.z1000,
            z1500: stats.z1500,
            isRent: effectiveDataMode === "rent"
          },
          prompt: promptToSend
        })
      });

      if (!res.ok) throw new Error("AI 解析伺服器發生異常");
      const data = await res.json();
      setAiResponse(data.analysis || "無解析結果，請稍後重試。");
    } catch (err: any) {
      setAiResponse(`### [分析錯誤]\n\n無法完成空間分析: ${err.message}`);
    } finally {
      setAiLoading(false);
    }
  };

  // Drag and drop / File upload handlers for Custom MoI CSV Data
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await processUploadFile(files[0]);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processUploadFile(files[0]);
    }
  };

  const processUploadFile = async (file: File) => {
    if (!file.name.endsWith(".csv")) {
      setUploadStatus({
        type: "error",
        msg: "對不起，只支援內政部標準 CSV 實價登錄格式之檔案類型 (.csv)"
      });
      return;
    }

    setUploadStatus({
      type: "info",
      msg: "正在解析與進行地址經緯度定位定位... 請稍候..."
    });

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const text = event.target?.result as string;
        try {
          const response = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ csvData: text, isRent: effectiveDataMode === "rent" })
          });

          const result = await response.json();
          if (response.ok && result.success) {
            setUploadStatus({
              type: "success",
              msg: `${result.message} 頁面隨即重載。`
            });
            setTimeout(() => {
              fetchAllData();
              setUploadStatus({ type: null, msg: null });
            }, 2500);
          } else {
            setUploadStatus({
              type: "error",
              msg: result.error || "整合實價登錄 CSV 失敗，請確認欄位格式"
            });
          }
        } catch (err: any) {
          setUploadStatus({
            type: "error",
            msg: "傳送檔案伺服器錯誤: " + err.message
          });
        }
      };
      reader.readAsText(file);
    } catch (err: any) {
      setUploadStatus({
        type: "error",
        msg: "讀取檔案失敗: " + err.message
      });
    }
  };

  return (
    <div className="flex flex-col lg:flex-row h-screen w-screen bg-linen-50 font-sans text-earth-900 overflow-hidden">
      
      {/* 1. Left Control Panel & Analytics (Artistic-Literary Layout) */}
      <aside className="w-full lg:w-[480px] flex flex-col h-1/2 lg:h-full border-r border-linen-300 bg-linen-100 shadow-sm z-10 overflow-y-auto">
        
        {/* Header Block with Literary Title */}
        <div className="p-6 pb-4 border-b border-linen-200">
          <div className="flex items-center gap-2 text-clay-600 mb-1">
            <Compass className="w-5 h-5 animate-pulse" />
            <span className="text-xs font-mono tracking-widest font-semibold uppercase">Tainan Urban Renewal</span>
          </div>
          <h1 className="text-2xl font-serif font-bold tracking-tight text-earth-950">
            {activeTab === "opinion" ? "鐵道地下化廊帶 ｜ 民意輿論模擬" : `台南鐵路地下化 ｜ 空間${effectiveDataMode === "price" ? "房價" : "房租"}熱力圖`}
          </h1>
          <p className="text-xs font-serif text-olive-600 italic mt-2 leading-relaxed">
            {activeTab === "opinion" 
              ? "利用生成式 AI（Gemini）深度模擬台南鐵道地下化與萬坪綠廊沿線不同背景群體、世代與社會角色的政策立場、核心疑慮與具體建言。"
              : "以「台南車站 → 東門路廊帶 → 仁德」都市更新與地景重建沿線為分析焦點，研析文化古都地景再造與不動產價值的雅致共生。"}
          </p>
        </div>

        {/* 三標籤頁 Tabs */}
        <div className="flex border-b border-linen-200 bg-linen-150">
          <button
            id="tab-price"
            onClick={() => {
              setActiveTab("price");
              setEffectiveDataMode("price");
              setSelectedYear("all");
              setSelectedType("all");
            }}
            className={`flex-1 py-3 text-center text-[11px] font-serif font-bold transition-all duration-300 border-b-2 ${
              activeTab === "price"
                ? "border-clay-600 text-clay-700 bg-linen-50"
                : "border-transparent text-olive-600 hover:text-earth-900 hover:bg-linen-100/50"
            }`}
          >
            沿線房價熱力
          </button>
          <button
            id="tab-rent"
            onClick={() => {
              setActiveTab("rent");
              setEffectiveDataMode("rent");
              setSelectedYear("all");
              setSelectedType("all");
            }}
            className={`flex-1 py-3 text-center text-[11px] font-serif font-bold transition-all duration-300 border-b-2 ${
              activeTab === "rent"
                ? "border-clay-600 text-clay-700 bg-linen-50"
                : "border-transparent text-olive-600 hover:text-earth-900 hover:bg-linen-100/50"
            }`}
          >
            沿線房租熱力
          </button>
          <button
            id="tab-opinion"
            onClick={() => {
              setActiveTab("opinion");
            }}
            className={`flex-1 py-3 text-center text-[11px] font-serif font-bold transition-all duration-300 border-b-2 ${
              activeTab === "opinion"
                ? "border-clay-600 text-clay-700 bg-linen-50"
                : "border-transparent text-olive-600 hover:text-earth-900 hover:bg-linen-100/50"
            }`}
          >
            民意 輿論
          </button>
        </div>

        {/* 民意輿論政策模擬與分析界面 */}
        {activeTab === "opinion" && (
          <div className="flex-1 flex flex-col p-6 space-y-5 bg-linen-50/55 backdrop-blur-[2px]">
            {/* 1. 政策方案與模擬設定 */}
            <div className="bg-linen-150 border border-linen-200 p-4 rounded-xl space-y-4 shadow-[0_2px_8px_rgba(0,0,0,0.01)]">
              <div className="flex items-center gap-2 text-earth-900 font-serif font-semibold text-sm">
                <Sliders className="w-4 h-4 text-clay-600" />
                <span>政策輿情模擬設定</span>
              </div>

              {/* 唯讀/控制地圖狀態的切換 */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block text-olive-700 font-serif mb-1">模擬基礎市場</label>
                    <div className="flex rounded-md overflow-hidden border border-linen-300">
                      <button
                        onClick={() => setEffectiveDataMode("price")}
                        className={`flex-1 py-1.5 text-center transition-colors ${effectiveDataMode === "price" ? "bg-clay-600 text-white font-semibold" : "bg-white text-olive-600"}`}
                      >
                        買賣房價
                      </button>
                      <button
                        onClick={() => setEffectiveDataMode("rent")}
                        className={`flex-1 py-1.5 text-center transition-colors ${effectiveDataMode === "rent" ? "bg-clay-600 text-white font-semibold" : "bg-white text-olive-600"}`}
                      >
                        租賃行情
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-olive-700 font-serif mb-1">空間影響半徑</label>
                    <select
                      value={bufferDistance}
                      onChange={(e) => setBufferDistance(Number(e.target.value))}
                      className="w-full bg-white border border-linen-300 rounded-md py-1.5 px-2 focus:outline-none focus:border-clay-600"
                    >
                      <option value={500}>500m (核心圈)</option>
                      <option value={1000}>1000m (主體圈)</option>
                      <option value={1500}>1500m (擴散圈)</option>
                    </select>
                  </div>
                </div>

                {/* 自動同步的地圖狀態摘要 */}
                <div className="p-3 bg-linen-50 rounded-lg border border-linen-200/50 space-y-1.5 text-[11px] font-serif leading-relaxed text-olive-800">
                  <div className="font-bold text-earth-900 flex items-center gap-1">
                    <Compass className="w-3.5 h-3.5 text-clay-600" />
                    <span>當前空間特徵 (已自動帶入)</span>
                  </div>
                  <div>● 區域行情均值：<span className="font-mono font-bold text-clay-700">{stats.avgPrice}</span> {effectiveDataMode === "price" ? "萬/坪" : "元/坪/月"}</div>
                  <div>● 機能商家總量：<span className="font-mono font-bold text-clay-700">{shopStats.total}</span> 家</div>
                  <div>● 與綠廊中軸線：廊帶核心 0 - 250m 至 1500m 空間帶</div>
                </div>
              </div>

              {/* 政策方案文字輸入框 */}
              <div className="space-y-1.5">
                <label className="block text-xs font-serif text-olive-700 font-semibold">政策方案情境文字</label>
                <textarea
                  value={policyScenario}
                  onChange={(e) => setPolicyScenario(e.target.value)}
                  placeholder="請輸入政策方案，例如：增加步行空間、減少停車、增加商業活動、提高綠化比例..."
                  className="w-full bg-white border border-linen-300 rounded-md p-2.5 text-xs focus:outline-none focus:border-clay-700 leading-relaxed font-serif"
                  rows={3}
                />
                <p className="text-[10px] text-gray-500 font-serif">說明：本文字與上述空間特徵，將做為四個民意 Agent 的模擬依據。</p>
              </div>

              {/* 開始模擬按鈕 */}
              <button
                onClick={async () => {
                  setSimulationLoading(true);
                  setSimulationError(null);
                  try {
                    const response = await fetch("/api/agent-simulation", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        isRent: effectiveDataMode === "rent",
                        bufferSize: bufferDistance,
                        avgPrice: stats.avgPrice,
                        shopCount: shopStats.total,
                        distanceToGreenway: 150,
                        policyScenario: policyScenario
                      })
                    });
                    if (!response.ok) throw new Error("模擬請求失敗，請確認後端服務。");
                    const data = await response.json();
                    if (data.agents) {
                      setSimulationResults(data.agents);
                    } else {
                      throw new Error("回傳資料格式有誤。");
                    }
                  } catch (err: any) {
                    setSimulationError(err.message || "未知錯誤");
                  } finally {
                    setSimulationLoading(false);
                  }
                }}
                disabled={simulationLoading}
                className="w-full bg-clay-600 hover:bg-clay-700 text-white text-xs font-serif py-2.5 px-3 rounded-md shadow-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-55 font-bold cursor-pointer"
              >
                {simulationLoading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>正在喚醒 4 位 AI 社會角色 Agent 進行政策意向模擬中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>開始 Agent 模擬</span>
                  </>
                )}
              </button>

              {simulationError && (
                <div className="bg-red-50 text-red-800 text-[11px] p-2.5 rounded border border-red-200 leading-normal font-serif">
                  ⚠️ 模擬出錯：{simulationError}
                </div>
              )}
            </div>

            {/* 2. 角色卡片展示區 */}
            <div className="space-y-4 overflow-y-auto pr-1">
              <div className="text-xs font-serif font-bold text-earth-900 border-b border-linen-200 pb-2 flex items-center justify-between">
                <span>角色政策意向與回饋</span>
                {simulationResults && <span className="text-[10px] text-clay-600 bg-clay-50 px-2 py-0.5 rounded-full">已完成模擬</span>}
              </div>

              {[
                {
                  id: "net",
                  name: "網路輿論場",
                  emoji: "💬",
                  description: "代表社群媒體、PTT、Dcard 與在地粉專上的網路匿名群體。多由中青年網友組成，注重公平正義、都市美學、工程進度與八卦討論。",
                  coreConcerns: ["居住正義與房價透明度", "捷運與地下化工程進度", "人行道寬度與都市美學", "公有土地開發方向"],
                },
                {
                  id: "young_resident",
                  name: "青年在地居民",
                  emoji: "🏡",
                  description: "25-40 歲的在地青年，包含成大畢業留台南工作的上班族、小家庭。關心長期定居、托育空間、房價可負擔性與通勤便利度。",
                  coreConcerns: ["青年購屋房價可負擔性", "公托幼兒園與公園遊戲空間", "林森與南台南新站通勤便利性", "高素質青年就業機會"],
                },
                {
                  id: "young_student",
                  name: "青年短居學生",
                  emoji: "🎓",
                  description: "成功大學、台南大學等周圍高校在校生或剛畢業的短租族。租屋居住 2-6 年，著重日常消費便利度、房租水準與學生路權。",
                  coreConcerns: ["套房雅房房租水準", "生活機能（超商/超市/餐飲）", "租屋安全與消防保障", "機車與自行車友善路權"],
                },
                {
                  id: "senior_resident",
                  name: "高齡在地居民",
                  emoji: "🍵",
                  description: "60 歲以上、世代居住於東區或北區沿線的長者。對歷史地景有深厚感情，著重養老環境、無障礙設施與鄰里社交。",
                  coreConcerns: ["台南老站與鐵道歷史記憶保存", "公園綠地多寡與全齡無障礙空間", "成大醫院與醫療設施可達性", "住宅區的寧靜與安全生活品質"]
                }
              ].map((agent) => {
                const sim = simulationResults ? simulationResults.find(s => s.name === agent.name || agent.name.includes(s.name) || s.name.includes(agent.name)) : null;
                
                return (
                  <div key={agent.id} className="bg-white border border-linen-200 rounded-xl p-4 shadow-[0_2px_8px_rgba(0,0,0,0.015)] space-y-3.5 transition-all hover:shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
                    {/* Header: Emoji, Name, Character Type */}
                    <div className="flex justify-between items-start">
                      <div className="flex gap-2.5">
                        <span className="text-2xl">{agent.emoji}</span>
                        <div>
                          <h3 className="text-sm font-serif font-bold text-earth-950">{agent.name}</h3>
                          <p className="text-[10px] font-serif text-olive-600 mt-0.5">台南鐵道地下化廊帶主要利害關係群體</p>
                        </div>
                      </div>

                      {/* Support Score Badge */}
                      {sim ? (
                        <div className="text-right">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-serif font-bold ${
                            sim.supportScore >= 80 
                              ? "bg-emerald-50 text-emerald-700" 
                              : sim.supportScore >= 50 
                              ? "bg-amber-50 text-amber-700" 
                              : "bg-red-50 text-red-700"
                          }`}>
                            {sim.supportScore >= 80 ? "高度支持" : sim.supportScore >= 50 ? "理性觀望" : "高度疑慮"}
                          </span>
                          <div className="text-lg font-mono font-black text-clay-700 mt-1">{sim.supportScore}<span className="text-[10px] font-normal text-olive-600">分</span></div>
                        </div>
                      ) : (
                        <span className="text-[11px] text-gray-400 font-serif bg-gray-50 px-2 py-0.5 rounded-full">未模擬</span>
                      )}
                    </div>

                    {/* Description (角色背景) */}
                    <div className="text-[11px] font-serif text-olive-700 bg-linen-50/65 p-2.5 rounded-lg leading-relaxed text-justify">
                      <strong className="text-earth-900 block mb-1">【角色背景】</strong>
                      {agent.description}
                    </div>

                    {/* Core concerns (關心議題) */}
                    <div className="text-[11px] font-serif text-olive-800 space-y-1">
                      <strong className="text-earth-900 block mb-1">【長期關心之議題】</strong>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {agent.coreConcerns.map((concern, idx) => (
                          <span key={idx} className="bg-linen-150 text-[10px] px-2 py-0.5 rounded-md border border-linen-200/50 text-olive-700">{concern}</span>
                        ))}
                      </div>
                    </div>

                    {/* Simulated Output (支持度分數 0-100, 主要疑慮, 政策建議, 角色觀點) */}
                    {sim ? (
                      <div className="border-t border-linen-150 pt-3.5 space-y-3.5">
                        {/* Support score progress bar */}
                        <div>
                          <div className="flex justify-between text-[10px] text-earth-900 font-serif mb-1">
                            <span>模擬支持度評分</span>
                            <span className="font-mono font-bold text-clay-600">{sim.supportScore}%</span>
                          </div>
                          <div className="w-full bg-linen-200 h-1.5 rounded-full overflow-hidden">
                            <div 
                              className={`h-1.5 rounded-full transition-all duration-1000 ${
                                sim.supportScore >= 80 
                                  ? "bg-emerald-600" 
                                  : sim.supportScore >= 50 
                                  ? "bg-amber-500" 
                                  : "bg-red-500"
                              }`}
                              style={{ width: `${sim.supportScore}%` }}
                            ></div>
                          </div>
                        </div>

                        {/* Concerns (主要疑慮) */}
                        <div className="text-[11px] font-serif leading-relaxed text-olive-900 space-y-1">
                          <strong className="text-red-700 block mb-1">⚠️ 角色之主要疑慮與痛點：</strong>
                          <ul className="list-disc pl-4 space-y-1 text-justify">
                            {sim.concerns && sim.concerns.map((c: string, idx: number) => (
                              <li key={idx}>{c}</li>
                            ))}
                          </ul>
                        </div>

                        {/* Suggestions (政策建議) */}
                        <div className="text-[11px] font-serif leading-relaxed text-olive-900 space-y-1">
                          <strong className="text-emerald-700 block mb-1">💡 對政策方案的具體建言：</strong>
                          <ul className="list-disc pl-4 space-y-1 text-justify">
                            {sim.suggestions && sim.suggestions.map((s: string, idx: number) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ul>
                        </div>

                        {/* Summary / Viewpoint (角色觀點) */}
                        <div className="bg-clay-50/45 border border-clay-100 p-3 rounded-lg text-[11px] font-serif italic leading-relaxed text-earth-900 text-justify relative mt-2.5">
                          <span className="absolute -top-2.5 left-2.5 bg-white px-1 text-[10px] font-bold text-clay-700 not-italic">💬 角色心聲 (150字內觀點)</span>
                          "{sim.summary}"
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4 bg-linen-50/30 rounded-xl border border-dashed border-linen-200 text-[11px] font-serif text-gray-400">
                        ✨ 點擊上方「開始 Agent 模擬」看 4 位利害關係人的意向反饋與立論。
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 1. LAYER TOGGLES & RANGE CONTROLS */}
        {activeTab !== "opinion" && (
          <section className="p-6 border-b border-linen-200 space-y-5 bg-linen-50/55 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 text-earth-900 font-serif font-semibold text-sm">
            <Sliders className="w-4 h-4 text-clay-600" />
            <span>維度控制篩選</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-serif text-olive-700 mb-1">交易年份</label>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
                className="w-full bg-white border border-linen-300 text-xs rounded-md py-1.5 px-2.5 focus:outline-none focus:border-clay-600"
              >
                <option value="all">全部年度</option>
                {uniqueYears.map(yr => (
                  <option key={yr} value={yr}>{yr} 年</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-serif text-olive-700 mb-1">建物型態</label>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="w-full bg-white border border-linen-300 text-xs rounded-md py-1.5 px-2.5 focus:outline-none focus:border-clay-600 truncate"
              >
                <option value="all">全部型態</option>
                {uniqueTypes.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Sliders */}
          <div className="space-y-4">
            {activeTab === "price" ? (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-serif text-olive-700">
                  <span className="font-semibold text-earth-900">單價區間篩選 (低價 ⇔ 高價)</span>
                  <span className="font-mono text-clay-700 font-bold">
                    {minHousePrice} 〜 {maxHousePrice} 萬/坪
                  </span>
                </div>
                
                {/* Unified Dual-Thumb Slider Container */}
                <div className="relative w-full h-6 flex flex-col justify-center px-1">
                  {/* Gray Background Track */}
                  <div className="absolute left-1 right-1 h-1.5 bg-linen-200 rounded-full" />
                  
                  {/* Active Highlight Track */}
                  <div 
                    className="absolute h-1.5 bg-clay-600 rounded-full"
                    style={{
                      left: `${priceBounds.max === priceBounds.min ? 0 : Math.max(0, Math.min(100, ((minHousePrice - priceBounds.min) / (priceBounds.max - priceBounds.min)) * 100))}%`,
                      width: `${priceBounds.max === priceBounds.min ? 100 : Math.max(0, Math.min(100, ((maxHousePrice - minHousePrice) / (priceBounds.max - priceBounds.min)) * 100))}%`
                    }}
                  />

                  {/* Min Price Slider */}
                  <input
                    type="range"
                    min={priceBounds.min}
                    max={priceBounds.max}
                    value={minHousePrice}
                    onChange={(e) => {
                      const value = Math.min(Number(e.target.value), maxHousePrice - 1);
                      setMinHousePrice(value);
                    }}
                    className="absolute pointer-events-none appearance-none w-full bg-transparent h-5 focus:outline-none [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-clay-700 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-clay-700 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer z-20"
                  />

                  {/* Max Price Slider */}
                  <input
                    type="range"
                    min={priceBounds.min}
                    max={priceBounds.max}
                    value={maxHousePrice}
                    onChange={(e) => {
                      const value = Math.max(Number(e.target.value), minHousePrice + 1);
                      setMaxHousePrice(value);
                    }}
                    className="absolute pointer-events-none appearance-none w-full bg-transparent h-5 focus:outline-none [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-clay-700 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-clay-700 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer z-10"
                  />
                </div>

                {/* Range Labels */}
                <div className="flex justify-between text-[10px] text-gray-400 font-mono px-1">
                  <span>{priceBounds.min} 萬</span>
                  <span>{priceBounds.max} 萬</span>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-serif text-olive-700">
                  <span className="font-semibold text-earth-900">租金區間篩選 (低價 ⇔ 高價)</span>
                  <span className="font-mono text-clay-700 font-bold">
                    {minRentPrice} 〜 {maxRentPrice} 元/坪/月
                  </span>
                </div>

                {/* Unified Dual-Thumb Slider Container */}
                <div className="relative w-full h-6 flex flex-col justify-center px-1">
                  {/* Gray Background Track */}
                  <div className="absolute left-1 right-1 h-1.5 bg-linen-200 rounded-full" />
                  
                  {/* Active Highlight Track */}
                  <div 
                    className="absolute h-1.5 bg-clay-600 rounded-full"
                    style={{
                      left: `${rentBounds.max === rentBounds.min ? 0 : Math.max(0, Math.min(100, ((minRentPrice - rentBounds.min) / (rentBounds.max - rentBounds.min)) * 100))}%`,
                      width: `${rentBounds.max === rentBounds.min ? 100 : Math.max(0, Math.min(100, ((maxRentPrice - minRentPrice) / (rentBounds.max - rentBounds.min)) * 100))}%`
                    }}
                  />

                  {/* Min Rent Slider */}
                  <input
                    type="range"
                    min={rentBounds.min}
                    max={rentBounds.max}
                    step="50"
                    value={minRentPrice}
                    onChange={(e) => {
                      const value = Math.min(Number(e.target.value), maxRentPrice - 50);
                      setMinRentPrice(value);
                    }}
                    className="absolute pointer-events-none appearance-none w-full bg-transparent h-5 focus:outline-none [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-clay-700 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-clay-700 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer z-20"
                  />

                  {/* Max Rent Slider */}
                  <input
                    type="range"
                    min={rentBounds.min}
                    max={rentBounds.max}
                    step="50"
                    value={maxRentPrice}
                    onChange={(e) => {
                      const value = Math.max(Number(e.target.value), minRentPrice + 50);
                      setMaxRentPrice(value);
                    }}
                    className="absolute pointer-events-none appearance-none w-full bg-transparent h-5 focus:outline-none [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-clay-700 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-clay-700 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer z-10"
                  />
                </div>

                {/* Range Labels */}
                <div className="flex justify-between text-[10px] text-gray-400 font-mono px-1">
                  <span>{rentBounds.min} 元</span>
                  <span>{rentBounds.max} 元</span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-serif text-olive-700 mb-1">
                分析範圍 (周邊影響半徑)
              </label>
              <select
                value={bufferDistance}
                onChange={(e) => setBufferDistance(Number(e.target.value))}
                className="w-full bg-white border border-linen-300 text-xs rounded-md py-1.5 px-2.5 focus:outline-none focus:border-clay-600 font-serif"
              >
                <option value={500}>500 公尺</option>
                <option value={1000}>1000 公尺 (1.0 公里)</option>
                <option value={1500}>1500 公尺 (1.5 公里)</option>
              </select>
            </div>
          </div>

          {/* Layer Checks */}
          <div className="pt-3 border-t border-linen-200/60 space-y-3">
            <div className="text-xs font-serif font-bold text-earth-900">圖層切換控制 (Layers)</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeTab === "price" && showHeatMap}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setActiveTab("price");
                      setShowHeatMap(true);
                    } else {
                      setShowHeatMap(false);
                    }
                  }}
                  className="rounded accent-clay-600"
                />
                <span className="font-medium">房價熱力圖</span>
              </label>

              <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeTab === "rent" && showHeatMap}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setActiveTab("rent");
                      setShowHeatMap(true);
                    } else {
                      setShowHeatMap(false);
                    }
                  }}
                  className="rounded accent-clay-600"
                />
                <span className="font-medium">房租熱力圖</span>
              </label>

              <div className="col-span-2 py-1.5 px-2.5 bg-linen-150/40 rounded border border-linen-200/50 space-y-2">
                <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showShops}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setShowShops(checked);
                      if (checked && selectedShopCategories.length === 0) {
                        setSelectedShopCategories(["便利商店", "超市", "咖啡廳", "餐廳", "百貨商場", "銀行", "藥局"]);
                      }
                    }}
                    className="rounded accent-clay-600"
                  />
                  <span className="font-bold text-clay-700">顯示沿線商業設施分布</span>
                </label>

                {showShops && (
                  <div className="pl-5 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-linen-200/60 pt-2 animate-fadeIn">
                    {[
                      { name: "便利商店", emoji: "🏪" },
                      { name: "超市", emoji: "🛒" },
                      { name: "咖啡廳", emoji: "☕" },
                      { name: "餐廳", emoji: "🍔" },
                      { name: "百貨商場", emoji: "🏬" },
                      { name: "銀行", emoji: "🏦" },
                      { name: "藥局", emoji: "💊" }
                    ].map((cat) => {
                      const isChecked = selectedShopCategories.includes(cat.name);
                      return (
                        <label key={cat.name} className="flex items-center gap-1.5 text-[11px] text-olive-600 cursor-pointer hover:text-earth-900 select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setSelectedShopCategories(selectedShopCategories.filter(c => c !== cat.name));
                              } else {
                                setSelectedShopCategories([...selectedShopCategories, cat.name]);
                              }
                            }}
                            className="rounded accent-clay-600 w-3 h-3"
                          />
                          <span className="flex items-center gap-1">
                            <span className="text-xs">{cat.emoji}</span>
                            <span>{cat.name}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCoreLine}
                  onChange={(e) => setShowCoreLine(e.target.checked)}
                  className="rounded accent-clay-600"
                />
                <span>綠園道軸線</span>
              </label>

              <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBuffer500}
                  onChange={(e) => {
                    setShowBuffer500(e.target.checked);
                    if (e.target.checked) {
                      setBufferDistance(500);
                    }
                  }}
                  className="rounded accent-clay-600"
                />
                <span>500m Buffer</span>
              </label>

              <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBuffer1000}
                  onChange={(e) => {
                    setShowBuffer1000(e.target.checked);
                    if (e.target.checked) {
                      setBufferDistance(1000);
                    }
                  }}
                  className="rounded accent-clay-600"
                />
                <span>1000m Buffer</span>
              </label>

              <label className="flex items-center gap-1.5 text-xs font-serif text-olive-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBuffer1500}
                  onChange={(e) => {
                    setShowBuffer1500(e.target.checked);
                    if (e.target.checked) {
                      setBufferDistance(1500);
                    }
                  }}
                  className="rounded accent-clay-600"
                />
                <span>1500m Buffer</span>
              </label>
            </div>
          </div>
        </section>
        )}
        {activeTab !== "opinion" && (
        <section className="p-6 border-b border-linen-200 space-y-4">
          <div className="flex items-center gap-2 text-earth-900 font-serif font-semibold text-sm">
            <TrendingUp className="w-4 h-4 text-clay-600" />
            <span>緩衝區內 · 實價登錄綜合摘要</span>
          </div>

          {loading ? (
            <div className="flex justify-center items-center py-6 text-xs text-olive-600 gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>正在從主伺服器串接真實行情數據...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 text-red-800 text-xs p-3 rounded border border-red-200">
              {error}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-linen-50 border border-linen-200 p-3 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)] col-span-2">
                  <div className="text-[10px] text-gray-500 font-serif mb-0.5">系統真實座標地理有效資料</div>
                  <div className="text-xl font-mono font-bold text-earth-950">
                    {activeTab === "price" ? properties.length : rentals.length}{" "}
                    <span className="text-xs font-serif font-normal text-olive-600">
                      筆高精度真實{activeTab === "price" ? "買賣" : "租賃"}資料
                    </span>
                  </div>
                </div>

                <div className="bg-linen-50 border border-linen-200 p-3 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)]">
                  <div className="text-[10px] text-gray-500 font-serif mb-0.5">範圍內交易筆數</div>
                  <div className="text-xl font-mono font-bold text-earth-950">{stats.count} <span className="text-xs font-serif font-normal">筆</span></div>
                </div>

                <div className="bg-linen-50 border border-linen-200 p-3 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)]">
                  <div className="text-[10px] text-gray-500 font-serif mb-0.5">平均每坪{activeTab === "price" ? "單價" : "租金"}</div>
                  <div className="text-xl font-mono font-bold text-clay-600">
                    {stats.avgPrice} <span className="text-xs font-serif font-normal">{activeTab === "price" ? "萬" : "元"}</span>
                  </div>
                </div>

                <div className="bg-linen-50 border border-linen-200 p-3 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)]">
                  <div className="text-[10px] text-gray-500 font-serif mb-0.5">中位數每坪{activeTab === "price" ? "單價" : "租金"}</div>
                  <div className="text-xl font-mono font-bold text-earth-950">
                    {stats.medianPrice} <span className="text-xs font-serif font-normal">{activeTab === "price" ? "萬" : "元"}</span>
                  </div>
                </div>

                <div className="bg-linen-50 border border-linen-200 p-3 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)]">
                  <div className="text-[10px] text-gray-500 font-serif mb-0.5">最高／最低坪價</div>
                  <div className="text-xs font-mono font-bold text-earth-900 mt-1 leading-tight">
                    最高: <span className="text-clay-600">{stats.maxPrice || 0} {activeTab === "price" ? "萬" : "元"}</span><br />
                    最低: <span className="text-olive-700">{stats.minPrice || 0} {activeTab === "price" ? "萬" : "元"}</span>
                  </div>
                </div>
              </div>

              {/* Distance Band Analysis Visual Listing */}
              <div className="bg-linen-50/80 border border-linen-200 rounded-lg p-4 space-y-2.5">
                <h4 className="text-[11px] font-bold text-olive-600 tracking-wider">
                  🚂 沿線空間定位：距離衰減分析 ({activeTab === "price" ? "萬/坪" : "元/坪/月"})
                </h4>
                
                <div className="space-y-2">
                  {/* Band 1 */}
                  <div>
                    <div className="flex justify-between text-[11px] text-earth-900 font-serif">
                      <span>0 - 250 公尺 (近軸核心圈 - {activeTab === "price" ? "均價" : "均租"})</span>
                      <span className="font-mono font-bold text-clay-600">
                        {stats.z250 ? `${stats.z250} ${activeTab === "price" ? "萬" : "元"} (${stats.c250}筆)` : "無樣本"}
                      </span>
                    </div>
                    <div className="w-full bg-linen-200 h-1.5 rounded-full overflow-hidden mt-1">
                      <div className="bg-clay-600 h-1.5 rounded-full transition-all duration-500" style={{ width: `${Math.min((stats.z250 / (activeTab === "price" ? 80 : 1500)) * 100, 100)}%` }}></div>
                    </div>
                  </div>

                  {/* Band 2 */}
                  <div>
                    <div className="flex justify-between text-[11px] text-earth-900 font-serif">
                      <span>250 - 500 公尺 (主體影響圈 - {activeTab === "price" ? "均價" : "均租"})</span>
                      <span className="font-mono font-bold text-earth-850">
                        {stats.z500 ? `${stats.z500} ${activeTab === "price" ? "萬" : "元"} (${stats.c500}筆)` : "無樣本"}
                      </span>
                    </div>
                    <div className="w-full bg-linen-200 h-1.5 rounded-full overflow-hidden mt-1">
                      <div className="bg-earth-900 h-1.5 rounded-full transition-all duration-500" style={{ width: `${Math.min((stats.z500 / (activeTab === "price" ? 80 : 1500)) * 100, 100)}%` }}></div>
                    </div>
                  </div>

                  {/* Band 3 */}
                  <div>
                    <div className="flex justify-between text-[11px] text-earth-900 font-serif">
                      <span>500 - 1000 公尺 (次級散射圈 - {activeTab === "price" ? "均價" : "均租"})</span>
                      <span className="font-mono font-bold text-olive-600">
                        {stats.z1000 ? `${stats.z1000} ${activeTab === "price" ? "萬" : "元"} (${stats.c1000}筆)` : "無樣本"}
                      </span>
                    </div>
                    <div className="w-full bg-linen-200 h-1.5 rounded-full overflow-hidden mt-1">
                      <div className="bg-olive-600 h-1.5 rounded-full transition-all duration-500" style={{ width: `${Math.min((stats.z1000 / (activeTab === "price" ? 80 : 1500)) * 100, 100)}%` }}></div>
                    </div>
                  </div>

                  {/* Band 4 */}
                  <div>
                    <div className="flex justify-between text-[11px] text-earth-900 font-serif">
                      <span>1000 - 1500 公尺 (散射外圍帶 - {activeTab === "price" ? "均價" : "均租"})</span>
                      <span className="font-mono font-bold text-olive-700">
                        {stats.z1500 ? `${stats.z1500} ${activeTab === "price" ? "萬" : "元"} (${stats.c1500}筆)` : "無樣本"}
                      </span>
                    </div>
                    <div className="w-full bg-linen-200 h-1.5 rounded-full overflow-hidden mt-1">
                      <div className="bg-olive-700 h-1.5 opacity-60 rounded-full transition-all duration-500" style={{ width: `${Math.min((stats.z1500 / (activeTab === "price" ? 80 : 1500)) * 100, 100)}%` }}></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
        )}
        {/* 3. ALONG-LINE LIFESTYLE FUNCTIONALITY ANALYSIS (沿線生活機能分析) */}
        {activeTab !== "opinion" && (
        <section className="p-6 border-b border-linen-200 space-y-4">

          <div className="space-y-4">
            {/* Life Index Card (生活機能指數) */}
            <div className="bg-gradient-to-br from-earth-50 to-linen-50 border border-linen-200 p-4 rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.02)] space-y-3">
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-[11px] text-olive-600 font-serif tracking-wider font-semibold">生活機能綜合指數</div>
                  <div className="text-2xl font-mono font-bold text-clay-700 mt-0.5">
                    {shopStats.indexScore} <span className="text-xs font-serif font-normal text-olive-600">/ 100 分</span>
                  </div>
                </div>
                <div className="relative flex items-center justify-center w-11 h-11 rounded-full border-2 border-linen-200 bg-white shadow-inner">
                  <span className="text-xs font-bold text-clay-700">{shopStats.indexScore >= 80 ? "優" : (shopStats.indexScore >= 50 ? "中" : "低")}</span>
                </div>
              </div>

              {/* Progress bar */}
              <div className="space-y-1">
                <div className="w-full bg-linen-200 h-2 rounded-full overflow-hidden">
                  <div 
                    className="bg-gradient-to-r from-orange-400 to-clay-600 h-2 rounded-full transition-all duration-1000 ease-out" 
                    style={{ width: `${shopStats.indexScore}%` }}
                  ></div>
                </div>
                <div className="flex justify-between text-[9px] text-gray-500 font-serif">
                  <span>低機能</span>
                  <span>一般</span>
                  <span>高機能商圈</span>
                </div>
              </div>
            </div>

            {/* Grid of commercial facility counts */}
            <div className="grid grid-cols-2 gap-3">
              <div className={`bg-linen-50 border border-linen-200 p-3 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)] col-span-2 flex items-center justify-between px-4 transition-opacity ${!showShops ? "opacity-50" : ""}`}>
                <span className="text-xs text-gray-600 font-serif font-medium">🛍️ 沿線商業設施總數</span>
                <span className="text-lg font-mono font-bold text-earth-950">
                  {showShops ? displayedShops.length : 0} / {shopStats.total} <span className="text-xs font-normal text-gray-500">家</span>
                </span>
              </div>

              {[
                { name: "便利商店", count: shopStats.convenience, color: "bg-green-600" },
                { name: "超市", count: shopStats.supermarket, color: "bg-emerald-700" },
                { name: "咖啡廳", count: shopStats.cafe, color: "bg-[#7c2d12]" },
                { name: "餐廳", count: shopStats.restaurant, color: "bg-orange-500" },
                { name: "百貨商場", count: shopStats.mall, color: "bg-purple-600" },
                { name: "銀行", count: shopStats.bank, color: "bg-blue-600" },
                { name: "藥局", count: shopStats.pharmacy, color: "bg-red-500" }
              ].map((cat) => {
                const isActive = showShops && selectedShopCategories.includes(cat.name);
                return (
                  <div 
                    key={cat.name} 
                    className={`border border-linen-200 p-2.5 rounded-lg text-center shadow-[0_2px_4px_rgba(0,0,0,0.01)] transition-all duration-300 ${
                      isActive 
                        ? "bg-linen-50/50 hover:bg-linen-50 opacity-100" 
                        : "bg-linen-200/20 opacity-40 line-through decoration-linen-300 text-gray-400"
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 text-[10px] text-gray-500 font-serif mb-0.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${cat.color}`}></span>
                      <span>{cat.name}</span>
                    </div>
                    <div className="text-base font-mono font-bold text-earth-950">
                      {cat.count} <span className="text-xs font-normal">家</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
        )}
        {activeTab !== "opinion" && (
        <section className="p-6 border-b border-linen-200 space-y-4">

          <div className="space-y-3">
            <p className="text-xs font-serif text-olive-700 leading-relaxed">
              點擊預設或自訂關鍵，結合目前篩選的數據樣本。由 Gemini 主動進行兼具「數據統計科學」與「都市更新專業」的深度空間分析。
            </p>

            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => {
                  const p = "分析核心 250 公尺首要圈的林森與南台南站新站點商業引力效應，並進行專業空間與功能分析。";
                  setAiPrompt(p);
                  askAI(p);
                }}
                disabled={aiLoading}
                className="text-[10px] font-serif bg-linen-50 hover:bg-clay-50 border border-linen-300 text-olive-700 px-2 py-1 rounded transition-colors disabled:opacity-50"
              >
                🌾 分析預期通車效應
              </button>
              <button
                onClick={() => {
                  const p = "聚焦於大同路、榮譽街一帶老舊透天與公寓，探討大同路高架陸橋拆除、鐵路地下整合後的都市更新、商業復甦與縫合展望。";
                  setAiPrompt(p);
                  askAI(p);
                }}
                disabled={aiLoading}
                className="text-[10px] font-serif bg-linen-50 hover:bg-clay-50 border border-linen-300 text-olive-700 px-2 py-1 rounded transition-colors disabled:opacity-50"
              >
                🏘️ 大同路與老宅縫合展望
              </button>
            </div>

            <div className="relative">
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="在此鍵入自訂空間議題或特定路段，例如：『開元高架橋拆除對北端房價衝擊』..."
                className="w-full bg-white border border-linen-300 rounded-md p-2.5 text-xs focus:outline-none focus:border-clay-700"
                rows={3}
              />
              <button
                onClick={() => askAI()}
                disabled={aiLoading}
                className="w-full mt-2 bg-clay-600 hover:bg-clay-700 text-white text-xs font-serif py-2 px-3 rounded-md shadow-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-55"
              >
                {aiLoading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Gemini 正在分析鐵道沿線空間與價位數據...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>啟動 AI 空間與數據分析</span>
                  </>
                )}
              </button>
            </div>

            {aiResponse && (
              <div className="p-4 bg-linen-50 border border-linen-200 rounded-lg text-xs leading-relaxed text-olive-900 mt-2 font-serif select-text max-h-[350px] overflow-y-auto shadow-inner">
                <div className="flex items-center gap-1.5 text-clay-700 font-bold mb-2 border-b border-linen-200 pb-1.5">
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>Gemini 鐵道沿線空間與數據分析報告：</span>
                </div>
                {/* Clean Simple Markdown representation */}
                <div className="space-y-2 whitespace-pre-wrap">
                  {aiResponse}
                </div>
              </div>
            )}
          </div>
        </section>
        )}

        {/* 4. REAL GOVERNMENT CSV UPLOADER */}
        {activeTab !== "opinion" && (
        <section className="p-6 bg-linen-200/50 mt-auto border-t border-linen-200/80">
          <div className="flex items-center gap-2 text-earth-900 font-serif font-semibold text-sm mb-3">
            <FileUp className="w-4 h-4 text-clay-600" />
            <span>自訂實價登錄 CSV 數據匯入</span>
          </div>

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer border-2 border-dashed rounded-lg p-5 text-center transition-all ${
              isDragging ? "border-clay-600 bg-clay-50/50" : "border-linen-300 bg-white hover:border-clay-600"
            }`}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept=".csv"
              className="hidden"
            />
            <FileUp className="w-7 h-7 mx-auto text-gray-400 mb-2" />
            <p className="text-xs font-serif font-semibold text-earth-800">
              將內政部「實價登錄」批次 CSV 檔案拖放於此，或點按上傳
            </p>
            <p className="text-[10px] text-gray-500 font-serif mt-1">
              支援欄位：土地位置建物門牌、鄉鎮市區、總價元、建物移轉總面積平方公尺、建物型態、交易年月依序對應
            </p>
          </div>

          {uploadStatus.msg && (
            <div className={`mt-3 p-3 text-[11px] rounded border ${
              uploadStatus.type === "success" 
                ? "bg-emerald-50 text-emerald-800 border-emerald-200" 
                : uploadStatus.type === "error" 
                ? "bg-red-50 text-red-800 border-red-200" 
                : "bg-amber-50 text-amber-800 border-amber-200 animate-pulse"
            }`}>
              <div className="flex items-center gap-1">
                {uploadStatus.type === "success" && <Check className="w-3.5 h-3.5" />}
                <span>{uploadStatus.msg}</span>
              </div>
            </div>
          )}
        </section>
        )}
        <section className="p-6 bg-linen-200/30 border-t border-linen-250 text-[10px] text-olive-800 font-serif leading-relaxed space-y-1">
          <div className="font-bold flex items-center gap-1 text-olive-950">
            <Info className="w-3.5 h-3.5 text-clay-600" />
            <span>資料來源說明</span>
          </div>
          <p>
            資料來源：內政部不動產交易實價查詢服務網，買賣與租賃實價登錄資料。實際分析仍須注意交易類型、屋齡、樓層、車位、面積與資料清洗條件。
          </p>
        </section>

      </aside>

      {/* 2. Interactive Fullscreen Map (Leaflet.js) */}
      <main className="flex-1 relative h-1/2 lg:h-full text-earth-900">
        
        {/* Map Container */}
        <div id="map-container" ref={mapContainerRef} className="absolute inset-0 z-0 bg-linen-100" />

        {/* Legend Overlay Card */}
        <div className="absolute left-6 bottom-8 z-10 bg-linen-100/90 backdrop-blur-md border border-linen-300 px-4 py-3.5 rounded-lg shadow-md max-w-sm font-serif pointer-events-auto">
          <div className="flex items-center gap-1.5 text-xs text-clay-700 font-bold mb-2">
            <Layers className="w-3.5 h-3.5" />
            <span>{effectiveDataMode === "price" ? "價格分布指標 (萬/坪)" : "租賃分布指標 (元/坪/月)"}</span>
          </div>

          <div className="grid grid-cols-4 gap-2 text-center text-[10px] font-mono select-none">
            {effectiveDataMode === "price" ? (
              <>
                <div>
                  <div className="w-full h-3 bg-[#7b8a74] rounded-sm mb-1" />
                  <span>&lt; 25 萬</span>
                </div>
                <div>
                  <div className="w-full h-3 bg-[#dfd8bc] rounded-sm mb-1" />
                  <span>25 - 35 萬</span>
                </div>
                <div>
                  <div className="w-full h-3 bg-[#d98a6c] rounded-sm mb-1" />
                  <span>35 - 45 萬</span>
                </div>
                <div>
                  <div className="w-full h-3 bg-[#c35a3e] rounded-sm mb-1" />
                  <span>&gt; 45 萬</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="w-full h-3 bg-[#7b8a74] rounded-sm mb-1" />
                  <span>&lt; 500 元</span>
                </div>
                <div>
                  <div className="w-full h-3 bg-[#dfd8bc] rounded-sm mb-1" />
                  <span>500-750 元</span>
                </div>
                <div>
                  <div className="w-full h-3 bg-[#d98a6c] rounded-sm mb-1" />
                  <span>750-1000 元</span>
                </div>
                <div>
                  <div className="w-full h-3 bg-[#c35a3e] rounded-sm mb-1" />
                  <span>&gt; 1000 元</span>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-linen-200/60 mt-3 pt-2 text-[10px] text-olive-700">
            <div className="w-3.5 h-1 border-t-2 border-dashed border-clay-600" />
            <span>台南鐵路地下化長廊軸線</span>
            <div className="w-4 h-4 rounded-full bg-clay-50 border border-clay-600/30 flex items-center justify-center font-bold text-[9px]">i</div>
            <span>點擊地圖各標記獲取完整細則</span>
          </div>
        </div>

        {/* Dynamic floating panel top-right of map */}
        <div className="absolute right-6 top-6 z-10 flex flex-col gap-2 pointer-events-auto select-none hidden sm:flex">
          <div className="bg-linen-100/90 backdrop-blur-md border border-linen-300 px-3.5 py-2.5 rounded-lg shadow-sm text-xs select-none">
            <span className="font-serif text-olive-700 font-bold">🗺️ 智慧圖層 analysis</span>
            <p className="text-[10px] text-gray-500 font-serif mt-0.5">
              林森、生產、大同綠園中軸緩衝區涵蓋度: <span className="font-mono font-bold text-clay-700">{filteredProperties.length}</span> 筆
            </p>
          </div>
        </div>

      </main>

    </div>
  );
}
