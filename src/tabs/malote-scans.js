// =============================================================================
// MODULE: MALOTE PASTE (colar lista de malotes do sistema)
// =============================================================================
// Same idea as loec-scans.js's "Colar LOECs": the user copies a table straight
// out of the internal system and pastes it here. We parse every well-formed
// row, build one summary + per-SE report, and store it as a single
// daily_malote_deliveries row (source_type = 'malote_paste') so today's totals
// and history stay correct without anyone typing counts by hand.

// Chart.js instance for the "malotes por SE" bar chart shown inside the
// report modal. Reuses loecReportChartInstances so the existing closeModal()
// cleanup (in ui.js) destroys it too, regardless of which report is open.

// Parses a block of text copied from the malote system into a flat list of
// items. Whitespace-agnostic (splits on any run of whitespace), so it works
// whether the source was copied as tab-separated or plain space-separated
// columns, with or without the header row.
//
// Expected row shape (7+ whitespace-separated tokens):
//   <SE> <CEP Destino> <Serviço> <Código de Barras> <Peso (g)> <Data> <Hora>
// e.g. "SE/SC  89700-176  44105  89700176441050000104198540000800372  00520  31/07/2026 16:12:09"
import { qs } from "../utils.js";
import { sb } from "../supabase-client.js";
import { showToast, openModal, closeModal } from "../ui.js";



function parseMalotePasteText(text) {
    const lines = (text || "").split("\n");
    const items = [];

    lines.forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;

        const tokens = line.split(/\s+/).filter(Boolean);
        if (tokens.length < 7) return;

        // First token must look like "SE/UF" (this also skips the header row,
        // which starts with the literal word "SE" alone).
        const se = tokens[0];
        if (!/^SE\/[A-Za-z]{2}$/i.test(se)) return;

        const cep = tokens[1];
        if (!/^\d{5}-?\d{3}$/.test(cep)) return;

        const servico = tokens[2];
        if (!/^\d+$/.test(servico)) return;

        const barcode = tokens[3];
        if (!/^[A-Za-z0-9]{8,}$/.test(barcode)) return;

        const peso_g = parseInt(tokens[4], 10);
        if (Number.isNaN(peso_g)) return;

        const date = tokens[5];
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return;
        const time = tokens[6] || "";

        items.push({
            se: se.toUpperCase(),
            cep_destino: cep.includes("-") ? cep : `${cep.slice(0, 5)}-${cep.slice(5)}`,
            servico,
            barcode,
            peso_g,
            data_hora: /^\d{2}:\d{2}(:\d{2})?$/.test(time) ? `${date} ${time}` : date,
        });
    });

    return { items };
}

// Builds the full malote report: overall totals, plus one breakdown per SE.
function buildMaloteReport(items) {
    const total = {
        count: items.length,
        peso_total_g: items.reduce((sum, i) => sum + i.peso_g, 0),
        se_count: new Set(items.map((i) => i.se)).size,
        cep_count: new Set(items.map((i) => i.cep_destino)).size,
    };

    const bySe = new Map();
    items.forEach((item) => {
        if (!bySe.has(item.se)) {
            bySe.set(item.se, { se: item.se, count: 0, peso_g: 0, items: [] });
        }
        const group = bySe.get(item.se);
        group.count += 1;
        group.peso_g += item.peso_g;
        group.items.push(item);
    });

    const se_groups = Array.from(bySe.values())
        .map((group) => ({
            ...group,
            items: group.items.sort((a, b) => a.data_hora.localeCompare(b.data_hora)),
        }))
        .sort((a, b) => b.count - a.count);

    return { total, se_groups };
}

// --- Paste form ---

