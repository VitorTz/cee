// =============================================================================
// QUADRO DE FUNCIONÁRIOS
// =============================================================================
// Registro completo de carteiros (internos/externos), terceirizados
// (internos/externos), motoristas e profissionais da limpeza. Toda a aba (e
// as tabelas por trás dela: employees, employee_attendance, employee_leaves)
// só é visível/editável por admin ou supervisor — reforçado tanto aqui
// (esconder a aba) quanto no banco via RLS (ver employees_schema.sql).

const EMPLOYEE_TYPE_LABELS = {
    carteiro_interno: "Carteiro Interno",
    carteiro_externo: "Carteiro Externo",
    carteiro_emprestado: "Carteiro Emprestado",
    terceirizado_interno: "Terceirizado Interno",
    terceirizado_externo: "Terceirizado Externo",
    motorista: "Motorista",
    limpeza: "Limpeza",
};

// Employee types that come from another branch on loan — these show an
// "origin_branch" field so it's clear where they came from.
const EMPLOYEE_TYPES_WITH_ORIGIN = new Set(["carteiro_emprestado"]);

// One CSS-safe class name per type, so each category gets a distinct color
// (see .func-type-<value> rules in style.css). The enum values themselves
// are already valid class name suffixes, so this is just a passthrough —
// kept as an explicit map in case labels/values ever diverge.
const EMPLOYEE_TYPE_CLASS = {
    carteiro_interno: "carteiro_interno",
    carteiro_externo: "carteiro_externo",
    carteiro_emprestado: "carteiro_emprestado",
    terceirizado_interno: "terceirizado_interno",
    terceirizado_externo: "terceirizado_externo",
    motorista: "motorista",
    limpeza: "limpeza",
};

function funcTypeBadge(type) {
    const cls = EMPLOYEE_TYPE_CLASS[type] || "carteiro_interno";
    const label = EMPLOYEE_TYPE_LABELS[type] || type;
    return `<span class="func-type-badge func-type-${cls}">${label}</span>`;
}

const ATTENDANCE_STATUS_LABELS = {
    presente: "Presente",
    falta_justificada: "Falta Justificada",
    falta_injustificada: "Falta Injustificada",
    atestado: "Atestado",
    ferias: "Férias",
    folga: "Folga",
};

const FUNC_PAGE_SIZE = 20;

let funcInitialized = false;
let funcPage = 0;
let funcSearchTerm = "";
let funcFilterType = "";
let funcFilterActive = "active";
let funcStatusMap = {}; // employee_id -> { current_situation, ferias_until, atestado_until }

let funcLeavesCache = []; // all leave rows for the current filter, client-paginated below

// `null` means "not fetched yet" — ensureActiveEmployeesCache() only hits the
// network the first time it's needed, and again after anything that could
// change the active roster (create/edit/deactivate/delete an employee).
let funcActiveEmployeesCache = null; // [{id, full_name, employee_type}] for selects

let funcCalendarDate = new Date();
funcCalendarDate.setDate(1);
let funcCalendarViewMode = "week"; // "day" | "3day" | "week" | "month"
let funcCalendarEventsCache = []; // events overlapping the range currently on screen

// --- Helpers ---------------------------------------------------------------

function formatDateBR(isoDate) {
    if (!isoDate) return "—";
    const [y, m, d] = isoDate.split("-");
    return `${d}/${m}/${y}`;
}

// Builds a wa.me link from a Brazilian phone number. Returns null when the
// stored value doesn't look like a usable number, so callers can skip
// rendering the button entirely.
function whatsappLink(phone) {
    if (!phone) return null;
    let digits = phone.replace(/\D/g, "");
    if (!digits) return null;
    if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
        digits = `55${digits}`;
    }
    if (digits.length < 12 || digits.length > 13) return null;
    return `https://wa.me/${digits}`;
}

function funcSituationLabel(situation) {
    switch (situation) {
        case "ferias":
            return "De Férias";
        case "atestado":
            return "De Atestado";
        case "inativo":
            return "Desligado";
        default:
            return "Ativo";
    }
}

function leavePeriodStatus(leave) {
    const today = todayIsoDate();
    if (leave.end_date < today) return "past";
    if (leave.start_date > today) return "upcoming";
    return "current";
}

function leaveStatusLabel(status) {
    return { current: "Em andamento", upcoming: "Futuro", past: "Encerrado" }[status] || status;
}

// --- Data loading ------------------------------------------------------------

async function refreshFuncStatusMap() {
    const { data, error } = await sb
        .from("employee_current_status")
        .select("employee_id, current_situation, ferias_until, atestado_until, atestado_reason");
    funcStatusMap = {};
    if (!error && data) {
        data.forEach((row) => {
            funcStatusMap[row.employee_id] = row;
        });
    }
}

async function refreshFuncStatusSummary() {
    const in30Days = new Date();
    in30Days.setDate(in30Days.getDate() + 30);
    const in30DaysStr = in30Days.toISOString().slice(0, 10);

    // All three are independent — fire them together instead of one after
    // another, so opening the tab costs one round trip's worth of latency
    // instead of three.
    const [, { count: activeCount }, { count: upcomingCount }] = await Promise.all([
        refreshFuncStatusMap(),
        sb.from("employees").select("id", { count: "exact", head: true }).eq("active", true),
        sb
            .from("employee_upcoming_vacations")
            .select("id", { count: "exact", head: true })
            .lte("start_date", in30DaysStr),
    ]);

    let feriasToday = 0;
    let atestadoToday = 0;
    Object.values(funcStatusMap).forEach((row) => {
        if (row.current_situation === "ferias") feriasToday++;
        if (row.current_situation === "atestado") atestadoToday++;
    });

    qs("#func-stat-active").textContent = activeCount ?? 0;
    qs("#func-stat-ferias").textContent = feriasToday;
    qs("#func-stat-atestado").textContent = atestadoToday;
    qs("#func-stat-upcoming").textContent = upcomingCount ?? 0;
}

