// =============================================================================
// 01. CONFIGURATION & SETUP
// =============================================================================

const SUPABASE_URL = window.ENV.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.ENV.SUPABASE_ANON_KEY;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =============================================================================
// 02. CORE UTILITIES
// =============================================================================

// --- DOM Helpers ---
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- Text & Search Normalization ---
function normalizeSearchTerm(term) {
  const withoutAccents = term
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return withoutAccents.replace(/[^a-z0-9]+/g, "%");
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNeighborhoods(neighborhoods) {
  if (Array.isArray(neighborhoods)) return neighborhoods.join(", ");
  return neighborhoods || "—";
}

// --- ZIP Code Normalization ---
const ZIP_REGEX = /^880[0-6][0-9]-[0-9]{3}$/;

function normalizeZipDigits(raw) {
  let digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (!digits.startsWith("880")) {
    digits = `880${digits}`;
  }
  return digits.slice(0, 8);
}

function digitsToZipPattern(digits) {
  if (!digits) return "";
  if (digits.length > 5) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return digits;
}

function attachZipMask(inputEl) {
  inputEl.addEventListener("input", () => {
    let digits = inputEl.value.replace(/\D/g, "").slice(0, 8);
    if (digits.length > 5) digits = `${digits.slice(0, 5)}-${digits.slice(5)}`;
    inputEl.value = digits;
  });
  inputEl.addEventListener("blur", () => {
    if (!inputEl.value.trim()) return;
    inputEl.value = digitsToZipPattern(normalizeZipDigits(inputEl.value));
  });
}

// --- Date & Time Helpers ---
function todayIsoDate() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function formatTimeShort(value) {
  if (!value) return "&mdash;";
  return value.slice(0, 5);
}

// =============================================================================
// 03. UI SYSTEM: TOASTS, MODALS, TABS & HOTKEYS
// =============================================================================

// --- Toasts ---
function showToast(message, type = "success") {
  const container = qs("#toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "toast-error" : ""}`.trim();
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

// --- Modals ---
const modalOverlay = qs("#modal-overlay");
const modalTitleEl = qs("#modal-title");
const modalBodyEl = qs("#modal-body");

function openModal(title, bodyHtml, options = {}) {
  modalTitleEl.innerHTML = title;
  modalBodyEl.innerHTML = bodyHtml;
  qs(".modal-slip").classList.toggle("modal-slip-wide", Boolean(options.wide));
  modalOverlay.classList.remove("hidden");
}

function closeModal() {
  modalOverlay.classList.add("hidden");
  modalBodyEl.innerHTML = "";
  qs(".modal-slip").classList.remove("modal-slip-wide");
  if (typeof loecReportChartInstances !== "undefined" && loecReportChartInstances.length) {
    loecReportChartInstances.forEach((chart) => chart.destroy());
    loecReportChartInstances = [];
  }
}

qs("#modal-close").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalOverlay.classList.contains("hidden"))
    closeModal();
});