function malotePasteFormTemplate() {
    return `
    <form id="malote-paste-form">
      <div class="field">
        <label for="malote-paste-area">Cole o texto do sistema aqui</label>
        <textarea id="malote-paste-area" rows="10" required placeholder="Ex:\nSE    CEP Destino    Serviço    Código de Barras    Peso (g)    Data / Hora\nSE/SC    89700-176    44105    89700176441050000104198540000800372    00520    31/07/2026 16:12:09"></textarea>
        <p class="field-hint">Pode colar com ou sem a linha de cabeçalho (SE, CEP Destino, Serviço...). A quantidade de malotes, SE, CEP Destino, Serviço e peso de cada um são identificados automaticamente e um relatório completo é gerado.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="malote-paste-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Processar e Salvar</button>
      </div>
    </form>
  `;
}

export function openMalotePasteForm() {
    openModal("Colar Lista de Malotes", malotePasteFormTemplate());
    qs("#malote-paste-cancel").addEventListener("click", closeModal);
    qs("#malote-paste-form").addEventListener("submit", submitMalotePasteForm);
}

async function submitMalotePasteForm(e) {
    e.preventDefault();
    const rawText = qs("#malote-paste-area").value;
    const { items } = parseMalotePasteText(rawText);

    if (items.length === 0) {
        showToast("Nenhum malote válido encontrado no texto colado.", "error");
        return;
    }

    const report = buildMaloteReport(items);

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const pesoKg = (report.total.peso_total_g / 1000).toFixed(2);

    const payload = {
        log_date: getDailyOpsDate(),
        delivery_time: timeStr,
        carteiro_name: null,
        malote_count: report.total.count,
        notes: `${report.total.count} malote${report.total.count === 1 ? "" : "s"} · ${pesoKg} kg · ${report.total.se_count} SE${report.total.se_count === 1 ? "" : "s"}`,
        source_type: "malote_paste",
        raw_text: rawText,
        report,
    };

    const { error } = await sb.from("daily_malote_deliveries").insert(payload);
    if (error) {
        showToast(`Erro ao registrar: ${error.message}`, "error");
        return;
    }

    closeModal();
    showToast(`${report.total.count} malotes registrados com sucesso!`);
    await loadDailyOps();
}

// --- Malote Report Details Modal ---

function maloteReportStatCard(title, value) {
    return `
    <div class="loec-report-stat">
      <div class="loec-report-stat-title">${title}</div>
      <div class="loec-report-stat-value">${value}</div>
    </div>
  `;
}

function maloteItemRowsTemplate(items) {
    return items
        .map(
            (i) => `
    <tr>
      <td class="zip-code-cell">${escapeHtml(i.cep_destino)}</td>
      <td>${escapeHtml(i.servico)}</td>
      <td><span class="points-badge">${i.peso_g} g</span></td>
      <td class="loec-code-cell">${escapeHtml(i.barcode)}</td>
      <td>${escapeHtml(i.data_hora)}</td>
    </tr>
  `,
        )
        .join("");
}

function maloteSeSectionTemplate(group) {
    const pesoKg = (group.peso_g / 1000).toFixed(2);
    return `
    <div class="loec-report-sector">
      <div class="loec-report-sector-header">
        <h4>${escapeHtml(group.se)}</h4>
        <span class="count-badge">${group.count} malote${group.count === 1 ? "" : "s"}</span>
      </div>
      <div class="loec-report-summary loec-report-summary-compact">
        ${maloteReportStatCard("Malotes", group.count)}
        ${maloteReportStatCard("Peso total", `${pesoKg} kg`)}
      </div>
      <div class="manifest-frame">
        <table class="manifest-table">
          <thead>
            <tr>
              <th>CEP Destino</th>
              <th>Serviço</th>
              <th>Peso</th>
              <th>Código de Barras</th>
              <th>Data / Hora</th>
            </tr>
          </thead>
          <tbody>${maloteItemRowsTemplate(group.items)}</tbody>
        </table>
      </div>
    </div>
  `;
}

