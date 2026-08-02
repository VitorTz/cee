// =============================================================================
// MODULE: LOEC ANALYSIS (paste & analyze — available to every role)
// =============================================================================
// Pure client-side text analysis: no writes happen anywhere, and the only
// network call is a read-only cross-check against zip_codes (which every
// authenticated role can already SELECT), so this tab needs no extra RLS.

import { qs, qsa } from "../utils.js";
import { showToast } from "../ui.js";

const LOEC_ANALYSIS_CODE_REGEX = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const LOEC_ANALYSIS_CEP_REGEX = /^\d{5}-?\d{3}$/;

let loecAnalysisRecords = [];
let loecAnalysisIgnoredCount = 0;
let loecAnalysisSort = { field: "ordem", dir: "asc" };
let loecAnalysisFilterType = "";
let loecAnalysisFilterSearch = "";
let loecAnalysisTypeChart = null;
let loecAnalysisStreetChart = null;

// Parses the pasted LOEC text. Only lines that carry a valid Correios object
// code (2 letters + 9 digits + 2 letters, e.g. AN924300185BR) in the format
// "código  ordem  logradouro  CEP" are kept — every other line (headers,
// blank lines, notes mixed into the paste, etc.) is silently skipped.
function parseLoecAnalysisText(text) {
    const lines = (text || "").split(/\r?\n/);
    const records = [];
    let ignored = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // The native paste format is tab-separated; fall back to runs of 2+
        // spaces in case the tabs got collapsed by the source/clipboard.
        let cols = line
            .split("\t")
            .map((c) => c.trim())
            .filter((c) => c !== "");
        if (cols.length < 4) {
            cols = line
                .split(/\s{2,}/)
                .map((c) => c.trim())
                .filter((c) => c !== "");
        }
        if (cols.length < 4) continue;

        const code = cols[0].toUpperCase();
        if (!LOEC_ANALYSIS_CODE_REGEX.test(code)) continue;

        const cepRaw = cols[cols.length - 1];
        if (!LOEC_ANALYSIS_CEP_REGEX.test(cepRaw)) {
            ignored++;
            continue;
        }

        const ordemRaw = cols[1];
        const ordemNum = parseInt(ordemRaw, 10);
        const logradouro = cols.slice(2, cols.length - 1).join(" ").trim() || "—";
        const cep = cepRaw.includes("-")
            ? cepRaw
            : `${cepRaw.slice(0, 5)}-${cepRaw.slice(5)}`;

        records.push({
            code,
            type: code.slice(0, 2),
            ordemRaw,
            ordem: Number.isFinite(ordemNum) ? ordemNum : null,
            logradouro,
            cep,
        });
    }

    return { records, ignored };
}

function loecAnalysisTypeCounts() {
    const counts = new Map();
    loecAnalysisRecords.forEach((r) => {
        counts.set(r.type, (counts.get(r.type) || 0) + 1);
    });
    return Array.from(counts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);
}