function deleteConfirmTemplate(label, warning) {
  return `
    <p class="confirm-text">Confirma a exclusão de <strong>${escapeHtml(label)}</strong>?</p>
    ${warning ? `<p class="confirm-warning">${warning}</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" id="confirm-cancel">Cancelar</button>
      <button type="button" class="btn btn-danger" id="confirm-delete">Excluir</button>
    </div>
  `;
}

function openDeleteConfirm(label, warning, onConfirm) {
  openModal("Confirmar exclusão", deleteConfirmTemplate(label, warning));
  qs("#confirm-cancel").addEventListener("click", closeModal);
  qs("#confirm-delete").addEventListener("click", onConfirm);
}

// --- Tabs ---
qsa(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  qsa(".tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });

  qsa(".panel").forEach((panel) =>
    panel.classList.toggle("active", panel.id === `panel-${tab}`),
  );

  if (tab === "stats") loadStatistics();
  if (tab === "cee-map") loadCeeSectors();
  if (tab === "daily-ops") loadDailyOps();
  if (tab === "about") loadAboutPage();
}

// --- Global Hotkeys ---
document.addEventListener("keydown", (e) => {
  if (e.key === "F4") {
    e.preventDefault();
    zipsPage = 0;

    qsa("input, select, textarea").forEach((el) => {
      if (el.type === "checkbox" || el.type === "radio") {
        el.checked = false;
      } else {
        el.value = "";
      }
    });

    if (
      typeof rulesFilterCombobox !== "undefined" &&
      rulesFilterCombobox.setValue
    ) {
      rulesFilterCombobox.setValue(null);
    }

    if (typeof rulesFilterStreetId !== "undefined") rulesFilterStreetId = "";
    if (typeof rulesFilterZipId !== "undefined") rulesFilterZipId = "";

    if (typeof resetRulesFilterZipSelect === "function")
      resetRulesFilterZipSelect();

    if (typeof cepSearchState !== "undefined") {
      cepSearchState = {
        streetId: null,
        street: null,
        breakdown: [],
        searchLogged: false,
      };
    }

    const resultsEl = qs("#cepsearch-results");
    const emptyEl = qs("#cepsearch-empty");
    if (resultsEl) resultsEl.classList.add("hidden");
    if (emptyEl) emptyEl.classList.remove("hidden");

    if (typeof loadZips === "function") loadZips(0);
    if (typeof loadRules === "function") loadRules();

    const dailyOpsDateEl = qs("#daily-ops-date");
    if (dailyOpsDateEl && typeof loadDailyOps === "function") {
      dailyOpsDateEl.value = todayIsoDate();
      loadDailyOps();
    }

    if (typeof loadCeeSectors === "function") loadCeeSectors();

    showToast("Todos os campos e filtros foram limpos.");
  }
  if (e.key === "F6") {
    e.preventDefault();
    switchTab("cepsearch");
    const numInput = qs("#cepsearch-number");
    if (numInput && !numInput.disabled) {
      numInput.value = "";
      numInput.focus();
    }
  }

  if (e.key === "F7") {
    e.preventDefault();
    switchTab("cepsearch");
    const queryInput = qs("#cepsearch-query");
    if (queryInput) {
      queryInput.value = "";
      queryInput.focus();
    }
  }
});

const tabKeyMap = {
  1: "zips",
  2: "cepsearch",
  3: "rules",
  4: "stats",
  5: "cee-map",
  6: "daily-ops",
  7: "about",
};

document.addEventListener("keydown", (e) => {
  const activeElement = document.activeElement;
  const isInputFocused =
    activeElement &&
    (activeElement.tagName === "INPUT" ||
      activeElement.tagName === "TEXTAREA" ||
      activeElement.tagName === "SELECT" ||
      activeElement.isContentEditable);

  if (isInputFocused) return;

  const targetTab = tabKeyMap[e.key];
  if (targetTab) {
    e.preventDefault();
    switchTab(targetTab);
  }
});

// =============================================================================
// 04. SHARED COMPONENTS (COMBOBOX)
// =============================================================================

async function searchStreetsByTerm(term, limit = 8) {
  if (!term.trim()) return [];

  const wildcardTerm = normalizeSearchTerm(term);
  const digits = term.replace(/\D/g, "");
  let zipStreetIds = [];

  // If input has numbers, attempt to resolve via zip code
  if (digits) {
    const pattern = digitsToZipPattern(normalizeZipDigits(term));
    const { data: zipMatches } = await sb
      .from("zip_codes")
      .select("street_id")
      .ilike("zip_code", `%${pattern}%`)
      .limit(limit);

    if (zipMatches && zipMatches.length > 0) {
      zipStreetIds = zipMatches.map((z) => z.street_id);
    }
  }

  let query = sb.from("streets").select("id, name, neighborhood");

  // Combine text search OR zip code matched IDs
  if (zipStreetIds.length > 0) {
    query = query.or(
      `search_text.ilike.%${wildcardTerm}%,id.in.(${zipStreetIds.join(",")})`,
    );
  } else {
    query = query.ilike("search_text", `%${wildcardTerm}%`);
  }

  const { data, error } = await query.order("name").limit(limit);
  return error ? [] : data;
}

function initStreetCombobox({ inputEl, suggestionsEl, onSelect }) {
  let debounceHandle = null;
  let activeIndex = -1;
  let currentMatches = [];
  let selected = null;

  function closeSuggestions() {
    suggestionsEl.innerHTML = "";
    suggestionsEl.classList.add("hidden");
    activeIndex = -1;
    currentMatches = [];
  }

  function updateActiveHighlight() {
    qsa(".combobox-suggestion", suggestionsEl).forEach((btn, i) => {
      btn.classList.toggle("active", i === activeIndex);
    });
  }

  function renderSuggestions(matches) {
    currentMatches = matches;
    activeIndex = -1;
    if (matches.length === 0) {
      suggestionsEl.innerHTML =
        '<div class="combobox-empty">Nenhum logradouro encontrado.</div>';
      suggestionsEl.classList.remove("hidden");
      return;
    }
    suggestionsEl.innerHTML = matches
      .map(
        (s, i) => `
      <button type="button" class="combobox-suggestion" data-index="${i}">
        <span class="combobox-suggestion-name">${escapeHtml(s.name)}</span>
        <span class="combobox-suggestion-sub">${escapeHtml(formatNeighborhoods(s.neighborhood))}</span>
      </button>
    `,
      )
      .join("");
    suggestionsEl.classList.remove("hidden");
  }

  function pick(street) {
    selected = street;
    inputEl.value = street.name;
    closeSuggestions();
    onSelect(street);
  }

  inputEl.addEventListener("input", () => {
    if (selected && inputEl.value !== selected.name) {
      selected = null;
      onSelect(null);
    }
    clearTimeout(debounceHandle);
    const term = inputEl.value;
    debounceHandle = setTimeout(async () => {
      const matches = await searchStreetsByTerm(term);
      // Auto-select if exactly 1 result is returned
      if (matches.length === 1) {
        pick(matches[0]);
        return;
      }
      renderSuggestions(matches);
    }, 280);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (
      suggestionsEl.classList.contains("hidden") ||
      currentMatches.length === 0
    )
      return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
      updateActiveHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveHighlight();
    } else if (e.key === "Enter") {
      if (activeIndex >= 0) {
        e.preventDefault();
        pick(currentMatches[activeIndex]);
      }
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  suggestionsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".combobox-suggestion");
    if (!btn) return;
    pick(currentMatches[Number(btn.dataset.index)]);
  });

  inputEl.addEventListener("blur", () => {
    setTimeout(closeSuggestions, 150);
  });

  return {
    setValue(street) {
      selected = street;
      inputEl.value = street ? street.name : "";
      closeSuggestions();
    },
    getSelected() {
      return selected;
    },
  };
}

// =============================================================================
// 05. MODULE: STREET MANAGEMENT
// =============================================================================

function streetFormTemplate() {
  return `
    <form id="street-form">
      <div class="field">
        <label for="street-name">Nome do Logradouro</label>
        <input type="text" id="street-name" required placeholder="Ex: Rua Felipe Schmidt">
      </div>
      <div class="field">
        <label for="street-neighborhood">Bairros (separados por vírgula)</label>
        <input type="text" id="street-neighborhood" required placeholder="Ex: Centro, Agronômica">
      </div>
      <div class="field">
        <label for="street-descr">Descrição (Opcional)</label>
        <input type="text" id="street-descr" placeholder="Ex: Servidão, Rodovia...">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="street-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar Logradouro</button>
      </div>
    </form>
  `;
}

function openStreetForm() {
  openModal("Novo Logradouro", streetFormTemplate());
  qs("#street-cancel").addEventListener("click", closeModal);
  qs("#street-form").addEventListener("submit", submitStreetForm);
}

async function submitStreetForm(e) {
  e.preventDefault();

  const name = qs("#street-name").value.trim();
  const neighborhoodRaw = qs("#street-neighborhood").value;
  const descr = qs("#street-descr").value.trim() || null;

  const neighborhood = neighborhoodRaw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n);
  const payload = { name, neighborhood, descr };

  const { error } = await sb.from("streets").insert(payload);

  if (error) {
    showToast(`Error saving street: ${error.message}`, "error");
    return;
  }

  closeModal();
  showToast("Logradouro cadastrado com sucesso!");
}

const btnNewStreet = qs("#btn-new-street");
if (btnNewStreet) btnNewStreet.addEventListener("click", openStreetForm);

// =============================================================================
// 06. MODULE: ZIP CODES (CRUD)
// =============================================================================

const ZIPS_PAGE_SIZE = 32;
let zipsSearchTerm = "";
let zipsPage = 0;
let zipsTotalCount = 0;
let zipsSearchDebounce = null;

async function loadZipsLite(filterStreetId = "") {
  let query = sb
    .from("zip_codes")
    .select("id, zip_code, street_id, streets(name)")
    .order("zip_code");
  if (filterStreetId) query = query.eq("street_id", filterStreetId);
  const { data, error } = await query;
  if (error) {
    console.error("Failed to load zip codes for dropdowns:", error);
    return [];
  }
  return data;
}

function populateZipSelect(selectEl, zipList, selectedId) {
  const options = ['<option value="">Selecione um CEP&hellip;</option>'].concat(
    zipList.map(
      (z) =>
        `<option value="${z.id}" ${String(z.id) === String(selectedId) ? "selected" : ""}>${z.zip_code} &mdash; ${escapeHtml(
          z.streets ? z.streets.name : "",
        )}</option>`,
    ),
  );
  selectEl.innerHTML = options.join("");
}

async function loadZips(page = 0) {
  const tbody = qs("#zips-tbody");
  const emptyEl = qs("#zips-empty");
  zipsPage = page;
  tbody.innerHTML =
    '<tr class="loading-row"><td colspan="4">Carregando manifesto&hellip;</td></tr>';

  const term = zipsSearchTerm.trim();
  const from = page * ZIPS_PAGE_SIZE;
  const to = from + ZIPS_PAGE_SIZE - 1;

  let query = sb
    .from("zip_codes")
    .select("id, zip_code, street_id, streets(name, neighborhood)", {
      count: "exact",
    })
    .order("zip_code");

  if (term) {
    const wildcardTerm = normalizeSearchTerm(term);

    const { data: streetMatches, error: streetError } = await sb
      .from("streets")
      .select("id")
      .ilike("search_text", `%${wildcardTerm}%`);

    if (streetError) {
      tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar CEPs: ${escapeHtml(streetError.message)}</td></tr>`;
      return;
    }

    const streetIds = (streetMatches || []).map((s) => s.id);
    const digits = term.replace(/\D/g, "");
    const orParts = [];

    if (digits) {
      const pattern = digitsToZipPattern(normalizeZipDigits(term));
      orParts.push(`zip_code.ilike.%${pattern}%`);
    }
    if (streetIds.length) orParts.push(`street_id.in.(${streetIds.join(",")})`);

    if (orParts.length === 0) {
      zipsTotalCount = 0;
      emptyEl.classList.remove("hidden");
      tbody.innerHTML = "";
      renderZipsPagination();
      return;
    }
    query = query.or(orParts.join(","));
  }

  query = query.range(from, to);
  const { data, error, count } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar CEPs: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  zipsTotalCount = count || 0;
  emptyEl.classList.toggle("hidden", data.length > 0);
  tbody.innerHTML = data
    .map(
      (z) => `
    <tr>
      <td class="zip-code-cell">${z.zip_code}</td>
      <td>${escapeHtml(z.streets ? z.streets.name : "&mdash;")}</td>
      <td>${escapeHtml(z.streets ? formatNeighborhoods(z.streets.neighborhood) : "&mdash;")}</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-view-zip="${z.id}" data-zip-value="${z.zip_code}">Consultar</button>
          <button class="btn btn-secondary btn-icon" data-edit-zip="${z.id}">Editar</button>
        </span>
      </td>
    </tr>
  `,
    )
    .join("");

  renderZipsPagination();
}