function maloteReportTemplate(record, report) {
    const pesoKg = (report.total.peso_total_g / 1000).toFixed(2);
    return `
    <div class="loec-report">
      <div class="loec-legend">
        <span class="loec-legend-item"><span class="count-badge legend-swatch">00</span> Quantidade</span>
        <span class="loec-legend-item"><span class="points-badge legend-swatch">00</span> Peso (g)</span>
      </div>
      <div class="loec-report-summary">
        ${maloteReportStatCard("Total de malotes", report.total.count)}
        ${maloteReportStatCard("Peso total", `${pesoKg} kg`)}
        ${maloteReportStatCard("SEs distintos", report.total.se_count)}
        ${maloteReportStatCard("CEPs distintos", report.total.cep_count)}
      </div>
      <div class="loec-report-chart-box">
        <canvas id="malote-report-chart-total" height="180"></canvas>
      </div>

      ${report.se_groups.map(maloteSeSectionTemplate).join("")}

      ${record.raw_text
            ? `
      <details class="loec-report-raw">
        <summary>Ver texto original colado</summary>
        <pre>${escapeHtml(record.raw_text)}</pre>
      </details>`
            : ""
        }
    </div>
  `;
}

function maloteSimpleReportTemplate(record) {
    return `
    <div class="loec-report">
      <p class="field-hint">Registrado às ${formatTimeShort(record.delivery_time)}</p>
      <div class="loec-report-summary">
        ${maloteReportStatCard("Malotes", record.malote_count)}
        ${maloteReportStatCard("Carteiro", escapeHtml(record.carteiro_name || "—"))}
      </div>
      ${record.notes ? `<p>${escapeHtml(record.notes)}</p>` : ""}
      <p class="field-hint">Este registro não possui detalhamento por SE (lançamento manual, ou registrado antes desta atualização).</p>
    </div>
  `;
}

function renderMaloteReportChart(report) {
    const ctx = qs("#malote-report-chart-total");
    if (!ctx) return;

    const labels = report.se_groups.map((g) => g.se);
    const data = report.se_groups.map((g) => g.count);

    loecReportChartInstances.push(
        new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    {
                        label: "Malotes por SE",
                        data,
                        backgroundColor: "rgba(0, 68, 124, 0.65)",
                        borderColor: "#00447c",
                        borderWidth: 1.5,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                plugins: { legend: { display: false } },
            },
        }),
    );
}

function openMaloteReportModal(record) {
    const hasFullReport = record.source_type === "malote_paste" && record.report;
    const title = `Malotes &middot; ${formatTimeShort(record.delivery_time)}`;

    openModal(
        title,
        hasFullReport
            ? maloteReportTemplate(record, record.report)
            : maloteSimpleReportTemplate(record),
        hasFullReport ? { wide: true } : {},
    );

    if (hasFullReport) renderMaloteReportChart(record.report);
}

// =============================================================================
// DAILY MALOTE ANALYSIS ("+ Analisar Malotes")
// =============================================================================
// Aggregates every daily_malote_deliveries record loaded for the currently
// selected date (dailyMalotesCache: both "+ Colar Malotes" and
// "+ Registrar Malote" entries) into a single day-level view: totals, a
// breakdown by SE, the busiest destination CEPs, a breakdown by Serviço, and
// a timeline of how malotes arrived over the day.

