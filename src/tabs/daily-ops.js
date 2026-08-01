// =============================================================================
// MODULE: DAILY OPERATIONS (CEE)
// =============================================================================

function getDailyOpsDate() {
    const input = qs("#daily-ops-date");
    return (input && input.value) || todayIsoDate();
}

let dailyTrucksCache = [];
let dailyScansCache = []
let dailyMalotesCache = [];

async function loadDailyOps() {
    const dateInput = qs("#daily-ops-date");
    if (dateInput && !dateInput.value) dateInput.value = todayIsoDate();
    const date = getDailyOpsDate();

    await Promise.all([
        loadDailyOpsSummary(date),
        loadDailyTrucks(date),
        loadDailyScans(date),
        loadDailyMalotes(date),
        loadDailyNotes(date)
    ]);
}

async function loadDailyOpsSummary(date) {
    const { data, error } = await sb
        .from("daily_operation_summary")
        .select("*")
        .eq("log_date", date)
        .maybeSingle();

    if (error) {
        console.error("Failed to load daily summary:", error);
        return;
    }

    const summary = data || {
        total_trucks: 0,
        total_cdls: 0,
        total_objects: 0,
        total_malotes: 0,
    };

    qs("#dops-total-trucks").textContent = summary.total_trucks;
    qs("#dops-total-cdls").textContent = summary.total_cdls;
    qs("#dops-total-malotes").textContent = summary.total_malotes;
}