// Fetches the active-employee list used by the leave/presence selects, but
// only over the network the first time (or after `invalidate`/a mutation
// that could change who's active). Everything else reuses the cache.
async function ensureActiveEmployeesCache(forceReload = false) {
    if (funcActiveEmployeesCache !== null && !forceReload) return funcActiveEmployeesCache;
    const { data, error } = await sb
        .from("employees")
        .select("id, full_name, employee_type")
        .eq("active", true)
        .order("full_name");
    funcActiveEmployeesCache = error ? [] : data;
    return funcActiveEmployeesCache;
}

function invalidateFuncActiveEmployeesCache() {
    funcActiveEmployeesCache = null;
}

// --- Sub-panel: employee registry (list + CRUD) -----------------------------

async function loadFuncList() {
    const tbody = qs("#func-tbody");
    const emptyEl = qs("#func-empty");
    tbody.innerHTML = `<tr class="loading-row"><td colspan="7">Carregando&hellip;</td></tr>`;
    emptyEl.classList.add("hidden");

    let query = sb.from("employees").select("*", { count: "exact" });

    if (funcFilterActive === "active") query = query.eq("active", true);
    else if (funcFilterActive === "inactive") query = query.eq("active", false);

    if (funcFilterType) query = query.eq("employee_type", funcFilterType);

    if (funcSearchTerm.trim()) {
        const term = funcSearchTerm.trim();
        const orParts = [
            `full_name.ilike.%${term}%`,
            `email.ilike.%${term}%`,
            `phone.ilike.%${term}%`,
        ];
        query = query.or(orParts.join(","));
    }

    query = query
        .order("full_name")
        .range(funcPage * FUNC_PAGE_SIZE, funcPage * FUNC_PAGE_SIZE + FUNC_PAGE_SIZE - 1);

    const { data, error, count } = await query;
    // funcStatusMap is refreshed once when the tab opens and again after any
    // mutation that can change it (leave/employee CRUD) — no need to re-fetch
    // the whole employee_current_status view on every keystroke or page turn.

    if (error || !data || data.length === 0) {
        tbody.innerHTML = "";
        emptyEl.classList.remove("hidden");
    } else {
        tbody.innerHTML = data.map(renderFuncRow).join("");
        wireFuncRowActions();
    }

    const totalPages = Math.max(1, Math.ceil((count || 0) / FUNC_PAGE_SIZE));
    qs("#func-page-info").textContent = `Página ${funcPage + 1} de ${totalPages}`;
    qs("#func-prev").disabled = funcPage <= 0;
    qs("#func-next").disabled = funcPage + 1 >= totalPages;
}

function renderFuncRow(emp) {
    const status = funcStatusMap[emp.id];
    const situation = !emp.active ? "inativo" : status ? status.current_situation : "ativo";

    const originNote =
        emp.employee_type === "carteiro_emprestado" && emp.origin_branch
            ? `<span class="func-origin-note">de: ${escapeHtml(emp.origin_branch)}</span>`
            : "";

    const wa = whatsappLink(emp.phone);

    const waIcon = wa
        ? `<a class="contact-icon wa-icon" href="${wa}" target="_blank" rel="noopener" title="WhatsApp">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
             </svg>
           </a>`
        : "";

    const emailIcon = emp.email
        ? `<a class="contact-icon email-icon" href="mailto:${encodeURIComponent(emp.email)}" title="E-mail">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
               <polyline points="22,6 12,13 2,6"></polyline>
             </svg>
           </a>`
        : "";

    return `
    <tr data-emp-id="${emp.id}">
      <td>${escapeHtml(emp.full_name)}</td>
      <td>${funcTypeBadge(emp.employee_type)}${originNote}</td>
      <td>
        <div class="contact-wrapper">
            <span>${escapeHtml(emp.phone || "—")}</span>
            ${waIcon}
        </div>
      </td>
      <td>
        <div class="contact-wrapper">
            <span>${escapeHtml(emp.email || "—")}</span>
            ${emailIcon}
        </div>
      </td>
      <td><span class="func-situation-badge func-situation-${situation}">${funcSituationLabel(situation)}</span></td>
      <td class="col-actions">
        <button type="button" class="btn btn-secondary btn-icon" data-history-func="${emp.id}">Histórico</button>
        <button type="button" class="btn btn-secondary btn-icon" data-edit-func="${emp.id}">Editar</button>
        <button type="button" class="btn btn-secondary btn-icon" data-toggle-func="${emp.id}">${emp.active ? "Desligar" : "Reativar"}</button>
        <button type="button" class="btn btn-danger btn-icon" data-delete-func="${emp.id}">Excluir</button>
      </td>
    </tr>`;
}

function wireFuncRowActions() {
    qsa("[data-edit-func]").forEach((btn) => {
        btn.addEventListener("click", () => openFuncEmployeeModal(Number(btn.dataset.editFunc)));
    });
    qsa("[data-toggle-func]").forEach((btn) => {
        btn.addEventListener("click", () => toggleFuncActive(Number(btn.dataset.toggleFunc)));
    });
    qsa("[data-delete-func]").forEach((btn) => {
        btn.addEventListener("click", () => confirmDeleteFunc(Number(btn.dataset.deleteFunc)));
    });
    qsa("[data-history-func]").forEach((btn) => {
        btn.addEventListener("click", () => openFuncHistoryModal(Number(btn.dataset.historyFunc)));
    });
}

async function toggleFuncActive(id) {
    const { data: emp } = await sb.from("employees").select("active, full_name").eq("id", id).maybeSingle();
    if (!emp) return;
    const { error } = await sb.from("employees").update({ active: !emp.active }).eq("id", id);
    if (error) {
        showToast("Não foi possível atualizar o funcionário.", "error");
        return;
    }
    showToast(emp.active ? `${emp.full_name} foi desligado(a).` : `${emp.full_name} foi reativado(a).`);
    invalidateFuncActiveEmployeesCache();
    await loadFuncList();
    await refreshFuncStatusSummary();
}

