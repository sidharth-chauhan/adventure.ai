import express, { Request, Response } from "express";
import cors from "cors";
import { MongoClient, Collection } from "mongodb";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "gemma2:2b";
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const USER_AGENT = "adventure-ai-hacktoberfest";
const RADIUS_M = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Category = "Gardens & Parks" | "Viewpoints" | "Water & Trails";

interface Center {
  lat: number;
  lon: number;
  label: string;
}

interface Spot {
  id: string;
  name: string;
  category: Category;
  lat: number;
  lon: number;
  distanceKm: number;
}

interface FieldGuide {
  vibe: string;
  bestActivity: string;
  natureSpotter: string[];
  screenFreeQuests: string[];
  voiceScript: string;
}

interface GuideDoc {
  _id: string;
  guide: FieldGuide;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

// ---------------------------------------------------------------------------
// MongoDB with in-memory fallback
// ---------------------------------------------------------------------------
const memoryCache = new Map<string, FieldGuide>();
let guides: Collection<GuideDoc> | null = null;

(async () => {
  try {
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    guides = client.db("adventure_ai").collection<GuideDoc>("guides");
    console.log("[mongo] connected - guides are cached in MongoDB");
  } catch {
    guides = null;
    console.log("[mongo] not available - using in-memory cache");
  }
})();

async function cacheGet(key: string): Promise<FieldGuide | null> {
  if (guides) {
    try {
      const doc = await guides.findOne({ _id: key });
      if (doc) return doc.guide;
    } catch {
      /* fall through to memory */
    }
  }
  return memoryCache.get(key) ?? null;
}

async function cacheSet(key: string, guide: FieldGuide): Promise<void> {
  memoryCache.set(key, guide);
  if (guides) {
    try {
      await guides.updateOne({ _id: key }, { $set: { guide, createdAt: new Date() } }, { upsert: true });
    } catch {
      /* memory copy is enough */
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery: geocoding, Overpass, fallback generator
// ---------------------------------------------------------------------------
async function geocodeCity(city: string): Promise<Center | null> {
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(city)}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } }, 8000);
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!data.length) return null;
  const label = data[0].display_name.split(",").slice(0, 2).join(",").trim();
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label };
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function categorize(tags: Record<string, string>): Category | null {
  if (tags.tourism === "viewpoint") return "Viewpoints";
  if (tags.leisure && /^(park|garden|nature_reserve)$/.test(tags.leisure)) return "Gardens & Parks";
  if (tags.natural && /^(water|wood|peak)$/.test(tags.natural)) return "Water & Trails";
  if (tags.tourism && /^(picnic_site|attraction)$/.test(tags.tourism)) return "Viewpoints";
  return null;
}

