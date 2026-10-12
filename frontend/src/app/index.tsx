import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

// ---------------------------------------------------------------------------
// Config & types
// ---------------------------------------------------------------------------
const API = "http://localhost:3000";

const C = {
  forest: "#1B4332",
  forestSoft: "#2D6A4F",
  cream: "#F8F5F0",
  creamDeep: "#EDE7DC",
  terracotta: "#E07A5F",
  ink: "#22302A",
  muted: "#66746C",
  line: "#DDD5C7",
};

const HEADING = "'Bricolage Grotesque', 'Trebuchet MS', system-ui, sans-serif";
const BODY = "'Figtree', system-ui, -apple-system, 'Segoe UI', sans-serif";

type Category = "Gardens & Parks" | "Viewpoints" | "Water & Trails";
type Filter = "All" | Category;

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
interface Mission {
  guide: FieldGuide;
  cached: boolean;
  source: "cache" | "ollama" | "template" | "local";
}

const FILTERS: Filter[] = ["All", "Gardens & Parks", "Viewpoints", "Water & Trails"];
const CATEGORY_ICON: Record<Category, string> = {
  "Gardens & Parks": "🌳",
  Viewpoints: "🌄",
  "Water & Trails": "💧",
};

const formatDistance = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

// ---------------------------------------------------------------------------
// Offline cache (browser localStorage, safe to fail)
// ---------------------------------------------------------------------------
const LOCAL_PREFIX = "adventure-ai:guide:";
const readLocalGuide = (key: string): FieldGuide | null => {
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFIX + key);
    return raw ? (JSON.parse(raw) as FieldGuide) : null;
  } catch {
    return null;
  }
};
const writeLocalGuide = (key: string, guide: FieldGuide) => {
  try {
    window.localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(guide));
  } catch {
    /* storage full or blocked */
  }
};