function confirmDeleteFunc(id) {
    const row = qs(`tr[data-emp-id="${id}"]`);
    const name = row ? row.children[0].textContent : "este funcionário";
    openDeleteConfirm(
        name,
        "Isso apaga também todo o histórico de presença e afastamentos deste funcionário. Considere usar “Desligar” para manter o histórico.",
        async () => {
            const { error } = await sb.from("employees").delete().eq("id", id);
            closeModal();
            if (error) {
                showToast("Não foi possível excluir o funcionário.", "error");
                return;
            }
            showToast("Funcionário excluído.");
            invalidateFuncActiveEmployeesCache();
            await loadFuncList();
            await refreshFuncStatusSummary();
        },
    );
}

function funcEmployeeTypeOptions(selected) {
    return Object.entries(EMPLOYEE_TYPE_LABELS)
        .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
        .join("");
}

function funcEmployeeFormTemplate(emp) {
    const e = emp || {
        full_name: "",
        employee_type: "carteiro_interno",
        email: "",
        phone: "",
        address: "",
        notes: "",
        origin_branch: "",
    };
    const showOrigin = EMPLOYEE_TYPES_WITH_ORIGIN.has(e.employee_type);
    return `
    <form id="func-employee-form">
      <div class="field-row">
        <div class="field field-grow">
          <label for="func-f-name">Nome completo *</label>
          <input type="text" id="func-f-name" maxlength="150" required value="${escapeHtml(e.full_name)}">
        </div>
        <div class="field">
          <label for="func-f-type">Tipo *</label>
          <select id="func-f-type">${funcEmployeeTypeOptions(e.employee_type)}</select>
        </div>
      </div>
      <div class="field" id="func-f-origin-wrap" style="${showOrigin ? "" : "display:none"}">
        <label for="func-f-origin">Sede/unidade de origem <span style="font-weight:400;color:var(--ink-soft)">(de onde ele veio ajudar)</span></label>
        <input type="text" id="func-f-origin" maxlength="150" value="${escapeHtml(e.origin_branch || "")}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="func-f-phone">Telefone <span style="font-weight:400;color:var(--ink-soft)">(usado para o botão de WhatsApp)</span></label>
          <input type="text" id="func-f-phone" maxlength="30" placeholder="(00) 00000-0000" value="${escapeHtml(e.phone || "")}">
        </div>
        <div class="field">
          <label for="func-f-email">E-mail</label>
          <input type="email" id="func-f-email" maxlength="150" value="${escapeHtml(e.email || "")}">
        </div>
      </div>
      <div class="field">
        <label for="func-f-address">Endereço</label>
        <input type="text" id="func-f-address" maxlength="255" value="${escapeHtml(e.address || "")}">
      </div>
      <div class="field">
        <label for="func-f-notes">Observações</label>
        <textarea id="func-f-notes" rows="2" maxlength="1000">${escapeHtml(e.notes || "")}</textarea>
      </div>
      <p id="func-f-error" class="account-status hidden" style="color: var(--stamp-red);"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="func-f-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>`;
}

async function openFuncEmployeeModal(id) {
    let emp = null;
    if (id) {
        const { data } = await sb.from("employees").select("*").eq("id", id).maybeSingle();
        emp = data;
    }
    openModal(id ? "Editar Funcionário" : "Novo Funcionário", funcEmployeeFormTemplate(emp));
    qs("#func-f-cancel").addEventListener("click", closeModal);
    qs("#func-f-type").addEventListener("change", (e) => {
        qs("#func-f-origin-wrap").style.display = EMPLOYEE_TYPES_WITH_ORIGIN.has(e.target.value)
            ? ""
            : "none";
    });
    qs("#func-employee-form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const errorEl = qs("#func-f-error");
        errorEl.classList.add("hidden");

        const fullName = qs("#func-f-name").value.trim();
        if (!fullName) {
            errorEl.textContent = "Informe o nome do funcionário.";
            errorEl.classList.remove("hidden");
            return;
        }

        const selectedType = qs("#func-f-type").value;
        const payload = {
            full_name: fullName,
            employee_type: selectedType,
            phone: qs("#func-f-phone").value.trim() || null,
            email: qs("#func-f-email").value.trim() || null,
            address: qs("#func-f-address").value.trim() || null,
            notes: qs("#func-f-notes").value.trim() || null,
            origin_branch: EMPLOYEE_TYPES_WITH_ORIGIN.has(selectedType)
                ? qs("#func-f-origin").value.trim() || null
                : null,
        };

        const { error } = id
            ? await sb.from("employees").update(payload).eq("id", id)
            : await sb.from("employees").insert(payload);

        if (error) {
            errorEl.textContent = "Não foi possível salvar. Tente novamente.";
            errorEl.classList.remove("hidden");
            return;
        }

        showToast(id ? "Funcionário atualizado." : "Funcionário cadastrado.");
        closeModal();
        invalidateFuncActiveEmployeesCache();
        await loadFuncList();
        await refreshFuncStatusSummary();
    });
}

// --- Per-employee history (presence, faults, leaves) — current & past months

function funcHistoryShellTemplate() {
    return `
    <div class="func-hist-toolbar">
      <button type="button" class="btn btn-secondary btn-icon" id="func-hist-prev">&larr;</button>
      <h4 id="func-hist-label">&nbsp;</h4>
      <button type="button" class="btn btn-secondary btn-icon" id="func-hist-next">&rarr;</button>
      <button type="button" class="btn btn-secondary btn-icon" id="func-hist-current">Mês Atual</button>
    </div>
    <div id="func-hist-body"><p class="empty-state">Carregando&hellip;</p></div>`;
}