function buildDailyMaloteAnalysis(records) {
    const pasteRecords = records.filter(
        (r) => r.source_type === "malote_paste" && r.report,
    );
    const manualRecords = records.filter(
        (r) => !(r.source_type === "malote_paste" && r.report),
    );

    // Flatten every individual malote item out of every pasted record for the day.
    const allItems = [];
    pasteRecords.forEach((r) => {
        (r.report.se_groups || []).forEach((g) => {
            (g.items || []).forEach((item) => allItems.push(item));
        });
    });

    const pasteCount = allItems.length;
    const manualCount = manualRecords.reduce(
        (sum, r) => sum + (r.malote_count || 0),
        0,
    );
    const pesoTotalG = allItems.reduce((sum, i) => sum + i.peso_g, 0);

    // Breakdown by SE
    const bySe = new Map();
    allItems.forEach((item) => {
        if (!bySe.has(item.se)) {
            bySe.set(item.se, { se: item.se, count: 0, peso_g: 0 });
        }
        const g = bySe.get(item.se);
        g.count += 1;
        g.peso_g += item.peso_g;
    });
    const se_groups = Array.from(bySe.values()).sort((a, b) => b.count - a.count);

    // Breakdown by destination CEP (top 10 busiest)
    const byCep = new Map();
    allItems.forEach((item) => {
        if (!byCep.has(item.cep_destino)) {
            byCep.set(item.cep_destino, { cep: item.cep_destino, count: 0, peso_g: 0 });
        }
        const c = byCep.get(item.cep_destino);
        c.count += 1;
        c.peso_g += item.peso_g;
    });
    const top_ceps = Array.from(byCep.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    // Breakdown by Serviço code
    const byServico = new Map();
    allItems.forEach((item) => {
        if (!byServico.has(item.servico)) {
            byServico.set(item.servico, { servico: item.servico, count: 0, peso_g: 0 });
        }
        const s = byServico.get(item.servico);
        s.count += 1;
        s.peso_g += item.peso_g;
    });
    const servico_groups = Array.from(byServico.values()).sort(
        (a, b) => b.count - a.count,
    );

    // Timeline: every record of the day (both manual and paste), chronological.
    const timeline = records
        .map((r) => ({
            time: r.delivery_time,
            count: r.malote_count,
            label:
                r.source_type === "malote_paste"
                    ? "Colagem automática"
                    : r.carteiro_name || "Manual",
        }))
        .sort((a, b) => a.time.localeCompare(b.time));

    return {
        total: {
            overall_count: pasteCount + manualCount,
            paste_count: pasteCount,
            manual_count: manualCount,
            peso_total_g: pesoTotalG,
            se_count: se_groups.length,
            cep_count: byCep.size,
            servico_count: servico_groups.length,
            paste_events: pasteRecords.length,
            manual_events: manualRecords.length,
        },
        se_groups,
        top_ceps,
        servico_groups,
        timeline,
    };
}

function maloteAnalysisSeTableTemplate(se_groups) {
    if (se_groups.length === 0) {
        return `<p class="empty-state">Nenhum malote detalhado (colado) registrado hoje.</p>`;
    }
    return `
    <div class="manifest-frame">
      <table class="manifest-table">
        <thead>
          <tr><th>SE</th><th>Malotes</th><th>Peso</th><th>% do total</th></tr>
        </thead>
        <tbody>
          ${se_groups
            .map((g) => {
                const totalCount = se_groups.reduce((s, x) => s + x.count, 0);
                const pct = totalCount ? ((g.count / totalCount) * 100).toFixed(1) : "0.0";
                return `
              <tr>
                <td>${escapeHtml(g.se)}</td>
                <td><span class="count-badge">${g.count}</span></td>
                <td><span class="points-badge">${(g.peso_g / 1000).toFixed(2)} kg</span></td>
                <td>${pct}%</td>
              </tr>
            `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function maloteAnalysisCepTableTemplate(top_ceps) {
    if (top_ceps.length === 0) {
        return `<p class="empty-state">Nenhum malote detalhado (colado) registrado hoje.</p>`;
    }
    return `
    <div class="manifest-frame">
      <table class="manifest-table">
        <thead>
          <tr><th>CEP Destino</th><th>Malotes</th><th>Peso</th></tr>
        </thead>
        <tbody>
          ${top_ceps
            .map(
                (c) => `
              <tr>
                <td class="zip-code-cell">${escapeHtml(c.cep)}</td>
                <td><span class="count-badge">${c.count}</span></td>
                <td><span class="points-badge">${(c.peso_g / 1000).toFixed(2)} kg</span></td>
              </tr>
            `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function maloteAnalysisServicoTableTemplate(servico_groups) {
    if (servico_groups.length === 0) {
        return `<p class="empty-state">Nenhum malote detalhado (colado) registrado hoje.</p>`;
    }
    return `
    <div class="manifest-frame">
      <table class="manifest-table">
        <thead>
          <tr><th>Serviço</th><th>Malotes</th><th>Peso</th></tr>
        </thead>
        <tbody>
          ${servico_groups
            .map(
                (s) => `
              <tr>
                <td>${escapeHtml(s.servico)}</td>
                <td><span class="count-badge">${s.count}</span></td>
                <td><span class="points-badge">${(s.peso_g / 1000).toFixed(2)} kg</span></td>
              </tr>
            `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function maloteAnalysisTemplate(date, analysis) {
    const t = analysis.total;
    const pesoKg = (t.peso_total_g / 1000).toFixed(2);
    const dateObj = new Date(`${date}T12:00:00`);
    const dateStr = dateObj.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });

    return `
    <div class="loec-report">
      <div class="loec-report-summary">
        ${maloteReportStatCard("Total de malotes", t.overall_count)}
        ${maloteReportStatCard("Peso total (colados)", `${pesoKg} kg`)}
        ${maloteReportStatCard("SEs distintos", t.se_count)}
        ${maloteReportStatCard("CEPs distintos", t.cep_count)}
        ${maloteReportStatCard("Serviços distintos", t.servico_count)}
      </div>

      <div class="loec-report-chart-box">
        <canvas id="malote-analysis-chart-timeline" height="180"></canvas>
      </div>

      <div class="loec-report-sector">
        <div class="loec-report-sector-header"><h4>Malotes por SE</h4></div>
        <div class="loec-report-chart-box" style="margin-bottom: 16px;">
          <canvas id="malote-analysis-chart-se" height="160"></canvas>
        </div>
        ${maloteAnalysisSeTableTemplate(analysis.se_groups)}
      </div>

      <div class="loec-report-sector">
        <div class="loec-report-sector-header"><h4>CEPs de destino mais frequentes</h4></div>
        ${maloteAnalysisCepTableTemplate(analysis.top_ceps)}
      </div>

      <div class="loec-report-sector">
        <div class="loec-report-sector-header"><h4>Por tipo de Serviço</h4></div>
        ${maloteAnalysisServicoTableTemplate(analysis.servico_groups)}
      </div>
    </div>
  `;
}

function renderMaloteAnalysisCharts(analysis) {
    const colors = { border: "#00447c", bg: "rgba(0, 68, 124, 0.65)" };

    // Timeline chart: malotes per registered event over the day, chronological.
    const timelineCtx = qs("#malote-analysis-chart-timeline");
    if (timelineCtx) {
        loecReportChartInstances.push(
            new Chart(timelineCtx, {
                type: "line",
                data: {
                    labels: analysis.timeline.map(
                        (e) => `${formatTimeShort(e.time)} · ${e.label}`,
                    ),
                    datasets: [
                        {
                            label: "Malotes por registro",
                            data: analysis.timeline.map((e) => e.count),
                            borderColor: colors.border,
                            backgroundColor: "rgba(0, 68, 124, 0.1)",
                            pointBackgroundColor: colors.border,
                            pointRadius: 4,
                            fill: true,
                            tension: 0.3,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                    plugins: { legend: { display: false } },
                },
            }),
        );
    }

    // SE breakdown chart.
    const seCtx = qs("#malote-analysis-chart-se");
    if (seCtx && analysis.se_groups.length > 0) {
        loecReportChartInstances.push(
            new Chart(seCtx, {
                type: "bar",
                data: {
                    labels: analysis.se_groups.map((g) => g.se),
                    datasets: [
                        {
                            label: "Malotes por SE",
                            data: analysis.se_groups.map((g) => g.count),
                            backgroundColor: colors.bg,
                            borderColor: colors.border,
                            borderWidth: 1.5,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                    plugins: { legend: { display: false } },
                },
            }),
        );
    }
}

export function openMaloteAnalysisModal() {
    const date = getDailyOpsDate();

    if (!dailyMalotesCache || dailyMalotesCache.length === 0) {
        showToast("Nenhum malote registrado nesta data ainda.", "error");
        return;
    }

    const analysis = buildDailyMaloteAnalysis(dailyMalotesCache);
    const dateStr = date.split("-").reverse().join("/");
    openModal(
        `Análise de Malotes &middot; ${dateStr}`,
        maloteAnalysisTemplate(date, analysis),
        { wide: true },
    );
    renderMaloteAnalysisCharts(analysis);
}