// ---------------------------------------------------------------------------
// Leaflet map document (rendered in an iframe via srcDoc)
// The parent sends {type:'data', center, spots, selectedId}; the map sends
// {type:'ready'} once loaded and {type:'spot', id} when a pin is clicked.
// ---------------------------------------------------------------------------
const MAP_HTML = [
  "<!DOCTYPE html><html><head><meta charset='utf-8'/>",
  "<meta name='viewport' content='width=device-width, initial-scale=1'/>",
  "<link rel='stylesheet' href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'/>",
  "<script src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'></script>",
  "<style>",
  "html,body,#map{height:100%;margin:0;background:#EDE7DC;font-family:system-ui,sans-serif}",
  ".pin{width:18px;height:18px;border-radius:50%;background:#2D6A4F;border:3px solid #F8F5F0;box-shadow:0 1px 4px rgba(0,0,0,.4)}",
  ".pin.sel{background:#E07A5F;width:24px;height:24px;margin:-3px 0 0 -3px}",
  ".me{width:16px;height:16px;border-radius:3px;background:#1B4332;border:3px solid #F8F5F0;transform:rotate(45deg);box-shadow:0 1px 4px rgba(0,0,0,.5)}",
  "</style></head><body><div id='map'></div><script>",
  "var map=L.map('map').setView([22,80],4);",
  "L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles &copy; Esri &mdash; OpenStreetMap contributors'}).addTo(map);",
  "var layer=L.layerGroup().addTo(map),lastSig='',lastSel=null;",
  "function icon(cls,size){return L.divIcon({className:'',html:'<div class=\"'+cls+'\"></div>',iconSize:[size,size],iconAnchor:[size/2,size/2]});}",
  "function tip(text){var s=document.createElement('span');s.textContent=text;return s;}",
  "window.addEventListener('message',function(e){",
  "  var d=e.data; if(!d||d.type!=='data'||!d.center) return;",
  "  layer.clearLayers();",
  "  var pts=[[d.center.lat,d.center.lon]];",
  "  L.marker(pts[0],{icon:icon('me',16),zIndexOffset:1000}).addTo(layer).bindTooltip(tip(d.center.label));",
  "  d.spots.forEach(function(s){",
  "    var sel=s.id===d.selectedId;",
  "    var m=L.marker([s.lat,s.lon],{icon:icon('pin'+(sel?' sel':''),sel?24:18),zIndexOffset:sel?900:0}).addTo(layer);",
  "    m.bindTooltip(tip(s.name+' ('+s.distanceKm.toFixed(1)+' km)'));",
  "    m.on('click',function(){parent.postMessage({type:'spot',id:s.id},'*');});",
  "    pts.push([s.lat,s.lon]);",
  "  });",
  "  var sig=d.center.lat+','+d.center.lon+':'+d.spots.map(function(s){return s.id;}).join();",
  "  if(sig!==lastSig){map.fitBounds(pts,{padding:[32,32],maxZoom:15});lastSig=sig;}",
  "  else if(d.selectedId&&d.selectedId!==lastSel){",
  "    var t=d.spots.filter(function(s){return s.id===d.selectedId;})[0];",
  "    if(t) map.panTo([t.lat,t.lon]);",
  "  }",
  "  lastSel=d.selectedId;",
  "});",
  "parent.postMessage({type:'ready'},'*');",
  "</script></body></html>",
].join("");

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function ExploreScreen() {
  const { width } = useWindowDimensions();
  const wide = width >= 900;

  const [cityInput, setCityInput] = useState("");
  const [center, setCenter] = useState<Center | null>(null);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [filter, setFilter] = useState<Filter>("All");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Spot | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [missionLoading, setMissionLoading] = useState(false);
  const [done, setDone] = useState<boolean[]>([false, false, false]);

  const [audioState, setAudioState] = useState<"idle" | "loading" | "playing">("idle");
  const [audioNote, setAudioNote] = useState<string | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const missionY = useRef(0);
  const requestId = useRef(0);

  const visibleSpots = filter === "All" ? spots : spots.filter((s) => s.category === filter);

  // Load web fonts once.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Figtree:wght@400;500;600&display=swap";
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  // ----- Audio ---------------------------------------------------------------
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setAudioState("idle");
  }, []);

  useEffect(() => stopAudio, [stopAudio]);

  const speakWithBrowser = (text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setAudioState("idle");
      setAudioNote("This browser can't read the briefing aloud. The text above has everything.");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.onend = () => setAudioState("idle");
    utterance.onerror = () => setAudioState("idle");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setAudioState("playing");
  };

  const listen = async () => {
    if (!mission) return;
    if (audioState !== "idle") {
      stopAudio();
      return;
    }
    setAudioNote(null);
    setAudioState("loading");
    const text = mission.guide.voiceScript;
    try {
      const res = await fetch(`${API}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!data.fallback && data.audioBase64) {
        const audio = new Audio(`data:${data.mime ?? "audio/mpeg"};base64,${data.audioBase64}`);
        audioRef.current = audio;
        audio.onended = () => {
          audioRef.current = null;
          setAudioState("idle");
        };
        await audio.play();
        setAudioState("playing");
        return;
      }
    } catch {
      /* fall through to the browser voice */
    }
    speakWithBrowser(text);
  };

  // ----- Discovery -----------------------------------------------------------
  const resetMission = () => {
    stopAudio();
    setSelected(null);
    setMission(null);
    setDone([false, false, false]);
    setAudioNote(null);
  };

  const discover = async (query: string) => {
    setLoading(true);
    setError(null);
    resetMission();
    setFilter("All");
    try {
      const res = await fetch(`${API}/api/discover?${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Discovery failed.");
      setCenter(data.center);
      setSpots(data.spots);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? `Can't reach the server at ${API}. Start the backend and try again.`
          : (e as Error).message
      );
    } finally {
      setLoading(false);
    }
  };

  const exploreCity = () => {
    const city = cityInput.trim();
    if (!city) {
      setError("Type a city name first, for example Udaipur or Portland.");
      return;
    }
    discover(`city=${encodeURIComponent(city)}`);
  };

  const findAroundMe = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This browser doesn't support location. Search for a city instead.");
      return;
    }
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => discover(`lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`),
      () => {
        setLoading(false);
        setError("Location permission was denied. Allow location access or search for a city instead.");
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  };

  // ----- Mission -------------------------------------------------------------
  const selectSpot = async (spot: Spot) => {
    const myRequest = ++requestId.current;
    stopAudio();
    setAudioNote(null);
    setSelected(spot);
    setDone([false, false, false]);
    setError(null);

    const localKey = `${spot.id}|${center?.label ?? ""}`;
    const local = readLocalGuide(localKey);
    if (local) {
      setMission({ guide: local, cached: true, source: "local" });
      setMissionLoading(false);
      return;
    }

    setMission(null);
    setMissionLoading(true);
    try {
      const res = await fetch(`${API}/api/mission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spotName: spot.name,
          category: spot.category,
          city: center?.label ?? "",
          lat: spot.lat,
          lon: spot.lon,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't build the field guide.");
      if (myRequest !== requestId.current) return; // user clicked another spot meanwhile
      if (data.source !== "template") writeLocalGuide(localKey, data.guide);
      setMission({ guide: data.guide, cached: data.source === "cache", source: data.source });
    } catch (e) {
      if (myRequest !== requestId.current) return;
      setError((e as Error).message);
      setSelected(null);
    } finally {
      if (myRequest === requestId.current) setMissionLoading(false);
    }
  };

  // Scroll the card into view when a mission starts.
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(missionY.current - 8, 0), animated: true }), 60);
    return () => clearTimeout(t);
  }, [selected]);

  // ----- Map bridge ----------------------------------------------------------
  const onPinRef = useRef<(id: string) => void>(() => {});
  onPinRef.current = (id: string) => {
    const spot = spots.find((s) => s.id === id);
    if (spot) selectSpot(spot);
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (msg?.type === "ready") setMapReady(true);
      if (msg?.type === "spot" && typeof msg.id === "string") onPinRef.current(msg.id);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!mapReady || !center) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "data", center, spots: visibleSpots, selectedId: selected?.id ?? null },
      "*"
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, center, spots, filter, selected]);

  const mapFrame = React.createElement("iframe", {
    ref: iframeRef,
    srcDoc: MAP_HTML,
    title: "Map of nearby outdoor spots",
    sandbox: "allow-scripts allow-same-origin",
    style: { width: "100%", height: "100%", border: 0, display: "block" },
  });

  // ----- UI pieces -----------------------------------------------------------
  const questsDone = done.filter(Boolean).length;

  const missionCard = (
    <View onLayout={(e) => (missionY.current = e.nativeEvent.layout.y)}>
      {selected && missionLoading && (
        <View style={styles.missionLoading}>
          <ActivityIndicator color={C.forest} />
          <Text style={styles.missionLoadingText}>Writing the field guide for {selected.name}…</Text>
        </View>
      )}

      {selected && mission && !missionLoading && (
        <View style={styles.mission}>
          <View style={styles.missionTop}>
            <Text style={styles.missionPlace}>
              {CATEGORY_ICON[selected.category]} {selected.name}
            </Text>
            <Text style={styles.missionVibe}>{mission.guide.vibe}</Text>
            <View style={styles.badgeRow}>
              {mission.source === "template" ? (
                <View style={[styles.badge, styles.badgeWarn]}>
                  <Text style={styles.badgeWarnText}>Starter guide · Ollama isn't running</Text>
                </View>
              ) : (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    💾 Offline Cached · {mission.cached ? "loaded from cache" : "saved for offline use"}
                  </Text>
                </View>
              )}
            </View>
          </View>

          <View style={styles.missionBody}>
            <Text style={styles.sectionTitle}>Best thing to do here</Text>
            <Text style={styles.bodyText}>{mission.guide.bestActivity}</Text>

            <Text style={styles.sectionTitle}>Nature spotter</Text>
            <View style={styles.chipWrap}>
              {mission.guide.natureSpotter.map((item, i) => (
                <View key={i} style={styles.chip}>
                  <Text style={styles.chipText}>🔎 {item}</Text>
                </View>
              ))}
            </View>

            <View style={styles.questHeader}>
              <Text style={styles.sectionTitle}>Screen-free quests</Text>
              <Text style={styles.questCount}>{questsDone} of 3 done</Text>
            </View>
            {mission.guide.screenFreeQuests.map((quest, i) => (
              <Pressable
                key={i}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: done[i] }}
                onPress={() => setDone((d) => d.map((v, j) => (j === i ? !v : v)))}
                style={[styles.quest, done[i] && styles.questDone]}
              >
                <View style={[styles.box, done[i] && styles.boxChecked]}>
                  {done[i] && <Text style={styles.tick}>✓</Text>}
                </View>
                <Text style={[styles.questText, done[i] && styles.questTextDone]}>{quest}</Text>
              </Pressable>
            ))}
            {questsDone === 3 && (
              <Text style={styles.allDone}>All three done. You touched grass today. 🌱</Text>
            )}

            <Pressable onPress={listen} style={styles.listenBtn} accessibilityRole="button">
              <Text style={styles.listenText}>
                {audioState === "idle" && "🔊 Listen to Audio Briefing"}
                {audioState === "loading" && "Preparing audio…"}
                {audioState === "playing" && "⏹ Stop audio"}
              </Text>
            </Pressable>
            {audioNote && <Text style={styles.audioNote}>{audioNote}</Text>}
          </View>
        </View>
      )}
    </View>
  );

  const spotList = (
    <View style={styles.listWrap}>
      {spots.length > 0 && (
        <Text style={styles.listTitle}>
          {visibleSpots.length} {visibleSpots.length === 1 ? "spot" : "spots"} near {center?.label}
        </Text>
      )}
      {visibleSpots.map((spot) => {
        const active = selected?.id === spot.id;
        return (
          <Pressable
            key={spot.id}
            onPress={() => selectSpot(spot)}
            style={[styles.card, active && styles.cardActive]}
            accessibilityRole="button"
          >
            <Text style={styles.cardIcon}>{CATEGORY_ICON[spot.category]}</Text>
            <View style={styles.cardMain}>
              <Text style={styles.cardName} numberOfLines={2}>
                {spot.name}
              </Text>
              <Text style={styles.cardMeta}>{spot.category}</Text>
            </View>
            <Text style={styles.cardDistance}>{formatDistance(spot.distanceKm)}</Text>
          </Pressable>
        );
      })}
      {spots.length === 0 && !loading && (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Where do you want to go outside?</Text>
          <Text style={styles.emptyText}>
            Search a city or tap Find Around Me to see parks, gardens, viewpoints and waterside trails within 5 km.
          </Text>
        </View>
      )}
      {loading && <ActivityIndicator style={{ marginTop: 24 }} color={C.forest} />}
    </View>
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.brandRow}>
        <Text style={styles.brand}>adventure.ai</Text>
        <Text style={styles.tagline}>Find a patch of green nearby, then leave your phone in your pocket.</Text>
      </View>
      <View style={styles.controls}>
        <TextInput
          value={cityInput}
          onChangeText={setCityInput}
          onSubmitEditing={exploreCity}
          placeholder="Any city, like Udaipur or Portland"
          placeholderTextColor="#8A9A90"
          returnKeyType="search"
          style={styles.input}
          accessibilityLabel="City name"
        />
        <Pressable onPress={exploreCity} style={styles.primaryBtn} accessibilityRole="button">
          <Text style={styles.primaryBtnText}>🔍 Explore City</Text>
        </Pressable>
        <Pressable onPress={findAroundMe} style={styles.ghostBtn} accessibilityRole="button">
          <Text style={styles.ghostBtnText}>📍 Find Around Me</Text>
        </Pressable>
      </View>
      {error && (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </View>
  );

  const pills = (
    <View style={styles.pills}>
      {FILTERS.map((f) => (
        <Pressable
          key={f}
          onPress={() => setFilter(f)}
          style={[styles.pill, filter === f && styles.pillActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: filter === f }}
        >
          <Text style={[styles.pillText, filter === f && styles.pillTextActive]}>{f}</Text>
        </Pressable>
      ))}
    </View>
  );

  const mapPanel = (
    <View style={styles.mapPanel}>
      {pills}
      <View style={[styles.mapBox, !wide && { height: 340 }]}>{mapFrame}</View>
    </View>
  );

  if (wide) {
    return (
      <View style={[styles.root, { height: "100vh" as unknown as number }]}>
        {header}
        <View style={styles.split}>
          <View style={styles.leftCol}>{mapPanel}</View>
          <ScrollView ref={scrollRef} style={styles.rightCol} contentContainerStyle={styles.rightContent}>
            {missionCard}
            {spotList}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <ScrollView ref={scrollRef} style={styles.root} contentContainerStyle={{ paddingBottom: 40 }}>
      {header}
      {mapPanel}
      <View style={styles.narrowPad}>
        {missionCard}
        {spotList}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.cream },

  // header
  header: { backgroundColor: C.forest, paddingHorizontal: 20, paddingVertical: 16, gap: 12 },
  brandRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 16, rowGap: 2 },
  brand: { color: C.cream, fontSize: 28, fontWeight: "700", fontFamily: HEADING, letterSpacing: -0.5 },
  tagline: { color: "#B7D3C3", fontSize: 14, fontFamily: BODY },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  input: {
    flexGrow: 1,
    flexBasis: 240,
    minHeight: 44,
    backgroundColor: C.cream,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    color: C.ink,
    fontFamily: BODY,
  },
  primaryBtn: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: C.terracotta,
    justifyContent: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600", fontFamily: BODY },
  ghostBtn: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#7FA892",
    justifyContent: "center",
  },
  ghostBtnText: { color: C.cream, fontSize: 15, fontWeight: "600", fontFamily: BODY },
  error: { backgroundColor: "#F6DDD5", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  errorText: { color: "#8A2F18", fontSize: 14, fontFamily: BODY },

  // split
  split: { flex: 1, flexDirection: "row", minHeight: 0 },
  leftCol: { flex: 1.25, minWidth: 0, padding: 16, paddingRight: 8 },
  rightCol: { flex: 1, minWidth: 340, maxWidth: 560 },
  rightContent: { padding: 16, paddingLeft: 8, gap: 16 },
  narrowPad: { padding: 16, gap: 16 },

  // map
  mapPanel: { flex: 1, gap: 10, padding: 0 },
  mapBox: {
    flex: 1,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.creamDeep,
  },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: C.forestSoft,
    backgroundColor: "transparent",
  },
  pillActive: { backgroundColor: C.forest, borderColor: C.forest },
  pillText: { color: C.forest, fontSize: 14, fontWeight: "600", fontFamily: BODY },
  pillTextActive: { color: C.cream },

  // spot list
  listWrap: { gap: 10 },
  listTitle: { fontSize: 18, fontWeight: "700", color: C.forest, fontFamily: HEADING, marginBottom: 2 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#FFFDF9",
    borderWidth: 1.5,
    borderColor: C.line,
  },
  cardActive: { borderColor: C.terracotta, backgroundColor: "#FDF1EC" },
  cardIcon: { fontSize: 24 },
  cardMain: { flex: 1, gap: 2 },
  cardName: { fontSize: 16, fontWeight: "600", color: C.ink, fontFamily: BODY },
  cardMeta: { fontSize: 13, color: C.muted, fontFamily: BODY },
  cardDistance: { fontSize: 14, fontWeight: "600", color: C.forestSoft, fontFamily: BODY },
  empty: { padding: 20, borderRadius: 12, backgroundColor: C.creamDeep, gap: 6 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: C.forest, fontFamily: HEADING },
  emptyText: { fontSize: 15, lineHeight: 22, color: C.muted, fontFamily: BODY },

  // mission card
  missionLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 18,
    borderRadius: 14,
    backgroundColor: C.creamDeep,
  },
  missionLoadingText: { flex: 1, color: C.forest, fontSize: 15, fontFamily: BODY },
  mission: { borderRadius: 16, overflow: "hidden", borderWidth: 1.5, borderColor: C.forest, backgroundColor: "#FFFDF9" },
  missionTop: { backgroundColor: C.forest, padding: 18, gap: 8 },
  missionPlace: { color: "#B7D3C3", fontSize: 15, fontWeight: "600", fontFamily: BODY },
  missionVibe: { color: C.cream, fontSize: 22, lineHeight: 29, fontWeight: "700", fontFamily: HEADING, letterSpacing: -0.3 },
  badgeRow: { flexDirection: "row", marginTop: 4 },
  badge: { backgroundColor: "rgba(248,245,240,0.14)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  badgeText: { color: C.cream, fontSize: 12.5, fontWeight: "600", fontFamily: BODY },
  badgeWarn: { backgroundColor: "#F6DDD5" },
  badgeWarnText: { color: "#8A2F18", fontSize: 12.5, fontWeight: "600", fontFamily: BODY },
  missionBody: { padding: 18, gap: 10 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: C.forest, fontFamily: HEADING, marginTop: 6 },
  bodyText: { fontSize: 15, lineHeight: 22, color: C.ink, fontFamily: BODY },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: C.creamDeep, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  chipText: { fontSize: 14, color: C.ink, fontFamily: BODY },
  questHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  questCount: { fontSize: 13, color: C.muted, fontFamily: BODY },
  quest: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: C.line,
    backgroundColor: C.cream,
  },
  questDone: { borderColor: C.terracotta, backgroundColor: "#FDF1EC" },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: C.forestSoft,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  boxChecked: { backgroundColor: C.terracotta, borderColor: C.terracotta },
  tick: { color: "#fff", fontSize: 15, fontWeight: "700" },
  questText: { flex: 1, fontSize: 15, lineHeight: 22, color: C.ink, fontFamily: BODY },
  questTextDone: { textDecorationLine: "line-through", color: C.muted },
  allDone: { fontSize: 15, fontWeight: "600", color: C.terracotta, fontFamily: BODY },
  listenBtn: {
    marginTop: 8,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: C.terracotta,
    alignItems: "center",
    justifyContent: "center",
  },
  listenText: { color: "#fff", fontSize: 16, fontWeight: "700", fontFamily: BODY },
  audioNote: { fontSize: 13, color: C.muted, fontFamily: BODY },
});