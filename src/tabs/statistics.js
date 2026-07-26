// =============================================================================
// MODULE: STATISTICS DASHBOARD
// =============================================================================

let statsSearchChartInstance = null;
let statsOpsChartInstance = null;
let isStatsLoaded = false;

async function loadStatistics() {
    // Prevent duplicate database queries if already loaded
    if (isStatsLoaded) return;

    const { data, error } = await sb.rpc("get_dashboard_statistics");

    if (error || !data) {
        console.error("Failed to load dashboard statistics:", error);
        return;
    }

    const {
        globalData,
        qualityData,
        missingZipsData,
        missingRulesData,
        neighborhoodData,
        topStreetsData,
        topConsultedData
    } = data;

    if (globalData) {
        qs("#stat-total-streets").textContent = globalData.total_streets;
        qs("#stat-total-zips").textContent = globalData.total_zips;
        qs("#stat-total-rules").textContent = globalData.total_rules;
    }

    if (qualityData) {
        qs("#stat-streets-missing-zips").textContent = qualityData.streets_missing_zips;
        qs("#stat-zips-missing-rules").textContent = qualityData.zips_missing_rules;
    }

    if (missingZipsData) {
        qs("#stat-streets-missing-zips-tbody").innerHTML = missingZipsData.length
            ? missingZipsData
                .map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="col-actions">${escapeHtml(formatNeighborhoods(s.neighborhood))}</td></tr>`)
                .join("")
            : '<tr><td colspan="2" class="empty-state">Todos os logradouros têm CEP cadastrado.</td></tr>';
    }

    if (missingRulesData) {
        qs("#stat-zips-missing-rules-tbody").innerHTML = missingRulesData.length
            ? missingRulesData
                .map((z) => `<tr><td class="zip-code-cell">${escapeHtml(z.zip_code)}</td><td class="col-actions">${escapeHtml(z.street_name)}</td></tr>`)
                .join("")
            : '<tr><td colspan="2" class="empty-state">Todos os CEPs têm regras cadastradas.</td></tr>';
    }

    if (neighborhoodData) {
        qs("#stat-neighborhoods-tbody").innerHTML = neighborhoodData
            .map((n) => `<tr><td>${escapeHtml(n.neighborhood_name)}</td><td class="col-actions"><span class="count-badge">${n.street_count}</span></td></tr>`)
            .join("");
    }

    if (topStreetsData) {
        qs("#stat-top-streets-tbody").innerHTML = topStreetsData
            .map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="col-actions"><span class="count-badge">${s.zip_count}</span></td></tr>`)
            .join("");
    }

    if (topConsultedData) {
        qs("#stat-top-consulted-tbody").innerHTML = topConsultedData
            .map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="col-actions"><span class="count-badge">${s.consultation_count}</span></td></tr>`)
            .join("");
    }

    isStatsLoaded = true;
}