async function renderFuncHistoryMonth(employeeId, monthDate) {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    qs("#func-hist-label").textContent = `${FUNC_MONTH_LABELS[month]} de ${year}`;

    const monthStart = isoDate(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthEnd = isoDate(year, month, daysInMonth);

    const body = qs("#func-hist-body");
    body.innerHTML = `<p class="empty-state">Carregando&hellip;</p>`;

    const [{ data: attendance, error: attError }, { data: leaves, error: leavesError }] =
        await Promise.all([
            sb
                .from("employee_attendance")
                .select("log_date, status, notes")
                .eq("employee_id", employeeId)
                .gte("log_date", monthStart)
                .lte("log_date", monthEnd)
                .order("log_date"),
            sb
                .from("employee_leaves")
                .select("leave_type, start_date, end_date, reason")
                .eq("employee_id", employeeId)
                .lte("start_date", monthEnd)
                .gte("end_date", monthStart)
                .order("start_date"),
        ]);

    const attendanceRows = attError || !attendance ? [] : attendance;
    const leaveRows = leavesError || !leaves ? [] : leaves;

    const attendanceHtml =
        attendanceRows.length === 0
            ? `<p class="empty-state">Nenhum registro de presença neste mês.</p>`
            : `<table class="func-hist-table">
          <thead><tr><th>Data</th><th>Situação</th><th>Observação</th></tr></thead>
          <tbody>
            ${attendanceRows
                .map(
                    (a) => `
              <tr>
                <td>${formatDateBR(a.log_date)}</td>
                <td><span class="func-hist-status-tag func-hist-status-${a.status}">${ATTENDANCE_STATUS_LABELS[a.status] || a.status}</span></td>
                <td>${escapeHtml(a.notes || "—")}</td>
              </tr>`,
                )
                .join("")}
          </tbody>
        </table>`;

    const leavesHtml =
        leaveRows.length === 0
            ? `<p class="empty-state">Nenhuma férias/atestado neste mês.</p>`
            : `<table class="func-hist-table">
          <thead><tr><th>Tipo</th><th>Período</th><th>Motivo</th></tr></thead>
          <tbody>
            ${leaveRows
                .map(
                    (l) => `
              <tr>
                <td>${l.leave_type === "ferias" ? "Férias" : "Atestado"}</td>
                <td>${formatDateBR(l.start_date)} a ${formatDateBR(l.end_date)}</td>
                <td>${escapeHtml(l.reason || "—")}</td>
              </tr>`,
                )
                .join("")}
          </tbody>
        </table>`;

    body.innerHTML = `
      <div class="func-hist-section-title">Presenças e Faltas</div>
      ${attendanceHtml}
      <div class="func-hist-section-title">Férias e Atestados</div>
      ${leavesHtml}`;
}

async function openFuncHistoryModal(employeeId) {
    const { data: emp } = await sb.from("employees").select("full_name").eq("id", employeeId).maybeSingle();
    const employeeName = emp ? emp.full_name : "Funcionário";

    let monthDate = new Date();
    monthDate.setDate(1);

    openModal(`Histórico de ${escapeHtml(employeeName)}`, funcHistoryShellTemplate(), { wide: true });

    qs("#func-hist-prev").addEventListener("click", () => {
        monthDate.setMonth(monthDate.getMonth() - 1);
        renderFuncHistoryMonth(employeeId, monthDate);
    });
    qs("#func-hist-next").addEventListener("click", () => {
        monthDate.setMonth(monthDate.getMonth() + 1);
        renderFuncHistoryMonth(employeeId, monthDate);
    });
    qs("#func-hist-current").addEventListener("click", () => {
        monthDate = new Date();
        monthDate.setDate(1);
        renderFuncHistoryMonth(employeeId, monthDate);
    });

    await renderFuncHistoryMonth(employeeId, monthDate);
}

// --- Sub-panel: daily attendance --------------------------------------------

async function loadFuncPresenca() {
    const dateEl = qs("#func-presenca-date");
    if (!dateEl.value) dateEl.value = todayIsoDate();
    const logDate = dateEl.value;

    const tbody = qs("#func-presenca-tbody");
    const emptyEl = qs("#func-presenca-empty");
    tbody.innerHTML = `<tr class="loading-row"><td colspan="4">Carregando&hellip;</td></tr>`;
    emptyEl.classList.add("hidden");

    let employeesQuery = sb
        .from("employees")
        .select("id, full_name, employee_type")
        .eq("active", true)
        .order("full_name");
    const typeFilter = qs("#func-presenca-filter-type").value;
    if (typeFilter) employeesQuery = employeesQuery.eq("employee_type", typeFilter);

    const employeesP = employeesQuery;
    const attendanceP = sb.from("employee_attendance").select("*").eq("log_date", logDate);
    const leavesP = sb
        .from("employee_leaves")
        .select("employee_id, leave_type, reason")
        .lte("start_date", logDate)
        .gte("end_date", logDate);

    const [{ data: employees }, { data: attendance }, { data: leaves }] = await Promise.all([
        employeesP,
        attendanceP,
        leavesP,
    ]);

    if (!employees || employees.length === 0) {
        tbody.innerHTML = "";
        emptyEl.classList.remove("hidden");
        return;
    }

    const attendanceMap = {};
    (attendance || []).forEach((a) => (attendanceMap[a.employee_id] = a));
    const leaveMap = {};
    (leaves || []).forEach((l) => (leaveMap[l.employee_id] = l));

    tbody.innerHTML = employees
        .map((emp) => {
            const existing = attendanceMap[emp.id];
            const leave = leaveMap[emp.id];
            const defaultStatus = existing ? existing.status : leave ? leave.leave_type : "presente";
            const defaultNotes = existing ? existing.notes || "" : leave ? leave.reason || "" : "";
            const options = Object.entries(ATTENDANCE_STATUS_LABELS)
                .map(([v, label]) => `<option value="${v}" ${v === defaultStatus ? "selected" : ""}>${label}</option>`)
                .join("");
            return `
        <tr class="func-attendance-row" data-emp-id="${emp.id}">
          <td>${escapeHtml(emp.full_name)}</td>
          <td>${funcTypeBadge(emp.employee_type)}</td>
          <td><select class="func-att-status">${options}</select></td>
          <td><input type="text" class="func-att-notes" maxlength="255" value="${escapeHtml(defaultNotes)}" placeholder="Observação (opcional)"></td>
        </tr>`;
        })
        .join("");
}

async function saveFuncPresenca() {
    const logDate = qs("#func-presenca-date").value || todayIsoDate();
    const rows = qsa(".func-attendance-row").map((tr) => ({
        employee_id: Number(tr.dataset.empId),
        log_date: logDate,
        status: qs(".func-att-status", tr).value,
        notes: qs(".func-att-notes", tr).value.trim() || null,
        created_by: currentUser ? currentUser.id : null,
    }));

    if (rows.length === 0) return;

    const btn = qs("#btn-save-presenca");
    btn.disabled = true;
    const { error } = await sb
        .from("employee_attendance")
        .upsert(rows, { onConflict: "employee_id,log_date" });
    btn.disabled = false;

    if (error) {
        showToast("Não foi possível salvar as presenças.", "error");
        return;
    }
    showToast("Presenças salvas com sucesso.");
    await refreshFuncStatusSummary();
}

// --- Sub-panel: afastamentos (férias / atestado) ----------------------------

async function loadFuncLeaves() {
    const tbody = qs("#func-leaves-tbody");
    const emptyEl = qs("#func-leaves-empty");
    tbody.innerHTML = `<tr class="loading-row"><td colspan="7">Carregando&hellip;</td></tr>`;
    emptyEl.classList.add("hidden");

    let query = sb
        .from("employee_leaves")
        .select("*, employees(full_name, employee_type)")
        .order("start_date", { ascending: false })
        .limit(500);

    const typeFilter = qs("#func-leaves-filter-type").value;
    if (typeFilter) query = query.eq("leave_type", typeFilter);

    const { data, error } = await query;
    let rows = error || !data ? [] : data;

    const statusFilter = qs("#func-leaves-filter-status").value;
    if (statusFilter) {
        rows = rows.filter((r) => leavePeriodStatus(r) === statusFilter);
    }

    funcLeavesCache = rows;

    if (rows.length === 0) {
        tbody.innerHTML = "";
        emptyEl.classList.remove("hidden");
        return;
    }

    tbody.innerHTML = rows.map(renderFuncLeaveRow).join("");
    wireFuncLeaveActions();
}

function renderFuncLeaveRow(leave) {
    const status = leavePeriodStatus(leave);
    const emp = leave.employees || {};
    return `
    <tr data-leave-id="${leave.id}">
      <td>${escapeHtml(emp.full_name || "—")}</td>
      <td>${leave.leave_type === "ferias" ? "Férias" : "Atestado"}</td>
      <td>${formatDateBR(leave.start_date)}</td>
      <td>${formatDateBR(leave.end_date)}</td>
      <td>${escapeHtml(leave.reason || "—")}</td>
      <td><span class="func-leave-status func-leave-status-${status}">${leaveStatusLabel(status)}</span></td>
      <td class="col-actions">
        <button type="button" class="btn btn-secondary btn-icon" data-edit-leave="${leave.id}">Editar</button>
        <button type="button" class="btn btn-danger btn-icon" data-delete-leave="${leave.id}">Excluir</button>
      </td>
    </tr>`;
}

function wireFuncLeaveActions() {
    qsa("[data-edit-leave]").forEach((btn) => {
        btn.addEventListener("click", () => openFuncLeaveModal(Number(btn.dataset.editLeave)));
    });
    qsa("[data-delete-leave]").forEach((btn) => {
        btn.addEventListener("click", () => confirmDeleteLeave(Number(btn.dataset.deleteLeave)));
    });
}

function confirmDeleteLeave(id) {
    const leave = funcLeavesCache.find((l) => l.id === id);
    const label = leave
        ? `${leave.leave_type === "ferias" ? "férias" : "atestado"} de ${leave.employees?.full_name || "funcionário"}`
        : "este afastamento";
    openDeleteConfirm(label, null, async () => {
        const { error } = await sb.from("employee_leaves").delete().eq("id", id);
        closeModal();
        if (error) {
            showToast("Não foi possível excluir o afastamento.", "error");
            return;
        }
        showToast("Afastamento excluído.");
        await loadFuncLeaves();
        await refreshFuncStatusSummary();
    });
}

function funcEmployeeSelectOptions(selectedId) {
    return funcActiveEmployeesCache
        .map(
            (e) =>
                `<option value="${e.id}" ${e.id === selectedId ? "selected" : ""}>${escapeHtml(e.full_name)} — ${EMPLOYEE_TYPE_LABELS[e.employee_type] || e.employee_type}</option>`,
        )
        .join("");
}

function funcLeaveFormTemplate(leave) {
    const l = leave || { employee_id: null, leave_type: "ferias", start_date: "", end_date: "", reason: "" };
    return `
    <form id="func-leave-form">
      <div class="field">
        <label for="func-l-employee">Funcionário *</label>
        <select id="func-l-employee" required>
          <option value="">Selecione&hellip;</option>
          ${funcEmployeeSelectOptions(l.employee_id)}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="func-l-type">Tipo *</label>
          <select id="func-l-type">
            <option value="ferias" ${l.leave_type === "ferias" ? "selected" : ""}>Férias</option>
            <option value="atestado" ${l.leave_type === "atestado" ? "selected" : ""}>Atestado</option>
          </select>
        </div>
        <div class="field">
          <label for="func-l-start">Data de início *</label>
          <input type="date" id="func-l-start" required value="${l.start_date || ""}">
        </div>
        <div class="field">
          <label for="func-l-end">Data de fim *</label>
          <input type="date" id="func-l-end" required value="${l.end_date || ""}">
        </div>
      </div>
      <div class="field">
        <label for="func-l-reason">Motivo <span style="font-weight:400;color:var(--ink-soft)">(opcional — usado principalmente em atestados)</span></label>
        <textarea id="func-l-reason" rows="2" maxlength="500">${escapeHtml(l.reason || "")}</textarea>
      </div>
      <p id="func-l-error" class="account-status hidden" style="color: var(--stamp-red);"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="func-l-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>`;
}

async function openFuncLeaveModal(id) {
    await ensureActiveEmployeesCache();
    let leave = null;
    if (id) leave = funcLeavesCache.find((l) => l.id === id) || null;

    openModal(id ? "Editar Afastamento" : "Registrar Afastamento", funcLeaveFormTemplate(leave));
    qs("#func-l-cancel").addEventListener("click", closeModal);
    qs("#func-leave-form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const errorEl = qs("#func-l-error");
        errorEl.classList.add("hidden");

        const employeeId = Number(qs("#func-l-employee").value);
        const startDate = qs("#func-l-start").value;
        const endDate = qs("#func-l-end").value;

        if (!employeeId) {
            errorEl.textContent = "Selecione um funcionário.";
            errorEl.classList.remove("hidden");
            return;
        }
        if (!startDate || !endDate || endDate < startDate) {
            errorEl.textContent = "Informe um período válido (fim não pode ser antes do início).";
            errorEl.classList.remove("hidden");
            return;
        }

        const payload = {
            employee_id: employeeId,
            leave_type: qs("#func-l-type").value,
            start_date: startDate,
            end_date: endDate,
            reason: qs("#func-l-reason").value.trim() || null,
        };
        if (!id) payload.created_by = currentUser ? currentUser.id : null;

        const { error } = id
            ? await sb.from("employee_leaves").update(payload).eq("id", id)
            : await sb.from("employee_leaves").insert(payload);

        if (error) {
            errorEl.textContent = "Não foi possível salvar o afastamento.";
            errorEl.classList.remove("hidden");
            return;
        }

        showToast(id ? "Afastamento atualizado." : "Afastamento registrado.");
        closeModal();
        await loadFuncLeaves();
        await refreshFuncStatusSummary();
    });
}

