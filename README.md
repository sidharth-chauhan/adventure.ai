# 🌿 adventure.ai

> **Find a patch of green nearby, then leave your phone in your pocket.**  
> Built for the **Hacktoberfest 2026 Open-Source AI Challenge: Week 1 (Touch Grass)**.

**adventure.ai** is a privacy-first, offline-capable local nature scout and micro-adventure generator. Instead of keeping you glued to a screen, it discovers real parks, botanical gardens, viewpoints, and waterside trails within 5 km of your location (or any city worldwide) and uses local open-weight AI (**Google Gemma 2 2B** via **Ollama**) to generate a **Screen-Free Field Guide** with physical outdoor quests and an eyes-free audio briefing.

---

## ✨ Key Features

- **📍 Zero-Key Geospatial Discovery:** Uses browser geolocation (`Find Around Me`) or global city geocoding via **OpenStreetMap Nominatim** + **Overpass API** to find real nearby parks, gardens, viewpoints, and water trails within a 3–5 km radius—with deterministic offline fallback spots if rate-limited.
- **🗺️ Interactive Topographic Map:** Embedded **Leaflet.js** + **Esri World Topo Map** with custom category filtering (`All`, `Gardens & Parks`, `Viewpoints`, `Water & Trails`) and one-click pin selection.
- **🧠 100% Local AI Field Guides (Gemma 2 2B):** Powered by **Ollama** running locally, every selected spot gets a structured JSON "Touch Grass Field Guide" including:
  - **The Vibe:** A 1-sentence hook tailored to the location and current season.
  - **Best Activity:** What to do once you arrive.
  - **Nature Spotter:** 3 local trees, plants, or birds to look out for.
  - **3 Screen-Free Quests:** Interactive physical mini-challenges designed to be completed with your phone locked in your pocket.
- **🔊 Eyes-Free Audio Briefing:** Converts your field guide into a warm spoken briefing via **ElevenLabs TTS** (with automatic fallback to the browser's offline `window.speechSynthesis`), letting you put one earbud in, lock your screen, and walk.
- **💾 Dual Offline Caching:** Automatically caches generated field guides in **MongoDB** (with in-memory server fallback) and browser **`localStorage`**, so your map coordinates and field guide work on the trail even with zero cell service.

---

## 🏗️ Tech Stack

| Layer                | Technology                                                                            |
| :------------------- | :------------------------------------------------------------------------------------ |
| **Frontend**         | React Native (Expo Router Web), TypeScript, Leaflet.js, Esri World Topo Map           |
| **Backend**          | Node.js, Express, TypeScript (`tsx`)                                                  |
| **Local AI Engine**  | Ollama (`gemma2:2b` open-weight model)                                                |
| **Database & Cache** | MongoDB (`mongodb` driver + automatic in-memory `Map` + `localStorage` offline cache) |
| **Geospatial Data**  | OpenStreetMap Nominatim API & Overpass API                                            |
| **Voice / Audio**    | ElevenLabs Text-to-Speech API + Web Speech API (`speechSynthesis`)                    |
| **Infrastructure**   | Docker & Docker Compose                                                               |

---

## 🚀 Quick Start

### 1. Start Ollama & MongoDB (via Docker)

If you already have Ollama running locally with `gemma2:2b`, skip to Step 2. Otherwise, spin up the local stack with Docker Compose:

```bash
docker compose up -d
```