function renderZipsPagination() {
  const totalPages = Math.max(1, Math.ceil(zipsTotalCount / ZIPS_PAGE_SIZE));
  const countLabel = zipsTotalCount === 1 ? "CEP" : "CEPs";
  qs("#zips-page-info").textContent =
    `Página ${zipsPage + 1} de ${totalPages} · ${zipsTotalCount} ${countLabel}`;
  qs("#zips-prev").disabled = zipsPage <= 0;
  qs("#zips-next").disabled = zipsPage + 1 >= totalPages;
}

function zipFormTemplate(record) {
  return `
    <form id="zip-form">
      <div class="field combobox-field">
        <label for="zip-street-search">Logradouro</label>
        <input type="text" id="zip-street-search" autocomplete="off" placeholder="Digite para buscar um logradouro&hellip;" required>
        <div class="combobox-suggestions hidden" id="zip-street-suggestions"></div>
        <p class="field-error">Selecione um logradouro na lista de sugestões.</p>
      </div>
      <div class="field" id="zip-code-field">
        <label for="zip-code-input">CEP</label>
        <input id="zip-code-input" type="text" inputmode="numeric" placeholder="88000-000"
               value="${record ? record.zip_code : ""}" maxlength="9" required>
        <p class="field-hint">Basta digitar os 5 últimos números &mdash; o prefixo 880 é adicionado automaticamente.</p>
        <p class="field-error">CEP fora do formato ou da faixa permitida para a ilha.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="zip-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${record ? "Salvar alterações" : "Cadastrar CEP"}</button>
      </div>
    </form>
  `;
}

async function openZipForm(record = null) {
  openModal(record ? "Editar CEP" : "Novo CEP", zipFormTemplate(record));
  attachZipMask(qs("#zip-code-input"));

  const streetCombobox = initStreetCombobox({
    inputEl: qs("#zip-street-search"),
    suggestionsEl: qs("#zip-street-suggestions"),
    onSelect: () =>
      qs("#zip-street-search").closest(".field").classList.remove("has-error"),
  });
  if (record && record.streets) {
    streetCombobox.setValue({
      id: record.street_id,
      name: record.streets.name,
    });
  }

  qs("#zip-cancel").addEventListener("click", closeModal);
  qs("#zip-form").addEventListener("submit", (e) =>
    submitZipForm(e, record, streetCombobox),
  );
}