// --- Sub-panel: calendar -----------------------------------------------------

const FUNC_WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const FUNC_MONTH_LABELS = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function isoDate(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoDateFromDate(date) {
    return isoDate(date.getFullYear(), date.getMonth(), date.getDate());
}

// Spreads any row with a start_date/end_date across every ISO date it
// touches within [rangeStart, rangeEnd], tagged with `kind` so the renderer
// can tell leaves and free-form events apart. Keyed by full ISO date (not
// day-of-month) so it works for ranges that span a month boundary — which
// happens as soon as you're not looking at a whole-month view.
function bucketByDate(rows, kind, rangeStart, rangeEnd, byDate) {
    rows.forEach((row) => {
        const from = row.start_date < rangeStart ? rangeStart : row.start_date;
        const to = row.end_date > rangeEnd ? rangeEnd : row.end_date;
        const cursor = new Date(`${from}T00:00:00`);
        const toDate = new Date(`${to}T00:00:00`);
        while (cursor <= toDate) {
            const iso = isoDateFromDate(cursor);
            if (!byDate[iso]) byDate[iso] = [];
            byDate[iso].push({ kind, ...row });
            cursor.setDate(cursor.getDate() + 1);
        }
    });
}

// Computes which days are visible for the current view mode, anchored on
// funcCalendarDate. Month keeps the classic grid (with leading blanks for
// alignment); day/3-day/week are just a run of consecutive days.
function funcCalendarVisibleRange(mode, anchor) {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();

    if (mode === "month") {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const days = [];
        for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
        return {
            days,
            leadingBlanks: new Date(year, month, 1).getDay(),
            label: `${FUNC_MONTH_LABELS[month]} de ${year}`,
        };
    }

    if (mode === "week") {
        const start = new Date(anchor);
        start.setDate(start.getDate() - start.getDay());
        const days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            return d;
        });
        return {
            days,
            leadingBlanks: 0,
            label: `${formatDateBR(isoDateFromDate(days[0]))} – ${formatDateBR(isoDateFromDate(days[6]))}`,
        };
    }

    if (mode === "3day") {
        const days = Array.from({ length: 3 }, (_, i) => {
            const d = new Date(anchor);
            d.setDate(anchor.getDate() + i);
            return d;
        });
        return {
            days,
            leadingBlanks: 0,
            label: `${formatDateBR(isoDateFromDate(days[0]))} – ${formatDateBR(isoDateFromDate(days[2]))}`,
        };
    }

    // day
    return { days: [new Date(anchor)], leadingBlanks: 0, label: formatDateBR(isoDateFromDate(anchor)) };
}

