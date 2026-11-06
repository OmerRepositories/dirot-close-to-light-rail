# Light Rail Proximity — Chrome extension for Yad2, Madlan, and Facebook

[עברית](./README.md)

[Marketing copy](./MARKETING.md) · [Terms of use](./LICENSE.en.md)

The extension displays useful indicators on real-estate listings in search results and on listing pages:

- **Light rail distance**: `450 m` · `🚶 ~7 min walk · 🚉 Dizengoff`
- **Price per square meter**: `₪28,800` · `−12% from the page median`
- `⭐ Worth checking` — highlights listings that meet all enabled criteria.

Clicking the distance badge opens a new Google Maps tab with walking directions when a street and city are available. A house number is not required; Maps does not open when no street-and-city address was found. The extension's displayed distance is straight-line distance, not walking distance.

Colors: green up to 600 m · yellow up to 1.5 km · gray for farther distances. `≈` means the location is approximate.

## Installation (Developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `lightrail-ext` directory.
4. If the extension is already installed, click its reload button and refresh the website.

## License and terms

Use of the extension is subject to the [license and terms of use](./LICENSE.en.md). The Hebrew version is available in [LICENSE.md](./LICENSE.md).

## Settings

Click the extension icon in Chrome's toolbar. Settings are saved automatically and applied to open pages:

- **Maximum price per square meter (₪)** — for example, `30000`. `0` or blank disables the limit.
- **At least this percentage below the page median** — `0` disables this rule.
- **Require proximity to light rail** and set the **maximum distance** from a station.
- **Yad2 and Madlan calculations** — independently turn off price-per-square-meter or light-rail calculations. The corresponding badge is hidden, the calculation is skipped, and its criteria are ignored when highlighting listings.
- **Highlight good listings** — displays a badge and orange outline when all enabled requirements are met.
- **Brokerage is less preferred** — highlights mentions of brokerage and real-estate terms; Yad2's agent label above the price is highlighted too. Positive phrases such as “without brokerage” are shown as positive.
- **Always remove brokerage listings** — automatically hides listings detected as brokerage. Alternatively, use the compact floating button at the bottom-left of a search page to hide them only for the current page; click again to show them. A small red “Brokerage listing” warning appears on detected listing cards and detail pages.
- **Always remove projects** — hides project cards, including Yad2 `/yad1/project/` links and Madlan `/projects/` links, on regular search pages. Filtering is disabled on project catalog pages such as `/yad1` and `/projects-for-sale/`, so their projects remain visible. The floating button can apply this only to the current page; click again to restore the projects.
- **Hide Yad2 ads** — hides Google ad slots and sponsored project promotions (regular listings are not affected). On by default; turn it off in settings to keep seeing ads.
- **Blocked streets** — list streets in settings (one per line) and listings on them are hidden from search pages. Add a city after a comma (e.g. “Jabotinsky, Petah Tikva”) to block it only in that city. Matching uses whole words and ignores house numbers, quotes, and hyphens.
- **Floating search filters** — drag the bar anywhere on screen with its “drag to move” handle; the position is remembered, and double-clicking the handle resets it to the corner. Brokerage and project filters can be toggled off with a second click. “Only near light rail” shows listings with a precise distance within the configured maximum; listings still being calculated remain visible until a result is available, while approximate and unavailable results do not count as near. This filter is disabled when rail calculations are off.
- **Disable the extension on selected sites** — independently disable Yad2, Madlan, or Facebook. When disabled, the extension removes its badges and highlights and stops observing the page. The preference is saved, and changes apply to already-open pages.
- **Required listing amenities** — choose parking, secure room (Mamad), elevator, storage, air conditioning, accessibility, balcony, solar water heater, bars, garden, and pool. Missing amenities are shown as an alert on a listing page and prevent the listing from being marked as worth checking. Unknown amenities are reported as unverifiable. Mamad is selected by default.
- **Madlan extraction** — listing cards use Madlan's structured price, area, and room fields, image address, and hydrated listing address/coordinates when available. Searches spanning multiple areas are not treated as having a single city; missing precise address/location data is not presented as an exact address.
- **Yad2 listing area extraction** — on listing pages, Yad2's structured “built area” and “price per square meter” fields take precedence over free-form description text. If the separate built-area field is absent, the extension reads the area item in the structured building-details section (the value paired with the “sqm” unit). This prevents a balcony size in the description from being mistaken for the apartment's area. Search results continue to use text extraction when structured details are unavailable.
- **Copy listing details for WhatsApp** — the clipboard button on a listing card or listing-page panel shows a hover preview of its address, price, area, rooms, floor, price per square meter, straight-line rail distance (not walking distance), and a link to the listing. Confirmed missing amenities are added in a “Missing” note; unknown amenities are not treated as missing. If the listing is identified as brokered, the copied message also warns “שים לב מדובר במודעת תיווך!” Clicking copies the message; unavailable fields are identified.
- **Listing indexing choice** — in the settings cache tab, choose whether listings are saved as soon as they appear in search results or only after you open their listing page. This affects new listings and does not delete data already saved; projects continue to be saved as before.
- **Full backup and transfer** — the cache manager exports a JSON backup containing all records, price history, extension preferences, and local data, and can import it on another computer. Choose to merge (backup records replace records with matching IDs) or replace all current local data and preferences. TXT, CSV, and Excel remain available for viewing/export.
- **Listing and project cache for Yad2 and Madlan** — listing visits store amenities, price, area, price per square meter, room count, available listing creation/update dates, coordinates, approximate rail distance, and brokerage detection. On Yad2 listing pages, price extraction uses the current-price element rather than the adjacent previous-price tag. Repeat visits record price changes (up to 50 observations per listing). When a legacy baseline has no date, the cache manager estimates it as one day before the next dated observation, preserves the uncertainty marker, and displays the resulting increase or decrease with a clear estimated-date label. If no later dated observation is available, its date remains unknown. Project pages store available project details and price/area ranges. The cache manager provides a wide table with global and per-column search, yes/no/unknown filters, combined min/max filters for price, price per square meter, rail distance, area, and rooms, sorting, a comparison score, editing, and deletion. The **Listing search** tab searches already-saved records and combines ranges for price, area, rooms, rail distance, and price per square meter with listing dates, brokerage, and amenities. Project price/area ranges match when they overlap the selected range, and text search covers all saved record fields. The **Delete listings** tab lets you opt in to one or more optional filters for price, area, rooms, rail distance, price per square meter, site, status, brokerage, and amenities. It previews matching listings and requires a separate confirmation before permanent deletion; deletion is disabled until at least one filter is selected, and projects are never affected. You can add a personal note to any record in its edit panel; notes appear in the table, can be searched, and are preserved when listing data is refreshed. Listing titles and addresses open their source page. Font size can be adjusted and is remembered. Price per square meter is calculated and read-only. The Excel workbook has a listings sheet and a separate price-history sheet with one readable row per observation, dates, prices, highlighted changes, and clickable listing links—no JSON price-history column. CSV and Excel exports also include yes/no indicators and rail data. Refreshing listings starts only after an explicit click, uses one tab, and observes a configurable 5–600 second delay. A 5-second delay is risky and may cause sites to block or restrict access; the extension does not bypass blocks. Unavailable listings and closed tabs are skipped so the queue can continue. Saving new data can be disabled; existing data remains until cleared. Up to 2,500 records and approximately 4 MiB are retained; old records are removed automatically. **Clear saved data** removes only the cache, not user settings.
- The price-history column shows the three latest observations on separate lines, with an option to expand the full history. The **Price changes** tab defaults to the complete price-change timeline across all listings, with filters for direction, current price, rail distance, rooms, brokerage, and amenities. **Show my preferences** filters by the required amenities and rail/brokerage settings saved in extension settings. Filtering only changes the display and never deletes or edits saved data; price ranges use the latest cached listing price. Events also include available listing details such as rail distance, rooms, Mamad, and storage. A comparison against an undated legacy baseline is classified by direction, while the known change date is shown and the estimated baseline date is clearly marked. The cache manager can clear only price histories while preserving each listing's latest price and all other cached data. All cached data, including price history, can be exported to TXT, CSV, and Excel from either the cache manager or the settings cache panel.
- The listing-status column records refresh checks for Yad2 only: the explicit “we searched everywhere but there is no such page” message marks a listing removed, and valid listing data marks it active. Pages that cannot be verified retain their previous status or remain unchecked.
- Refresh can be limited to Yad2 listings with an unchecked status. An explicit periodic schedule can run every 1–168 hours with a 5–600 second delay between listings, refreshing all saved listings or only unchecked Yad2 listings. Scheduling stays off until saved, runs while the browser is open, and may be delayed while the computer sleeps. Refresh uses one tab, does not bypass site blocks, and can be paused/stopped; disabling the schedule prevents future cycles.