async function submitZipForm(e, record, streetCombobox) {
  e.preventDefault();
  const selectedStreet = streetCombobox.getSelected();
  const streetField = qs("#zip-street-search").closest(".field");
  if (!selectedStreet) {
    streetField.classList.add("has-error");
    return;
  }
  streetField.classList.remove("has-error");

  const zipInput = qs("#zip-code-input");
  const normalizedZip = digitsToZipPattern(normalizeZipDigits(zipInput.value));
  zipInput.value = normalizedZip;
  const zipField = qs("#zip-code-field");

  if (!ZIP_REGEX.test(normalizedZip)) {
    zipField.classList.add("has-error");
    return;
  }
  zipField.classList.remove("has-error");

  const payload = { street_id: selectedStreet.id, zip_code: normalizedZip };
  const query = record
    ? sb.from("zip_codes").update(payload).eq("id", record.id)
    : sb.from("zip_codes").insert(payload);
  const { error } = await query;

  if (error) {
    showToast(`Erro ao salvar CEP: ${error.message}`, "error");
    return;
  }
  closeModal();
  showToast(record ? "CEP atualizado." : "CEP cadastrado.");
  await loadZips(zipsPage);
  if (rulesFilterStreetId) await loadRulesFilterZipOptions(rulesFilterStreetId);
}

async function deleteZip(id, label) {
  openDeleteConfirm(
    `CEP ${label}`,
    "Excluir este CEP também remove as regras de numeração vinculadas a ele.",
    async () => {
      const { error } = await sb.from("zip_codes").delete().eq("id", id);
      if (error) {
        showToast(`Erro ao excluir: ${error.message}`, "error");
        return;
      }
      closeModal();
      showToast("CEP excluído.");
      await loadZips(zipsPage);
      if (rulesFilterStreetId)
        await loadRulesFilterZipOptions(rulesFilterStreetId);
    },
  );
}

// Zips Event Listeners
qs("#zips-search").addEventListener("input", (e) => {
  clearTimeout(zipsSearchDebounce);
  const value = e.target.value;
  zipsSearchDebounce = setTimeout(() => {
    zipsSearchTerm = value;
    loadZips(0);
  }, 320);
});

qs("#zips-prev").addEventListener("click", () => {
  if (zipsPage > 0) loadZips(zipsPage - 1);
});
qs("#zips-next").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(zipsTotalCount / ZIPS_PAGE_SIZE));
  if (zipsPage + 1 < totalPages) loadZips(zipsPage + 1);
});

qs("#btn-new-zip").addEventListener("click", () => openZipForm());

qs("#zips-tbody").addEventListener("click", (e) => {
  const viewBtn = e.target.closest("[data-view-zip]");
  const editBtn = e.target.closest("[data-edit-zip]");
  const deleteBtn = e.target.closest("[data-delete-zip]");

  if (viewBtn) {
    goToCepSearch(viewBtn.dataset.zipValue);
    return;
  }
  if (editBtn) {
    const id = editBtn.dataset.editZip;
    sb.from("zip_codes")
      .select("id, zip_code, street_id, streets(name)")
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (error) {
          showToast(`Erro ao carregar CEP: ${error.message}`, "error");
          return;
        }
        openZipForm(data);
      });
  }
  if (deleteBtn)
    deleteZip(deleteBtn.dataset.deleteZip, deleteBtn.dataset.zipLabel);
});

// =============================================================================
// 07. MODULE: NUMBERING RULES (CRUD)
// =============================================================================

const RULES_PAGE_SIZE = 25;
let rulesFilterStreetId = "";
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