function funcCalendarStep(direction) {
    if (funcCalendarViewMode === "month") funcCalendarDate.setMonth(funcCalendarDate.getMonth() + direction);
    else if (funcCalendarViewMode === "week") funcCalendarDate.setDate(funcCalendarDate.getDate() + direction * 7);
    else if (funcCalendarViewMode === "3day") funcCalendarDate.setDate(funcCalendarDate.getDate() + direction * 3);
    else funcCalendarDate.setDate(funcCalendarDate.getDate() + direction);
}

async function loadFuncCalendar() {
    const grid = qs("#func-calendar-grid");
    grid.innerHTML = `<div class="empty-state">Carregando calendário&hellip;</div>`;

    const { days, leadingBlanks, label } = funcCalendarVisibleRange(funcCalendarViewMode, funcCalendarDate);
    qs("#func-cal-label").textContent = label;

    const rangeStart = isoDateFromDate(days[0]);
    const rangeEnd = isoDateFromDate(days[days.length - 1]);

    // Leaves and events live in different tables — fetch both at once
    // instead of waiting on one before starting the other.
    const [{ data: leavesData, error: leavesError }, { data: eventsData, error: eventsError }] =
        await Promise.all([
            sb
                .from("employee_leaves")
                .select("id, leave_type, start_date, end_date, reason, employees(full_name)")
                .lte("start_date", rangeEnd)
                .gte("end_date", rangeStart),
            sb
                .from("employee_calendar_events")
                .select("id, title, description, start_date, end_date")
                .lte("start_date", rangeEnd)
                .gte("end_date", rangeStart)
                .order("start_date"),
        ]);

    const leaves = leavesError || !leavesData ? [] : leavesData;
    funcCalendarEventsCache = eventsError || !eventsData ? [] : eventsData;

    const byDate = {};
    bucketByDate(leaves, "leave", rangeStart, rangeEnd, byDate);
    bucketByDate(funcCalendarEventsCache, "event", rangeStart, rangeEnd, byDate);

    const todayStr = todayIsoDate();
    const isMonth = funcCalendarViewMode === "month";
    // Fewer days on screen means more room per cell, so show more tags
    // before collapsing into "+N mais".
    const maxTagsShown = isMonth ? 2 : 8;

    let html = "";
    if (isMonth) {
        html += FUNC_WEEKDAY_LABELS.map((w) => `<div class="func-cal-weekday">${w}</div>`).join("");
        for (let i = 0; i < leadingBlanks; i++) {
            html += `<div class="func-cal-day func-cal-day-empty"></div>`;
        }
    }

    days.forEach((d) => {
        const dayIso = isoDateFromDate(d);
        const dayItems = byDate[dayIso] || [];
        const isToday = dayIso === todayStr;
        const shown = dayItems.slice(0, maxTagsShown);
        const rest = dayItems.length - shown.length;
        const tagsHtml =
            shown
                .map((item) => {
                    const label =
                        item.kind === "leave" ? item.employees?.full_name || "—" : item.title;
                    const cls = item.kind === "leave" ? item.leave_type : "evento";
                    return `<span class="func-cal-tag func-cal-tag-${cls}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
                })
                .join("") + (rest > 0 ? `<span class="func-cal-tag-more" data-cal-day="${dayIso}">+${rest} mais</span>` : "");
        const weekdayLabel = isMonth
            ? ""
            : `<span class="func-cal-day-weekday-label">${FUNC_WEEKDAY_LABELS[d.getDay()]}</span>`;

        html += `
      <div class="func-cal-day ${isToday ? "func-cal-day-today" : ""}" data-cal-day="${dayIso}">
        ${weekdayLabel}
        <span class="func-cal-day-num">${d.getDate()}</span>
        <div class="func-cal-day-tags">${tagsHtml}</div>
      </div>`;
    });

    grid.className = `func-calendar-grid${isMonth ? "" : ` func-cal-grid-${funcCalendarViewMode}`}`;
    grid.innerHTML = html;

    qsa("[data-cal-day]", grid).forEach((el) => {
        el.addEventListener("click", () => showFuncCalendarDayModal(el.dataset.calDay, byDate));
    });

    renderFuncEventsList();
}

function showFuncCalendarDayModal(dayIso, byDate) {
    const items = byDate[dayIso] || [];
    const bodyHtml =
        items.length === 0
            ? `<p class="empty-state">Nada registrado neste dia.</p>`
            : `<ul style="margin:0; padding-left: 18px;">${items
                .map((item) => {
                    if (item.kind === "leave") {
                        return `<li style="margin-bottom:6px;">${escapeHtml(item.employees?.full_name || "—")} — ${item.leave_type === "ferias" ? "Férias" : "Atestado"} (${formatDateBR(item.start_date)} a ${formatDateBR(item.end_date)})</li>`;
                    }
                    return `<li style="margin-bottom:6px;"><span class="func-event-type-tag">Evento</span> ${escapeHtml(item.title)} (${formatDateBR(item.start_date)} a ${formatDateBR(item.end_date)})</li>`;
                })
                .join("")}</ul>`;
    openModal(`Em ${formatDateBR(dayIso)}`, bodyHtml);
}

// --- Calendar events & reminders (free-form, not tied to an employee) ------

function renderFuncEventsList() {
    const tbody = qs("#func-events-tbody");
    const emptyEl = qs("#func-events-empty");
    if (!tbody) return;

    if (funcCalendarEventsCache.length === 0) {
        tbody.innerHTML = "";
        emptyEl.classList.remove("hidden");
        return;
    }
    emptyEl.classList.add("hidden");
    tbody.innerHTML = funcCalendarEventsCache
        .map(
            (ev) => `
      <tr data-event-id="${ev.id}">
        <td>${escapeHtml(ev.title)}</td>
        <td>${ev.start_date === ev.end_date ? formatDateBR(ev.start_date) : `${formatDateBR(ev.start_date)} a ${formatDateBR(ev.end_date)}`}</td>
        <td>${escapeHtml(ev.description || "—")}</td>
        <td class="col-actions">
          <button type="button" class="btn btn-secondary btn-icon" data-edit-event="${ev.id}">Editar</button>
          <button type="button" class="btn btn-danger btn-icon" data-delete-event="${ev.id}">Excluir</button>
        </td>
      </tr>`,
        )
        .join("");

    qsa("[data-edit-event]").forEach((btn) => {
        btn.addEventListener("click", () => openFuncEventModal(Number(btn.dataset.editEvent)));
    });
    qsa("[data-delete-event]").forEach((btn) => {
        btn.addEventListener("click", () => confirmDeleteEvent(Number(btn.dataset.deleteEvent)));
    });
}

function funcEventFormTemplate(event) {
    const ev = event || { title: "", description: "", start_date: todayIsoDate(), end_date: todayIsoDate() };
    return `
    <form id="func-event-form">
      <div class="field">
        <label for="func-e-title">Título *</label>
        <input type="text" id="func-e-title" maxlength="150" required value="${escapeHtml(ev.title)}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="func-e-start">Início *</label>
          <input type="date" id="func-e-start" required value="${ev.start_date}">
        </div>
        <div class="field">
          <label for="func-e-end">Fim *</label>
          <input type="date" id="func-e-end" required value="${ev.end_date}">
        </div>
      </div>
      <div class="field">
        <label for="func-e-desc">Descrição</label>
        <textarea id="func-e-desc" rows="2" maxlength="500">${escapeHtml(ev.description || "")}</textarea>
      </div>
      <p id="func-e-error" class="account-status hidden" style="color: var(--stamp-red);"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="func-e-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>`;
}

function openFuncEventModal(id) {
    const event = id ? funcCalendarEventsCache.find((e) => e.id === id) || null : null;
    openModal(id ? "Editar Evento/Lembrete" : "Novo Evento/Lembrete", funcEventFormTemplate(event));
    qs("#func-e-cancel").addEventListener("click", closeModal);
    qs("#func-event-form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const errorEl = qs("#func-e-error");
        errorEl.classList.add("hidden");

        const title = qs("#func-e-title").value.trim();
        const startDate = qs("#func-e-start").value;
        const endDate = qs("#func-e-end").value;

        if (!title) {
            errorEl.textContent = "Informe um título para o evento.";
            errorEl.classList.remove("hidden");
            return;
        }
        if (!startDate || !endDate || endDate < startDate) {
            errorEl.textContent = "Informe um período válido (fim não pode ser antes do início).";
            errorEl.classList.remove("hidden");
            return;
        }

        const payload = {
            title,
            description: qs("#func-e-desc").value.trim() || null,
            start_date: startDate,
            end_date: endDate,
        };
        if (!id) payload.created_by = currentUser ? currentUser.id : null;

        const { error } = id
            ? await sb.from("employee_calendar_events").update(payload).eq("id", id)
            : await sb.from("employee_calendar_events").insert(payload);

        if (error) {
            errorEl.textContent = "Não foi possível salvar o evento.";
            errorEl.classList.remove("hidden");
            return;
        }

        showToast(id ? "Evento atualizado." : "Evento registrado.");
        closeModal();
        await loadFuncCalendar();
    });
}

function confirmDeleteEvent(id) {
    const event = funcCalendarEventsCache.find((e) => e.id === id);
    openDeleteConfirm(event ? event.title : "este evento", null, async () => {
        const { error } = await sb.from("employee_calendar_events").delete().eq("id", id);
        closeModal();
        if (error) {
            showToast("Não foi possível excluir o evento.", "error");
            return;
        }
        showToast("Evento excluído.");
        await loadFuncCalendar();
    });
}

// --- Wiring & entry point ----------------------------------------------------

function onFuncionariosSubtabChange(target) {
    switch (target) {
        case "func-list":
            loadFuncList();
            break;
        case "func-presenca":
            loadFuncPresenca();
            break;
        case "func-afastamentos":
            loadFuncLeaves();
            break;
        case "func-calendario":
            loadFuncCalendar();
            break;
    }
}

function wireFuncionariosEvents() {
    let searchDebounce = null;
    qs("#func-search").addEventListener("input", (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            funcSearchTerm = e.target.value;
            funcPage = 0;
            loadFuncList();
        }, 280);
    });
    qs("#func-filter-type").addEventListener("change", (e) => {
        funcFilterType = e.target.value;
        funcPage = 0;
        loadFuncList();
    });
    qs("#func-filter-active").addEventListener("change", (e) => {
        funcFilterActive = e.target.value;
        funcPage = 0;
        loadFuncList();
    });
    qs("#func-prev").addEventListener("click", () => {
        if (funcPage > 0) {
            funcPage--;
            loadFuncList();
        }
    });
    qs("#func-next").addEventListener("click", () => {
        funcPage++;
        loadFuncList();
    });
    qs("#btn-new-func").addEventListener("click", () => openFuncEmployeeModal(null));

    qs("#func-presenca-date").addEventListener("change", loadFuncPresenca);
    qs("#func-presenca-filter-type").addEventListener("change", loadFuncPresenca);
    qs("#func-presenca-today").addEventListener("click", () => {
        qs("#func-presenca-date").value = todayIsoDate();
        loadFuncPresenca();
    });
    qs("#btn-save-presenca").addEventListener("click", saveFuncPresenca);

    qs("#func-leaves-filter-type").addEventListener("change", loadFuncLeaves);
    qs("#func-leaves-filter-status").addEventListener("change", loadFuncLeaves);
    qs("#btn-new-leave").addEventListener("click", () => openFuncLeaveModal(null));

    qs("#func-cal-prev").addEventListener("click", () => {
        funcCalendarStep(-1);
        loadFuncCalendar();
    });
    qs("#func-cal-next").addEventListener("click", () => {
        funcCalendarStep(1);
        loadFuncCalendar();
    });
    qs("#func-cal-today").addEventListener("click", () => {
        funcCalendarDate = new Date();
        if (funcCalendarViewMode === "month") funcCalendarDate.setDate(1);
        loadFuncCalendar();
    });
    qsa(".func-cal-view-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            funcCalendarViewMode = btn.dataset.calView;
            qsa(".func-cal-view-btn").forEach((b) => b.classList.toggle("active", b === btn));
            funcCalendarDate = new Date();
            if (funcCalendarViewMode === "month") funcCalendarDate.setDate(1);
            loadFuncCalendar();
        });
    });
    qs("#btn-new-cal-event").addEventListener("click", () => openFuncEventModal(null));
}

async function loadFuncionarios() {
    if (!funcInitialized) {
        funcInitialized = true;
        wireFuncionariosEvents();
    }
    // Independent requests — run together instead of one after another.
    await Promise.all([ensureActiveEmployeesCache(), refreshFuncStatusSummary()]);
    await loadFuncList();
}