All enabled criteria must be met for a listing to be highlighted as worth checking.

## Facebook

On the main feed page of a Facebook group only (for example, `facebook.com/groups/370244223604031`), the extension tries to identify properties offered for sale from the post text, property details, and a price or area. It does not analyze the general feed, profiles, or individual post pages. Posts are free-form, so classification is an estimate:

- **Price**: `2,500,000` · `2.5 מיליון` · `2.5M` · `950 אלף` · `מיליון וחצי`
- **Area**: `95 מ"ר` · `גודל 80` · `80 מטר מרובעים`
- **Address**: a street and house number, optionally with a city, for example `הרצל 12 פתח תקווה`
- Rental posts are excluded from purchase analysis. Phrases such as “for rent,” “monthly rent,” or “per month,” as well as a low currency amount typical of rent (for example `₪7,700`), produce a notice that the rental is not relevant to a purchase search.
- “Looking for an apartment/property” posts are excluded and receive a separate notice.
- Marketing copy such as “Looking for your next home?” is not automatically treated as a home-seeker post when property details and seller signals (such as a sale price or viewing invitation) identify a listing.
- Phone numbers are not treated as prices.
- Facebook distance is calculated only when a street and house number are explicitly identified (for example, `רחוב צה״ל 30`). A city alone or a street without a number is not used to guess an address, to avoid misleading locations.
- If price, area, or address is missing, the badge indicates what could not be found.

## How it works

- **Addresses**: Yad2 and Madlan are parsed using known site structures and listing data first. If those are unavailable, the extension falls back to general text parsing. The search context can supply a missing city.
- **Yad2 amenities**: the parking count in “More details” is also considered; a count greater than zero confirms parking even if the parking icon is disabled.
- **Yad2 location**: exact coordinates read on a listing page are cached with its amenity check and reused on search cards for that listing, avoiding street-level geocoding estimates.
- **Price per square meter**: price divided by area, compared with the median of listings on the page. A listing page uses the last saved search median when available.
- **Stations**: sourced from OpenStreetMap (Overpass) and cached for one week.
- **Lazy processing**: listing calculations start as cards approach the viewport.
- **Storage**: preferences are stored separately in `chrome.storage.sync`; listing checks are stored locally in `chrome.storage.local` and are not synced.
- **Geocoding**: exact coordinates provided by a listing are preferred. Otherwise, Nominatim (OSM) is queried. When a house number is requested, a result with a different number is rejected; a street-level fallback is marked approximate. Requests are rate-limited to comply with the service policy.
- **Distance**: straight-line distance to the nearest station; estimated walking time is distance × 1.3 ÷ 80 m/min.

## Troubleshooting

- **Address not found** — hover over the distance badge to see which addresses were searched.
- **Price per square meter unavailable** — the badge indicates whether price or area could not be extracted.

## Notes

- Yad2 and Madlan may change their page structures. Site-specific parsers are in `yad2.js` and `madlan.js`; shared extraction helpers are in `parse.js`; Facebook post classification and group-page scoping are isolated in `facebook-classifier.js` and `facebook-page.js`; Facebook UI/DOM handling is in `fb.js`; coordinate and Maps helpers are in `location.js`.
- The median is most meaningful when the results are for a single city or neighborhood.
- New or under-construction stations may not yet appear in OpenStreetMap.

## Releases

Releases are created automatically when a commit is pushed to `main` with a `manifest.json` version higher than the latest release. The version must use `MAJOR.MINOR.PATCH` format. Each release includes a ZIP archive of the extension.