async function loadRulesFilterZipOptions(streetId) {
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

async function loadRules(page = 0) {
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
      "id, start_number, end_number, side, description, zip_code_id, zip_codes(id, zip_code, street_id, streets(name))",
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
    query = query.in("zip_code_id", zipIds);
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
  qs("#rule-form").addEventListener("submit", (e) =>
    submitRuleForm(e, record, streetCombobox),
  );
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

  const payload = {
    zip_code_id: zipCodeId,
    start_number: startNumber,
    end_number: endNumber,
    side,
    description
  };
  if (record) {
    // Normal update
    const { error } = await sb.from('numbering_rules').update(payload).eq('id', record.id);
    if (error) { showToast(`Error saving rule: ${error.message}`, 'error'); return; }
  } else {
    // Check for duplicates to perform a manual upsert
    let query = sb.from('numbering_rules').select('id')
      .eq('zip_code_id', zipCodeId)
      .eq('side', side);

    query = startNumber === null ? query.is('start_number', null) : query.eq('start_number', startNumber);
    query = endNumber === null ? query.is('end_number', null) : query.eq('end_number', endNumber);

    const { data: duplicates } = await query;

    if (duplicates && duplicates.length > 0) {
      // Update the duplicated rule silently
      const { error } = await sb.from('numbering_rules').update(payload).eq('id', duplicates[0].id);
      if (error) { showToast(`Error updating rule: ${error.message}`, 'error'); return; }
    } else {
      // Insert new rule
      const { error } = await sb.from('numbering_rules').insert(payload);
      if (error) { showToast(`Error creating rule: ${error.message}`, 'error'); return; }
    }
  }

  closeModal();
  showToast(record ? 'Regra atualizada.' : 'Regra cadastrada/atualizada.');
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

// =============================================================================
// 08. MODULE: CEP SEARCH ENGINE
// =============================================================================

const SIDE_LABELS = { odd: "Ímpar", even: "Par", both: "Ambos" };

let cepSearchState = {
  streetId: null,
  street: null,
  breakdown: [],
  searchLogged: false,
};
let cepSearchDebounce = null;

function goToCepSearch(zipCodeStr) {
  switchTab("cepsearch");
  qs("#cepsearch-query").value = zipCodeStr;
  qs("#cepsearch-number").value = "";
  resolveStreetForQuery(zipCodeStr, { focusNumber: true });
}

async function resolveStreetForQuery(term, opts = {}) {
  const trimmed = term.trim();
  const hintEl = qs("#cepsearch-match-hint");
  const numberInput = qs("#cepsearch-number");
  const resultsEl = qs("#cepsearch-results");
  const emptyEl = qs("#cepsearch-empty");

  if (!trimmed) {
    cepSearchState = {
      streetId: null,
      street: null,
      breakdown: [],
      searchLogged: false,
    };
    hintEl.textContent = "Digite para localizar o logradouro.";
    numberInput.disabled = true;
    resultsEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }

  hintEl.textContent = "Buscando...";

  const wildcardTerm = normalizeSearchTerm(term);
  const digits = term.replace(/\D/g, "");

  const textPromise = sb
    .from("streets")
    .select("id, name, neighborhood, descr")
    .ilike("search_text", `%${wildcardTerm}%`)
    .order("name")
    .limit(5);

  let zipPromise = Promise.resolve({ data: [] });
  if (digits) {
    const pattern = digitsToZipPattern(normalizeZipDigits(trimmed));
    zipPromise = sb
      .from("zip_codes")
      .select("street_id, streets(id, name, neighborhood, descr)")
      .ilike("zip_code", `%${pattern}%`)
      .limit(5);
  }

  const [
    { data: textMatches, error: textError },
    { data: zipMatches, error: zipError },
  ] = await Promise.all([textPromise, zipPromise]);

  if (textError || zipError) {
    hintEl.textContent = `Erro na busca: ${escapeHtml((textError || zipError).message)}`;
    return;
  }

  const merged = new Map();
  (zipMatches || []).forEach((z) => {
    if (z.streets) merged.set(z.streets.id, z.streets);
  });
  (textMatches || []).forEach((s) => {
    if (!merged.has(s.id)) merged.set(s.id, s);
  });

  const candidates = Array.from(merged.values());

  if (candidates.length === 0) {
    cepSearchState = {
      streetId: null,
      street: null,
      breakdown: [],
      searchLogged: false,
    };
    hintEl.textContent = "Nenhum logradouro encontrado para esta busca.";
    numberInput.disabled = true;
    resultsEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }

  const chosen = candidates[0];
  hintEl.innerHTML =
    candidates.length > 1
      ? `Correspondência: <strong>${escapeHtml(chosen.name)}</strong> &middot; ${candidates.length} logradouros encontrados, refine a busca se necessário.`
      : `Correspondência: <strong>${escapeHtml(chosen.name)}</strong>`;

  await loadStreetBreakdown(chosen);
  numberInput.disabled = false;
  if (opts.focusNumber) numberInput.focus();
  renderCepSearchResults();
}

async function loadStreetBreakdown(street) {
  const { data, error } = await sb
    .from("zip_codes")
    .select(
      "id, zip_code, numbering_rules(id, start_number, end_number, side, description)",
    )
    .eq("street_id", street.id)
    .order("zip_code");

  if (error) {
    showToast(`Erro ao carregar CEPs do logradouro: ${error.message}`, "error");
    cepSearchState = {
      streetId: street.id,
      street,
      breakdown: [],
      searchLogged: false,
    };
    return;
  }
  cepSearchState = {
    streetId: street.id,
    street,
    breakdown: data,
    searchLogged: false,
  };
}

function findMatchingZip(breakdown, number) {
  for (const z of breakdown) {
    for (const r of z.numbering_rules || []) {
      const startOk = r.start_number === null || number >= r.start_number;
      const endOk = r.end_number === null || number <= r.end_number;
      if (!startOk || !endOk) continue;

      const parityOk =
        r.side === "both" ||
        (r.side === "odd" && number % 2 === 1) ||
        (r.side === "even" && number % 2 === 0);
      if (parityOk) return z;
    }
  }
  return null;
}

function renderCepSearchResults() {
  const resultsEl = qs('#cepsearch-results');
  const emptyEl = qs('#cepsearch-empty');

  // If no street is selected, clear everything and reset the tracker
  if (!cepSearchState.streetId) {
    resultsEl.classList.add('hidden');
    resultsEl.dataset.renderedStreet = ''; 
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  const { street, breakdown } = cepSearchState;
  const numberRaw = qs('#cepsearch-number').value;
  const number = numberRaw === '' ? null : Number(numberRaw);
  const matchedZip = number !== null ? findMatchingZip(breakdown, number) : null;

  // Reorder to show the matched zip code at the top
  let displayBreakdown = [...breakdown];
  if (matchedZip) {
    displayBreakdown = displayBreakdown.filter(z => z.id !== matchedZip.id);
    displayBreakdown.unshift(matchedZip);
  }

  // Generate the HTML for the zip blocks
  const blocksHtml = displayBreakdown
    .map((z) => {
      const isMatch = Boolean(matchedZip && matchedZip.id === z.id);
      const rulesHtml = (z.numbering_rules || [])
        .map((r) => {
          const start = r.start_number === null ? 'aberto' : r.start_number;
          const end = r.end_number === null ? 'aberto' : r.end_number;
          
          let label = r.start_number !== null && r.start_number === r.end_number
            ? `Número ${r.start_number}`
            : `Faixa ${start}&ndash;${end}`;
          
          const descr = r.description ? ` &middot; ${escapeHtml(r.description)}` : '';
          return `<li>${label} &middot; <span class="side-badge side-${r.side}">${SIDE_LABELS[r.side] || r.side}</span>${descr}</li>`;
        })
        .join('');
        
      const detailsHtml = rulesHtml
          ? `<ul class="zip-block-detail-list">${rulesHtml}</ul>`
          : '<p class="field-hint">Nenhuma regra cadastrada para este CEP.</p>';

      return `
      <div class="zip-block ${isMatch ? 'zip-block--match' : ''}" style="margin-top: 0; margin-bottom: 12px;">
        <div class="zip-block-header">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <span class="zip-block-title">${z.zip_code}</span>
            ${isMatch ? '<span class="match-tag">CEP correto</span>' : ''}
          </div>
          <button type="button" class="btn btn-secondary btn-icon copy-zip-btn" data-clipboard="${z.zip_code}">
            Copiar
          </button>
        </div>
        ${detailsHtml}
      </div>
    `;
    })
    .join('');

  // Generate the "Not Found" message if needed
  let notFoundMessageHtml = '';
  if (number !== null && !matchedZip) {
    notFoundMessageHtml = `
      <div class="zip-block zip-block--not-found" style="border-color: var(--stamp-red); background: #fbeae7; margin-top: 0; margin-bottom: 12px;">
        <p class="field-error" style="display:block; margin:0; text-align:center;">
          Número <strong>${number}</strong> não encontrado nas faixas cadastradas.
        </p>
      </div>
    `;
  }

  // Combine the dynamic left column content
  const leftColumnContent = `
    ${notFoundMessageHtml}
    ${blocksHtml || '<p class="field-hint">Este logradouro ainda não tem CEPs cadastrados.</p>'}
  `;

  // OPTIMIZATION: Check if we have already rendered the map and layout for this exact street
  if (resultsEl.dataset.renderedStreet === String(street.id)) {
    // If yes, simply inject the new results into the left column without touching the map
    const resultsCol = qs('.cepsearch-results-col', resultsEl);
    if (resultsCol) {
      resultsCol.innerHTML = leftColumnContent;
    }
    return; // Exit early
  }

  // If it's a new street, build the entire layout from scratch (including the Google Map)
  const mapSearchQuery = encodeURIComponent(
    `${street.name}, ${formatNeighborhoods(street.neighborhood)}, Florianópolis, SC, Brasil`
  );

  const mapHtml = `
    <div class="street-map-container">
      <iframe 
        src="https://maps.google.com/maps?q=${mapSearchQuery}&t=&z=16&ie=UTF8&iwloc=&output=embed"
        title="Google Maps: ${escapeHtml(street.name)}"
        loading="lazy">
      </iframe>
    </div>
  `;

  resultsEl.innerHTML = `
    <div class="envelope-card">
      <div class="envelope-card-airmail" aria-hidden="true"></div>
      <div class="envelope-card-body">
        <div class="address-window">${escapeHtml(street.name)}</div>        

        <div class="cepsearch-split-layout">

          <!-- Left column (Dynamic Number Results) -->
          <div class="cepsearch-results-col">
            ${leftColumnContent}
          </div>
          
          <!-- Right column (Static Street Map) -->
          <div class="cepsearch-map-col">
            ${mapHtml}
          </div>
          
        </div>
      </div>
    </div>
  `;

  // Mark this street as rendered so subsequent number inputs don't reload the map
  resultsEl.dataset.renderedStreet = String(street.id);
}

// CEP Search Event Listeners
qs("#cepsearch-query").addEventListener("input", (e) => {
  clearTimeout(cepSearchDebounce);
  const value = e.target.value;
  cepSearchDebounce = setTimeout(() => resolveStreetForQuery(value), 320);
});

qs("#cepsearch-number").addEventListener("input", async () => {
  renderCepSearchResults();

  const numberRaw = qs("#cepsearch-number").value;

  if (
    numberRaw.trim() !== "" &&
    cepSearchState.streetId &&
    !cepSearchState.searchLogged
  ) {
    cepSearchState.searchLogged = true;

    const { error } = await sb
      .from("street_search_logs")
      .insert({ street_id: cepSearchState.streetId });

    if (error) {
      console.error("Failed to log street search:", error);
    }
  }
});

qs("#cepsearch-results").addEventListener("click", async (e) => {
  const copyBtn = e.target.closest(".copy-zip-btn");

  if (copyBtn) {
    const zipCode = copyBtn.dataset.clipboard;

    try {
      await navigator.clipboard.writeText(zipCode);
      showToast(`CEP ${zipCode} copiado para a área de transferência.`);
    } catch (err) {
      console.error("Failed to copy zip code: ", err);
      showToast("Erro ao copiar o CEP.", "error");
    }
  }
});

// =============================================================================
// 09. MODULE: CEE MAP & SECTORS
// =============================================================================

let ceeSectorsCache = [];

async function loadCeeSectors() {
  const { data, error } = await sb
    .from("cee_sectors")
    .select("id, code, label, base_start, base_end, current_offset")
    .order("display_order");

  if (error) {
    console.error("Failed to load CEE sectors:", error);
    showToast(`Erro ao carregar setores: ${error.message}`, "error");
    return;
  }

  ceeSectorsCache = data || [];
  renderCeeSectorCells();
  renderCeeOffsetCheckboxes();
}

function renderCeeSectorCells() {
  ceeSectorsCache.forEach((sector) => {
    const effectiveStart = sector.base_start + sector.current_offset;
    const effectiveEnd = sector.base_end + sector.current_offset;
    const offsetLabel =
      sector.current_offset > 0
        ? `+${sector.current_offset}`
        : `${sector.current_offset}`;

    qsa(`.cee-sector[data-sector="${sector.code}"]`).forEach((cell) => {
      cell.innerHTML = `
        <span class="cee-sector-code">${escapeHtml(sector.label)}</span>
        <span class="cee-sector-range">(${effectiveStart}-${effectiveEnd})</span>
        <span class="cee-sector-offset-badge ${sector.current_offset === 0 ? "hidden" : ""}">${offsetLabel}</span>
      `;
    });
  });
}

function renderCeeOffsetCheckboxes() {
  const container = qs("#cee-offset-sectors");
  if (!container) return;

  if (ceeSectorsCache.length === 0) {
    container.innerHTML =
      '<span class="empty-state">Nenhum setor cadastrado.</span>';
    return;
  }

  container.innerHTML = ceeSectorsCache
    .map(
      (sector) => `
    <label class="cee-offset-checkbox">
      <input type="checkbox" value="${sector.code}">
      Setor ${escapeHtml(sector.label)}
      <span class="cee-offset-checkbox-offset">${sector.current_offset !== 0 ? `(atual: ${sector.current_offset > 0 ? "+" : ""}${sector.current_offset})` : ""}</span>
    </label>
  `,
    )
    .join("");
}

function getCheckedCeeSectorCodes() {
  return qsa('#cee-offset-sectors input[type="checkbox"]:checked').map(
    (el) => el.value,
  );
}

async function applyCeeOffset() {
  const valueInput = qs("#cee-offset-value");
  const offsetValue = Number(valueInput.value);

  if (
    !valueInput.value.trim() ||
    Number.isNaN(offsetValue) ||
    offsetValue === 0
  ) {
    showToast("Informe um valor de offset diferente de zero.", "error");
    return;
  }

  const codes = getCheckedCeeSectorCodes();
  if (codes.length === 0) {
    showToast("Selecione ao menos um setor para receber o offset.", "error");
    return;
  }

  for (const code of codes) {
    const sector = ceeSectorsCache.find((s) => s.code === code);
    if (!sector) continue;
    const newOffset = sector.current_offset + offsetValue;
    const { error } = await sb
      .from("cee_sectors")
      .update({ current_offset: newOffset })
      .eq("id", sector.id);
    if (error) {
      showToast(
        `Erro ao aplicar offset no setor ${sector.label}: ${error.message}`,
        "error",
      );
      return;
    }
  }

  valueInput.value = "";
  showToast("Offset aplicado com sucesso!");
  await loadCeeSectors();
}

async function resetCeeOffset() {
  const codes = getCheckedCeeSectorCodes();
  if (codes.length === 0) {
    showToast("Selecione ao menos um setor para zerar o offset.", "error");
    return;
  }

  for (const code of codes) {
    const sector = ceeSectorsCache.find((s) => s.code === code);
    if (!sector) continue;
    const { error } = await sb
      .from("cee_sectors")
      .update({ current_offset: 0 })
      .eq("id", sector.id);
    if (error) {
      showToast(
        `Erro ao zerar offset do setor ${sector.label}: ${error.message}`,
        "error",
      );
      return;
    }
  }

  showToast("Offset zerado para os setores selecionados.");
  await loadCeeSectors();
}

const btnCeeOffsetApply = qs("#cee-offset-apply");
if (btnCeeOffsetApply)
  btnCeeOffsetApply.addEventListener("click", applyCeeOffset);

const btnCeeOffsetReset = qs("#cee-offset-reset");
if (btnCeeOffsetReset)
  btnCeeOffsetReset.addEventListener("click", resetCeeOffset);

// =============================================================================
// 10. MODULE: DAILY OPERATIONS (CEE)
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
  await loadDailyOps();
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
    await loadDailyOps();
  });
}

