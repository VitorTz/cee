
let dailyLoecChartInstance = null;
// Chart.js instances created inside the LOEC report modal (total + per-sector charts).
// closeModal() destroys these whenever the modal is dismissed, regardless of which
// modal is currently open, so it's safe to just keep pushing into this array.
let loecReportChartInstances = [];

async function loadDailyScans(date) {
    const tbody = qs("#daily-scans-tbody");
    const emptyEl = qs("#daily-scans-empty");

    if (!tbody) return;

    tbody.innerHTML = '<tr class="loading-row"><td colspan="4">Loading&hellip;</td></tr>';

    // Fetch the absolute last record that occurred strictly before the selected date
    const { data: prevRecord, error: prevError } = await sb
        .from("daily_object_scans")
        .select("*")
        .lt("log_date", date)
        .order("log_date", { ascending: false })
        .order("scan_time", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (prevError) {
        console.error("Failed to load previous day scan:", prevError);
    }

    // Fetch the records for the currently selected date
    const { data: currentRecords, error: currError } = await sb
        .from("daily_object_scans")
        .select("*")
        .eq("log_date", date)
        .order("scan_time", { ascending: false }); // Newest first for the table

    if (currError) {
        tbody.innerHTML = `<tr class="error-row"><td colspan="4">Error loading data: ${escapeHtml(currError.message)}</td></tr>`;
        return;
    }

    dailyScansCache = currentRecords || [];

    let html = "";
    let hasRecords = false;

    // 1. Render today's records normally (Newest records at the top)
    if (dailyScansCache.length > 0) {
        hasRecords = true;
        html += dailyScansCache.map((s, index) => {
            let diffHtml = "";
            let prevCount = null;

            // Como a lista está em ordem cronológica reversa (mais recente no topo),
            // o valor anterior cronologicamente é o próximo item do array (index + 1).
            // Se for o último item do array de hoje, comparamos com o prevRecord.
            if (index < dailyScansCache.length - 1) {
                prevCount = dailyScansCache[index + 1].object_count;
            } else if (prevRecord) {
                prevCount = prevRecord.object_count;
            }

            if (prevCount !== null) {
                const diff = s.object_count - prevCount;
                if (diff > 0) {
                    diffHtml = `<span style="color: var(--success-green); font-weight: bold; font-size: 0.85rem; margin-left: 8px;">&uarr; +${diff}</span>`;
                } else if (diff < 0) {
                    diffHtml = `<span style="color: var(--stamp-red); font-weight: bold; font-size: 0.85rem; margin-left: 8px;">&darr; ${diff}</span>`;
                }
            }

            return `
            <tr>
                <td>${formatTimeShort(s.scan_time)}</td>
                <td><span class="count-badge">${s.object_count}</span>${diffHtml}</td>
                <td>
                    ${escapeHtml(s.notes || "")}
                </td>
                <td class="col-actions">
                    <span class="row-actions">
                        <button class="btn btn-secondary btn-icon" data-view-scan="${s.id}">Detalhes</button>
                        ${s.source_type === "loec_paste" ? `<button class="btn btn-secondary btn-icon" data-export-scan="${s.id}">Excel</button>` : ""}
                        <button class="btn btn-danger btn-icon" data-delete-scan="${s.id}">Excluir</button>
                    </span>
                </td>
            </tr>
        `}).join("");
    }

    // 2. Render the historic record from the previous day at the BOTTOM (Oldest record)
    if (prevRecord) {
        hasRecords = true;

        // Format the date to DD/MM/YYYY for the visual badge
        // Ensure timezone offsets don't shift the date backwards by appending time
        const prevDateObj = new Date(prevRecord.log_date + "T12:00:00");
        const dateStr = prevDateObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

        html += `
            <tr style="background-color: #eef4fa; border-left: 4px solid var(--correios-blue);">
                <td>
                    <span class="meeting-tag" style="display: block; margin-bottom: 4px; font-size: 0.65rem;">
                        Último de ${dateStr}
                    </span>
                    ${formatTimeShort(prevRecord.scan_time)}
                </td>
                <td>
                    <span class="count-badge" style="background-color: var(--correios-blue); color: #ffffff;">
                        ${prevRecord.object_count}
                    </span>
                </td>
                <td>
                    <span style="font-size: 0.85rem; color: var(--ink-soft);">
                        ${escapeHtml(prevRecord.notes || "")}
                    </span>
                </td>
                <td class="col-actions">
                    <span class="readonly-tag" style="border-color: var(--correios-blue); color: var(--correios-blue);">Histórico</span>
                </td>
            </tr>
        `;
    }

    emptyEl.classList.toggle("hidden", hasRecords);
    tbody.innerHTML = html;

    // 3. Render Chart (chronological order, oldest to newest)
    const chronological = [...dailyScansCache].sort((a, b) =>
        a.scan_time.localeCompare(b.scan_time),
    );

    if (typeof renderLoecChart === 'function') {
        // Pass the previous record as well so the chart can start from the previous day's balance
        renderLoecChart(prevRecord, chronological);
    }
}

// =============================================================================
// EXPORT LOEC TO EXCEL (CSV)
// =============================================================================
function exportLoecToExcel(record) {
    if (!record || !record.report) {
        showToast("No report data available to export.", "error");
        return;
    }

    const report = record.report;

    // Start CSV content string
    let csvContent = "";

    // 1. GENERAL SUMMARY BLOCK
    csvContent += "=== RESUMO GERAL ===\n";
    csvContent += "Metrica;Valor\n";
    csvContent += `Total de objetos;${report.total.objects}\n`;
    csvContent += `Total de pontos;${report.total.points}\n`;
    csvContent += `Distritos;${report.total.district_count}\n`;
    csvContent += `Carteiros;${report.total.carteiro_count}\n`;
    csvContent += `Vencidos;${report.total.overdue}\n`;
    csvContent += `Vencendo hoje;${report.total.today}\n`;
    csvContent += `A vencer;${report.total.upcoming}\n`;
    csvContent += `T.AR;${report.total.t_ar}\n\n`;

    // 2. SECTOR SUMMARY BLOCK
    csvContent += "=== RESUMO POR SETOR ===\n";
    csvContent += "Setor;Faixa;Distritos;T.Obj;T.Pontos;Media Obj/Dist;Media Pts/Dist;Mais Atrasados;Mais Vencendo Hoje\n";

    if (report.sectors && report.sectors.length > 0) {
        report.sectors.forEach(sec => {
            // Format the highlights (e.g., "305 (15)")
            const mostOverdue = sec.district_most_overdue ? `${sec.district_most_overdue.district} (${sec.district_most_overdue.value})` : "-";
            const mostToday = sec.district_most_today ? `${sec.district_most_today.district} (${sec.district_most_today.value})` : "-";

            csvContent += `${sec.label};${sec.range};${sec.district_count};${sec.totals.objects};${sec.totals.points};${sec.avg_objects_per_district};${sec.avg_points_per_district};${mostOverdue};${mostToday}\n`;
        });
    }
    csvContent += "\n";

    // 3. DISTRICT DETAILS BLOCK
    csvContent += "=== DETALHAMENTO POR DISTRITO ===\n";
    csvContent += "Distrito;T.Obj;T.Pontos;Vencidos;Hoje;A Vencer;T.AR;Carteiro;LOEC;Setor\n";

    const allDistricts = [];

    // Group matched districts
    if (report.sectors) {
        report.sectors.forEach((sec) => {
            if (sec.districts) {
                sec.districts.forEach((d) => {
                    allDistricts.push({ ...d, sector_label: sec.label });
                });
            }
        });
    }

    // Group unmatched districts
    if (report.unmatched_districts) {
        report.unmatched_districts.forEach((d) => {
            allDistricts.push({ ...d, sector_label: "Sem Setor" });
        });
    }

    // Write each district row
    allDistricts.forEach((d) => {
        csvContent += `${d.district};${d.objects};${d.points};${d.overdue};${d.today};${d.upcoming};${d.t_ar};${d.carteiro};${d.loec};${d.sector_label}\n`;
    });

    // Create Blob with UTF-8 BOM to preserve accents in Excel
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `LOEC_${record.log_date}_${record.scan_time.replace(":", "")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Ensure the table click handler processes the export button click
qs("#daily-scans-tbody").addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("[data-delete-scan]");
    const viewBtn = e.target.closest("[data-view-scan]");
    const exportBtn = e.target.closest("[data-export-scan]"); // Added export selector

    if (deleteBtn) deleteDailyScan(deleteBtn.dataset.deleteScan);

    if (viewBtn) {
        const record = dailyScansCache.find((s) => String(s.id) === viewBtn.dataset.viewScan);
        if (record) openLoecReportModal(record);
    }

    if (exportBtn) {
        const record = dailyScansCache.find((s) => String(s.id) === exportBtn.dataset.exportScan);
        if (record) exportLoecToExcel(record); // Trigger Excel export
    }
});


function renderLoecChart(prevRecord, currentRecords) {
    const ctx = qs("#loec-chart");
    if (!ctx) return;

    const labels = [];
    const dataPoints = [];
    const pointColors = [];

    // Inject the previous day's record as point zero
    if (prevRecord) {
        const prevDateObj = new Date(prevRecord.log_date + "T12:00:00");
        const dateStr = prevDateObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

        labels.push(`${dateStr} ${formatTimeShort(prevRecord.scan_time)}`);
        dataPoints.push(prevRecord.object_count);
        pointColors.push("#c6432e"); // Red color for the historic point
    }

    // Inject today's records
    currentRecords.forEach(record => {
        labels.push(formatTimeShort(record.scan_time));
        dataPoints.push(record.object_count);
        pointColors.push("#00447c"); // Standard Correios blue for today's points
    });

    if (dailyLoecChartInstance) {
        dailyLoecChartInstance.destroy();
    }

    dailyLoecChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Objetos Suspensos',
                data: dataPoints,
                borderColor: '#00447c',
                backgroundColor: 'rgba(0, 68, 124, 0.1)',
                pointBackgroundColor: pointColors,
                pointRadius: 5,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { precision: 0 }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function scanFormTemplate() {
    return `
    <form id="scan-form">
      <div class="field-row">
        <div class="field">
          <label for="scan-time">Time</label>
          <input type="time" id="scan-time" required>
        </div>
        <div class="field">
          <label for="scan-object-count">Objetos</label>
          <input type="number" id="scan-object-count" min="0" required>
        </div>
      </div>
      <div class="field">
        <label for="scan-notes">Anotações (opcional)</label>
        <input type="text" id="scan-notes" placeholder="">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="scan-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  `;
}


async function submitScanForm(e) {
    e.preventDefault();

    const payload = {
        log_date: getDailyOpsDate(),
        scan_time: qs("#scan-time").value,
        object_count: Number(qs("#scan-object-count").value),
        notes: qs("#scan-notes").value.trim() || null,
    };

    const { error } = await sb.from("daily_object_scans").insert(payload);
    if (error) {
        showToast(`Error saving record: ${error.message}`, "error");
        return;
    }

    closeModal();
    showToast("LOEC record saved successfully!");
    await loadDailyOps();
}

async function deleteDailyScan(id) {
    openDeleteConfirm("este registro de leitura", null, async () => {
        const { error } = await sb.from("daily_object_scans").delete().eq("id", id);
        if (error) {
            showToast(`Erro ao excluir: ${error.message}`, "error");
            return;
        }
        closeModal();
        showToast("Registro excluído.");
        await loadDailyOps();
    });
}

function loecPasteFormTemplate() {
    return `
    <form id="loec-paste-form">
      <div class="field">
        <label for="loec-paste-area">Cole o texto do sistema aqui</label>
        <textarea id="loec-paste-area" rows="10" required placeholder="Ex:\n302 A  2  2  0  0  2  0...\n303 A  6  5  0  2..."></textarea>
        <p class="field-hint">Pode colar com ou sem a linha de cabeçalho (Distrito, T.Obj, T.Pontos...). Um relatório completo por distrito e por setor será gerado automaticamente.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="loec-paste-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Processar e Salvar</button>
      </div>
    </form>
  `;
}

function openLoecPasteForm() {
    openModal('Colar Registros de LOEC', loecPasteFormTemplate());
    qs('#loec-paste-cancel').addEventListener('click', closeModal);
    qs('#loec-paste-form').addEventListener('submit', submitLoecPasteForm);
}

// Parses a block of text copied from the LOEC system into a list of per-district
// records. Accepts text both with and without the header row (Distrito / T.Obj /
// T.Pontos / ...), since it's whitespace-agnostic: it splits on any run of
// whitespace (tabs or spaces), so it works whether the source was copied with
// tab-separated columns or plain spaces.
//
// Row shape (9+ whitespace-separated tokens):
//   <district> <side letter> <T.Obj> <T.Pontos> <Vencidos> <Hoje> <A vencer> <T.AR> <Carteiro...> <Loec>
// The side letter isn't meaningful to us; it's only used positionally, to
// locate and skip past it, and is not stored or sent to the database.
// The carteiro name can contain multiple words, so it's reconstructed as
// everything between the fixed numeric columns and the trailing Loec code.
function parseLoecPasteText(text) {
    const lines = (text || "").split("\n");
    const districts = [];

    lines.forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;

        const tokens = line.split(/\s+/).filter(Boolean);
        if (tokens.length < 9) return;

        // First token must be the numeric district code (this also skips header rows).
        if (!/^\d+$/.test(tokens[0])) return;
        // Second token is the single-letter side/track indicator (e.g. "A").
        if (!/^[A-Za-z]$/.test(tokens[1])) return;

        const objects = parseInt(tokens[2], 10);
        const points = parseInt(tokens[3], 10);
        const overdue = parseInt(tokens[4], 10);
        const today = parseInt(tokens[5], 10);
        const upcoming = parseInt(tokens[6], 10);
        const tAr = parseInt(tokens[7], 10);
        const loec = tokens[tokens.length - 1];

        if (
            [objects, points, overdue, today, upcoming, tAr].some((n) =>
                Number.isNaN(n),
            )
        )
            return;
        // Loec is a numeric barcode; if the last token isn't numeric this line
        // doesn't match the expected shape, so skip it rather than guess.
        if (!/^\d+$/.test(loec)) return;

        const carteiro = tokens.slice(8, tokens.length - 1).join(" ");
        if (!carteiro) return;

        districts.push({
            district: tokens[0],
            objects,
            points,
            overdue,
            today,
            upcoming,
            t_ar: tAr,
            carteiro,
            loec,
        });
    });

    return { districts };
}