function loecAnalysisStreetCounts(limit = 10) {
    const counts = new Map();
    loecAnalysisRecords.forEach((r) => {
        counts.set(r.logradouro, (counts.get(r.logradouro) || 0) + 1);
    });
    return Array.from(counts.entries())
        .map(([logradouro, count]) => ({ logradouro, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

function renderLoecAnalysisKpis() {
    const records = loecAnalysisRecords;
    const types = new Set(records.map((r) => r.type));
    const streets = new Set(records.map((r) => r.logradouro));
    const ceps = new Set(records.map((r) => r.cep));

    qs("#loecx-total-objects").textContent = records.length;
    qs("#loecx-total-types").textContent = types.size;
    qs("#loecx-total-streets").textContent = streets.size;
    qs("#loecx-total-ceps").textContent = ceps.size;
    qs("#loecx-total-ignored").textContent = loecAnalysisIgnoredCount;
    qs("#loecx-total-unregistered").textContent = "…";
}

function renderLoecAnalysisTypeBreakdown() {
    const tbody = qs("#loecx-type-tbody");
    if (!tbody) return;
    const total = loecAnalysisRecords.length || 1;

    tbody.innerHTML = loecAnalysisTypeCounts()
        .map(
            (t) => `
    <tr>
      <td><span class="loec-type-chip">${escapeHtml(t.type)}</span></td>
      <td class="col-actions">${t.count}</td>
      <td class="col-actions">${((t.count / total) * 100).toFixed(1)}%</td>
    </tr>
  `,
        )
        .join("");
}

function populateLoecAnalysisTypeFilter() {
    const select = qs("#loecx-filter-type");
    if (!select) return;
    const currentValue = select.value;
    const typeCounts = loecAnalysisTypeCounts();

    select.innerHTML =
        `<option value="">Todos os tipos (${loecAnalysisRecords.length})</option>` +
        typeCounts
            .map((t) => `<option value="${t.type}">${t.type} (${t.count})</option>`)
            .join("");

    // Preserve the current filter selection across re-renders when possible.
    if (typeCounts.some((t) => t.type === currentValue)) {
        select.value = currentValue;
    } else {
        loecAnalysisFilterType = "";
    }
}

function renderLoecAnalysisCharts() {
    const colors = loecSectorChartColors();
    const typeCtx = qs("#loecx-chart-type");
    const streetCtx = qs("#loecx-chart-streets");

    if (loecAnalysisTypeChart) {
        loecAnalysisTypeChart.destroy();
        loecAnalysisTypeChart = null;
    }
    if (loecAnalysisStreetChart) {
        loecAnalysisStreetChart.destroy();
        loecAnalysisStreetChart = null;
    }

    const typeCounts = loecAnalysisTypeCounts();
    if (typeCtx) {
        loecAnalysisTypeChart = new Chart(typeCtx, {
            type: "bar",
            data: {
                labels: typeCounts.map((t) => t.type),
                datasets: [
                    {
                        label: "Objetos",
                        data: typeCounts.map((t) => t.count),
                        backgroundColor: colors.objects.bg,
                        borderColor: colors.objects.border,
                        borderWidth: 1.5,
                        borderRadius: 4,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                plugins: { legend: { display: false } },
            },
        });
    }

    const streetCounts = loecAnalysisStreetCounts(10);
    if (streetCtx) {
        loecAnalysisStreetChart = new Chart(streetCtx, {
            type: "bar",
            data: {
                labels: streetCounts.map((s) => s.logradouro),
                datasets: [
                    {
                        label: "Objetos",
                        data: streetCounts.map((s) => s.count),
                        backgroundColor: colors.today.bg,
                        borderColor: colors.today.border,
                        borderWidth: 1.5,
                        borderRadius: 4,
                    },
                ],
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
                plugins: { legend: { display: false } },
            },
        });
    }
}

function getFilteredSortedLoecAnalysisRecords() {
    let records = loecAnalysisRecords.slice();

    if (loecAnalysisFilterType) {
        records = records.filter((r) => r.type === loecAnalysisFilterType);
    }
    if (loecAnalysisFilterSearch) {
        const term = loecAnalysisFilterSearch.toLowerCase();
        records = records.filter(
            (r) =>
                r.code.toLowerCase().includes(term) ||
                r.logradouro.toLowerCase().includes(term),
        );
    }

    const { field, dir } = loecAnalysisSort;
    const mult = dir === "asc" ? 1 : -1;

    records.sort((a, b) => {
        if (field === "ordem") {
            const av = a.ordem === null ? Number.MAX_SAFE_INTEGER : a.ordem;
            const bv = b.ordem === null ? Number.MAX_SAFE_INTEGER : b.ordem;
            return (av - bv) * mult;
        }
        if (field === "code") return a.code.localeCompare(b.code) * mult;
        if (field === "logradouro")
            return a.logradouro.localeCompare(b.logradouro, "pt-BR") * mult;
        return 0;
    });

    return records;
}

function renderLoecAnalysisFullTable() {
    const tbody = qs("#loecx-full-tbody");
    const emptyEl = qs("#loecx-full-empty");
    const countInfoEl = qs("#loecx-count-info");
    if (!tbody) return;

    const records = getFilteredSortedLoecAnalysisRecords();

    if (emptyEl) emptyEl.classList.toggle("hidden", records.length > 0);

    tbody.innerHTML = records
        .map(
            (r) => `
    <tr>
      <td>${r.ordem !== null ? r.ordem : escapeHtml(r.ordemRaw)}</td>
      <td class="zip-code-cell">${escapeHtml(r.code)}</td>
      <td><span class="loec-type-chip">${escapeHtml(r.type)}</span></td>
      <td>${escapeHtml(r.logradouro)}</td>
      <td>${escapeHtml(r.cep)}</td>
    </tr>
  `,
        )
        .join("");

    if (countInfoEl) {
        countInfoEl.textContent = `${records.length} de ${loecAnalysisRecords.length} objeto(s) exibido(s)`;
    }
}

function updateLoecSortButtonLabels() {
    const labels = { ordem: "Ordem", code: "Código", logradouro: "Logradouro" };
    qsa(".loec-sort-btn").forEach((btn) => {
        const field = btn.dataset.sort;
        const isActive = field === loecAnalysisSort.field;
        btn.classList.toggle("active", isActive);
        const arrow = isActive ? (loecAnalysisSort.dir === "asc" ? " ↑" : " ↓") : "";
        btn.textContent = labels[field] + arrow;
    });
}

async function runLoecAnalysis() {
    const inputEl = qs("#loec-analysis-input");
    const { records, ignored } = parseLoecAnalysisText(inputEl ? inputEl.value : "");

    if (records.length === 0) {
        showToast("Nenhum objeto com código válido foi encontrado no texto colado.", "error");
        return;
    }

    loecAnalysisRecords = records;
    loecAnalysisIgnoredCount = ignored;
    loecAnalysisFilterType = "";
    loecAnalysisFilterSearch = "";

    const searchEl = qs("#loecx-filter-search");
    if (searchEl) searchEl.value = "";

    loecAnalysisSort = { field: "ordem", dir: "asc" };
    updateLoecSortButtonLabels();

    qs("#loec-analysis-empty")?.classList.add("hidden");
    qs("#loec-analysis-results")?.classList.remove("hidden");

    renderLoecAnalysisKpis();
    renderLoecAnalysisTypeBreakdown();
    populateLoecAnalysisTypeFilter();
    renderLoecAnalysisCharts();
    renderLoecAnalysisFullTable();
}

function clearLoecAnalysis() {
    const inputEl = qs("#loec-analysis-input");
    if (inputEl) inputEl.value = "";

    loecAnalysisRecords = [];
    loecAnalysisIgnoredCount = 0;

    if (loecAnalysisTypeChart) {
        loecAnalysisTypeChart.destroy();
        loecAnalysisTypeChart = null;
    }
    if (loecAnalysisStreetChart) {
        loecAnalysisStreetChart.destroy();
        loecAnalysisStreetChart = null;
    }

    qs("#loec-analysis-results")?.classList.add("hidden");
    qs("#loec-analysis-empty")?.classList.remove("hidden");
}

function exportLoecAnalysisCsv() {
    if (!loecAnalysisRecords.length) {
        showToast("Nenhum dado para exportar.", "error");
        return;
    }

    const records = getFilteredSortedLoecAnalysisRecords();
    let csv = "Ordem;Codigo;Tipo;Logradouro;CEP\n";
    records.forEach((r) => {
        const ordem = r.ordem !== null ? r.ordem : r.ordemRaw;
        const logradouro = (r.logradouro || "").replace(/;/g, ",");
        csv += `${ordem};${r.code};${r.type};${logradouro};${r.cep}\n`;
    });

    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `analise_loec_${todayIsoDate()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// --- LOEC Analysis Event Listeners ---
qs("#loec-analysis-run")?.addEventListener("click", runLoecAnalysis);
qs("#loec-analysis-clear")?.addEventListener("click", clearLoecAnalysis);
qs("#loecx-export-csv")?.addEventListener("click", exportLoecAnalysisCsv);

qs("#loecx-filter-search")?.addEventListener("input", (e) => {
    loecAnalysisFilterSearch = e.target.value.trim();
    renderLoecAnalysisFullTable();
});

qs("#loecx-filter-type")?.addEventListener("change", (e) => {
    loecAnalysisFilterType = e.target.value;
    renderLoecAnalysisFullTable();
});

qsa(".loec-sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        const field = btn.dataset.sort;
        if (loecAnalysisSort.field === field) {
            loecAnalysisSort.dir = loecAnalysisSort.dir === "asc" ? "desc" : "asc";
        } else {
            loecAnalysisSort = { field, dir: "asc" };
        }
        updateLoecSortButtonLabels();
        renderLoecAnalysisFullTable();
    });
});

updateLoecSortButtonLabels();