// =============================================================================
// MODULE: CACHED GEOCODING (SUPABASE + EDGE FUNCTION)
// =============================================================================
// Two ways in: a single CEP + street-number lookup, and a batch lookup that
// parses table data pasted from a spreadsheet (e.g. the daily manifest
// export), extracting the CEP and street number from each row and
// geocoding all of them through a small concurrency pool so we don't fire
// dozens of requests at the Edge Function at once.
import { sb } from "../supabase-client.js";
import { qs, escapeHtml, normalizeCep, attachZipMask } from "../utils.js";
import { showToast } from "../ui.js";

// Same shape as the `chk_island_zip_code` constraint on `zip_codes`.
const ZIP_REGEX = /^880[0-6][0-9]-[0-9]{3}$/;
// A CEP-looking token inside a pasted spreadsheet cell (with or without the dash).
const CEP_CELL_REGEX = /^\d{5}-?\d{3}$/;

const DEFAULT_CONCURRENCY = 20;
const MAX_CONCURRENCY = 20;

// -----------------------------------------------------------------------
// Core lookup: cache-first, falling back to the `geocode` Edge Function.
// Throws on failure instead of swallowing errors, so both the single-search
// form and each batch row can surface their own error message.
// -----------------------------------------------------------------------
function normalizeStreetNumber(raw) {
    const value = String(raw ?? "").trim().toUpperCase();
    return value === "" ? "S/N" : value;
}

async function geocodeAddress(cep, number) {
    const normalizedCep = normalizeCep(cep);
    const normalizedNumber = normalizeStreetNumber(number);

    if (!ZIP_REGEX.test(normalizedCep)) {
        throw new Error("CEP inválido. Use o formato 880XX-XXX.");
    }

    // 1. Fast path: check the Supabase cache first.
    const { data: cachedData, error: cacheError } = await sb
        .from("geocoding_cache")
        .select("*")
        .eq("zip_code", normalizedCep)
        .eq("street_number", normalizedNumber)
        .maybeSingle();

    if (cacheError) {
        console.error("Falha ao consultar cache de geocoding:", cacheError);
    }

    if (cachedData) {
        return {
            lat: Number(cachedData.lat),
            lon: Number(cachedData.lon),
            location_type: cachedData.location_type,
            formatted_address: cachedData.formatted_address,
            cep: normalizedCep,
            number: normalizedNumber,
            source: "cache",
        };
  }

    // 2. Cache miss: delegate to the secure Edge Function.
    const { data, error } = await sb.functions.invoke("geocode", {
        body: { cep: normalizedCep, number: normalizedNumber },
    });

    if (error) {
        throw new Error(error.message || "Falha ao chamar a função de geocodificação.");
    }
    if (data && data.error) {
        throw new Error(data.error);
    }
    if (!data) {
        throw new Error("Nenhum dado retornado pela geocodificação.");
    }

    return {
        lat: Number(data.lat),
        lon: Number(data.lon),
        location_type: data.location_type,
        formatted_address: data.formatted_address,
        cep: normalizedCep,
        number: normalizedNumber,
        source: data.source || "api",
    };
}

function googleMapsUrl(lat, lon) {
    return `https://www.google.com/maps?q=${lat},${lon}`;
}

function geoBadge(kind) {
    const map = {
        cache: ["geo-source-badge geo-source-cache", "Cache"],
        api: ["geo-source-badge geo-source-api", "API"],
        error: ["geo-source-badge geo-status-error", "Erro"],
        pending: ["geo-source-badge geo-status-pending", "Pendente"],
        processing: ["geo-source-badge geo-status-processing", "Processando…"],
    };
    const [cls, label] = map[kind] || map.pending;
    return `<span class="${cls}">${label}</span>`;
}

// =============================================================================
// SINGLE LOOKUP
// =============================================================================
const singleFormEl = qs("#geo-single-form");
const singleCepEl = qs("#geo-single-cep");
const singleNumberEl = qs("#geo-single-number");
const singleSubmitEl = qs("#geo-single-submit");
const singleResultEl = qs("#geo-single-result");
const singleEmptyEl = qs("#geo-single-empty");

if (singleCepEl) attachZipMask(singleCepEl);