// --- Trucks ---
async function loadDailyTrucks(date) {
    const tbody = qs("#daily-trucks-tbody");
    const emptyEl = qs("#daily-trucks-empty");
    tbody.innerHTML =
        '<tr class="loading-row"><td colspan="5">Carregando&hellip;</td></tr>';

    const { data, error } = await sb
        .from("daily_truck_arrivals")
        .select("*")
        .eq("log_date", date)
        .order("arrival_time");

    if (error) {
        tbody.innerHTML = `<tr class="error-row"><td colspan="5">Erro ao carregar: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    dailyTrucksCache = data || [];
    emptyEl.classList.toggle("hidden", dailyTrucksCache.length > 0);
    tbody.innerHTML = dailyTrucksCache
        .map(
            (t) => `
    <tr>
      <td>${formatTimeShort(t.arrival_time)}</td>
      <td>${escapeHtml(t.truck_identifier)}</td>
      <td><span class="count-badge">${t.cdl_count}</span></td>
      <td>${escapeHtml(t.notes || "")}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-truck="${t.id}">Excluir</button></td>
    </tr>
  `,
        )
        .join("");
}

function truckFormTemplate() {
    return `
    <form id="truck-form">
      <div class="field-row">
        <div class="field"><label for="truck-time">Horário de chegada</label><input type="time" id="truck-time" required></div>
        <div class="field"><label for="truck-cdl-count">Quantidade de CDLs</label><input type="number" id="truck-cdl-count" min="0" required></div>
      </div>
      <div class="field"><label for="truck-identifier">Identificação (opcional)</label><input type="text" id="truck-identifier" placeholder="Ex.: ABC-1234 ou Rota Norte"></div>
      <div class="field"><label for="truck-notes">Observações (opcional)</label><input type="text" id="truck-notes" placeholder="Opcional"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="truck-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar Caminhão</button>
      </div>
    </form>
  `;
}

function openTruckForm() {
    openModal("Registrar Chegada de Caminhão", truckFormTemplate());
    qs("#truck-cancel").addEventListener("click", closeModal);
    qs("#truck-form").addEventListener("submit", submitTruckForm);
}

async function submitTruckForm(e) {
    e.preventDefault();
    let payload = {
        log_date: getDailyOpsDate(),
        arrival_time: qs("#truck-time").value,
        truck_identifier: qs("#truck-identifier").value.trim(),
        cdl_count: Number(qs("#truck-cdl-count").value),
        notes: qs("#truck-notes").value.trim() || null,
    };
    payload.truck_identifier = !payload.truck_identifier
        ? null
        : payload.truck_identifier;

    const { error } = await sb.from("daily_truck_arrivals").insert(payload);
    if (error) {
        showToast(`Erro ao registrar caminhão: ${error.message}`, "error");
        return;
    }
    closeModal();
    showToast("Caminhão registrado com sucesso!");

    const date = getDailyOpsDate();
    await Promise.all([
        loadDailyTrucks(date),
        loadDailyOpsSummary(date)
    ]);
}

async function deleteDailyTruck(id) {
    openDeleteConfirm("este registro de caminhão", null, async () => {
        const { error } = await sb
            .from("daily_truck_arrivals")
            .delete()
            .eq("id", id);
        if (error) {
            showToast(`Erro ao excluir: ${error.message}`, "error");
            return;
        }
        closeModal();
        showToast("Registro excluído.");

        const date = getDailyOpsDate();
        await Promise.all([
            loadDailyTrucks(date),
            loadDailyOpsSummary(date)
        ]);
    });
}


// --- Malotes ---
async function loadDailyMalotes(date) {
    const tbody = qs("#daily-malotes-tbody");
    const emptyEl = qs("#daily-malotes-empty");
    tbody.innerHTML =
        '<tr class="loading-row"><td colspan="5">Carregando&hellip;</td></tr>';

    const { data, error } = await sb
        .from("daily_malote_deliveries")
        .select("*")
        .eq("log_date", date)
        .order("delivery_time");

    if (error) {
        tbody.innerHTML = `<tr class="error-row"><td colspan="5">Erro ao carregar: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    dailyMalotesCache = data || [];
    emptyEl.classList.toggle("hidden", dailyMalotesCache.length > 0);
    tbody.innerHTML = dailyMalotesCache
        .map(
            (m) => `
    <tr>
      <td>${formatTimeShort(m.delivery_time)}</td>
      <td>${m.carteiro_name ? escapeHtml(m.carteiro_name) : '<span class="field-hint">Colagem automática</span>'}</td>
      <td><span class="count-badge">${m.malote_count}</span></td>
      <td>${escapeHtml(m.notes || "")}</td>
      <td class="col-actions">
        <span class="row-actions">
          ${m.source_type === "malote_paste" ? `<button class="btn btn-secondary btn-icon" data-view-malote="${m.id}">Detalhes</button>` : ""}
          <button class="btn btn-danger btn-icon" data-delete-malote="${m.id}">Excluir</button>
        </span>
      </td>
    </tr>
  `,
        )
        .join("");
}

function maloteFormTemplate() {
    return `
    <form id="malote-form">
      <div class="field-row">
        <div class="field"><label for="malote-time">Horário</label><input type="time" id="malote-time" required></div>
        <div class="field"><label for="malote-count">Quantidade de malotes</label><input type="number" id="malote-count" min="0" required></div>
      </div>
      <div class="field"><label for="malote-carteiro">Carteiro</label><input type="text" id="malote-carteiro" required placeholder="Nome do carteiro"></div>
      <div class="field"><label for="malote-notes">Observações (opcional)</label><input type="text" id="malote-notes" placeholder="Opcional"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="malote-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar Malote</button>
      </div>
    </form>
  `;
}


async function submitMaloteForm(e) {
    e.preventDefault();
    const payload = {
        log_date: getDailyOpsDate(),
        delivery_time: qs("#malote-time").value,
        carteiro_name: qs("#malote-carteiro").value.trim(),
        malote_count: Number(qs("#malote-count").value),
        notes: qs("#malote-notes").value.trim() || null,
    };

    const { error } = await sb.from("daily_malote_deliveries").insert(payload);
    if (error) {
        showToast(`Erro ao registrar malote: ${error.message}`, "error");
        return;
    }
    closeModal();
    showToast("Malote registrado.");

    const date = getDailyOpsDate();
    await Promise.all([
        loadDailyMalotes(date),
        loadDailyOpsSummary(date)
    ]);
}

async function deleteDailyMalote(id) {
    openDeleteConfirm("este registro de malote", null, async () => {
        const { error } = await sb
            .from("daily_malote_deliveries")
            .delete()
            .eq("id", id);
        if (error) {
            showToast(`Erro ao excluir: ${error.message}`, "error");
            return;
        }
        closeModal();
        showToast("Registro excluído.");

        const date = getDailyOpsDate();
        await Promise.all([
            loadDailyMalotes(date),
            loadDailyOpsSummary(date)
        ]);
    });
}

let dailyNotesEditor = null;


// Initialize the Quill editor instance
function initNotesEditor() {
    const container = qs('#daily-notes-editor');
    if (container && !dailyNotesEditor) {
        dailyNotesEditor = new Quill('#daily-notes-editor', {
            theme: 'snow',
            placeholder: 'Escreva os apontamentos e observações do dia aqui...',
            modules: {
                toolbar: [
                    ['bold', 'italic', 'underline', 'strike'],        // Toggled buttons
                    [{ 'list': 'ordered' }, { 'list': 'bullet' }],     // Lists
                    [{ 'color': [] }, { 'background': [] }],          // Colors
                    ['clean']                                         // Remove formatting button
                ]
            }
        });
    }
}

async function loadDailyNotes(date) {
    // Ensure editor is initialized before using it
    if (!dailyNotesEditor) initNotesEditor();

    dailyNotesEditor.disable();
    dailyNotesEditor.root.innerHTML = '<p style="color: #5b6b85; font-style: italic;">Carregando anotações...</p>';

    const { data, error } = await sb.from('daily_operation_notes')
        .select('notes')
        .eq('log_date', date)
        .maybeSingle();

    // Only re-enable editing if the current role is allowed to write daily ops.
    if (currentUserRole === UserRoles.ADMIN || currentUserRole === UserRoles.SUPERVISOR) {
        dailyNotesEditor.enable();
    }

    if (error) {
        console.error('Failed to load notes:', error);
        dailyNotesEditor.root.innerHTML = '';
        return;
    }

    // Inject the saved HTML into the editor
    dailyNotesEditor.root.innerHTML = data && data.notes ? data.notes : '';
}

async function saveDailyNotes() {
    const date = getDailyOpsDate();

    // Extract HTML content directly from the editor
    const notesHtml = dailyNotesEditor.root.innerHTML;

    // Check if it's practically empty (Quill usually leaves <p><br></p> when empty)
    const isEditorEmpty = dailyNotesEditor.getText().trim().length === 0;
    const finalNotes = isEditorEmpty ? '' : notesHtml;

    const { error } = await sb.from('daily_operation_notes')
        .upsert({ log_date: date, notes: finalNotes }, { onConflict: 'log_date' });

    if (error) {
        showToast(`Erro ao salvar anotações: ${error.message}`, 'error');
    } else {
        showToast('Anotações salvas com sucesso!');
    }
}


// --- Daily Ops Event Listeners ---
qs("#btn-new-truck").addEventListener("click", openTruckForm);
qs("#daily-trucks-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-delete-truck]");
    if (btn) deleteDailyTruck(btn.dataset.deleteTruck);
});


