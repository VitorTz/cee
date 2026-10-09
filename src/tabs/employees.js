// =============================================================================
// QUADRO DE FUNCIONÁRIOS
// =============================================================================
// Registro completo de carteiros (internos/externos), terceirizados
// (internos/externos), motoristas e profissionais da limpeza. Toda a aba (e
// as tabelas por trás dela: employees, employee_attendance, employee_leaves)
// só é visível/editável por admin ou supervisor — reforçado tanto aqui
// (esconder a aba) quanto no banco via RLS (ver employees_schema.sql).

import { currentUser, sb } from "../supabase-client.js";
import { showToast, openModal, closeModal, openDeleteConfirm } from "../ui.js";
import { qs, qsa, escapeHtml, todayIsoDate } from "../utils.js";


const EMPLOYEE_TYPE_LABELS = {
    terceirizado_interno: "Terceirizado Interno",
    terceirizado_externo: "Terceirizado Externo"
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

export function onFuncionariosSubtabChange(target) {
    switch (target) {
        case "func-list":
            loadFuncList();
            break;
        case "func-presenca":
            loadFuncPresenca();
            break;
        case "func-upload-ponto":
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
    qs("#btn-process-ponto")?.addEventListener("click", processPontoFile);
}

export async function loadFuncionarios() {
    if (!funcInitialized) {
        funcInitialized = true;
        wireFuncionariosEvents();
    }
    // Independent requests — run together instead of one after another.
    await Promise.all([ensureActiveEmployeesCache(), refreshFuncStatusSummary()]);
    await loadFuncList();
}


// =============================================================================
// UPLOAD E PROCESSAMENTO DE PONTO ELETRÔNICO (AFD)
// =============================================================================

let pontoParsedData = []; // Armazena o resultado da extração do arquivo atual
let currentAfdText = ""; // Armazena o texto bruto do AFD para geração de Excel

/**
 * Lê o conteúdo em texto do AFD e normaliza os dados.
 */
function parseAfdRecords(fileContent) {
    const employees = {};
    const lines = fileContent.split(/\r?\n/);

    for (const line of lines) {
        if (line.length < 10) continue;

        const recordType = line[9];

        // Type 5: Employee metadata (Registration/Alteration)
        if (recordType === '5') {
            const operation = line[34];
            const workerId = line.substring(35, 47);
            const name = line.substring(47, 99).trim();

            if (!employees[workerId]) {
                employees[workerId] = { id: workerId, name: name, clockRecords: [] };
            } else if (operation === 'A' || operation === 'I') {
                employees[workerId].name = name;
            }
        }

        // Type 3: Clock in/out records
        if (recordType === '3') {
            const timestamp = line.substring(10, 34); // Format: 2026-08-14T12:05:00-0300
            const workerId = line.substring(34, 46);

            if (!employees[workerId]) {
                employees[workerId] = { id: workerId, name: "Unknown", clockRecords: [] };
            }
            employees[workerId].clockRecords.push(timestamp);
        }
    }

    // Returns only employees with at least one record, sorted alphabetically by name
    return Object.values(employees)
        .filter(emp => emp.clockRecords.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}


/**
 * Função auxiliar para converter milissegundos no formato legível "Xh Ym".
 * Exemplo: 2 horas e 48 minutos -> "2h 48m".
 */
function formatMsToReadableTime(ms) {
    const isNegative = ms < 0;
    const absMs = Math.abs(ms);
    const totalMinutes = Math.floor(absMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    const sign = isNegative ? "-" : "";
    return `${sign}${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * Formats the employee's clock records, grouping them by month.
 * Calculates worked hours and expected hours (8h Mon-Fri, 4h Sat).
 * 
 * @param {Object} emp - The employee object containing clock records.
 * @param {boolean} onlyLatestMonth - If true, returns only the most recent month's data.
 */
function formatPontoForEmployee(emp, onlyLatestMonth = false) {
    const SEP = '------------------';
    const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    const dayOfWeekNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
 
    let text = `*REGISTRO DE PONTO*\n`;
    text += `Funcionário: ${emp.name}\n`;
    text += `ID: ${emp.id}\n`;
 
    // Sort records chronologically
    const sortedRecords = [...emp.clockRecords].sort((a, b) => new Date(a) - new Date(b));
 
    const months = {};
 
    // Group records by Month and Day
    sortedRecords.forEach(isoString => {
        const dateObj = new Date(isoString);
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
 
        const monthKey = `${yyyy}-${mm}`;
        const dateKey = `${yyyy}-${mm}-${dd}`;
 
        if (!months[monthKey]) {
            months[monthKey] = {
                days: {},
                hasMissingPunch: false,
                missingPunchDates: []
            };
        }
        if (!months[monthKey].days[dateKey]) {
            months[monthKey].days[dateKey] = [];
        }
        months[monthKey].days[dateKey].push(isoString);
    });
 
    let monthKeys = Object.keys(months).sort();
 
    // Filter to keep only the most recent month if requested
    if (onlyLatestMonth && monthKeys.length > 0) {
        monthKeys = [monthKeys[monthKeys.length - 1]];
    }
 
    // Iterate and process data for each month
    monthKeys.forEach(monthKey => {
        const [yyyy, mm] = monthKey.split('-');
        const monthName = monthNames[parseInt(mm, 10) - 1];
 
        text += `\n${SEP}\n`;
        text += `*${monthName.toUpperCase()} / ${yyyy}*\n`;
        text += `${SEP}\n`;
 
        const monthData = months[monthKey];
        let totalWorkedMs = 0;
        let expectedMs = 0; // Calculated iterating only over worked days
 
        const sortedDates = Object.keys(monthData.days).sort();
 
        // Process clock records for each effectively worked/registered day
        sortedDates.forEach(date => {
            const dayRecords = monthData.days[date];
            const [, m, d] = date.split('-');
 
            const dayObj = new Date(`${date}T00:00:00`);
            const dayOfWeek = dayObj.getDay();
            const dowName = dayOfWeekNames[dayOfWeek];
 
            // Add expected workload ONLY for days the employee registered a punch
            if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                expectedMs += (8 * 3600000); 
            } else if (dayOfWeek === 6) {
                expectedMs += (4 * 3600000); 
            }
 
            // Extract only the HH:mm portion from the timestamp
            const times = dayRecords.map(iso => iso.split('T')[1].substring(0, 5));
 
            // Check if the day ended with incomplete punches (forgot to clock out/in)
            const dayMissingPunch = (dayRecords.length % 2 !== 0);
            if (dayMissingPunch) {
                monthData.hasMissingPunch = true;
                monthData.missingPunchDates.push(`${d}/${m}`);
            }
 
            // Sum milliseconds by calculating each In/Out pair
            let dayMs = 0;
            for (let i = 0; i < dayRecords.length - 1; i += 2) {
                const t1 = new Date(dayRecords[i]);
                const t2 = new Date(dayRecords[i + 1]);
                dayMs += (t2 - t1);
            }
 
            totalWorkedMs += dayMs;
            const dayReadable = formatMsToReadableTime(dayMs);
 
            // Day header + one In-Out pair per line
            text += `\n*${d}/${m}* | ${dowName} | ${dayReadable}${dayMissingPunch ? ' (!)' : ''}\n`;
            for (let i = 0; i < times.length; i += 2) {
                if (i + 1 < times.length) {
                    // "às" em vez de "-": o WhatsApp sublinha números separados por hífen
                    text += `  ${times[i]} às ${times[i + 1]}\n`;
                } else {
                    text += `  ${times[i]} (sem saída)\n`;
                }
            }
        });
 
        // Calculate the Final Month Balance
        const balanceMs = totalWorkedMs - expectedMs;
 
        let balanceText = "";
        if (balanceMs > 0) {
            balanceText = `*Saldo:* +${formatMsToReadableTime(balanceMs)}\n_(horas extras)_`;
        } else if (balanceMs < 0) {
            balanceText = `*Saldo:* ${formatMsToReadableTime(balanceMs)}\n_(faltaram horas)_`;
        } else {
            balanceText = `*Saldo:* 0h 00m\n_(carga cumprida)_`;
        }
 
        text += `\n${SEP}\n`;
        text += `*RESUMO DO MÊS*\n`;
        text += `Trabalhadas: ${formatMsToReadableTime(totalWorkedMs)}\n`;
        text += `Esperadas: ${formatMsToReadableTime(expectedMs)}\n`;
        text += `${balanceText}\n`;
 
        if (monthData.hasMissingPunch) {
            text += `\n*(!) Ponto incompleto em:*\n`;
            text += `${monthData.missingPunchDates.join(', ')}\n`;
            text += `_Horas desses dias não foram totalmente computadas._\n`;
        }
    });
 
    return text;
}



/**
 * Processa o arquivo selecionado no input e renderiza a tabela.
 */
function processPontoFile() {
    const fileInput = qs('#ponto-file-upload');
    const file = fileInput.files[0];
    
    if (!file) {
        showToast("Selecione um arquivo de ponto (.txt) primeiro.", "error");
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        currentAfdText = content; // Salva para uso no ExcelJS
        pontoParsedData = parseAfdRecords(content);
        renderPontoResults();
        showToast(`Arquivo processado! ${pontoParsedData.length} funcionários encontrados.`);
    };
    reader.readAsText(file);
}


/**
 * Renderiza os dados lidos na tabela HTML.
 */
function renderPontoResults() {
    const tbody = qs("#ponto-results-tbody");
    
    if (pontoParsedData.length === 0) {
        tbody.innerHTML = `<tr class="empty-state"><td colspan="4">Nenhum registro de ponto encontrado.</td></tr>`;
        return;
    }

    tbody.innerHTML = pontoParsedData.map(emp => `
        <tr>
            <td class="zip-code-cell">${escapeHtml(emp.id)}</td>
            <td style="font-weight: 600;">${escapeHtml(emp.name)}</td>
            <td><span class="count-badge">${emp.clockRecords.length}</span></td>
            <td class="col-actions">
                <button type="button" class="btn btn-secondary btn-icon" data-share-ponto="${emp.id}">
                    <svg style="margin-right:4px;" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                       <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                    </svg> Compartilhar
                </button>
            </td>
        </tr>
    `).join("");

    // Adiciona listener para os botões de compartilhamento
    qsa("[data-share-ponto]").forEach(btn => {
        btn.addEventListener("click", () => openPontoShareModal(btn.dataset.sharePonto));
    });
}

/**
 * Abre o modal de compartilhamento mesclando os layouts de texto padrão
 * com a nova seção focada em geração e envio de planilhas de Excel via API Nativa.
 */
function openPontoShareModal(workerId) {
    const emp = pontoParsedData.find(e => e.id === workerId);
    if (!emp) return;

    const dbMatchedEmp = funcActiveEmployeesCache?.find(e => e.full_name.toUpperCase() === emp.name.toUpperCase());
    const defaultPhone = dbMatchedEmp ? (dbMatchedEmp.phone || "") : "";

    const modalHtml = `
      <div class="field">
        <label for="ponto-share-period">Período a compartilhar no Texto</label>
        <select id="ponto-share-period">
          <option value="latest">Apenas o mês mais recente</option>
          <option value="all">Todos os registros do arquivo</option>
        </select>
      </div>
      <div class="field">
        <label>Visualização do Relatório em Texto</label>
        <textarea id="ponto-share-text" rows="6" readonly style="font-family: var(--font-mono); font-size: 0.85rem;"></textarea>
      </div>
      <div class="field" id="wa-fallback-field">
        <label for="ponto-share-phone">Telefone / WhatsApp (Para enviar apenas o Texto no WhatsApp Web)</label>
        <div style="display: flex; gap: 8px;">
            <input type="text" id="ponto-share-phone" value="${escapeHtml(defaultPhone)}" placeholder="Ex: 48999999999" style="flex: 1;">
            <button type="button" class="btn btn-primary" id="btn-send-wa">Enviar Texto</button>
        </div>
      </div>
      
      <div class="field" style="margin-top: 24px; padding-top: 16px; border-top: 2px dashed var(--paper-line);">
        <label>Exportar Planilha Completa (.xlsx)</label>
        <p class="field-hint" style="margin-bottom: 12px;">Gera a planilha formatada com fórmulas de horas e campos de alerta automáticos.</p>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary" id="btn-download-xlsx">📥 Baixar Excel</button>
            <button type="button" class="btn btn-primary" id="btn-share-xlsx-native" style="display: none;">
              <svg style="margin-right:6px;" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle>
                 <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg> Enviar Excel via WhatsApp (Celular)
            </button>
        </div>
      </div>
    `;

    openModal(`Compartilhar: ${emp.name}`, modalHtml);

    const periodSelect = qs("#ponto-share-period");
    const textArea = qs("#ponto-share-text");

    const updateTextPreview = () => {
        const onlyLatest = periodSelect.value === "latest";
        textArea.value = formatPontoForEmployee(emp, onlyLatest);
    };

    updateTextPreview();
    periodSelect.addEventListener("change", updateTextPreview);

    // Evento de Envio do WhatsApp Web (apenas texto)
    qs("#btn-send-wa").addEventListener("click", () => {
        const reportText = textArea.value;
        const phone = qs("#ponto-share-phone").value.replace(/\D/g, "");
        if (!phone || phone.length < 10) {
            showToast("Informe um número de telefone válido com DDD.", "error");
            return;
        }
        const waPhone = phone.startsWith("55") ? phone : `55${phone}`;
        const encodedMsg = encodeURIComponent(reportText);
        window.open(`https://wa.me/${waPhone}?text=${encodedMsg}`, "_blank");
    });

    // Evento para Download físico da planilha .xlsx
    qs("#btn-download-xlsx").addEventListener("click", async () => {
        const btn = qs("#btn-download-xlsx");
        try {
            btn.disabled = true;
            btn.innerText = "Gerando...";
            const { blob, filename } = await createExcelForEmployee(emp.id);
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
        } catch(err) {
            showToast("Erro ao gerar o Excel.", "error");
            console.error(err);
        } finally {
            btn.disabled = false;
            btn.innerText = "📥 Baixar Excel";
        }
    });

    // Checagem silenciosa e injeção do Botão Nativo para Mobile
    const btnShareXlsx = qs("#btn-share-xlsx-native");
    try {
        if (navigator.canShare && navigator.canShare({ files: [new File([''], 't.txt', {type: 'text/plain'})] })) {
            btnShareXlsx.style.display = "inline-flex";
            btnShareXlsx.addEventListener("click", async () => {
                try {
                    btnShareXlsx.disabled = true;
                    btnShareXlsx.innerHTML = "Gerando Planilha...";
                    
                    const { blob, filename } = await createExcelForEmployee(emp.id);
                    const file = new File([blob], filename, { type: blob.type });
                    
                    if (navigator.canShare({ files: [file] })) {
                        await navigator.share({
                            title: `Espelho de Ponto - ${emp.name}`,
                            files: [file]
                        });
                    } else {
                        showToast("O sistema não suporta anexar arquivos desta forma.", "error");
                    }
                } catch (err) {
                    console.log("Compartilhamento cancelado.", err);
                } finally {
                    btnShareXlsx.disabled = false;
                    btnShareXlsx.innerHTML = `<svg style="margin-right:6px;" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg> Enviar Excel via WhatsApp (Celular)`;
                }
            });
        }
    } catch(e) {
        // Fallback silencioso (navegador desktop clássico que recusa API Share com arquivos)
    }
}

// =============================================================================
// GERAÇÃO DE ESPELHO DE PONTO EM EXCEL (.xlsx)
// =============================================================================

function parseAFDForExcel(texto) {
    const linhas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
    const funcionarios = new Map();
    const marcacoes = new Map();
    let empregador = null;

    const reMarc = /^(\d{9})3(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}[-+]\d{4}(\d{12})/;
    const reFunc = /^(\d{9})5\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{4}([IAE])(\d{12})(.{52})/;
    const reEmpr = /^\d{10}\d(\d{14})\d*?([A-Za-zÀ-ú][^\s]*(?: [^\s]+)*?)\s{3,}/;

    for (const l of linhas) {
        const tipo = l[9];
        if (tipo === '1' && !empregador) {
            const m = reEmpr.exec(l);
            if (m) empregador = { cnpj: m[1], razaoSocial: m[2].trim() };
        } else if (tipo === '3') {
            const m = reMarc.exec(l);
            if (!m) continue;
            const [, , data, hora, pis] = m;
            if (!marcacoes.has(pis)) marcacoes.set(pis, []);
            marcacoes.get(pis).push({ data, hora });
        } else if (tipo === '5') {
            const m = reFunc.exec(l);
            if (!m) continue;
            const [, , op, pis, nome] = m;
            const atual = funcionarios.get(pis) || { pis, nome: '', ultimaOp: op };
            atual.nome = nome.trim() || atual.nome;
            atual.ultimaOp = op;
            funcionarios.set(pis, atual);
        }
    }
    return { empregador, funcionarios, marcacoes };
}

const minDe = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fracDia = (hhmm) => minDe(hhmm) / 1440;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const nomeTitulo = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const fmtCNPJ = (c) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

function distribuirMarcacoes(horas) {
    const n = horas.length;
    if (n === 0) return [null, null, null, null];
    if (n === 1) return [horas[0], null, null, null];
    if (n === 2) return [horas[0], null, null, horas[1]];
    if (n === 3) return [horas[0], horas[1], null, horas[2]];
    if (n === 4) return horas;
    return [horas[0], horas[1], horas[2], horas[n - 1]];
}

function nomeAbaUnico(base, usados) {
    let nome = base.replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Empregado';
    let final = nome;
    for (let i = 2; usados.has(final.toLowerCase()); i++) {
        const suf = ` (${i})`;
        final = nome.slice(0, 31 - suf.length) + suf;
    }
    usados.add(final.toLowerCase());
    return final;
}

function montarAba(wb, emp, diasMarcados, cfg) {
    const { ano, mes, empregador, jornadaSemanaMin, sabadoMin, almocoMin, ultimaData } = cfg;
    const ws = wb.addWorksheet(cfg.nomeAba, {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
        views: [{ state: 'frozen', xSplit: 2, ySplit: 9 }],
    });
    const F = 'Arial';
    const f = (o = {}) => ({ name: F, size: 10, ...o });
    const borda = { style: 'thin', color: { argb: 'FFBFBFBF' } };
    const box = { top: borda, left: borda, bottom: borda, right: borda };
    const centro = { horizontal: 'center', vertical: 'middle' };

    const MESES = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
    ws.getCell('A1').value = `ESPELHO DE PONTO - ${MESES[mes - 1]}/${ano}`;
    ws.getCell('A1').font = f({ bold: true, size: 14 });
    ws.getCell('A2').value = 'Empregado:';
    ws.getCell('A2').font = f({ bold: true });
    ws.getCell('C2').value = `${nomeTitulo(emp.nome)}   |   PIS ${emp.pis}`;
    ws.getCell('C2').font = f();
    
    if (empregador) {
        ws.getCell('A3').value = `Empregador: ${empregador.razaoSocial} - CNPJ ${fmtCNPJ(empregador.cnpj)}. Fonte: AFD.`;
        ws.getCell('A3').font = f({ italic: true, size: 9 });
    }

    const params = [
        [4, 'Jornada dias úteis (seg-sex)', jornadaSemanaMin / 1440, 'h:mm'],
        [5, 'Jornada sábado', sabadoMin / 1440, 'h:mm'],
        [6, 'Intervalo de almoço (seg-sex)', almocoMin / 1440, 'h:mm'],
        [7, 'Última data coberta pelo AFD', ultimaData, 'dd/mm/yyyy'],
    ];
    for (const [r, rotulo, v, nf] of params) {
        ws.getCell(r, 1).value = rotulo;
        ws.getCell(r, 1).font = f({ bold: true });
        const c = ws.getCell(r, 3);
        c.value = v; c.numFmt = nf;
        c.font = f({ color: { argb: 'FF0000FF' } });
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        c.border = box; c.alignment = centro;
    }

    const HR = 9;
    const heads = ['Data','Dia','Entrada','Saída almoço','Volta almoço','Saída','Nº marcações','Horas trabalhadas','Jornada esperada','Saldo (min)','Status','Observação'];
    heads.forEach((h, i) => {
        const c = ws.getCell(HR, i + 1);
        c.value = h;
        c.font = f({ bold: true, color: { argb: 'FFFFFFFF' } });
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
        c.alignment = { ...centro, wrapText: true }; c.border = box;
    });
    ws.getRow(HR).height = 30;

    const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const first = HR + 1;
    const last = first + diasNoMes - 1;
    const azul = { argb: 'FF0000FF' };

    for (let d = 1; d <= diasNoMes; d++) {
        const r = first + d - 1;
        const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const horas = diasMarcados.get(iso) || [];
        const slots = distribuirMarcacoes(horas);

        ws.getCell(r, 1).value = utc(ano, mes, d);
        ws.getCell(r, 1).numFmt = 'dd/mm/yyyy';
        ws.getCell(r, 2).value = { formula: `CHOOSE(WEEKDAY(A${r}),"Dom","Seg","Ter","Qua","Qui","Sex","Sáb")` };
        slots.forEach((h, j) => {
            const c = ws.getCell(r, 3 + j);
            if (h) c.value = fracDia(h);
            c.numFmt = 'hh:mm';
            c.font = f({ color: azul });
        });
        ws.getCell(r, 7).value = { formula: `COUNT(C${r}:F${r})` };
        ws.getCell(r, 8).value = { formula:
            `IF(A${r}>$C$7,"",IF(AND(ISNUMBER(C${r}),ISNUMBER(D${r}),ISNUMBER(E${r}),ISNUMBER(F${r})),(D${r}-C${r})+(F${r}-E${r}),` +
            `IF(AND(ISNUMBER(C${r}),ISNUMBER(F${r})),F${r}-C${r}-IF(WEEKDAY(A${r})=7,0,$C$6),0)))` };
        ws.getCell(r, 8).numFmt = '[h]:mm';
        ws.getCell(r, 9).value = { formula: `IF(A${r}>$C$7,"",IF(WEEKDAY(A${r})=1,0,IF(WEEKDAY(A${r})=7,$C$5,$C$4)))` };
        ws.getCell(r, 9).numFmt = '[h]:mm';
        ws.getCell(r, 10).value = { formula: `IF(A${r}>$C$7,"",ROUND((H${r}-I${r})*1440,0))` };
        ws.getCell(r, 10).numFmt = '+0;-0;0';
        ws.getCell(r, 11).value = { formula:
            `IF(A${r}>$C$7,"Fora do AFD",IF(AND(I${r}=0,G${r}=0),"Folga",IF(G${r}=0,"SEM MARCAÇÃO",` +
            `IF(MOD(G${r},2)=1,"Marcação ímpar",IF(AND(G${r}=2,WEEKDAY(A${r})<>7),"Almoço não marcado","OK")))))` };

        let obs = '';
        if (horas.length > 4) obs = `${horas.length} marcações no dia: ${horas.join(', ')}.`;
        ws.getCell(r, 12).value = obs;

        const domingo = new Date(Date.UTC(ano, mes - 1, d)).getUTCDay() === 0;
        for (let c = 1; c <= 12; c++) {
            const cell = ws.getCell(r, c);
            cell.border = box;
            if (!(c >= 3 && c <= 6)) cell.font = f(c === 12 ? { size: 9 } : {});
            cell.alignment = c === 12 ? { vertical: 'middle', wrapText: true } : centro;
            if (domingo) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
        }
    }

    const tr = last + 1;
    ws.getCell(tr, 1).value = 'TOTAL';
    [[7, 'G'], [8, 'H'], [9, 'I'], [10, 'J']].forEach(([c, L]) => {
        ws.getCell(tr, c).value = { formula: `SUM(${L}${first}:${L}${last})` };
    });
    ws.getCell(tr, 8).numFmt = '[h]:mm';
    ws.getCell(tr, 9).numFmt = '[h]:mm';
    ws.getCell(tr, 10).numFmt = '+0;-0;0';
    for (let c = 1; c <= 12; c++) {
        const cell = ws.getCell(tr, c);
        cell.font = f({ bold: true }); cell.border = box;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
        if (c > 1) cell.alignment = centro;
    }

    const s = tr + 2;
    ws.getCell(s, 1).value = 'RESUMO';
    ws.getCell(s, 1).font = f({ bold: true });
    const resumo = [
        ['Saldo do período (hh:mm)', `IF(J${tr}<0,"-","+")&TEXT(ABS(J${tr})/1440,"[h]:mm")`],
        ['Dias sem marcação', `COUNTIF(K${first}:K${last},"SEM MARCAÇÃO")`],
        ['Dias com marcação ímpar', `COUNTIF(K${first}:K${last},"Marcação ímpar")`],
        ['Dias com almoço não marcado', `COUNTIF(K${first}:K${last},"Almoço não marcado")`],
    ];
    resumo.forEach(([rot, form], i) => {
        ws.getCell(s + 1 + i, 1).value = rot;
        ws.getCell(s + 1 + i, 1).font = f();
        const c = ws.getCell(s + 1 + i, 5);
        c.value = { formula: form }; c.font = f({ bold: true }); c.alignment = centro;
    });

    const n = s + resumo.length + 2;
    ws.getCell(n, 1).value = 'LEGENDA E PREMISSAS';
    ws.getCell(n, 1).font = f({ bold: true });
    [
        'Fonte azul = dado digitado (marcações do AFD e parâmetros); preto = fórmula. Células amarelas = parâmetros editáveis.',
        'Com 4 marcações: horas = (saída almoço - entrada) + (saída - volta). Se faltar alguma do almoço: saída - entrada - intervalo (seg-sex) ou sem intervalo (sábado).',
        'Com 3 marcações, a 3ª é tratada como saída final e a volta do almoço fica vazia (ajuste manual). Marcações idênticas no mesmo minuto são unificadas.',
        'Feriados: sobrescreva manualmente a coluna Jornada esperada com 0:00.',
    ].forEach((t, i) => {
        ws.getCell(n + 1 + i, 1).value = t;
        ws.getCell(n + 1 + i, 1).font = f({ size: 9 });
    });

    [12, 6, 10, 12, 12, 10, 11, 12, 12, 11, 20, 60].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    return ws;
}

/**
 * Função principal para gerar o Excel de um único empregado no browser.
 */
async function createExcelForEmployee(workerId) {
    const { empregador, funcionarios, marcacoes } = parseAFDForExcel(currentAfdText);
    
    let todasDatas = [];
    for (const lista of marcacoes.values()) todasDatas = todasDatas.concat(lista.map((m) => m.data));
    if (!todasDatas.length) throw new Error('Nenhuma marcação encontrada no AFD.');
    
    const mesRef = todasDatas.reduce((a, b) => (a > b ? a : b)).slice(0, 7);
    const [ano, mes] = mesRef.split('-').map(Number);
    const datasDoMes = todasDatas.filter((d) => d.startsWith(mesRef));
    const ultimaIso = datasDoMes.length ? datasDoMes.reduce((a, b) => (a > b ? a : b)) : `${mesRef}-01`;
    const [uy, um, ud] = ultimaIso.split('-').map(Number);
    const ultimaData = utc(uy, um, ud);

    const emp = { 
        pis: workerId, 
        nome: (funcionarios.get(workerId) || {}).nome || '(não cadastrado no AFD)' 
    };

    const dias = new Map();
    for (const m of (marcacoes.get(workerId) || [])) {
        if (!m.data.startsWith(mesRef)) continue;
        if (!dias.has(m.data)) dias.set(m.data, []);
        dias.get(m.data).push(m.hora);
    }
    for (const [d, hs] of dias) dias.set(d, [...new Set(hs)].sort());

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEE App';
    wb.calcProperties.fullCalcOnLoad = true;
    
    const nomeAba = nomeAbaUnico(`${emp.pis} ${nomeTitulo(emp.nome)}`, new Set());
    
    montarAba(wb, emp, dias, {
        ano, mes, empregador, jornadaSemanaMin: 480, sabadoMin: 240, almocoMin: 60, ultimaData, nomeAba
    });
    
    const buffer = await wb.xlsx.writeBuffer();
    const safeName = nomeTitulo(emp.nome).replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_');
    const filename = `espelho_${mesRef}_${emp.pis}_${safeName}.xlsx`;
    
    return {
        blob: new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        filename
    };
}