// Finds which CEE sector a district number falls into, based on the sector's
// current effective range (base_start/base_end shifted by current_offset).
function findSectorForDistrict(districtNumber, sectors) {
    for (const sector of sectors) {
        const start = sector.base_start + sector.current_offset;
        const end = sector.base_end + sector.current_offset;
        if (districtNumber >= start && districtNumber <= end) return sector;
    }
    return null;
}

// Builds the full LOEC report: overall totals, plus one breakdown per CEE
// sector (average points/objects per district, which district has the most
// overdue and most due-today objects, and the full per-district rows).
// Districts whose number doesn't fall inside any known sector range are kept
// in `unmatched_districts` instead of being silently dropped.
function buildLoecReport(districts, sectors) {
    const total = districts.reduce(
        (acc, d) => {
            acc.objects += d.objects;
            acc.points += d.points;
            acc.overdue += d.overdue;
            acc.today += d.today;
            acc.upcoming += d.upcoming;
            acc.t_ar += d.t_ar;
            return acc;
        },
        { objects: 0, points: 0, overdue: 0, today: 0, upcoming: 0, t_ar: 0 },
    );
    total.district_count = districts.length;
    total.carteiro_count = new Set(districts.map((d) => d.carteiro)).size;

    const overallMostOverdue = districts.reduce(
        (max, d) => (!max || d.overdue > max.overdue ? d : max),
        null,
    );
    const overallMostToday = districts.reduce(
        (max, d) => (!max || d.today > max.today ? d : max),
        null,
    );
    total.district_most_overdue = overallMostOverdue
        ? {
            district: overallMostOverdue.district,
            value: overallMostOverdue.overdue,
        }
        : null;
    total.district_most_today = overallMostToday
        ? {
            district: overallMostToday.district,
            value: overallMostToday.today,
        }
        : null;

    const bySector = new Map();
    const unmatched = [];

    districts.forEach((d) => {
        const sector = findSectorForDistrict(Number(d.district), sectors);
        const enriched = {
            ...d,
            sector_code: sector ? sector.code : null,
            sector_label: sector ? sector.label : null,
        };
        if (!sector) {
            unmatched.push(enriched);
            return;
        }
        if (!bySector.has(sector.code)) {
            bySector.set(sector.code, {
                code: sector.code,
                label: sector.label,
                range: `${sector.base_start + sector.current_offset}-${sector.base_end + sector.current_offset}`,
                districts: [],
            });
        }
        bySector.get(sector.code).districts.push(enriched);
    });

    const sectorReports = Array.from(bySector.values())
        .map((s) => {
            const n = s.districts.length;
            const sums = s.districts.reduce(
                (acc, d) => {
                    acc.objects += d.objects;
                    acc.points += d.points;
                    acc.overdue += d.overdue;
                    acc.today += d.today;
                    acc.upcoming += d.upcoming;
                    acc.t_ar += d.t_ar;
                    return acc;
                },
                { objects: 0, points: 0, overdue: 0, today: 0, upcoming: 0, t_ar: 0 },
            );

            const mostOverdue = s.districts.reduce(
                (max, d) => (!max || d.overdue > max.overdue ? d : max),
                null,
            );
            const mostToday = s.districts.reduce(
                (max, d) => (!max || d.today > max.today ? d : max),
                null,
            );

            return {
                code: s.code,
                label: s.label,
                range: s.range,
                district_count: n,
                totals: sums,
                avg_objects_per_district: n ? +(sums.objects / n).toFixed(1) : 0,
                avg_points_per_district: n ? +(sums.points / n).toFixed(1) : 0,
                district_most_overdue: mostOverdue
                    ? {
                        district: mostOverdue.district,
                        value: mostOverdue.overdue,
                    }
                    : null,
                district_most_today: mostToday
                    ? {
                        district: mostToday.district,
                        value: mostToday.today,
                    }
                    : null,
                districts: s.districts.sort(
                    (a, b) => Number(a.district) - Number(b.district),
                ),
            };
        })
        .sort((a, b) => a.code.localeCompare(b.code));

    return { total, sectors: sectorReports, unmatched_districts: unmatched };
}