// --- LOEC Records ---

let loecChartInstance = null;
// Chart.js instances created inside the LOEC report modal (total + per-sector charts).
// closeModal() destroys these whenever the modal is dismissed, regardless of which
// modal is currently open, so it's safe to just keep pushing into this array.
let loecReportChartInstances = [];

async function loadDailyScans(date) {
  const tbody = qs("#daily-scans-tbody");
  const emptyEl = qs("#daily-scans-empty");
  tbody.innerHTML =
    '<tr class="loading-row"><td colspan="4">Loading&hellip;</td></tr>';

  const { data, error } = await sb
    .from("daily_object_scans")
    .select("*")
    .eq("log_date", date)
    .order("scan_time", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar dados: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  dailyScansCache = data || [];
  emptyEl.classList.toggle("hidden", dailyScansCache.length > 0);

  // Render Table (most recent scan first)
  tbody.innerHTML = dailyScansCache
    .map(
      (s) => `
    <tr>
      <td>${formatTimeShort(s.scan_time)}</td>
      <td><span class="count-badge">${s.object_count}</span></td>
      <td>
        ${escapeHtml(s.notes || "")}
        ${s.source_type === "loec_paste" ? '<span class="loec-source-tag">LOEC colada</span>' : ""}
      </td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-view-scan="${s.id}">Detalhes</button>
          <button class="btn btn-danger btn-icon" data-delete-scan="${s.id}">Excluir</button>
        </span>
      </td>
    </tr>
  `,
    )
    .join("");

  // Render Chart (chronological order, oldest to newest, regardless of table sort order)
  const chronological = [...dailyScansCache].sort((a, b) =>
    a.scan_time.localeCompare(b.scan_time),
  );
  renderLoecChart(chronological);
}

function renderLoecChart(records) {
  const ctx = qs("#loec-chart");
  if (!ctx) return;

  // Destroy previous chart instance if it exists to avoid overlapping renders
  if (loecChartInstance) {
    loecChartInstance.destroy();
  }

  const labels = records.map((r) => formatTimeShort(r.scan_time));
  const dataPoints = records.map((r) => r.object_count);

  loecChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Objetos na LOECs",
          data: dataPoints,
          borderColor: "#00447c",
          backgroundColor: "rgba(0, 68, 124, 0.1)",
          borderWidth: 2,
          fill: true,
          tension: 0.3, // Adds a slight curve to the line
          pointBackgroundColor: "#ffcc00",
          pointBorderColor: "#00447c",
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0 },
        },
      },
      plugins: {
        legend: { display: false },
      },
    },
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