function renderSingleResult(result) {
    singleResultEl.innerHTML = `
    <div class="geo-result-card-body">
      <div>
        <div class="geo-result-field-label">CEP</div>
        <div class="geo-result-field-value">${escapeHtml(result.cep)}</div>
      </div>
      <div>
        <div class="geo-result-field-label">Número</div>
        <div class="geo-result-field-value">${escapeHtml(result.number)}</div>
      </div>
      <div>
        <div class="geo-result-field-label">Latitude</div>
        <div class="geo-result-field-value">${escapeHtml(String(result.lat))}</div>
      </div>
      <div>
        <div class="geo-result-field-label">Longitude</div>
        <div class="geo-result-field-value">${escapeHtml(String(result.lon))}</div>
      </div>
      <div style="grid-column: 1 / -1">
        <div class="geo-result-field-label">Endereço formatado</div>
        <div class="geo-result-field-value">${escapeHtml(result.formatted_address || "—")}</div>
      </div>
    </div>
    <div class="geo-result-card-footer">
      ${geoBadge(result.source === "cache" ? "cache" : "api")}
      <a class="geo-map-link" href="${googleMapsUrl(result.lat, result.lon)}" target="_blank" rel="noopener">
        Abrir no Google Maps &rarr;
      </a>
    </div>
  `;
    singleResultEl.classList.remove("hidden");
    singleEmptyEl.classList.add("hidden");
}

function renderSingleError(message) {
    singleResultEl.innerHTML = `
    <div class="geo-result-card-body">
      <div style="grid-column: 1 / -1">
        <div class="geo-result-field-label">Erro</div>
        <div class="geo-result-field-value" style="color: var(--stamp-red)">${escapeHtml(message)}</div>
      </div>
    </div>
  `;
    singleResultEl.classList.remove("hidden");
    singleEmptyEl.classList.add("hidden");
}

if (singleFormEl) {
    singleFormEl.addEventListener("submit", async (e) => {
        e.preventDefault();

        if (!singleCepEl.value.trim()) {
            showToast("Informe um CEP para buscar.", "error");
            return;
        }

        singleSubmitEl.disabled = true;
        singleSubmitEl.textContent = "Buscando…";

        try {
            const result = await geocodeAddress(singleCepEl.value, singleNumberEl.value);
            renderSingleResult(result);
        } catch (error) {
            console.error("Erro ao geocodificar:", error);
            renderSingleError(error.message || "Não foi possível geocodificar este endereço.");
            showToast("Falha ao buscar coordenadas.", "error");
        } finally {
            singleSubmitEl.disabled = false;
            singleSubmitEl.textContent = "Buscar Coordenadas";
        }
    });
}

// =============================================================================
// BATCH LOOKUP (paste table data → parse → geocode with a concurrency pool)
// =============================================================================

// Pulls the street number off the end of an address cell. Addresses either
// end in a plain number ("...Camilo 203") or in the literal "S/N" (sem
// número), matching the export format used by the daily manifest.
function extractNumberFromAddress(address) {
    const trimmed = (address || "").trim();
    const match = trimmed.match(/(?:^|\s)(S\/N|\d+)\s*$/i);
    if (!match) {
        return { streetLabel: trimmed, number: "" };
    }
    const token = match[1];
    const streetLabel = trimmed.slice(0, trimmed.length - match[0].length).trim() || trimmed;
    const number = /^\d+$/.test(token) ? token : "";
    return { streetLabel, number };
}

// Parses pasted spreadsheet rows. Columns are expected to be tab-separated
// (the default when copying a table out of a browser/Excel/Sheets); a
// double-space fallback is used for plain-text paste. The CEP column is
// found by content rather than by fixed position, and the address is taken
// from the cell immediately before it — this matches the manifest export
// (Objeto, Ordem, Endereço, CEP, ...) without hard-coding column indexes.
// Lines with no recognizable CEP (e.g. the header row) are skipped.
function parseBatchInput(rawText) {
    const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const rows = [];
    let skipped = 0;

    for (const line of lines) {
        let cells = line.split("\t").map((c) => c.trim());
        if (cells.length < 2) {
            cells = line.split(/\s{2,}/).map((c) => c.trim());
        }

        const cepIndex = cells.findIndex((c) => CEP_CELL_REGEX.test(c));
        if (cepIndex === -1) {
            skipped++;
            continue;
        }

        const cep = normalizeCep(cells[cepIndex]);
        const addressRaw = cepIndex > 0 ? cells[cepIndex - 1] : "";
        const objeto = cells[0] && cells[0] !== addressRaw ? cells[0] : "";
        const { streetLabel, number } = extractNumberFromAddress(addressRaw);

        rows.push({ objeto, addressRaw, streetLabel, number, cep });
    }

    return { rows, skipped };
}