async function submitLoecPasteForm(e) {
    e.preventDefault();
    const rawText = qs('#loec-paste-area').value;
    const { districts } = parseLoecPasteText(rawText);

    if (districts.length === 0) {
        showToast('Nenhum registro de distrito válido encontrado no texto colado.', 'error');
        return;
    }

    // Pull the current sector ranges straight from cee_sectors so the report
    // always reflects the live offsets, regardless of whether the CEE Map tab
    // has been opened in this session.
    const { data: sectors, error: sectorsError } = await sb
        .from('cee_sectors')
        .select('id, code, label, base_start, base_end, current_offset')
        .order('display_order');

    if (sectorsError) {
        showToast(`Erro ao carregar setores: ${sectorsError.message}`, 'error');
        return;
    }

    const report = buildLoecReport(districts, sectors || []);

    // Get local system time
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const payload = {
        log_date: getDailyOpsDate(),
        scan_time: timeStr,
        object_count: report.total.objects,
        notes: `${report.total.district_count} distritos`,
        source_type: 'loec_paste',
        raw_text: rawText,
        report,
    };

    const { error } = await sb.from('daily_object_scans').insert(payload);
    if (error) {
        showToast(`Erro ao registrar: ${error.message}`, 'error');
        return;
    }

    closeModal();
    showToast(`${report.total.objects} objetos em ${report.total.district_count} distritos registrados com sucesso!`);
    await loadDailyOps();
}

