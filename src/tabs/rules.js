// =============================================================================
// MODULE: NUMBERING RULES
// =============================================================================
import { qs } from "../utils.js";
import { showToast, openModal, closeModal, openDeleteConfirm } from "../ui.js";
import { initStreetCombobox } from "../combobox.js";

const RULES_PAGE_SIZE = 25;
export let rulesFilterStreetId = "";
let rulesFilterZipId = "";
let rulesPage = 0;
let rulesTotalCount = 0;
let rulesCache = [];

const rulesFilterZipSelect = qs("#rules-filter-zip");

function resetRulesFilterZipSelect() {
  rulesFilterZipSelect.innerHTML =
    '<option value="">Selecione um logradouro&hellip;</option>';
  rulesFilterZipSelect.disabled = true;
}

export async function loadRulesFilterZipOptions(streetId) {
  if (!streetId) {
    resetRulesFilterZipSelect();
    return;
  }
  rulesFilterZipSelect.disabled = true;
  rulesFilterZipSelect.innerHTML =
    '<option value="">Carregando CEPs&hellip;</option>';
  const zipList = await loadZipsLite(streetId);
  const options = [
    '<option value="">Todos os CEPs deste logradouro</option>',
  ].concat(
    zipList.map((z) => `<option value="${z.id}">${z.zip_code}</option>`),
  );
  rulesFilterZipSelect.innerHTML = options.join("");
  rulesFilterZipSelect.disabled = zipList.length === 0;
}

const rulesFilterCombobox = initStreetCombobox({
  inputEl: qs("#rules-filter-street-search"),
  suggestionsEl: qs("#rules-filter-street-suggestions"),
  onSelect: async (street) => {
    rulesFilterStreetId = street ? street.id : "";
    rulesFilterZipId = "";
    await loadRulesFilterZipOptions(rulesFilterStreetId);
    await loadRules();
  },
});