async function queryOverpass(lat: number, lon: number): Promise<Spot[]> {
  const around = `(around:${RADIUS_M},${lat},${lon})`;
  const query = `
    [out:json][timeout:10];
    (
      nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]${around};
      nwr["tourism"~"^(viewpoint|picnic_site|attraction)$"]["name"]${around};
      nwr["natural"~"^(water|wood|peak)$"]["name"]${around};
    );
    out center 120;
  `;
  const res = await fetchWithTimeout(
    OVERPASS_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
    },
    9000
  );
  if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
  const json = (await res.json()) as { elements: OverpassElement[] };

  const seen = new Set<string>();
  const spots: Spot[] = [];
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    const category = categorize(tags);
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (!name || !category || pLat === undefined || pLon === undefined) continue;
    const dedupeKey = `${name.toLowerCase()}|${category}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    spots.push({
      id: `osm-${el.type}-${el.id}`,
      name,
      category,
      lat: round(pLat, 6),
      lon: round(pLon, 6),
      distanceKm: round(haversineKm(lat, lon, pLat, pLon), 2),
    });
  }
  return spots.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 40);
}

// Small deterministic PRNG so the same coordinates always give the same demo spots.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateFallbackSpots(lat: number, lon: number, count = 14): Spot[] {
  const rand = mulberry32(Math.floor(Math.abs(lat * 1000)) * 7919 + Math.floor(Math.abs(lon * 1000)));
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const prefixes = [
    "Riverside", "Maple Grove", "Heritage", "Sunrise", "Lakeview", "Banyan",
    "Old Orchard", "Cedar Hill", "Meadow", "Willow Bend", "Fern Hollow", "Sunset",
  ];
  const suffixes: Record<Category, string[]> = {
    "Gardens & Parks": ["Park", "Botanical Garden", "Community Garden", "Nature Reserve"],
    Viewpoints: ["Viewpoint", "Lookout", "Picnic Ground"],
    "Water & Trails": ["Lake Trail", "Pond Loop", "Creek Walk", "Wetland Path"],
  };
  const categories: Category[] = ["Gardens & Parks", "Viewpoints", "Water & Trails"];

  const spots: Spot[] = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const category = categories[i % categories.length];
    let name = `${pick(prefixes)} ${pick(suffixes[category])}`;
    while (used.has(name)) name = `${pick(prefixes)} ${pick(suffixes[category])}`;
    used.add(name);

    const radiusKm = 0.4 + rand() * 4.2;
    const theta = rand() * Math.PI * 2;
    const dLat = (radiusKm * Math.cos(theta)) / 111.32;
    const dLon = (radiusKm * Math.sin(theta)) / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const sLat = lat + dLat;
    const sLon = lon + dLon;
    spots.push({
      id: `fb-${i}-${Math.round(lat * 100)}-${Math.round(lon * 100)}`,
      name,
      category,
      lat: round(sLat, 6),
      lon: round(sLon, 6),
      distanceKm: round(haversineKm(lat, lon, sLat, sLon), 2),
    });
  }
  return spots.sort((a, b) => a.distanceKm - b.distanceKm);
}

// ---------------------------------------------------------------------------
// Field guide generation
// ---------------------------------------------------------------------------
const asString = (v: unknown, fallback: string) =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

function asThree(v: unknown, fallback: string[]): string[] {
  const items = Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
    : [];
  return [...items, ...fallback].slice(0, 3);
}

function templateGuide(spotName: string, category: string, city: string): FieldGuide {
  const where = city ? ` in ${city}` : "";
  return {
    vibe: `${spotName} is a quiet slice of green${where} that is made for a screen-free hour today.`,
    bestActivity:
      category === "Viewpoints"
        ? "Walk up slowly and watch the light change over the horizon."
        : category === "Water & Trails"
          ? "Follow the water's edge on a slow loop and listen to what's around you."
          : "Take a slow loop and find a bench or patch of grass to sit on.",
    natureSpotter: [
      "A tree with the widest trunk you can find",
      "Any bird you can hear but not yet see",
      "A flower or weed growing where it shouldn't",
    ],
    screenFreeQuests: [
      "Stand still for 60 seconds and count every different sound you hear.",
      "Find a leaf with an interesting shape and trace its veins with your finger.",
      "Take 20 slow steps barefoot or hand-on-bark and notice how it feels.",
    ],
    voiceScript: `Welcome to ${spotName}. Take a slow walk, breathe deeply, and keep your phone in your pocket. Try to listen for birds, find an interesting leaf, and stand still for one quiet minute. Enjoy being outside and come back a little lighter.`,
  };
}

function normalizeGuide(raw: unknown, spotName: string, category: string, city: string): FieldGuide {
  const base = templateGuide(spotName, category, city);
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    vibe: asString(obj.vibe, base.vibe),
    bestActivity: asString(obj.bestActivity, base.bestActivity),
    natureSpotter: asThree(obj.natureSpotter, base.natureSpotter),
    screenFreeQuests: asThree(obj.screenFreeQuests, base.screenFreeQuests),
    voiceScript: asString(obj.voiceScript, base.voiceScript),
  };
}

async function generateGuideWithOllama(
  spotName: string,
  category: string,
  city: string,
  lat: number | undefined,
  lon: number | undefined
): Promise<FieldGuide> {
  const prompt = `You are a friendly local nature guide writing a "Touch Grass Field Guide".
Spot: "${spotName}" (${category})
City/area: ${city || "unknown"}${lat !== undefined && lon !== undefined ? `\nCoordinates: ${lat}, ${lon}` : ""}
Today's month: ${new Date().toLocaleString("en-US", { month: "long" })}