// Runs `worker` over `items` using a fixed-size pool of concurrent workers,
// instead of firing every request at once. `isCancelled` is polled between
// items so an in-progress batch can be stopped early.
async function runWithConcurrency(items, worker, limit, isCancelled) {
    let nextIndex = 0;

    async function runner() {
        while (nextIndex < items.length) {
            if (isCancelled()) return;
            const current = nextIndex++;
            await worker(items[current], current);
        }
    }

    const poolSize = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: poolSize }, runner));
}

const batchInputEl = qs("#geo-batch-input");
const batchConcurrencyEl = qs("#geo-batch-concurrency");
const batchRunEl = qs("#geo-batch-run");
const batchCancelEl = qs("#geo-batch-cancel");
const batchSummaryEl = qs("#geo-batch-summary");
const batchStatTotalEl = qs("#geo-batch-stat-total");
const batchStatDoneEl = qs("#geo-batch-stat-done");
const batchStatSuccessEl = qs("#geo-batch-stat-success");
const batchStatErrorEl = qs("#geo-batch-stat-error");
const batchProgressEl = qs("#geo-batch-progress");
const batchProgressFillEl = qs("#geo-batch-progress-fill");
const batchResultsFrameEl = qs("#geo-batch-results-frame");
const batchTbodyEl = qs("#geo-batch-tbody");
const batchEmptyEl = qs("#geo-batch-empty");

let batchCancelled = false;
let batchRunning = false;

function renderBatchRow(row) {
    const tr = document.createElement("tr");
    tr.id = `geo-batch-row-${row.rowIndex}`;
    if (row.status === "error") tr.classList.add("geo-row-error");

    const hasCoords = row.lat !== undefined && row.lon !== undefined;
    const actionCell = hasCoords
        ? `<a class="geo-map-link" href="${googleMapsUrl(row.lat, row.lon)}" target="_blank" rel="noopener">Ver no mapa</a>`
        : row.errorMessage
            ? `<span class="geo-map-link" title="${escapeHtml(row.errorMessage)}" style="cursor: help">Detalhes</span>`
            : "—";

    tr.innerHTML = `
    <td>${escapeHtml(row.objeto || "—")}</td>
    <td>${escapeHtml(row.streetLabel || row.addressRaw || "—")}</td>
    <td>${escapeHtml(row.number || "S/N")}</td>
    <td class="zip-code-cell">${escapeHtml(row.cep)}</td>
    <td>${hasCoords ? escapeHtml(String(row.lat)) : "—"}</td>
    <td>${hasCoords ? escapeHtml(String(row.lon)) : "—"}</td>
    <td>${geoBadge(row.status)}</td>
    <td class="col-actions">${actionCell}</td>
  `;
    return tr;
}

function updateBatchRowEl(row) {
    const rendered = renderBatchRow(row);
    const existing = qs(`#geo-batch-row-${row.rowIndex}`);
    if (existing) existing.replaceWith(rendered);
    else batchTbodyEl.appendChild(rendered);
}

function updateBatchStats(rows) {
    const done = rows.filter((r) => r.status === "cache" || r.status === "api" || r.status === "error").length;
    const success = rows.filter((r) => r.status === "cache" || r.status === "api").length;
    const errors = rows.filter((r) => r.status === "error").length;

    batchStatTotalEl.textContent = String(rows.length);
    batchStatDoneEl.textContent = String(done);
    batchStatSuccessEl.textContent = String(success);
    batchStatErrorEl.textContent = String(errors);

    const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;
    batchProgressFillEl.style.width = `${pct}%`;
}

function setBatchRunningUI(isRunning) {
    batchRunning = isRunning;
    batchRunEl.disabled = isRunning;
    batchRunEl.textContent = isRunning ? "Processando…" : "Processar em Lote";
    batchCancelEl.disabled = !isRunning;
    batchConcurrencyEl.disabled = isRunning;
    batchInputEl.disabled = isRunning;
}