// --- LOEC Report Details Modal ---

function loecReportStatCard(title, value) {
    return `
    <div class="loec-report-stat">
      <div class="loec-report-stat-title">${title}</div>
      <div class="loec-report-stat-value">${value}</div>
    </div>
  `;
}

function loecReportHighlightChip(label, info, unit) {
    if (!info) return "";
    return `
    <span class="loec-report-highlight-chip">
      ${label}: <strong>${escapeHtml(info.district)}</strong> (${info.value} ${unit})
    </span>
  `;
}

function loecDistrictRowsTemplate(districts) {
    return districts
        .map(
            (d) => `
    <tr>
      <td class="zip-code-cell">${escapeHtml(d.district)}</td>
      <td><span class="count-badge">${d.objects}</span></td>
      <td><span class="points-badge">${d.points}</span></td>
      <td>${d.overdue}</td>
      <td>${d.today}</td>
      <td>${d.upcoming}</td>
      <td>${d.t_ar}</td>
      <td>${escapeHtml(d.carteiro)}</td>
      <td class="loec-code-cell">${escapeHtml(d.loec)}</td>
    </tr>
  `,
        )
        .join("");
}

function loecSectorSectionTemplate(sector) {
    const chartId = `loec-report-chart-sector-${sector.code}`;
    return `
    <div class="loec-report-sector">
      <div class="loec-report-sector-header">
        <h4>${escapeHtml(sector.label)} <span class="field-hint">(${sector.range})</span></h4>
        <span class="count-badge">${sector.district_count} distrito${sector.district_count === 1 ? "" : "s"}</span>
      </div>
      <div class="loec-report-summary loec-report-summary-compact">
        ${loecReportStatCard("Objetos", sector.totals.objects)}
        ${loecReportStatCard("Pontos", sector.totals.points)}
        ${loecReportStatCard("Média obj./distrito", sector.avg_objects_per_district)}
        ${loecReportStatCard("Média pts./distrito", sector.avg_points_per_district)}
      </div>
      <div class="loec-report-highlight-row">
        ${loecReportHighlightChip("Mais atrasados", sector.district_most_overdue, "vencidos")}
        ${loecReportHighlightChip("Mais vencendo hoje", sector.district_most_today, "hoje")}
      </div>
      <div class="loec-report-chart-box">
        <canvas id="${chartId}" height="180"></canvas>
      </div>
      <div class="manifest-frame">
        <table class="manifest-table">
          <thead>
            <tr>
              <th>Distrito</th>
              <th>T.Obj</th>
              <th>T.Pontos</th>
              <th>Vencidos</th>
              <th>Hoje</th>
              <th>A vencer</th>
              <th>T.AR</th>
              <th>Carteiro</th>
              <th>Loec</th>
            </tr>
          </thead>
          <tbody>${loecDistrictRowsTemplate(sector.districts)}</tbody>
        </table>
      </div>
    </div>
  `;
}

