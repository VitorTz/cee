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
    terceirizado_interno: "Terceirizado Interno",
    terceirizado_externo: "Terceirizado Externo",
    motorista: "Motorista",
    limpeza: "Limpeza",
};

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
let funcActiveEmployeesCache = []; // [{id, full_name, employee_type}] for selects

let funcCalendarDate = new Date();
funcCalendarDate.setDate(1);

// --- Helpers ---------------------------------------------------------------

function formatDateBR(isoDate) {
    if (!isoDate) return "—";
    const [y, m, d] = isoDate.split("-");
    return `${d}/${m}/${y}`;
}

function formatCPF(digits) {
    if (!digits) return "";
    const clean = digits.replace(/\D/g, "");
    if (clean.length !== 11) return digits;
    return clean.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
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
    await refreshFuncStatusMap();

    const activeCountP = sb
        .from("employees")
        .select("id", { count: "exact", head: true })
        .eq("active", true);

    const in30Days = new Date();
    in30Days.setDate(in30Days.getDate() + 30);
    const in30DaysStr = in30Days.toISOString().slice(0, 10);
    const upcomingCountP = sb
        .from("employee_upcoming_vacations")
        .select("id", { count: "exact", head: true })
        .lte("start_date", in30DaysStr);

    const [{ count: activeCount }, { count: upcomingCount }] = await Promise.all([
        activeCountP,
        upcomingCountP,
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

async function loadActiveEmployeesForSelect() {
    const { data, error } = await sb
        .from("employees")
        .select("id, full_name, employee_type")
        .eq("active", true)
        .order("full_name");
    funcActiveEmployeesCache = error ? [] : data;
    return funcActiveEmployeesCache;
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
        const digits = term.replace(/\D/g, "");
        const orParts = [
            `full_name.ilike.%${term}%`,
            `email.ilike.%${term}%`,
            `phone.ilike.%${term}%`,
        ];
        if (digits) orParts.push(`cpf.ilike.%${digits}%`);
        query = query.or(orParts.join(","));
    }

    query = query
        .order("full_name")
        .range(funcPage * FUNC_PAGE_SIZE, funcPage * FUNC_PAGE_SIZE + FUNC_PAGE_SIZE - 1);

    const { data, error, count } = await query;
    await refreshFuncStatusMap();

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
    return `
    <tr data-emp-id="${emp.id}">
      <td>${escapeHtml(emp.full_name)}</td>
      <td><span class="func-type-pill">${EMPLOYEE_TYPE_LABELS[emp.employee_type] || emp.employee_type}</span></td>
      <td>${escapeHtml(emp.phone || "—")}</td>
      <td>${escapeHtml(emp.email || "—")}</td>
      <td>${emp.cpf ? escapeHtml(formatCPF(emp.cpf)) : "—"}</td>
      <td><span class="func-situation-badge func-situation-${situation}">${funcSituationLabel(situation)}</span></td>
      <td class="col-actions">
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
        cpf: "",
        address: "",
        notes: "",
    };
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
      <div class="field-row">
        <div class="field">
          <label for="func-f-phone">Telefone</label>
          <input type="text" id="func-f-phone" maxlength="30" placeholder="(00) 00000-0000" value="${escapeHtml(e.phone || "")}">
        </div>
        <div class="field">
          <label for="func-f-email">E-mail</label>
          <input type="email" id="func-f-email" maxlength="150" value="${escapeHtml(e.email || "")}">
        </div>
        <div class="field">
          <label for="func-f-cpf">CPF</label>
          <input type="text" id="func-f-cpf" maxlength="14" placeholder="000.000.000-00" value="${e.cpf ? formatCPF(e.cpf) : ""}">
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

        const cpfDigits = qs("#func-f-cpf").value.replace(/\D/g, "");
        if (cpfDigits && cpfDigits.length !== 11) {
            errorEl.textContent = "CPF deve ter 11 dígitos (ou fique em branco).";
            errorEl.classList.remove("hidden");
            return;
        }

        const payload = {
            full_name: fullName,
            employee_type: qs("#func-f-type").value,
            phone: qs("#func-f-phone").value.trim() || null,
            email: qs("#func-f-email").value.trim() || null,
            cpf: cpfDigits || null,
            address: qs("#func-f-address").value.trim() || null,
            notes: qs("#func-f-notes").value.trim() || null,
        };

        const { error } = id
            ? await sb.from("employees").update(payload).eq("id", id)
            : await sb.from("employees").insert(payload);

        if (error) {
            errorEl.textContent = error.message.includes("employees_cpf_unique")
                ? "Já existe um funcionário cadastrado com esse CPF."
                : "Não foi possível salvar. Tente novamente.";
            errorEl.classList.remove("hidden");
            return;
        }

        showToast(id ? "Funcionário atualizado." : "Funcionário cadastrado.");
        closeModal();
        await loadFuncList();
        await refreshFuncStatusSummary();
        await loadActiveEmployeesForSelect();
    });
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

    const employeesP = sb
        .from("employees")
        .select("id, full_name, employee_type")
        .eq("active", true)
        .order("full_name");
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
          <td><span class="func-type-pill">${EMPLOYEE_TYPE_LABELS[emp.employee_type] || emp.employee_type}</span></td>
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
    await loadActiveEmployeesForSelect();
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

async function loadFuncCalendar() {
    const grid = qs("#func-calendar-grid");
    grid.innerHTML = `<div class="empty-state">Carregando calendário&hellip;</div>`;

    const year = funcCalendarDate.getFullYear();
    const month = funcCalendarDate.getMonth();
    qs("#func-cal-label").textContent = `${FUNC_MONTH_LABELS[month]} de ${year}`;

    const monthStart = isoDate(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthEnd = isoDate(year, month, daysInMonth);

    const { data, error } = await sb
        .from("employee_leaves")
        .select("id, leave_type, start_date, end_date, employees(full_name)")
        .lte("start_date", monthEnd)
        .gte("end_date", monthStart);

    const leaves = error || !data ? [] : data;

    // Bucket leaves per day-of-month they touch within this month.
    const byDay = {};
    for (let d = 1; d <= daysInMonth; d++) byDay[d] = [];
    leaves.forEach((leave) => {
        const from = leave.start_date < monthStart ? 1 : Number(leave.start_date.slice(8, 10));
        const to = leave.end_date > monthEnd ? daysInMonth : Number(leave.end_date.slice(8, 10));
        for (let d = from; d <= to; d++) {
            byDay[d].push(leave);
        }
    });

    const firstWeekday = new Date(year, month, 1).getDay();
    const todayStr = todayIsoDate();

    let html = FUNC_WEEKDAY_LABELS.map((w) => `<div class="func-cal-weekday">${w}</div>`).join("");
    for (let i = 0; i < firstWeekday; i++) {
        html += `<div class="func-cal-day func-cal-day-empty"></div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dayIso = isoDate(year, month, d);
        const dayLeaves = byDay[d];
        const isToday = dayIso === todayStr;
        const shown = dayLeaves.slice(0, 2);
        const rest = dayLeaves.length - shown.length;
        const tagsHtml =
            shown
                .map(
                    (l) =>
                        `<span class="func-cal-tag func-cal-tag-${l.leave_type}" title="${escapeHtml(l.employees?.full_name || "")}">${escapeHtml(l.employees?.full_name || "")}</span>`,
                )
                .join("") + (rest > 0 ? `<span class="func-cal-tag-more" data-cal-day="${dayIso}">+${rest} mais</span>` : "");

        html += `
      <div class="func-cal-day ${isToday ? "func-cal-day-today" : ""}" data-cal-day="${dayIso}">
        <span class="func-cal-day-num">${d}</span>
        <div class="func-cal-day-tags">${tagsHtml}</div>
      </div>`;
    }

    grid.innerHTML = html;

    qsa("[data-cal-day]", grid).forEach((el) => {
        el.addEventListener("click", () => showFuncCalendarDayModal(el.dataset.calDay, byDay));
    });
}

function showFuncCalendarDayModal(dayIso, byDay) {
    const day = Number(dayIso.slice(8, 10));
    const leaves = byDay[day] || [];
    const bodyHtml =
        leaves.length === 0
            ? `<p class="empty-state">Ninguém de férias ou atestado neste dia.</p>`
            : `<ul style="margin:0; padding-left: 18px;">${leaves
                .map(
                    (l) =>
                        `<li style="margin-bottom:6px;">${escapeHtml(l.employees?.full_name || "—")} — ${l.leave_type === "ferias" ? "Férias" : "Atestado"} (${formatDateBR(l.start_date)} a ${formatDateBR(l.end_date)})</li>`,
                )
                .join("")}</ul>`;
    openModal(`Afastamentos em ${formatDateBR(dayIso)}`, bodyHtml);
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
    qs("#func-presenca-today").addEventListener("click", () => {
        qs("#func-presenca-date").value = todayIsoDate();
        loadFuncPresenca();
    });
    qs("#btn-save-presenca").addEventListener("click", saveFuncPresenca);

    qs("#func-leaves-filter-type").addEventListener("change", loadFuncLeaves);
    qs("#func-leaves-filter-status").addEventListener("change", loadFuncLeaves);
    qs("#btn-new-leave").addEventListener("click", async () => {
        await loadActiveEmployeesForSelect();
        openFuncLeaveModal(null);
    });

    qs("#func-cal-prev").addEventListener("click", () => {
        funcCalendarDate.setMonth(funcCalendarDate.getMonth() - 1);
        loadFuncCalendar();
    });
    qs("#func-cal-next").addEventListener("click", () => {
        funcCalendarDate.setMonth(funcCalendarDate.getMonth() + 1);
        loadFuncCalendar();
    });
    qs("#func-cal-today").addEventListener("click", () => {
        funcCalendarDate = new Date();
        funcCalendarDate.setDate(1);
        loadFuncCalendar();
    });
}

async function loadFuncionarios() {
    if (!funcInitialized) {
        funcInitialized = true;
        wireFuncionariosEvents();
    }
    await loadActiveEmployeesForSelect();
    await refreshFuncStatusSummary();
    await loadFuncList();
}