// =============================================================================
// SUPABASE METRICS DASHBOARD
// Fetches data from SupabaseMetricsWrapper and renders Charts/Tables
// =============================================================================

import { sb } from "../supabase-client.js";
import { qs } from "../utils.js";


let metricsMethodChart = null;
let metricsStatusChart = null;
let currentMetricsView = 'local'; // 'local' or 'global'

/**
 * Loads the metrics data based on the selected view and updates the UI.
 * Prevents execution if the user is not an admin.
 */
async function loadMetricsDashboard() {
    if (currentUserRole !== "admin") return;

    const btnRefresh = qs("#btn-refresh-metrics");
    const logTableWrapper = qs("#metrics-log-tbody").closest(".stats-table-wrapper");

    if (btnRefresh) {
        btnRefresh.textContent = "Loading...";
        btnRefresh.disabled = true;
    }

    let stats;

    if (currentMetricsView === 'local') {
        stats = await supabaseWrapper.getStatsSnapshot();

        // Calculate top endpoints dynamically for the local session
        const endpointCounts = {};
        stats.requestsLog.forEach(log => {
            let ep = log.url;
            try {
                const urlObj = new URL(log.url);
                ep = urlObj.pathname;
            } catch (e) { }
            endpointCounts[ep] = (endpointCounts[ep] || 0) + 1;
        });

        stats.topEndpoints = Object.entries(endpointCounts)
            .map(([endpoint, count]) => ({ endpoint, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        if (logTableWrapper) logTableWrapper.classList.remove("hidden");
        renderMetricsLog(stats.requestsLog);

    } else {
        const { data, error } = await sb.rpc('get_global_metrics_24h');

        if (error || !data) {
            console.error("Failed to fetch global metrics", error);
            if (btnRefresh) {
                btnRefresh.textContent = "Refresh Data";
                btnRefresh.disabled = false;
            }
            return;
        }

        stats = data;

        if (logTableWrapper) logTableWrapper.classList.add("hidden");
    }

    // Refresh UI components
    updateMetricsKPIs(stats);
    updateMetricsCharts(stats);
    renderTopEndpoints(stats.topEndpoints);

    if (btnRefresh) {
        btnRefresh.textContent = "Refresh Data";
        btnRefresh.disabled = false;
    }
}

/**
 * Updates the top KPI cards for the metrics dashboard.
 */
function updateMetricsKPIs(stats) {
    const totalReqEl = qs("#metric-total-req");
    const avgTimeEl = qs("#metric-avg-time");
    const successRateEl = qs("#metric-success-rate");
    const rpmEl = qs("#metric-rpm");

    if (totalReqEl) totalReqEl.textContent = stats.totalRequests;

    if (avgTimeEl) {
        avgTimeEl.innerHTML = `${stats.averageResponseTimeMs}<span style="font-size: 1rem">ms</span>`;
    }

    if (successRateEl) {
        const successRate = stats.totalRequests > 0
            ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1)
            : 0;
        successRateEl.innerHTML = `${successRate}<span style="font-size: 1rem">%</span>`;
    }

    if (rpmEl) rpmEl.textContent = stats.requestsPerMinute;
}

/**
 * Re-renders the Chart.js instances based on current method and status stats.
 */
function updateMetricsCharts(stats) {
    // Array of standard system palette colors
    const chartColors = ["#00447c", "#f0b90b", "#2e7d4f", "#c6432e", "#5b6b85", "#ffcc00"];

    // 1. Method Doughnut Chart
    const methodLabels = Object.keys(stats.methods);
    const methodData = Object.values(stats.methods);

    const ctxMethod = qs("#metrics-method-chart");
    if (ctxMethod) {
        if (metricsMethodChart) {
            metricsMethodChart.data.labels = methodLabels;
            metricsMethodChart.data.datasets[0].data = methodData;
            metricsMethodChart.update();
        } else {
            metricsMethodChart = new Chart(ctxMethod.getContext("2d"), {
                type: "doughnut",
                data: {
                    labels: methodLabels,
                    datasets: [{
                        data: methodData,
                        backgroundColor: chartColors
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'right' } }
                }
            });
        }
    }

    // 2. Status Codes Bar Chart
    const statusLabels = Object.keys(stats.statusCodes);
    const statusData = Object.values(stats.statusCodes);

    const ctxStatus = qs("#metrics-status-chart");
    if (ctxStatus) {
        if (metricsStatusChart) {
            metricsStatusChart.data.labels = statusLabels;
            metricsStatusChart.data.datasets[0].data = statusData;
            metricsStatusChart.update();
        } else {
            metricsStatusChart = new Chart(ctxStatus.getContext("2d"), {
                type: "bar",
                data: {
                    labels: statusLabels,
                    datasets: [{
                        label: "Responses",
                        data: statusData,
                        backgroundColor: "#00447c",
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
                    plugins: { legend: { display: false } }
                }
            });
        }
    }
}

/**
 * Renders the recent requests array into the table body.
 */
function renderMetricsLog(logs) {
    const tbody = qs("#metrics-log-tbody");
    if (!tbody) return;

    if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No requests recorded yet.</td></tr>';
        return;
    }

    // Reverse the array to show the most recent requests at the top
    const reversedLogs = [...logs].reverse();

    tbody.innerHTML = reversedLogs.map(log => {
        const timeString = new Date(log.timestamp).toLocaleTimeString('pt-BR', { hour12: false });

        // Extract just the pathname and search params for a cleaner display
        let endpoint = log.url;
        try {
            const urlObj = new URL(log.url);
            endpoint = urlObj.pathname + urlObj.search;
        } catch (e) { }

        // Determine appropriate styling for the HTTP status badge
        let statusBadgeClass = "union-tag"; // default fallback
        if (log.status >= 200 && log.status < 300) {
            statusBadgeClass = "match-tag"; // Green match tag for success
        } else if (log.status >= 400 || log.status === "NETWORK_ERROR") {
            statusBadgeClass = "readonly-tag"; // Red border tag for errors
        }

        return `
            <tr>
                <td>${timeString}</td>
                <td><strong>${log.method}</strong></td>
                <td><span class="${statusBadgeClass}">${log.status}</span></td>
                <td>${log.durationMs}ms</td>
                <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(log.url)}">
                    ${escapeHtml(endpoint)}
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Renders the top endpoints array into the corresponding table body.
 */
function renderTopEndpoints(endpoints) {
    const tbody = qs("#metrics-top-endpoints-tbody");
    if (!tbody) return;

    if (!endpoints || endpoints.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="empty-state">No endpoints recorded yet.</td></tr>';
        return;
    }

    tbody.innerHTML = endpoints.map(ep => `
        <tr>
            <td style="max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(ep.endpoint)}">
                ${escapeHtml(ep.endpoint)}
            </td>
            <td class="col-actions"><span class="count-badge">${ep.count}</span></td>
        </tr>
    `).join('');
}

// =============================================================================
// EVENT LISTENERS FOR METRICS UI
// =============================================================================

const btnViewLocal = qs("#btn-view-local");
const btnViewGlobal = qs("#btn-view-global");
const btnRefreshMetrics = qs("#btn-refresh-metrics");

if (btnViewLocal && btnViewGlobal) {
    btnViewLocal.addEventListener("click", () => {
        if (currentMetricsView === 'local') return;

        currentMetricsView = 'local';

        // Swap visual states
        btnViewLocal.classList.replace("btn-secondary", "btn-primary");
        btnViewGlobal.classList.replace("btn-primary", "btn-secondary");

        loadMetricsDashboard();
    });

    btnViewGlobal.addEventListener("click", () => {
        if (currentMetricsView === 'global') return;

        currentMetricsView = 'global';

        // Swap visual states
        btnViewGlobal.classList.replace("btn-secondary", "btn-primary");
        btnViewLocal.classList.replace("btn-primary", "btn-secondary");

        loadMetricsDashboard();
    });
}

// Bind event listener to the refresh button
if (btnRefreshMetrics) {
    btnRefreshMetrics.addEventListener("click", loadMetricsDashboard);
}