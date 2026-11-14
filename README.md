# Civilization Ownership

**Live site: https://cjames2434.github.io/civilization-ownership/**

A free, interactive map of U.S. land ownership. Zoom in anywhere to see property lines, then click a piece of land to see:

- **Who owns it** (current owner name or names)
- **How big it is** (recorded acreage or square footage, plus the size measured from the map)
- **Ownership history**: each owner, the date they got the land, the date they sold it, and the buy and sell prices when the public record includes them
- **Public land**: federal, state, local and tribal land nationwide, with its owner and manager (USGS PAD-US)
- **Links to the official county records** for anything the free data doesn't cover

It's a static website (HTML, CSS and JavaScript). There's no server, database or API key, so hosting costs nothing.

---

## Run it on your computer

**Windows:** double-click `run-local.bat`. Your browser opens at http://localhost:8000.

**Any computer with Python:** open a terminal in this folder and run:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

Use the local server rather than double-clicking `index.html`: some government servers refuse requests from pages opened as plain files (`file://`).

---

## Put it online for free

Pick one. All three are free for a site like this and give you an `https://` address.

### Option A: Netlify Drop (easiest, no account setup beyond sign-in)
1. Go to https://app.netlify.com/drop
2. Drag this whole folder onto the page.
3. You get a link like `https://something.netlify.app`. Rename it in Site settings.

### Option B: GitHub Pages
1. Create a free account at https://github.com and make a new **public** repository (for example `civilization-ownership`).
2. Upload every file and folder from this directory (Add file → Upload files), or push it with git:
   ```bash
   git init
   git add .
   git commit -m "Civilization Ownership map"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/civilization-ownership.git
   git push -u origin main
   ```
3. In the repository, open **Settings → Pages**, set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://YOUR-NAME.github.io/civilization-ownership/`.

### Option C: Cloudflare Pages
Create a Pages project at https://dash.cloudflare.com, choose **Direct Upload**, and upload this folder. There's no build command and no output directory to set.

A custom domain (like `civilizationownership.com`) is optional and is the only part that costs money (about $10–15 a year from any registrar). All three hosts connect one for free.

---

## What data it covers, and why it isn't the same everywhere

Land records in the U.S. are kept by about 3,100 county offices, and each state decides what goes online. This map uses only **free, official, public** web services and reads them live in your browser. Open **About the data** in the app for the full list.

| Coverage | Where |
|---|---|
| **Owners + sale history** | New York City (ACRIS: every deed with buyers, sellers, dates, prices), Philadelphia (same, from transfer-tax records), Cook County / Chicago (every sale since 1999 with buyer and seller), Maryland (last 3 sales with seller names), Connecticut (current owner + every recorded sale since 2001, dates and prices only) |
| **Owners + latest sale** | Massachusetts, Colorado, Minnesota (opt-in counties), North Carolina (sale date), Washington DC |
| **Owner names** | Wisconsin, Texas, Florida, Montana, Vermont, Arkansas, Franklin County OH (Columbus) |
| **Property lines only** | Washington State (links to county assessor), Indiana, Virginia, Utah, Delaware, New Jersey (owner names redacted by law; deed date + price still shown) |
| **County by county** | Michigan and Iowa have no statewide layer, so the map reads each county's own public parcel service where one exists: **39 of 83 Michigan counties** (8 cover only part of the county, such as one city) and **26 of 99 Iowa counties** (3 partial). Owner names everywhere, plus the latest sale in 13 counties. Layers not updated in over a year are labeled with their date on every parcel. The **About the data** window lists every county. |
| **Public land only** | Everywhere else, via USGS PAD-US, plus links to the county's records |

Things to know:
- **Texas** never discloses sale prices (it's a "non-disclosure" state). **New Jersey** and **Maryland** remove owner names from open data for privacy.
- **California** and several other states restrict owner names at the county level, and many counties sell their data instead of publishing it. No free statewide parcel layer exists for those states.
- Tax rolls often lag behind deeds. When the deed records show a newer buyer than the tax roll, the map says so.
- A full chain of title back to the original land grant only exists in county deed books. Most of those aren't online as open data, so the map links to the county recorder instead.
- **This isn't a title search.** Public records can be wrong or out of date.

---

## Add more counties or states

**Asking a county for its data.** Contact the office that keeps the parcel map. In Michigan that's usually **Equalization** or **GIS**; in Iowa it's the **Auditor** or **Assessor**. Deed history lives with the **Register of Deeds** (MI) or **County Recorder** (IA). The easiest thing to add is a public map-service URL ending in `/FeatureServer/0` or `/MapServer/0` that includes owner names and allows cross-origin (CORS) requests. A downloaded file (shapefile or geodatabase) also works but becomes a frozen copy, so check the county allows it on a public website.

**Simple county entries.** Counties in [`js/counties-mi-ia.js`](js/counties-mi-ia.js) are one line of data each: the service `url` plus which fields hold the owner, parcel ID, address, acres, and sale date/price (see `fromFieldMap()` in `js/sources.js`). Copy a line, change the URL, FIPS code and field names, and reload.

**Full entries.** Every other data source is one entry in [`js/sources.js`](js/sources.js). Many counties publish an **ArcGIS REST** parcel layer (search the web for `"<county name> parcels FeatureServer"` or `"MapServer"`). To add one:

1. Open the layer URL with `?f=json` on the end and note the field names (owner, parcel ID, acres, sale date, sale price).
2. Copy an existing entry with `type: 'arcgis'` (Wisconsin is a simple one), set:
   - `id`: a short unique name
   - `url`: the layer URL, ending in `/FeatureServer/0` or `/MapServer/N`
   - `counties`: the county's 5-digit FIPS code (e.g. `'06037'` for Los Angeles), plus a `bbox` of `[west, south, east, north]`
   - `region`, `name`, `publisher`, `homepage`, `level`, `note`
   - a `normalize(a)` function mapping the layer's fields onto `owners`, `parcelId`, `address`, `acres`, `sales`
3. Reload the page and click a parcel in that county.

County entries are checked before statewide ones, so a detailed county source wins where both exist. For deed history, add a function to `HISTORY` in [`js/history.js`](js/history.js) and set `history: '<name>'` on the source.

The service has to allow browser requests from other websites (CORS). Most ArcGIS Online (`services*.arcgis.com`) and state GIS servers do.

---

## Files

```
index.html          the page
css/style.css       styles (light/dark, desktop/phone)
js/util.js          dates, money, area math, HTTP helpers
js/sources.js       parcel data sources (edit this to add places)
js/counties-mi-ia.js  Michigan + Iowa county services, one line of data each
js/history.js       deed/sales history sources + ownership timeline logic
js/app.js           map, property lines, click lookup, panel, search
data/states.js      simplified state outlines (U.S. Census)
run-local.bat       double-click to run locally on Windows
```

## Credits and usage notes
- Map library: [Leaflet](https://leafletjs.com/) (BSD-2).
- Satellite imagery: Esri World Imagery. Street map: © OpenStreetMap contributors. OpenStreetMap's own tile servers are meant for light use. If the site gets heavy traffic, switch the `streets` layer in `js/app.js` to another free tile provider.
- Address search: [Photon](https://photon.komoot.io/) with [Nominatim](https://nominatim.org/) as backup (both OpenStreetMap-based, fair-use limits apply).
- Parcel, deed and public-land data: the government agencies listed in the app's **About the data** dialog.