async function runBatch() {
    if (batchRunning) return;

    const { rows, skipped } = parseBatchInput(batchInputEl.value);

    if (rows.length === 0) {
        showToast("Nenhum CEP reconhecido no texto colado.", "error");
        return;
    }

    const requestedLimit = Number(batchConcurrencyEl.value);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(MAX_CONCURRENCY, Math.floor(requestedLimit))
        : DEFAULT_CONCURRENCY;
    batchConcurrencyEl.value = String(limit);

    rows.forEach((row, index) => {
        row.rowIndex = index;
        row.status = "pending";
    });

    batchCancelled = false;
    setBatchRunningUI(true);

    batchTbodyEl.innerHTML = "";
    batchResultsFrameEl.style.display = "";
    batchEmptyEl.classList.add("hidden");
    batchSummaryEl.style.display = "";
    batchProgressEl.classList.remove("hidden");

    rows.forEach((row) => updateBatchRowEl(row));
    updateBatchStats(rows);

    if (skipped > 0) {
        showToast(`${skipped} linha(s) ignorada(s) por não conter um CEP reconhecível.`, "error");
    }

    await runWithConcurrency(
        rows,
        async (row) => {
            if (batchCancelled) return;
            row.status = "processing";
            updateBatchRowEl(row);

            try {
                const result = await geocodeAddress(row.cep, row.number);
                row.status = result.source === "cache" ? "cache" : "api";
                row.lat = result.lat;
                row.lon = result.lon;
                row.formattedAddress = result.formatted_address;
      } catch (error) {
            row.status = "error";
            row.errorMessage = error.message || "Falha desconhecida.";
        }

          updateBatchRowEl(row);
          updateBatchStats(rows);
      },
      limit,
      () => batchCancelled,
  );

    setBatchRunningUI(false);
    showToast(batchCancelled ? "Processamento em lote cancelado." : "Processamento em lote concluído.");
}

if (batchRunEl) {
    batchRunEl.addEventListener("click", runBatch);
}

if (batchCancelEl) {
    batchCancelEl.addEventListener("click", () => {
        batchCancelled = true;
        batchCancelEl.disabled = true;
        batchCancelEl.textContent = "Cancelando…";
    });
}

// =============================================================================
// TAB LIFECYCLE (called from switchTab in ui.js)
// =============================================================================

// Called every time the tab is opened. Kept idempotent — it must not wipe
// out an in-progress or completed batch just because the user switched
// tabs and came back.
export function loadGeocoding() {
    if (singleCepEl && singleResultEl.classList.contains("hidden")) {
        singleCepEl.focus();
    }
}

// Called from the global "clear everything" (F4) hotkey in ui.js.
export function resetGeocodingPanel() {
    singleResultEl.innerHTML = "";
    singleResultEl.classList.add("hidden");
    singleEmptyEl.classList.remove("hidden");

    batchCancelled = true;
    batchTbodyEl.innerHTML = "";
    batchResultsFrameEl.style.display = "none";
    batchSummaryEl.style.display = "none";
    batchProgressEl.classList.add("hidden");
    batchProgressFillEl.style.width = "0%";
    batchEmptyEl.classList.remove("hidden");
    batchConcurrencyEl.value = String(DEFAULT_CONCURRENCY);
    setBatchRunningUI(false);
}


const OSRM_BASE_URL = 'https://router.project-osrm.org/trip/v1/driving';
const OSMR_SOURCE = "https://download.geofabrik.de/south-america/brazil/sul-latest.osm.pbf"
const CEE_START_POINT = { lon: -48.5311624, lat: -27.6632354, zip: "88047-401", number: "1899" };

/**
 * Optimizes a route for a single vehicle given an array of coordinates.
 * 
 * @param {Array<{lon: number, lat: number, zip: string, number: string, code: string | undefined | null}>} locations 
 * @param {Object} startPoint - The mandatory starting location
 * @returns {Promise<Object>} The optimized route and ordered waypoints
 */