function openScanForm() {
  openModal("Registrar LOECs", scanFormTemplate());
  qs("#scan-cancel").addEventListener("click", closeModal);
  qs("#scan-form").addEventListener("submit", submitScanForm);
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
      side: tokens[1].toUpperCase(),
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
      side: overallMostOverdue.side,
      value: overallMostOverdue.overdue,
    }
    : null;
  total.district_most_today = overallMostToday
    ? {
      district: overallMostToday.district,
      side: overallMostToday.side,
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
            side: mostOverdue.side,
            value: mostOverdue.overdue,
          }
          : null,
        district_most_today: mostToday
          ? {
            district: mostToday.district,
            side: mostToday.side,
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
    notes: `${report.total.district_count} distritos colados`,
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
      <td>${d.points}</td>
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
      <td>${escapeHtml(m.carteiro_name)}</td>
      <td><span class="count-badge">${m.malote_count}</span></td>
      <td>${escapeHtml(m.notes || "")}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-malote="${m.id}">Excluir</button></td>
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

function openMaloteForm() {
  openModal("Registrar Malote", maloteFormTemplate());
  qs("#malote-cancel").addEventListener("click", closeModal);
  qs("#malote-form").addEventListener("submit", submitMaloteForm);
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
  await loadDailyOps();
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
    await loadDailyOps();
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

  dailyNotesEditor.enable();

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

qs("#btn-new-scan").addEventListener("click", openScanForm);
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

qs("#btn-new-malote").addEventListener("click", openMaloteForm);
qs("#daily-malotes-tbody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-delete-malote]");
  if (btn) deleteDailyMalote(btn.dataset.deleteMalote);
});

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

// =============================================================================
// 11. MODULE: STATISTICS DASHBOARD
// =============================================================================