export async function loadRules(page = 0) {
  const tbody = qs("#rules-tbody");
  const emptyEl = qs("#rules-empty");

  rulesPage = page;
  tbody.innerHTML =
    '<tr class="loading-row"><td colspan="7">Loading manifest&hellip;</td></tr>';

  const from = page * RULES_PAGE_SIZE;
  const to = from + RULES_PAGE_SIZE - 1;

  let query = sb
    .from("numbering_rules")
    .select(
      "id, start_number, end_number, side, description, zip_code_id, zip_codes!inner(id, zip_code, street_id, streets(name))",
      { count: "exact" },
    )
    .order("id");

  if (rulesFilterZipId) {
    query = query.eq("zip_code_id", rulesFilterZipId);
  } else if (rulesFilterStreetId) {
    const zipList = await loadZipsLite(rulesFilterStreetId);
    const zipIds = zipList.map((z) => z.id);

    if (zipIds.length === 0) {
      rulesCache = [];
      rulesTotalCount = 0;
      emptyEl.classList.remove("hidden");
      tbody.innerHTML = "";
      renderRulesPagination();
      return;
    }
    query = query.eq("zip_codes.street_id", rulesFilterStreetId);
  }

  query = query.range(from, to);
  const { data, error, count } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="7">Error loading rules: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  rulesTotalCount = count || 0;
  rulesCache = data;

  emptyEl.classList.toggle("hidden", data.length > 0);

  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td class="zip-code-cell">${r.zip_codes ? r.zip_codes.zip_code : "&mdash;"}</td>
      <td>${escapeHtml(r.zip_codes && r.zip_codes.streets ? r.zip_codes.streets.name : "&mdash;")}</td>
      <td>${r.start_number === null ? '<span class="field-hint">aberto</span>' : r.start_number}</td>
      <td>${r.end_number === null ? '<span class="field-hint">aberto</span>' : r.end_number}</td>
      <td><span class="side-badge side-${r.side}">${SIDE_LABELS[r.side] || r.side}</span></td>
      <td>${escapeHtml(r.description) || '<span class="field-hint">&mdash;</span>'}</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-edit-rule="${r.id}">Editar</button>
          <button class="btn btn-danger btn-icon" data-delete-rule="${r.id}">Excluir</button>
        </span>
      </td>
    </tr>
  `,
    )
    .join("");

  renderRulesPagination();
}

function renderRulesPagination() {
  const totalPages = Math.max(1, Math.ceil(rulesTotalCount / RULES_PAGE_SIZE));
  const countLabel = rulesTotalCount === 1 ? "Regra" : "Regras";

  qs("#rules-page-info").textContent =
    `Página ${rulesPage + 1} de ${totalPages} · ${rulesTotalCount} ${countLabel}`;
  qs("#rules-prev").disabled = rulesPage <= 0;
  qs("#rules-next").disabled = rulesPage + 1 >= totalPages;
}

function ruleFormTemplate(record) {
  return `
    <form id="rule-form">
      <div class="field combobox-field">
        <label for="rule-street-search">Logradouro</label>
        <input type="text" id="rule-street-search" autocomplete="off" placeholder="Digite para buscar um logradouro&hellip;" required>
        <div class="combobox-suggestions hidden" id="rule-street-suggestions"></div>
        <p class="field-error">Selecione um logradouro na lista de sugestões.</p>
      </div>
      <div class="field">
        <label for="rule-zip">CEP</label>
        <select id="rule-zip" required disabled>
          <option value="">Selecione um logradouro primeiro&hellip;</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="rule-start">Número inicial</label>
          <input id="rule-start" type="number" min="0" placeholder="Opcional" value="${record && record.start_number !== null ? record.start_number : ""}">
        </div>
        <div class="field">
          <label for="rule-end">Número final</label>
          <input id="rule-end" type="number" min="0" placeholder="Opcional" value="${record && record.end_number !== null ? record.end_number : ""}">
        </div>
      </div>
      <p class="field-error" id="rule-empty-error">Informe ao menos o número inicial ou o número final.</p>
      <p class="field-error" id="rule-order-error">O número inicial deve ser menor ou igual ao final.</p>
      
      <div class="field">
        <label for="rule-side">Lado da rua</label>
        <select id="rule-side">
          <option value="both" ${!record || record.side === "both" ? "selected" : ""}>Ambos</option>
          <option value="odd" ${record && record.side === "odd" ? "selected" : ""}>Ímpar</option>
          <option value="even" ${record && record.side === "even" ? "selected" : ""}>Par</option>
        </select>
      </div>
      
      <div class="field">
        <label for="rule-descr">Descrição</label>
        <input id="rule-descr" type="text" maxlength="255" placeholder="Ex.: Hospital, condomínio, prédio comercial&hellip;"
               value="${record && record.description ? escapeHtml(record.description) : ""}">
      </div>
      
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="rule-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${record ? "Salvar alterações" : "Cadastrar regra"}</button>
      </div>
    </form>
  `;
}

async function openRuleForm(record = null) {
  openModal(
    record ? "Editar Regra de Numeração" : "Nova Regra de Numeração",
    ruleFormTemplate(record),
  );

  setTimeout(() => {
    const searchInput = qs('#rule-street-search');
    if (searchInput) searchInput.focus();
  }, 100);

  const zipSelect = qs("#rule-zip");

  async function loadCepOptionsForStreet(streetId, selectedZipId) {
    if (!streetId) {
      zipSelect.innerHTML =
        '<option value="">Selecione um logradouro primeiro&hellip;</option>';
      zipSelect.disabled = true;
      return;
    }
    zipSelect.disabled = true;
    zipSelect.innerHTML = '<option value="">Carregando CEPs&hellip;</option>';
    const zipList = await loadZipsLite(streetId);
    if (zipList.length === 0) {
      zipSelect.innerHTML =
        '<option value="">Este logradouro não tem CEPs cadastrados</option>';
      zipSelect.disabled = true;
      return;
    }
    populateZipSelect(zipSelect, zipList, selectedZipId);
    zipSelect.disabled = false;
  }

  const streetCombobox = initStreetCombobox({
    inputEl: qs("#rule-street-search"),
    suggestionsEl: qs("#rule-street-suggestions"),
    onSelect: (street) => {
      qs("#rule-street-search").closest(".field").classList.remove("has-error");
      loadCepOptionsForStreet(street ? street.id : null);
    },
  });

  if (record && record.zip_codes) {
    streetCombobox.setValue({
      id: record.zip_codes.street_id,
      name: record.zip_codes.streets.name,
    });
    await loadCepOptionsForStreet(
      record.zip_codes.street_id,
      record.zip_code_id,
    );
  }

  qs("#rule-cancel").addEventListener("click", closeModal);
  qs("#rule-form").addEventListener("submit", (e) => submitRuleForm(e, record, streetCombobox),);
}

async function submitRuleForm(e, record, streetCombobox) {
  e.preventDefault();

  const selectedStreet = streetCombobox.getSelected();
  const streetField = qs("#rule-street-search").closest(".field");

  if (!selectedStreet) {
    streetField.classList.add("has-error");
    return;
  }
  streetField.classList.remove("has-error");

  const zipCodeId = qs("#rule-zip").value;
  if (!zipCodeId) {
    showToast("Selecione um CEP para este logradouro.", "error");
    return;
  }

  const startRaw = qs("#rule-start").value;
  const endRaw = qs("#rule-end").value;
  const side = qs("#rule-side").value;
  const description = qs("#rule-descr").value.trim() || null;

  let startNumber = startRaw === "" ? null : Number(startRaw);
  let endNumber = endRaw === "" ? null : Number(endRaw);

  if (Number.isNaN(startNumber)) startNumber = null;
  if (Number.isNaN(endNumber)) endNumber = null;

  // Auto-fill logic if one of the boundaries is empty
  if (startNumber === null && endNumber !== null) {
    startNumber = endNumber;
  } else if (endNumber === null && startNumber !== null) {
    endNumber = startNumber;
  }

  const emptyError = qs("#rule-empty-error");
  if (startNumber === null && endNumber === null) {
    emptyError.style.display = "block";
    return;
  }
  emptyError.style.display = "none";

  const orderError = qs("#rule-order-error");
  if (startNumber !== null && endNumber !== null && startNumber > endNumber) {
    orderError.style.display = "block";
    return;
  }
  orderError.style.display = "none";

  // Build payload mapping directly to the RPC parameters
  const payload = {
    p_id: record ? record.id : null,
    p_zip_code_id: parseInt(zipCodeId, 10),
    p_start_number: startNumber,
    p_end_number: endNumber,
    p_side: side,
    p_description: description
  };

  // Execute the RPC call
  const { error } = await sb.rpc('upsert_numbering_rule', payload);

  if (error) {
    // If the user tries to update an existing rule into a conflict, Postgres will still block it
    if (error.code === '23505') {
      console.log("Erro: Conflito de regra já existente.", "error")
      showToast("Erro: Conflito de regra já existente.", "error");
    } else {
      console.log(`Error saving rule: ${error.message}`, "error")
      showToast(`Error saving rule: ${error.message}`, "error");
    }
    return;
  }

  showToast(record ? "Regra atualizada." : "Regra cadastrada.");
  closeModal();
  await loadRules(rulesPage);
}

async function deleteRule(id) {
  openDeleteConfirm("esta regra de numeração", null, async () => {
    const { error } = await sb.from("numbering_rules").delete().eq("id", id);
    if (error) {
      showToast(`Erro ao excluir: ${error.message}`, "error");
      return;
    }
    closeModal();
    showToast("Regra excluída.");
    await loadRules(rulesPage);
  });
}

// Rules Event Listeners
qs("#rules-prev").addEventListener("click", () => {
  if (rulesPage > 0) loadRules(rulesPage - 1);
});

qs("#rules-next").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(rulesTotalCount / RULES_PAGE_SIZE));
  if (rulesPage + 1 < totalPages) loadRules(rulesPage + 1);
});

rulesFilterZipSelect.addEventListener("change", () => {
  rulesFilterZipId = rulesFilterZipSelect.value;
  loadRules(0);
});

qs("#rules-filter-clear").addEventListener("click", () => {
  rulesFilterStreetId = "";
  rulesFilterZipId = "";
  rulesFilterCombobox.setValue(null);
  resetRulesFilterZipSelect();
  loadRules(0);
});

qs("#btn-new-rule").addEventListener("click", () => openRuleForm());

qs("#rules-tbody").addEventListener("click", (e) => {
  const editBtn = e.target.closest("[data-edit-rule]");
  const deleteBtn = e.target.closest("[data-delete-rule]");
  if (editBtn) {
    const record = rulesCache.find(
      (r) => String(r.id) === editBtn.dataset.editRule,
    );
    if (record) openRuleForm(record);
  }
  if (deleteBtn) deleteRule(deleteBtn.dataset.deleteRule);
});