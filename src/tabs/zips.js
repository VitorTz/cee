// =============================================================================
// MODULE: ZIP CODES (CRUD)
// =============================================================================

import { qs, normalizeSearchTerm, digitsToZipPattern, normalizeZipDigits, escapeHtml, formatNeighborhoods, attachZipMask, ZIP_REGEX } from "../utils.js";
import { initStreetCombobox } from "../combobox.js";
import { showToast, openModal, closeModal, openDeleteConfirm } from "../ui.js";
import { goToCepSearch } from "./cep-search.js";
import { rulesFilterStreetId, loadRulesFilterZipOptions } from "./rules.js";
import { sb } from "../supabase-client.js";

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

export async function loadZips(page = 0) {
  const tbody = qs("#zips-tbody");
  const emptyEl = qs("#zips-empty");
  zipsPage = page;
  tbody.innerHTML =
    '<tr class="loading-row"><td colspan="4">Carregando logradouros&hellip;</td></tr>';

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
  qs("#zips-page-info").textContent = `Página ${zipsPage + 1} de ${totalPages} · ${zipsTotalCount} ${countLabel}`;
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