function loecReportTemplate(record, report) {
    const unmatchedSection =
        report.unmatched_districts && report.unmatched_districts.length > 0
            ? `
    <div class="loec-report-sector loec-report-unmatched">
      <div class="loec-report-sector-header">
        <h4>Distritos fora dos setores</h4>
        <span class="count-badge">${report.unmatched_districts.length}</span>
      </div>
      <div class="manifest-frame">
        <table class="manifest-table">
          <thead>
            <tr>
              <th>Distrito</th><th>T.Obj</th><th>T.Pontos</th><th>Vencidos</th><th>Hoje</th><th>A vencer</th><th>T.AR</th><th>Carteiro</th><th>Loec</th>
            </tr>
          </thead>
          <tbody>${loecDistrictRowsTemplate(report.unmatched_districts)}</tbody>
        </table>
      </div>
    </div>
  `
            : "";

    return `
    <div class="loec-report">
      <div class="loec-legend">
        <span class="loec-legend-item"><span class="count-badge legend-swatch">00</span> Objetos (T.Obj)</span>
        <span class="loec-legend-item"><span class="points-badge legend-swatch">00</span> Pontos (T.Pontos)</span>
      </div>
      <div class="loec-report-summary">
        ${loecReportStatCard("Total de objetos", report.total.objects)}
        ${loecReportStatCard("Total de pontos", report.total.points)}
        ${loecReportStatCard("Distritos", report.total.district_count)}
        ${loecReportStatCard("Carteiros", report.total.carteiro_count)}
        ${loecReportStatCard("Vencidos", report.total.overdue)}
        ${loecReportStatCard("Vencendo hoje", report.total.today)}
        ${loecReportStatCard("A vencer", report.total.upcoming)}
        ${loecReportStatCard("T.AR", report.total.t_ar)}
      </div>
      <div class="loec-report-chart-box">
        <canvas id="loec-report-chart-total" height="180"></canvas>
      </div>

      ${report.sectors.map(loecSectorSectionTemplate).join("")}
      ${unmatchedSection}

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

function loecSimpleReportTemplate(record) {
    return `
    <div class="loec-report">
      <p class="field-hint">Registrado às ${formatTimeShort(record.scan_time)}</p>
      <div class="loec-report-summary">
        ${loecReportStatCard("Total de objetos", record.object_count)}
      </div>
      ${record.notes ? `<p>${escapeHtml(record.notes)}</p>` : ""}
      <p class="field-hint">Este registro não possui detalhamento por distrito (lançamento manual, ou registrado antes desta atualização).</p>
    </div>
  `;
}

function loecSectorChartColors() {
    return {
        objects: { border: "#00447c", bg: "rgba(0, 68, 124, 0.65)" },
        overdue: { border: "#c6432e", bg: "rgba(198, 67, 46, 0.65)" },
        today: { border: "#f0b90b", bg: "rgba(240, 185, 11, 0.75)" },
    };
}

function renderLoecReportCharts(report) {
    const colors = loecSectorChartColors();

    // Overview chart: total objects per sector (+ "Sem setor" bucket if any).
    const totalCtx = qs("#loec-report-chart-total");
    if (totalCtx) {
        const labels = report.sectors.map((s) => `${s.label} (${s.range})`);
        const data = report.sectors.map((s) => s.totals.objects);
        if (report.unmatched_districts && report.unmatched_districts.length > 0) {
            labels.push("Sem setor");
            data.push(
                report.unmatched_districts.reduce((sum, d) => sum + d.objects, 0),
            );
        }
        loecReportChartInstances.push(
            new Chart(totalCtx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Objetos por setor",
                            data,
                            backgroundColor: colors.objects.bg,
                            borderColor: colors.objects.border,
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

    // Per-sector chart: objects / overdue / due-today per district.
    report.sectors.forEach((sector) => {
        const ctx = qs(`#loec-report-chart-sector-${sector.code}`);
        if (!ctx) return;
        const labels = sector.districts.map((d) => `${d.district}`);
        loecReportChartInstances.push(
            new Chart(ctx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Objetos",
                            data: sector.districts.map((d) => d.objects),
                            backgroundColor: colors.objects.bg,
                            borderColor: colors.objects.border,
                            borderWidth: 1,
                        },
                        {
                            label: "Vencidos",
                            data: sector.districts.map((d) => d.overdue),
                            backgroundColor: colors.overdue.bg,
                            borderColor: colors.overdue.border,
                            borderWidth: 1,
                        },
                        {
                            label: "Vencendo hoje",
                            data: sector.districts.map((d) => d.today),
                            backgroundColor: colors.today.bg,
                            borderColor: colors.today.border,
                            borderWidth: 1,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                    plugins: { legend: { position: "bottom" } },
                },
            }),
        );
    });
}

function openLoecReportModal(record) {
    const hasFullReport = record.source_type === "loec_paste" && record.report;
    const title = `LOECs &middot; ${formatTimeShort(record.scan_time)}`;

    openModal(
        title,
        hasFullReport
            ? loecReportTemplate(record, record.report)
            : loecSimpleReportTemplate(record),
        hasFullReport ? { wide: true } : {},
    );

    if (hasFullReport) renderLoecReportCharts(record.report);
}