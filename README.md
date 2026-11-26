# Thunai (துணை) — your family's companion

Thunai is an AI-powered, bilingual (Tamil / English) companion app with twelve helpers for families in Chennai:

| Helper | What it does |
|---|---|
| Talk to Thunai | Voice assistant that answers and opens the right helper |
| FloodSense | Flood-depth reports from photos, rain forecast, routes that avoid water, live shared flood map |
| Scam Shield | Checks a message or screenshot for fraud |
| Nearby Help | Hospitals, pharmacies, police, fire stations and shelters near you |
| Medicine Box | Reads tablet strips and prescriptions, finds duplicates and expiry, daily doses and alarms |
| Health Tracker | BP and sugar log with colour flags and charts |
| Scheme Finder | Finds central and Tamil Nadu government schemes you qualify for |
| Document Helper | Explains bills, notices and letters, and flags fake ones |
| Power Saver | Monthly electricity units and cost, savings plan |
| Green Hours | Best time to run heavy appliances for lower carbon |
| LakeWatch | Satellite imagery of Chennai lakes from 2018 onwards, complaint letters |
| SOS | One tap sends your location to family by SMS |

## Try it

**Live web app:** https://jackwalker728.github.io/thunai/

1. Open the link on a phone (Chrome works best) and choose **Add to Home screen** to install it.
2. Open **Settings** and paste a free Google Gemini API key (from Google AI Studio). The key stays on your device only.
3. Switch between English and Tamil with the **EN / தமிழ்** button.

## Tech

Plain HTML, CSS and JavaScript (no framework), Leaflet maps, Google Gemini API, OpenStreetMap, OSRM routing, Nominatim, Overpass API, Open-Meteo, ntfy.sh and Sentinel-2 imagery. All personal data is stored only in the browser on your device. An Android APK version wraps the same web app.

Built for OHPC-2026, Dhanalakshmi College of Engineering, by Sahana Shree and Shahitha.