async function loadStatistics() {
  const { data: globalData, error: globalError } = await sb
    .from("stats_global_counts")
    .select("*")
    .single();
  if (!globalError && globalData) {
    qs("#stat-total-streets").textContent = globalData.total_streets;
    qs("#stat-total-zips").textContent = globalData.total_zips;
    qs("#stat-total-rules").textContent = globalData.total_rules;
  } else if (globalError)
    console.error("Failed to load global stats:", globalError);

  const { data: neighborhoodData, error: neighborhoodError } = await sb
    .from("stats_neighborhoods")
    .select("*")
    .limit(10);
  if (!neighborhoodError && neighborhoodData) {
    qs("#stat-neighborhoods-tbody").innerHTML = neighborhoodData
      .map(
        (n) => `
      <tr>
        <td>${escapeHtml(n.neighborhood_name)}</td>
        <td class="col-actions"><span class="count-badge">${n.street_count}</span></td>
      </tr>
    `,
      )
      .join("");
  } else if (neighborhoodError)
    console.error("Failed to load top neighborhoods:", neighborhoodError);

  const { data: topStreetsData, error: topStreetsError } = await sb
    .from("streets_with_zip_count")
    .select("name, zip_count")
    .order("zip_count", { ascending: false })
    .limit(10);
  if (!topStreetsError && topStreetsData) {
    qs("#stat-top-streets-tbody").innerHTML = topStreetsData
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td class="col-actions"><span class="count-badge">${s.zip_count}</span></td>
      </tr>
    `,
      )
      .join("");
  } else if (topStreetsError)
    console.error("Failed to load top streets:", topStreetsError);

  const { data: topConsultedData, error: topConsultedError } = await sb
    .from("top_consulted_streets")
    .select("name, consultation_count")
    .order("consultation_count", { ascending: false })
    .limit(10);
  if (!topConsultedError && topConsultedData) {
    qs("#stat-top-consulted-tbody").innerHTML = topConsultedData
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td class="col-actions"><span class="count-badge">${s.consultation_count}</span></td>
      </tr>
    `,
      )
      .join("");
  } else if (topConsultedError)
    console.error("Failed to load top consulted streets:", topConsultedError);
}

// =============================================================================
// 12. MODULE: BUG REPORTS
// =============================================================================

function bugReportFormTemplate() {
  return `
    <form id="bug-report-form">
      <div class="field">
        <label for="bug-title">Título (Obrigatório)</label>
        <input type="text" id="bug-title" required placeholder="Ex: Erro ao buscar logradouro na aba 2">
      </div>
      <div class="field">
        <label for="bug-description">Descrição (Obrigatório)</label>
        <textarea id="bug-description" required rows="5" placeholder="Descreva os passos para reproduzir o problema..."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="bug-cancel">Cancelar</button>
        <button type="submit" class="btn btn-danger">Enviar Report</button>
      </div>
    </form>
  `;
}

function openBugReportForm() {
  openModal("Reportar um Bug", bugReportFormTemplate());
  qs("#bug-cancel").addEventListener("click", closeModal);
  qs("#bug-report-form").addEventListener("submit", submitBugReportForm);
}

async function submitBugReportForm(e) {
  e.preventDefault();
  const title = qs("#bug-title").value.trim();
  const description = qs("#bug-description").value.trim();
  const payload = { title, description };

  const { error } = await sb.from("bug_reports").insert(payload);

  if (error) {
    showToast(`Error saving bug report: ${error.message}`, "error");
    return;
  }

  closeModal();
  showToast("Bug report enviado com sucesso!");
}

const btnReportBug = qs("#btn-report-bug");
if (btnReportBug) {
  btnReportBug.addEventListener("click", openBugReportForm);
}

// =============================================================================
// MODULE: MANUAL / ABOUT PAGE (MARKDOWN RENDERER)
// =============================================================================

async function loadAboutPage() {
  const container = qs("#about-content");

  // Prevent fetching the file again if it's already loaded
  if (container.dataset.loaded === "true") return;

  try {
    // Fetch the README.md file from the root directory
    // Since it's on GitHub Pages, './README.md' points to the public file
    const response = await fetch("./README.md");

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const markdownText = await response.text();

    // Convert Markdown to HTML using marked.js
    container.innerHTML = marked.parse(markdownText);

    // Flag as loaded to avoid unnecessary network requests on future tab clicks
    container.dataset.loaded = "true";
  } catch (error) {
    console.error("Failed to load README.md:", error);
    container.innerHTML = `
      <div class="field-error" style="display: block; padding: 20px; text-align: center;">
        <strong>Error loading the manual.</strong><br> 
        Please check if README.md exists at the project root.
      </div>`;
  }
}

// =============================================================================
// 13. APP INITIALIZATION
// =============================================================================

async function init() {
  const placeholderUrl = SUPABASE_URL.includes("YOUR-PROJECT");
  const placeholderKey = SUPABASE_ANON_KEY.includes("YOUR-ANON");
  if (placeholderUrl || placeholderKey) {
    qs("#config-banner").classList.remove("hidden");
  }

  const dailyOpsDateEl = qs("#daily-ops-date");
  if (dailyOpsDateEl && !dailyOpsDateEl.value)
    dailyOpsDateEl.value = todayIsoDate();

  await loadZips(0);
  await loadRules();
  await loadStatistics();
  initSupabasePing();
}

// Initialize connection quality ping
function initSupabasePing() {
  const dot = qs('#ping-dot');
  const text = qs('#ping-text');

  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;

    const start = performance.now();

    try {
      // Execute the RPC call to retrieve the PostgreSQL version
      const { data, error } = await sb.rpc('get_pg_version');

      const end = performance.now();
      const latency = Math.round(end - start);

      if (error) {
        throw error;
      }

      // Update the UI based on latency
      text.textContent = `${latency}ms`;
      if (latency < 200) {
        dot.className = 'ping-dot ping-green';
      } else if (latency < 800) {
        dot.className = 'ping-dot ping-yellow';
      } else {
        dot.className = 'ping-dot ping-red';
      }

    } catch (error) {
      // Only log the error if you need to debug connection issues
      // console.error('Ping query failed:', error);
      dot.className = 'ping-dot ping-red';
      text.textContent = 'Err';
    }
  }, 1500);
}

init();