export async function getOptimizedRoute(locations, startPoint = CEE_START_POINT) {
    if (!locations || locations.length < 2) {
        throw new Error('At least two locations are required to generate a route.');
    }

    // Ensure the starting point is always the first item in the array
    if (locations.length !== 0 && (locations[0].lat !== startPoint.lat || locations[0].lon !== startPoint.lon)) {
        locations = [startPoint, ...locations];
    }

    // 1. OSRM expects coordinates in the format: longitude,latitude separated by semicolons
    const coordsString = locations
        .map(loc => `${loc.lon},${loc.lat}`)
        .join(';');

    const url = `${OSRM_BASE_URL}/${coordsString}?steps=true`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`OSRM API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== 'Ok') {
            throw new Error(`OSRM routing failed: ${data.code}`);
        }
        console.log(data)

        // 5. Map the optimized waypoint order back to the original locations
        const optimizedOrder = locations
            .map((loc, index) => {
                const wp = data.waypoints[index];
                return {
                    ...loc,
                    waypoint_index: wp.waypoint_index,
                    snapping_distance: wp.distance
                };
            })
            .sort((a, b) => a.waypoint_index - b.waypoint_index);

        return {
            durationSeconds: data.trips[0].duration,
            distanceMeters: data.trips[0].distance,
            geometry: data.trips[0].geometry,
            optimizedLocations: optimizedOrder
        };

    } catch (error) {
        console.error('Failed to optimize route:', error);
        throw error;
    }
}


// ui.js dispatches to these by bare identifier (`typeof loadGeocoding === "function"`),
// matching every other tab module in this app, so expose them globally.
window.loadGeocoding = loadGeocoding;
window.resetGeocodingPanel = resetGeocodingPanel;

// =============================================================================
// ROUTE OPTIMIZATION (Map & OSRM Integration)
// =============================================================================
const routeManualForm = qs("#geo-route-manual-form");
const routeCodeInput = qs("#geo-route-code");
const routeCepInput = qs("#geo-route-cep");
const routeNumberInput = qs("#geo-route-number");
const routePasteInput = qs("#geo-route-paste");
const routeAddPastedBtn = qs("#geo-route-add-pasted");
const routeGenerateBtn = qs("#geo-route-generate");
const routeTbody = qs("#geo-route-tbody");
const routeCount = qs("#geo-route-count");
const routeMapContainer = qs("#geo-route-map");
const routeStats = qs("#geo-route-stats");
const routeTime = qs("#geo-route-time");
const routeDistance = qs("#geo-route-distance");

let routeItems = []; // Stores pending delivery items
let leafletMap = null;
let routeLayer = null;
let markersLayer = null;

// Ensure CEP mask is applied to the new manual input
if (routeCepInput) attachZipMask(routeCepInput);

/**
 * Initializes the Leaflet map centered on Florianópolis
 */
function initRouteMap() {
    if (leafletMap) return;

    // Default center at CEE Florianópolis
    leafletMap = L.map(routeMapContainer).setView([CEE_START_POINT.lat, CEE_START_POINT.lon], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(leafletMap);

    markersLayer = L.layerGroup().addTo(leafletMap);
}

/**
 * Updates the UI table with pending delivery items
 */
function renderRouteTable() {
    routeCount.textContent = routeItems.length;

    if (routeItems.length === 0) {
        routeTbody.innerHTML = '<tr class="empty-state"><td colspan="4">No packages added.</td></tr>';
        return;
    }

    routeTbody.innerHTML = routeItems.map((item, index) => `
        <tr>
            <td>${escapeHtml(item.code || "N/A")}</td>
            <td class="zip-code-cell">${escapeHtml(item.cep)}</td>
            <td>${escapeHtml(item.number || "S/N")}</td>
            <td class="col-actions">
                <button type="button" class="btn btn-danger btn-icon" onclick="removeRouteItem(${index})">X</button>
            </td>
        </tr>
    `).join('');
}

// Attach globally so the inline onclick works
window.removeRouteItem = function (index) {
    routeItems.splice(index, 1);
    renderRouteTable();
};

/**
 * Handles adding a single item from the manual form
 */
if (routeManualForm) {
    routeManualForm.addEventListener("submit", (e) => {
        e.preventDefault();

        const cep = routeCepInput.value.trim();
        if (!ZIP_REGEX.test(normalizeCep(cep))) {
            showToast("Invalid CEP format.", "error");
            return;
        }

        routeItems.push({
            code: routeCodeInput.value.trim(),
            cep: normalizeCep(cep),
            number: routeNumberInput.value.trim() || "S/N"
        });

        routeManualForm.reset();
        routeCodeInput.focus();
        renderRouteTable();
    });
}

/**
 * Handles bulk adding from the pasted textarea
 * Reuses the existing parseBatchInput function which handles the specific table format
 */
if (routeAddPastedBtn) {
    routeAddPastedBtn.addEventListener("click", () => {
        const rawText = routePasteInput.value;
        if (!rawText.trim()) return;

        const { rows, skipped } = parseBatchInput(rawText);

        rows.forEach(row => {
            routeItems.push({
                code: row.objeto,
                cep: row.cep,
                number: row.number || "S/N"
            });
        });

        routePasteInput.value = "";
        renderRouteTable();

        if (rows.length > 0) {
            showToast(`${rows.length} packages added successfully.`);
        }
        if (skipped > 0) {
            showToast(`${skipped} rows skipped (No CEP found).`, "error");
        }
    });
}

/**
 * Decodes the OSRM geometry polyline into LatLng array for Leaflet
 */
function decodePolyline(encoded) {
    let points = [];
    let index = 0, len = encoded.length;
    let lat = 0, lng = 0;

    while (index < len) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        points.push([lat / 1E5, lng / 1E5]);
    }
    return points;
}


/**
 * Orchestrates Geocoding -> Routing -> Map Rendering
 */
if (routeGenerateBtn) {
    routeGenerateBtn.addEventListener("click", async () => {
        if (routeItems.length === 0) {
            showToast("Add at least one package to generate a route.", "error");
            return;
        }

        initRouteMap();
        routeGenerateBtn.disabled = true;
        routeGenerateBtn.textContent = "Geocoding and Routing...";

        try {
            // 1. Geocode all items
            const geocodedLocations = [];
            const MAX_CONCURRENT_REQUESTS = 20;
            const queue = [...routeItems];
            // Determine the actual number of workers to spawn (prevents spawning 20 if we only have 5 items)
            const poolSize = Math.min(MAX_CONCURRENT_REQUESTS, routeItems.length);
            const workers = [];

            /**
             * Async worker that picks the next item from the queue and processes it.
             * It keeps running until the queue is completely empty.
             */
            async function worker() {
                while (queue.length > 0) {
                    // Safely remove the first item from the queue
                    const item = queue.shift();

                    try {
                        const geoResult = await geocodeAddress(item.cep, item.number);

                        // Push directly to the shared array (safe in JS due to Event Loop)
                        geocodedLocations.push({
                            id: item.code || `${item.cep} ${item.number}`,
                            lat: geoResult.lat,
                            lon: geoResult.lon,
                            cep: item.cep,
                            number: item.number
                        });
                    } catch (err) {
                        console.warn(`Failed to geocode ${item.cep} ${item.number}`, err);
                        showToast(`Failed to locate: ${item.cep}. Skipping...`, "error");
                    }
                }
            }

            // Spawn the workers
            for (let i = 0; i < poolSize; i++) {
                workers.push(worker());
            }

            // Await until all workers finish their tasks
            await Promise.all(workers);

            if (geocodedLocations.length < 1) {
                throw new Error("Could not geocode enough valid locations to create a route.");
            }

            // 2. Fetch Optimized Route using existing getOptimizedRoute function
            const routeData = await getOptimizedRoute(geocodedLocations, CEE_START_POINT);

            // 3. Render Route on Map
            if (routeLayer) leafletMap.removeLayer(routeLayer);
            markersLayer.clearLayers();

            // Decode OSRM geometry and draw the polyline path
            const latlngs = decodePolyline(routeData.geometry);
            routeLayer = L.polyline(latlngs, { color: '#00447c', weight: 5, opacity: 0.8 }).addTo(leafletMap);
            leafletMap.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });

            // Add Markers with optimized order
            routeData.optimizedLocations.forEach((loc, idx) => {
                const isStart = idx === 0;

                // Create a custom numbered icon
                const iconHtml = `<div style="background-color: ${isStart ? '#c6432e' : '#ffcc00'}; color: ${isStart ? '#fff' : '#002b54'}; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: 2px solid #002b54; font-weight: bold; font-family: 'Space Mono', monospace; font-size: 12px;">${idx}</div>`;

                const customIcon = L.divIcon({
                    html: iconHtml,
                    className: 'custom-route-marker',
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });

                const popupContent = isStart
                    ? `<b>Origem (CEE)</b><br>Start Point`
                    : `<b>Stop ${idx}</b><br>Obj: ${loc.id}<br>CEP: ${loc.cep}<br>Num: ${loc.number}`;

                L.marker([loc.lat, loc.lon], { icon: customIcon })
                    .bindPopup(popupContent)
                    .addTo(markersLayer);
            });

            // 4. Update Stats UI
            const mins = Math.round(routeData.durationSeconds / 60);
            const kms = (routeData.distanceMeters / 1000).toFixed(1);
            routeTime.textContent = `${mins} min`;
            routeDistance.textContent = `${kms} km`;
            routeStats.style.display = 'flex';

            showToast("Route generated successfully!");

        } catch (error) {
            console.error("Routing error:", error);
            showToast(error.message || "Failed to generate route.", "error");
        } finally {
            routeGenerateBtn.disabled = false;
            routeGenerateBtn.textContent = "Traçar Melhor Rota";
        }
    });
}