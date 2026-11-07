// יד2 exposes structured listing data in __NEXT_DATA__; use it before text heuristics.
var LRYad2 = (() => {
  let pageData;
  let pageDataRead = false;
  let pageListingsById;

  function getPageData() {
    if (pageDataRead) return pageData;
    const script = document.querySelector('script#__NEXT_DATA__');
    if (!script) return null;
    try {
      pageData = JSON.parse(script.textContent);
      pageDataRead = true;
    } catch (error) {
      console.warn("[lightrail-ext] could not read Yad2 listing data", error);
    }
    return pageData || null;
  }

  function listingId(root) {
    if (root === document) {
      const pageMatch = location.pathname.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
      if (pageMatch) return pageMatch[1];
    }
    const links = root.querySelectorAll ? root.querySelectorAll("a[href]") : [];
    for (const link of links) {
      try {
        const path = new URL(link.href, location.href).pathname;
        const match = path.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
        if (match) return match[1];
      } catch {}
    }
    const match = location.pathname.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
    return match ? match[1] : null;
  }

  function getPageListingsById() {
    if (pageListingsById) return pageListingsById;
    const data = getPageData();
    if (!data) return null;
    pageListingsById = new Map();
    const stack = [data];
    const visited = new WeakSet();
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== "object" || visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) {
        for (const value of current) stack.push(value);
        continue;
      }
      if (current.token && current.address) {
        pageListingsById.set(String(current.token), current);
      }
      for (const value of Object.values(current)) stack.push(value);
    }
    return pageListingsById;
  }

  function listingId(root) {
    if (root === document) {
      const pageMatch = location.pathname.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
      return pageMatch ? pageMatch[1] : null;
    }
    const link = root.querySelector('a[href*="/realestate/item/"]');
    if (!link) return null;
    try {
      const path = new URL(link.href, location.href).pathname;
      const match = path.match(/\/realestate\/item\/[^/]+\/([^/]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function listingUrl(root) {
    if (root === document && /\/realestate\/item\//.test(location.pathname)) {
      return location.href;
    }
    const link = root.querySelector('a[href*="/realestate/item/"]');
    return link ? new URL(link.href, location.href).href : null;
  }

  function readListingDetailNumber(root, testId) {
    if (!root || !root.querySelector) return null;
    const element = root.querySelector(`[data-testid="${testId}"]`);
    const text = element && (element.innerText || element.textContent || "");
    const match = String(text || "").replace(/[\u200e\u200f]/g, "").match(/^\s*([\d,]+(?:\.\d+)?)/);
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  function readListingBuiltArea(root) {
    const explicitArea = readListingDetailNumber(root, "square-meter-build-value");
    if (Number.isFinite(explicitArea)) return explicitArea;
    if (!root || !root.querySelectorAll) return null;

    for (const element of root.querySelectorAll('[data-testid="building-text"]')) {
      const itemText = element.parentElement &&
        (element.parentElement.innerText || element.parentElement.textContent || "");
      if (!/(?:מ["״”'׳]?ר|מ²|מ2)\s*$/.test(String(itemText || "").replace(/\s+/g, ""))) {
        continue;
      }
      const value = Number(String(element.innerText || element.textContent || "").replace(/[,\s]/g, ""));
      if (Number.isFinite(value) && value >= 15 && value <= 1000) return value;
    }
    return null;
  }

  function extractPriceSqm(root, text) {
    const stats = LR.extractPriceSqm(text);
    // סדר עדיפות למחיר (מהאמין ביותר): "המחיר הנוכחי" בעמוד מודעה, אלמנט המחיר בכרטיס חיפוש,
    // המחיר המובנה מנתוני הדף, ורק אחרון – חיפוש בטקסט החופשי. הטקסט החופשי עלול לתפוס
    // מספר אחר מהכרטיס, למשל סכום הירידה ("ירד ב־₪105,000"), ולשמור אותו בטעות כמחיר.
    // עמוד מודעה שלם מכיל גם מודעות אחרות (דומות/מומלצות) – בו לא מחפשים מחיר בטקסט החופשי
    const isWholePage = Boolean(root && root.nodeType === 9);
    const currentPriceElement =
      root &&
      root.querySelector &&
      (root.querySelector('[data-testid="current-price"] [data-testid="price"]') ||
        root.querySelector('[data-testid="ad-price"] [data-testid="price"]') ||
        root.querySelector('[data-testid="ad-card-price"] [data-testid="price"]') ||
        (!isWholePage ? root.querySelector('[data-testid="price"]') : null));
    const currentPriceText = currentPriceElement
      ? currentPriceElement.innerText || currentPriceElement.textContent || ""
      : "";
    const currentPrice = LR.extractPriceSqm(currentPriceText).price;
    // יש מקום למחיר אבל אין בו מספר (למשל "למידע נוסף") = המפרסם לא פרסם מחיר
    const priceHidden = Boolean(currentPriceElement) && !Number.isFinite(currentPrice);
    const id = Number.isFinite(currentPrice) ? null : listingId(root);
    const index = id ? getPageListingsById() : null;
    const dataRecord = index && index.get(id);
    const dataPrice = dataRecord && Number.isFinite(dataRecord.price) && dataRecord.price > 0
      ? dataRecord.price
      : null;
    const structuredSqm = readListingBuiltArea(root);
    const structuredPricePerSqm = readListingDetailNumber(root, "price-per-squaremeter-value");
    const price = Number.isFinite(currentPrice)
      ? currentPrice
      : Number.isFinite(dataPrice)
        ? dataPrice
        : priceHidden || isWholePage
          ? null
          : stats.price;
    const sqm = Number.isFinite(structuredSqm) ? structuredSqm : stats.sqm;
    const normalized = LR.extractPriceSqm(
      `${Number.isFinite(price) ? `${price} ₪ ` : ""}${Number.isFinite(sqm) ? `${sqm} מ״ר` : ""}`
    );
    if (Number.isFinite(structuredPricePerSqm) && !priceHidden) {
      normalized.ppsm = structuredPricePerSqm;
    }
    if (priceHidden && !Number.isFinite(price)) {
      normalized.priceHidden = true;
      normalized.reason = "המחיר לא פורסם במודעה";
    }
    return normalized;
  }

  function placeFromData(root) {
    const id = listingId(root);
    const index = id ? getPageListingsById() : null;
    const record = index && index.get(id);
    const address = record && record.address;
    if (!address) return null;
    const street = address.street && address.street.text;
    const city = address.city && address.city.text;
    if (!street || !city) return null;
    const number = address.house && address.house.number;
    const coords = address.coords;
    const escapedNumber = String(number || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fullStreet =
      number && !new RegExp(`\\s${escapedNumber}$`).test(street) ? `${street} ${number}` : street;
    return {
      street: fullStreet,
      city,
      hood: address.neighborhood && address.neighborhood.text,
      coordinates:
        coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
          ? { lat: coords.lat, lon: coords.lon }
          : null,
    };
  }

  function projectFromData() {
    const projectId = location.pathname.match(/^\/yad1\/project\/(\d+)\/?$/);
    const data = getPageData();
    const project =
      data &&
      data.props &&
      data.props.pageProps &&
      data.props.pageProps.grayProject;
    if (!project || !projectId || String(project.id) !== projectId[1]) return null;

    const street = project.street && project.street.name;
    const city = project.city && project.city.name;
    const number = project.houseNumber;
    if (!street || !city) return null;
    return {
      street: number ? `${street} ${number}` : street,
      city,
      coordinates:
        Number.isFinite(project.y) && Number.isFinite(project.x)
          ? { lat: project.y, lon: project.x }
          : null,
    };
  }

  function projectExportData(root, text) {
    const data = getPageData();
    const pageProps = data && data.props && data.props.pageProps;
    const project = pageProps && pageProps.project;
    const address = project && project.address;
    const detail = project && project.additionalDetails;
    const grayProject = pageProps && pageProps.grayProject;
    const projectId = location.pathname.match(/^\/yad1\/project\/(\d+)\/?$/);
    if (!projectId || !project || String(project.token) !== projectId[1]) return null;

    const titleElement = root.querySelector('[data-testid="project-title"], h1');
    const displayAddress =
      (address && address.display) ||
      [grayProject && grayProject.street && grayProject.street.name,
       grayProject && grayProject.houseNumber,
       grayProject && grayProject.city && grayProject.city.name]
        .filter(Boolean)
        .join(" ");
    const city = address && address.city && address.city.text;
    const neighborhood = address && address.neighborhood && address.neighborhood.text;
    const price = Number(detail && detail.minPrice) || null;
    const sqm = Number(detail && detail.minSquaremeter) || null;
    const coords = address && address.coords;
    return {
      id: projectId[1],
      title: (titleElement && titleElement.innerText) || project.projectName || "",
      address: displayAddress,
      city: city || (grayProject && grayProject.city && grayProject.city.name) || "",
      neighborhood:
        neighborhood ||
        (grayProject && grayProject.neighborhood && grayProject.neighborhood.name) ||
        "",
      coordinates:
        coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
          ? { lat: coords.lat, lon: coords.lon }
          : grayProject && Number.isFinite(grayProject.y) && Number.isFinite(grayProject.x)
            ? { lat: grayProject.y, lon: grayProject.x }
            : null,
      price,
      maxPrice: Number(detail && detail.maxPrice) || null,
      sqm,
      maxSqm: Number(detail && detail.maxSquaremeter) || null,
      pricePerSqm: price && sqm ? Math.round(price / sqm) : null,
      rooms: Number(detail && detail.roomsCount) || null,
      url: location.href,
      recordType: "project",
    };
  }

  function parseRoomCount(value) {
    const match = String(value || "").match(/\d+(?:[.,]\d+)?/);
    if (!match) return null;
    const rooms = Number(match[0].replace(",", "."));
    return Number.isFinite(rooms) ? rooms : null;
  }

  function listingExportData(root) {
    const id = listingId(root);
    const index = id ? getPageListingsById() : null;
    const data = index && index.get(id);
    const roomElement = root.querySelector('[data-testid="building-text"]');
    const createdElement = root.querySelector('[data-testid="report-ad-label"]');
    const structuredRooms =
      data &&
      (data.roomsCount ??
        data.rooms ??
        (data.additionalDetails && data.additionalDetails.roomsCount));
    const createdText = createdElement ? createdElement.innerText : "";
    const createdMatch = createdText.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/);
    const dateValue = (keys) => {
      if (!data) return null;
      for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== "") {
          return data[key];
        }
      }
      return null;
    };

    return {
      rooms:
        parseRoomCount(roomElement && roomElement.innerText) ??
        parseRoomCount(structuredRooms),
      listingCreatedAt:
        (createdMatch && createdMatch[0]) ||
        dateValue(["releaseDate", "createdAt", "publishedAt", "dateCreated"]),
      listingUpdatedAt: dateValue([
        "updatedAt",
        "lastUpdatedAt",
        "modifiedAt",
        "updateDate",
      ]),
    };
  }

  function listingPageStatus(root = document) {
    const match = location.pathname.match(/^\/realestate\/item\/[^/]+\/([^/]+)/);
    if (!match) return null;
    const id = match[1];
    const pageText = root.body && (root.body.innerText || root.body.textContent || "");
    const normalizedText = pageText.replace(/\s+/g, " ");
    if (
      normalizedText.includes("חיפשנו בכל מקום") &&
      normalizedText.includes("אין לנו עמוד כזה")
    ) {
      return { id, status: "removed" };
    }

    const listing = getPageListingsById()?.get(id);
    if (listing && listing.address && typeof listing.address === "object") {
      return { id, status: "active" };
    }
    return null;
  }

  function addressFromCardDetails(root) {
    const streetElement = root.querySelector('[data-testid="street-name"]');
    const locationElement = root.querySelector('[data-testid="item-info-line-1st"]');
    if (!streetElement || !locationElement) return null;

    const street = streetElement.innerText.trim();
    const location = LR.parseAddress(locationElement.innerText, null);
    if (!street || !location.city) return null;

    const hasHouseNumber = /\s\d{1,4}[א-ת]?$/.test(street);
    return {
      street,
      city: location.city,
      hood: location.hood,
      queries: [
        {
          q: `${street}, ${location.city}`,
          approx: !hasHouseNumber,
          bias: false,
        },
      ],
      coordinates: null,
    };
  }

  function readAddress(root, text, ctxCity, single) {
    const projectPage = isProjectPage(location.pathname);
    const project = projectPage ? projectFromData() : null;
    const place = placeFromData(root);
    const cardDetails = addressFromCardDetails(root);
    let parsed;
    let coordinates = project ? project.coordinates : null;
    let addressText = text;
    if (projectPage) {
      const addressElement = root.querySelector('[data-testid="project-address"]');
      addressText =
        (addressElement && addressElement.innerText) ||
        (project ? `${project.street}, ${project.city}` : "");
      parsed = LR.parseAddress(addressText, addressText ? ctxCity : null);
    } else if (cardDetails) {
      parsed = cardDetails;
      coordinates = place ? place.coordinates : null;
    } else if (place) {
      addressText = `${place.street}, ${place.hood || ""}, ${place.city}`;
      parsed = LR.parseAddress(
        addressText,
        ctxCity
      );
      coordinates = place.coordinates;
    } else {
      const addressElement = root.querySelector(
        '[data-testid="address"], [data-testid="ad-card-address"]'
      );
      addressText = addressElement ? addressElement.innerText : text;
      parsed = single
        ? LR.parseAny(addressText, ctxCity)
        : LR.parseAddress(addressText, ctxCity);
    }

    if (!single && text && !cardDetails) {
      const cardAddress = LR.parseAddress(text, ctxCity);
      const houseNumber = (street) => /\s\d{1,4}[א-ת]?$/.test(street || "");
      const streetName = (street) =>
        String(street || "")
          .replace(/\s+\d{1,4}[א-ת]?$/, "")
          .replace(/[\s"'׳״-]/g, "")
          .toLowerCase();
      const focusedAddress = streetName(addressText);
      const candidateStreetName = streetName(cardAddress.street);
      const houseNumberValue = (street) => {
        const match = String(street || "").match(/\s(\d{1,4}[א-ת]?)$/);
        return match ? match[1].replace(/\s+/g, "").toLowerCase() : null;
      };
      const focusedNumber = houseNumberValue(parsed.street);
      const candidateNumber = houseNumberValue(cardAddress.street);
      const hasConflictingHouseNumbers =
        focusedNumber && candidateNumber && focusedNumber !== candidateNumber;
      const addsLocationContext =
        (cardAddress.city && !parsed.city) || (cardAddress.hood && !parsed.hood);
      const canEnrichAddress =
        !parsed.street ||
        (!houseNumber(parsed.street) &&
          (candidateStreetName.includes(streetName(parsed.street)) ||
            streetName(parsed.street).includes(candidateStreetName))) ||
        addsLocationContext;
      if (
        houseNumber(cardAddress.street) &&
        (focusedAddress.includes(candidateStreetName) ||
          (!houseNumber(parsed.street) &&
            (!parsed.street ||
              candidateStreetName.includes(streetName(parsed.street)) ||
              streetName(parsed.street).includes(candidateStreetName)))) &&
        !hasConflictingHouseNumbers &&
        canEnrichAddress
      ) {
        parsed = {
          ...cardAddress,
          queries: [...cardAddress.queries, ...parsed.queries].filter(
            (query, index, queries) => queries.findIndex((item) => item.q === query.q) === index
          ),
        };
      }
    }

    return { ...parsed, coordinates };
  }

  function isProjectPage(path) {
    return /^\/yad1\/project\/\d+\/?$/.test(path);
  }

  function isProjectListingPage(path) {
    return /^\/yad1\/?$/.test(path);
  }

  const AMENITY_TEST_IDS = {
    parking: ["parking-item"],
    secureRoom: ["security-room-item"],
    elevator: ["elevator-item"],
    storage: ["warehouse-item"],
    airConditioner: ["air-conditioning-item"],
    accessible: ["handicap-access-item"],
    balcony: ["balcony-item"],
    sunBoiler: ["boiler-item"],
    grating: ["bars-item"],
    garden: ["garden-item"],
    pool: ["pool-item", "swimming-pool-item"],
  };

  function readAmenities(root) {
    const grid = root.querySelector('[data-testid="in-property-grid"]');
    if (!grid) return null;
    const result = {};
    for (const [key, testIds] of Object.entries(AMENITY_TEST_IDS)) {
      const item = testIds.map((id) => grid.querySelector(`[data-testid="${id}"]`)).find(Boolean);
      const disabled =
        item &&
        (item.classList.contains("disabled") ||
          [...item.classList].some((className) => className.endsWith("__disabled")));
      result[key] = Boolean(item && !disabled);
    }

    const parkingValue = root.querySelector('[data-testid="parking-value"]');
    const parkingCount = parkingValue && parkingValue.textContent.match(/^\s*(\d+)/);
    if (parkingCount && Number(parkingCount[1]) > 0) {
      result.parking = true;
    }

    return result;
  }

  return {
    listingId,
    listingUrl,
    extractPriceSqm,
    readAddress,
    listingExportData,
    listingPageStatus,
    projectExportData,
    readAmenities,
    isProjectPage,
    isProjectListingPage,
  };
})();