qs("#daily-scans-tbody").addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("[data-delete-scan]");
    const viewBtn = e.target.closest("[data-view-scan]");
    if (deleteBtn) deleteDailyScan(deleteBtn.dataset.deleteScan);
    if (viewBtn) {
        const record = dailyScansCache.find(
            (s) => String(s.id) === viewBtn.dataset.viewScan,
        );
        if (record) openLoecReportModal(record);
    }
});


qs("#daily-malotes-tbody").addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("[data-delete-malote]");
    const viewBtn = e.target.closest("[data-view-malote]");
    if (deleteBtn) deleteDailyMalote(deleteBtn.dataset.deleteMalote);
    if (viewBtn) {
        const record = dailyMalotesCache.find(
            (m) => String(m.id) === viewBtn.dataset.viewMalote,
        );
        if (record) openMaloteReportModal(record);
    }
});

const btnPasteMalote = qs("#btn-paste-malote");
if (btnPasteMalote) btnPasteMalote.addEventListener("click", openMalotePasteForm);

const btnAnalyzeMalotes = qs("#btn-analyze-malotes");
if (btnAnalyzeMalotes) btnAnalyzeMalotes.addEventListener("click", openMaloteAnalysisModal);

qs('#btn-paste-loec').addEventListener('click', openLoecPasteForm);

const btnSaveNotes = qs('#btn-save-notes');
if (btnSaveNotes) {
    btnSaveNotes.addEventListener('click', saveDailyNotes);
}

const dailyOpsDateInput = qs("#daily-ops-date");
if (dailyOpsDateInput)
    dailyOpsDateInput.addEventListener("change", () => loadDailyOps());

const btnDailyOpsToday = qs("#daily-ops-today");
if (btnDailyOpsToday) {
    btnDailyOpsToday.addEventListener("click", () => {
        qs("#daily-ops-date").value = todayIsoDate();
        loadDailyOps();
    });
}

// --- Modal: LOEC Analysis ---
const btnOpenLoecAnalysis = qs("#btn-open-loec-analysis");
const loecAnalysisModal = qs("#loec-analysis-modal");
const loecAnalysisModalClose = qs("#loec-analysis-modal-close");

if (btnOpenLoecAnalysis) {
    btnOpenLoecAnalysis.addEventListener("click", () => {
        loecAnalysisModal.classList.remove("hidden");
    });
}

if (loecAnalysisModalClose) {
    loecAnalysisModalClose.addEventListener("click", () => {
        loecAnalysisModal.classList.add("hidden");
    });
}

// Close the modal when clicking outside the slip body
if (loecAnalysisModal) {
    loecAnalysisModal.addEventListener("click", (e) => {
        if (e.target === loecAnalysisModal) {
            loecAnalysisModal.classList.add("hidden");
        }
    });
}