Return ONLY a JSON object with exactly these keys:
{
  "vibe": "1 sentence hook on why to visit this spot today",
  "bestActivity": "the best outdoor activity to do there, one sentence",
  "natureSpotter": ["3 local plants, trees or birds to look out for"],
  "screenFreeQuests": ["3 short, fun physical mini-challenges to do with your phone in your pocket"],
  "voiceScript": "a warm 3-sentence audio briefing summarizing the walk and the quests"
}`;

  const res = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.8 },
      }),
    },
    90000
  );
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const data = (await res.json()) as { response?: string };
  return normalizeGuide(JSON.parse(data.response ?? "{}"), spotName, category, city);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, mongo: guides !== null });
});

app.get("/api/discover", async (req: Request, res: Response) => {
  try {
    const cityParam = typeof req.query.city === "string" ? req.query.city.trim() : "";
    const latParam = parseFloat(String(req.query.lat ?? ""));
    const lonParam = parseFloat(String(req.query.lon ?? ""));

    let center: Center;
    if (cityParam) {
      const geo = await geocodeCity(cityParam).catch(() => null);
      if (!geo) {
        res.status(404).json({ error: `Couldn't find "${cityParam}". Check the spelling or try a nearby larger city.` });
        return;
      }
      center = geo;
    } else if (Number.isFinite(latParam) && Number.isFinite(lonParam)) {
      center = { lat: latParam, lon: lonParam, label: "Your location" };
    } else {
      res.status(400).json({ error: "Pass either ?city=CityName or ?lat=...&lon=..." });
      return;
    }

    let spots: Spot[] = [];
    let source: "overpass" | "fallback" | "mixed" = "overpass";
    try {
      spots = await queryOverpass(center.lat, center.lon);
    } catch (err) {
      console.warn("[discover] Overpass failed, using fallback:", (err as Error).message);
    }

    if (spots.length === 0) {
      spots = generateFallbackSpots(center.lat, center.lon);
      source = "fallback";
    } else if (spots.length < 6) {
      spots = [...spots, ...generateFallbackSpots(center.lat, center.lon, 8)].sort(
        (a, b) => a.distanceKm - b.distanceKm
      );
      source = "mixed";
    }

    res.json({ center, spots, source });
  } catch (err) {
    console.error("[discover]", err);
    res.status(500).json({ error: "Something went wrong while discovering spots." });
  }
});

app.post("/api/mission", async (req: Request, res: Response) => {
  const { spotName, category, city, lat, lon } = (req.body ?? {}) as {
    spotName?: string;
    category?: string;
    city?: string;
    lat?: number;
    lon?: number;
  };

  if (!spotName || !category) {
    res.status(400).json({ error: "spotName and category are required." });
    return;
  }

  const cityName = city ?? "";
  const cacheKey = [
    spotName.toLowerCase(),
    category.toLowerCase(),
    cityName.toLowerCase(),
    typeof lat === "number" ? lat.toFixed(3) : "",
    typeof lon === "number" ? lon.toFixed(3) : "",
  ].join("|");

  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.json({ guide: cached, cached: true, source: "cache" });
      return;
    }

    try {
      const guide = await generateGuideWithOllama(spotName, category, cityName, lat, lon);
      await cacheSet(cacheKey, guide);
      res.json({ guide, cached: false, source: "ollama" });
    } catch (err) {
      console.warn("[mission] Ollama unavailable, using template:", (err as Error).message);
      // Template guides are intentionally not cached so real AI output can replace them later.
      res.json({ guide: templateGuide(spotName, category, cityName), cached: false, source: "template" });
    }
  } catch (err) {
    console.error("[mission]", err);
    res.status(500).json({ error: "Could not build the field guide." });
  }
});

app.post("/api/tts", async (req: Request, res: Response) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
  if (!text) {
    res.status(400).json({ error: "text is required." });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.json({ fallback: true });
    return;
  }

  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL";
    const r = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      },
      20000
    );
    if (!r.ok) throw new Error(`ElevenLabs responded ${r.status}`);
    const audioBase64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    res.json({ fallback: false, audioBase64, mime: "audio/mpeg" });
  } catch (err) {
    console.warn("[tts] ElevenLabs failed, asking client to use speechSynthesis:", (err as Error).message);
    res.json({ fallback: true });
  }
});

app.listen(PORT, () => {
  console.log(`adventure.ai backend listening on http://localhost:${PORT}`);
});