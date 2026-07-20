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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); 
  
  return withoutAccents.replace(/[^a-z0-9]+/g, '%');
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNeighborhoods(neighborhoods) {
  if (Array.isArray(neighborhoods)) return neighborhoods.join(', ');
  return neighborhoods || '—';
}

// --- ZIP Code Normalization ---
const ZIP_REGEX = /^880[0-6][0-9]-[0-9]{3}$/;

function normalizeZipDigits(raw) {
  let digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (!digits.startsWith('880')) {
    digits = `880${digits}`;
  }
  return digits.slice(0, 8);
}

function digitsToZipPattern(digits) {
  if (!digits) return '';
  if (digits.length > 5) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return digits;
}

function attachZipMask(inputEl) {
  inputEl.addEventListener('input', () => {
    let digits = inputEl.value.replace(/\D/g, '').slice(0, 8);
    if (digits.length > 5) digits = `${digits.slice(0, 5)}-${digits.slice(5)}`;
    inputEl.value = digits;
  });
  inputEl.addEventListener('blur', () => {
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
  if (!value) return '&mdash;';
  return value.slice(0, 5);
}

// =============================================================================
// 03. UI SYSTEM: TOASTS, MODALS, TABS & HOTKEYS
// =============================================================================

// --- Toasts ---
function showToast(message, type = 'success') {
  const container = qs('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'toast-error' : ''}`.trim();
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

// --- Modals ---
const modalOverlay = qs('#modal-overlay');
const modalTitleEl = qs('#modal-title');
const modalBodyEl = qs('#modal-body');

function openModal(title, bodyHtml) {
  modalTitleEl.textContent = title;
  modalBodyEl.innerHTML = bodyHtml;
  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalBodyEl.innerHTML = '';
}

qs('#modal-close').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeModal();
});

function deleteConfirmTemplate(label, warning) {
  return `
    <p class="confirm-text">Confirma a exclusão de <strong>${escapeHtml(label)}</strong>?</p>
    ${warning ? `<p class="confirm-warning">${warning}</p>` : ''}
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" id="confirm-cancel">Cancelar</button>
      <button type="button" class="btn btn-danger" id="confirm-delete">Excluir</button>
    </div>
  `;
}

function openDeleteConfirm(label, warning, onConfirm) {
  openModal('Confirmar exclusão', deleteConfirmTemplate(label, warning));
  qs('#confirm-cancel').addEventListener('click', closeModal);
  qs('#confirm-delete').addEventListener('click', onConfirm);
}

// --- Tabs ---
qsa('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  qsa('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  
  qsa('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tab}`));

  if (tab === 'stats') loadStatistics();
  if (tab === 'cee-map') loadCeeSectors();
  if (tab === 'daily-ops') loadDailyOps();
  if (tab === 'about') loadAboutPage();
}

// --- Global Hotkeys ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'F4') {
    e.preventDefault();
    
    qsa('input, select, textarea').forEach(el => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = false;
      } else {
        el.value = '';
      }
    });

    if (typeof rulesFilterCombobox !== 'undefined' && rulesFilterCombobox.setValue) {
      rulesFilterCombobox.setValue(null);
    }
    
    if (typeof rulesFilterStreetId !== 'undefined') rulesFilterStreetId = '';
    if (typeof rulesFilterZipId !== 'undefined') rulesFilterZipId = '';
    
    if (typeof resetRulesFilterZipSelect === 'function') resetRulesFilterZipSelect();
    
    if (typeof cepSearchState !== 'undefined') {
      cepSearchState = { streetId: null, street: null, breakdown: [], searchLogged: false };
    }
    
    const resultsEl = qs('#cepsearch-results');
    const emptyEl = qs('#cepsearch-empty');
    if (resultsEl) resultsEl.classList.add('hidden');
    if (emptyEl) emptyEl.classList.remove('hidden');

    if (typeof loadZips === 'function') loadZips(0);
    if (typeof loadRules === 'function') loadRules();

    const dailyOpsDateEl = qs('#daily-ops-date');
    if (dailyOpsDateEl && typeof loadDailyOps === 'function') {
      dailyOpsDateEl.value = todayIsoDate();
      loadDailyOps();
    }

    if (typeof loadCeeSectors === 'function') loadCeeSectors();

    showToast('Todos os campos e filtros foram limpos.');
  }
});

const tabKeyMap = { '1': 'zips', '2': 'cepsearch', '3': 'rules', '4': 'stats', '5': 'cee-map', '6': 'daily-ops', '7': 'about' };

document.addEventListener('keydown', (e) => {
  const activeElement = document.activeElement;
  const isInputFocused = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    activeElement.tagName === 'SELECT' ||
    activeElement.isContentEditable
  );

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
  
  const { data, error } = await sb
    .from('streets')
    .select('id, name, neighborhood')
    .ilike('search_text', `%${wildcardTerm}%`)
    .order('name')
    .limit(limit);
    
  if (error) {
    console.error('Street search failed:', error);
    return [];
  }
  return data;
}

function initStreetCombobox({ inputEl, suggestionsEl, onSelect }) {
  let debounceHandle = null;
  let activeIndex = -1;
  let currentMatches = [];
  let selected = null;

  function closeSuggestions() {
    suggestionsEl.innerHTML = '';
    suggestionsEl.classList.add('hidden');
    activeIndex = -1;
    currentMatches = [];
  }

  function updateActiveHighlight() {
    qsa('.combobox-suggestion', suggestionsEl).forEach((btn, i) => {
      btn.classList.toggle('active', i === activeIndex);
    });
  }

  function renderSuggestions(matches) {
    currentMatches = matches;
    activeIndex = -1;
    if (matches.length === 0) {
      suggestionsEl.innerHTML = '<div class="combobox-empty">Nenhum logradouro encontrado.</div>';
      suggestionsEl.classList.remove('hidden');
      return;
    }
    suggestionsEl.innerHTML = matches
      .map(
        (s, i) => `
      <button type="button" class="combobox-suggestion" data-index="${i}">
        <span class="combobox-suggestion-name">${escapeHtml(s.name)}</span>
        <span class="combobox-suggestion-sub">${escapeHtml(formatNeighborhoods(s.neighborhood))}</span>
      </button>
    `
      )
      .join('');
    suggestionsEl.classList.remove('hidden');
  }

  function pick(street) {
    selected = street;
    inputEl.value = street.name;
    closeSuggestions();
    onSelect(street);
  }

  inputEl.addEventListener('input', () => {
    if (selected && inputEl.value !== selected.name) {
      selected = null;
      onSelect(null);
    }
    clearTimeout(debounceHandle);
    const term = inputEl.value;
    debounceHandle = setTimeout(async () => {
      const matches = await searchStreetsByTerm(term);
      renderSuggestions(matches);
    }, 280);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (suggestionsEl.classList.contains('hidden') || currentMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
      updateActiveHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveHighlight();
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        pick(currentMatches[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      closeSuggestions();
    }
  });

  suggestionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.combobox-suggestion');
    if (!btn) return;
    pick(currentMatches[Number(btn.dataset.index)]);
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(closeSuggestions, 150);
  });

  return {
    setValue(street) {
      selected = street;
      inputEl.value = street ? street.name : '';
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
  openModal('Novo Logradouro', streetFormTemplate());
  qs('#street-cancel').addEventListener('click', closeModal);
  qs('#street-form').addEventListener('submit', submitStreetForm);
}

async function submitStreetForm(e) {
  e.preventDefault();
  
  const name = qs('#street-name').value.trim();
  const neighborhoodRaw = qs('#street-neighborhood').value;
  const descr = qs('#street-descr').value.trim() || null;
  
  const neighborhood = neighborhoodRaw.split(',').map(n => n.trim()).filter(n => n);
  const payload = { name, neighborhood, descr };
  
  const { error } = await sb.from('streets').insert(payload);
  
  if (error) {
    showToast(`Error saving street: ${error.message}`, 'error');
    return;
  }
  
  closeModal();
  showToast('Logradouro cadastrado com sucesso!');
}

const btnNewStreet = qs('#btn-new-street');
if (btnNewStreet) btnNewStreet.addEventListener('click', openStreetForm);

// =============================================================================
// 06. MODULE: ZIP CODES (CRUD)
// =============================================================================

const ZIPS_PAGE_SIZE = 32;
let zipsSearchTerm = '';
let zipsPage = 0;
let zipsTotalCount = 0;
let zipsSearchDebounce = null;

async function loadZipsLite(filterStreetId = '') {
  let query = sb.from('zip_codes').select('id, zip_code, street_id, streets(name)').order('zip_code');
  if (filterStreetId) query = query.eq('street_id', filterStreetId);
  const { data, error } = await query;
  if (error) {
    console.error('Failed to load zip codes for dropdowns:', error);
    return [];
  }
  return data;
}

function populateZipSelect(selectEl, zipList, selectedId) {
  const options = ['<option value="">Selecione um CEP&hellip;</option>'].concat(
    zipList.map(
      (z) =>
        `<option value="${z.id}" ${String(z.id) === String(selectedId) ? 'selected' : ''}>${z.zip_code} &mdash; ${escapeHtml(
          z.streets ? z.streets.name : ''
        )}</option>`
    )
  );
  selectEl.innerHTML = options.join('');
}

async function loadZips(page = 0) {
  const tbody = qs('#zips-tbody');
  const emptyEl = qs('#zips-empty');
  zipsPage = page;
  tbody.innerHTML = '<tr class="loading-row"><td colspan="4">Carregando manifesto&hellip;</td></tr>';

  const term = zipsSearchTerm.trim();
  const from = page * ZIPS_PAGE_SIZE;
  const to = from + ZIPS_PAGE_SIZE - 1;

  let query = sb
    .from('zip_codes')
    .select('id, zip_code, street_id, streets(name, neighborhood)', { count: 'exact' })
    .order('zip_code');

  if (term) {
    const wildcardTerm = normalizeSearchTerm(term);
    
    const { data: streetMatches, error: streetError } = await sb
      .from('streets')
      .select('id')
      .ilike('search_text', `%${wildcardTerm}%`);

    if (streetError) {
      tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar CEPs: ${escapeHtml(streetError.message)}</td></tr>`;
      return;
    }

    const streetIds = (streetMatches || []).map((s) => s.id);
    const digits = term.replace(/\D/g, '');
    const orParts = [];
    
    if (digits) {
      const pattern = digitsToZipPattern(normalizeZipDigits(term));
      orParts.push(`zip_code.ilike.%${pattern}%`);
    }
    if (streetIds.length) orParts.push(`street_id.in.(${streetIds.join(',')})`);

    if (orParts.length === 0) {
      zipsTotalCount = 0;
      emptyEl.classList.remove('hidden');
      tbody.innerHTML = '';
      renderZipsPagination();
      return;
    }
    query = query.or(orParts.join(','));
  }

  query = query.range(from, to);
  const { data, error, count } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar CEPs: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  zipsTotalCount = count || 0;
  emptyEl.classList.toggle('hidden', data.length > 0);
  tbody.innerHTML = data
    .map(
      (z) => `
    <tr>
      <td class="zip-code-cell">${z.zip_code}</td>
      <td>${escapeHtml(z.streets ? z.streets.name : '&mdash;')}</td>
      <td>${escapeHtml(z.streets ? formatNeighborhoods(z.streets.neighborhood) : '&mdash;')}</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-view-zip="${z.id}" data-zip-value="${z.zip_code}">Consultar</button>
          <button class="btn btn-secondary btn-icon" data-edit-zip="${z.id}">Editar</button>
        </span>
      </td>
    </tr>
  `
    )
    .join('');

  renderZipsPagination();
}

function renderZipsPagination() {
  const totalPages = Math.max(1, Math.ceil(zipsTotalCount / ZIPS_PAGE_SIZE));
  const countLabel = zipsTotalCount === 1 ? 'CEP' : 'CEPs';
  qs('#zips-page-info').textContent = `Página ${zipsPage + 1} de ${totalPages} · ${zipsTotalCount} ${countLabel}`;
  qs('#zips-prev').disabled = zipsPage <= 0;
  qs('#zips-next').disabled = zipsPage + 1 >= totalPages;
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
               value="${record ? record.zip_code : ''}" maxlength="9" required>
        <p class="field-hint">Basta digitar os 5 últimos números &mdash; o prefixo 880 é adicionado automaticamente.</p>
        <p class="field-error">CEP fora do formato ou da faixa permitida para a ilha.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="zip-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${record ? 'Salvar alterações' : 'Cadastrar CEP'}</button>
      </div>
    </form>
  `;
}

async function openZipForm(record = null) {
  openModal(record ? 'Editar CEP' : 'Novo CEP', zipFormTemplate(record));
  attachZipMask(qs('#zip-code-input'));

  const streetCombobox = initStreetCombobox({
    inputEl: qs('#zip-street-search'),
    suggestionsEl: qs('#zip-street-suggestions'),
    onSelect: () => qs('#zip-street-search').closest('.field').classList.remove('has-error'),
  });
  if (record && record.streets) {
    streetCombobox.setValue({ id: record.street_id, name: record.streets.name });
  }

  qs('#zip-cancel').addEventListener('click', closeModal);
  qs('#zip-form').addEventListener('submit', (e) => submitZipForm(e, record, streetCombobox));
}

async function submitZipForm(e, record, streetCombobox) {
  e.preventDefault();
  const selectedStreet = streetCombobox.getSelected();
  const streetField = qs('#zip-street-search').closest('.field');
  if (!selectedStreet) {
    streetField.classList.add('has-error');
    return;
  }
  streetField.classList.remove('has-error');

  const zipInput = qs('#zip-code-input');
  const normalizedZip = digitsToZipPattern(normalizeZipDigits(zipInput.value));
  zipInput.value = normalizedZip;
  const zipField = qs('#zip-code-field');

  if (!ZIP_REGEX.test(normalizedZip)) {
    zipField.classList.add('has-error');
    return;
  }
  zipField.classList.remove('has-error');

  const payload = { street_id: selectedStreet.id, zip_code: normalizedZip };
  const query = record
    ? sb.from('zip_codes').update(payload).eq('id', record.id)
    : sb.from('zip_codes').insert(payload);
  const { error } = await query;

  if (error) {
    showToast(`Erro ao salvar CEP: ${error.message}`, 'error');
    return;
  }
  closeModal();
  showToast(record ? 'CEP atualizado.' : 'CEP cadastrado.');
  await loadZips(zipsPage);
  if (rulesFilterStreetId) await loadRulesFilterZipOptions(rulesFilterStreetId);
}

async function deleteZip(id, label) {
  openDeleteConfirm(`CEP ${label}`, 'Excluir este CEP também remove as regras de numeração vinculadas a ele.', async () => {
    const { error } = await sb.from('zip_codes').delete().eq('id', id);
    if (error) {
      showToast(`Erro ao excluir: ${error.message}`, 'error');
      return;
    }
    closeModal();
    showToast('CEP excluído.');
    await loadZips(zipsPage);
    if (rulesFilterStreetId) await loadRulesFilterZipOptions(rulesFilterStreetId);
  });
}

// Zips Event Listeners
qs('#zips-search').addEventListener('input', (e) => {
  clearTimeout(zipsSearchDebounce);
  const value = e.target.value;
  zipsSearchDebounce = setTimeout(() => {
    zipsSearchTerm = value;
    loadZips(0);
  }, 320);
});

qs('#zips-prev').addEventListener('click', () => {
  if (zipsPage > 0) loadZips(zipsPage - 1);
});
qs('#zips-next').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(zipsTotalCount / ZIPS_PAGE_SIZE));
  if (zipsPage + 1 < totalPages) loadZips(zipsPage + 1);
});

qs('#btn-new-zip').addEventListener('click', () => openZipForm());

qs('#zips-tbody').addEventListener('click', (e) => {
  const viewBtn = e.target.closest('[data-view-zip]');
  const editBtn = e.target.closest('[data-edit-zip]');
  const deleteBtn = e.target.closest('[data-delete-zip]');

  if (viewBtn) {
    goToCepSearch(viewBtn.dataset.zipValue);
    return;
  }
  if (editBtn) {
    const id = editBtn.dataset.editZip;
    sb.from('zip_codes')
      .select('id, zip_code, street_id, streets(name)')
      .eq('id', id)
      .single()
      .then(({ data, error }) => {
        if (error) {
          showToast(`Erro ao carregar CEP: ${error.message}`, 'error');
          return;
        }
        openZipForm(data);
      });
  }
  if (deleteBtn) deleteZip(deleteBtn.dataset.deleteZip, deleteBtn.dataset.zipLabel);
});

// =============================================================================
// 07. MODULE: NUMBERING RULES (CRUD)
// =============================================================================

const RULES_PAGE_SIZE = 25;
let rulesFilterStreetId = '';
let rulesFilterZipId = '';
let rulesPage = 0;
let rulesTotalCount = 0;
let rulesCache = [];

const rulesFilterZipSelect = qs('#rules-filter-zip');

function resetRulesFilterZipSelect() {
  rulesFilterZipSelect.innerHTML = '<option value="">Selecione um logradouro&hellip;</option>';
  rulesFilterZipSelect.disabled = true;
}

async function loadRulesFilterZipOptions(streetId) {
  if (!streetId) {
    resetRulesFilterZipSelect();
    return;
  }
  rulesFilterZipSelect.disabled = true;
  rulesFilterZipSelect.innerHTML = '<option value="">Carregando CEPs&hellip;</option>';
  const zipList = await loadZipsLite(streetId);
  const options = ['<option value="">Todos os CEPs deste logradouro</option>'].concat(
    zipList.map((z) => `<option value="${z.id}">${z.zip_code}</option>`)
  );
  rulesFilterZipSelect.innerHTML = options.join('');
  rulesFilterZipSelect.disabled = zipList.length === 0;
}

const rulesFilterCombobox = initStreetCombobox({
  inputEl: qs('#rules-filter-street-search'),
  suggestionsEl: qs('#rules-filter-street-suggestions'),
  onSelect: async (street) => {
    rulesFilterStreetId = street ? street.id : '';
    rulesFilterZipId = '';
    await loadRulesFilterZipOptions(rulesFilterStreetId);
    await loadRules();
  },
});

async function loadRules(page = 0) {
  const tbody = qs('#rules-tbody');
  const emptyEl = qs('#rules-empty');
  
  rulesPage = page;
  tbody.innerHTML = '<tr class="loading-row"><td colspan="7">Loading manifest&hellip;</td></tr>';

  const from = page * RULES_PAGE_SIZE;
  const to = from + RULES_PAGE_SIZE - 1;

  let query = sb
    .from('numbering_rules')
    .select('id, start_number, end_number, side, description, zip_code_id, zip_codes(id, zip_code, street_id, streets(name))', { count: 'exact' })
    .order('id');

  if (rulesFilterZipId) {
    query = query.eq('zip_code_id', rulesFilterZipId);
  } else if (rulesFilterStreetId) {
    const zipList = await loadZipsLite(rulesFilterStreetId);
    const zipIds = zipList.map((z) => z.id);
    
    if (zipIds.length === 0) {
      rulesCache = [];
      rulesTotalCount = 0;
      emptyEl.classList.remove('hidden');
      tbody.innerHTML = '';
      renderRulesPagination();
      return;
    }
    query = query.in('zip_code_id', zipIds);
  }

  query = query.range(from, to);
  const { data, error, count } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="7">Error loading rules: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  rulesTotalCount = count || 0;
  rulesCache = data;
  
  emptyEl.classList.toggle('hidden', data.length > 0);
  
  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td class="zip-code-cell">${r.zip_codes ? r.zip_codes.zip_code : '&mdash;'}</td>
      <td>${escapeHtml(r.zip_codes && r.zip_codes.streets ? r.zip_codes.streets.name : '&mdash;')}</td>
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
  `
    )
    .join('');

  renderRulesPagination();
}

function renderRulesPagination() {
  const totalPages = Math.max(1, Math.ceil(rulesTotalCount / RULES_PAGE_SIZE));
  const countLabel = rulesTotalCount === 1 ? 'Regra' : 'Regras';
  
  qs('#rules-page-info').textContent = `Página ${rulesPage + 1} de ${totalPages} · ${rulesTotalCount} ${countLabel}`;
  qs('#rules-prev').disabled = rulesPage <= 0;
  qs('#rules-next').disabled = rulesPage + 1 >= totalPages;
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
          <input id="rule-start" type="number" min="0" placeholder="Opcional" value="${record && record.start_number !== null ? record.start_number : ''}">
        </div>
        <div class="field">
          <label for="rule-end">Número final</label>
          <input id="rule-end" type="number" min="0" placeholder="Opcional" value="${record && record.end_number !== null ? record.end_number : ''}">
        </div>
      </div>
      <p class="field-error" id="rule-order-error">O número inicial deve ser menor ou igual ao final.</p>
      
      <div class="field">
        <label for="rule-side">Lado da rua</label>
        <select id="rule-side">
          <option value="both" ${!record || record.side === 'both' ? 'selected' : ''}>Ambos</option>
          <option value="odd" ${record && record.side === 'odd' ? 'selected' : ''}>Ímpar</option>
          <option value="even" ${record && record.side === 'even' ? 'selected' : ''}>Par</option>
        </select>
      </div>
      
      <div class="field">
        <label for="rule-descr">Descrição</label>
        <input id="rule-descr" type="text" maxlength="255" placeholder="Ex.: Hospital, condomínio, prédio comercial&hellip;"
               value="${record && record.description ? escapeHtml(record.description) : ''}">
      </div>
      
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="rule-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${record ? 'Salvar alterações' : 'Cadastrar regra'}</button>
      </div>
    </form>
  `;
}

async function openRuleForm(record = null) {
  openModal(record ? 'Editar Regra de Numeração' : 'Nova Regra de Numeração', ruleFormTemplate(record));

  const zipSelect = qs('#rule-zip');

  async function loadCepOptionsForStreet(streetId, selectedZipId) {
    if (!streetId) {
      zipSelect.innerHTML = '<option value="">Selecione um logradouro primeiro&hellip;</option>';
      zipSelect.disabled = true;
      return;
    }
    zipSelect.disabled = true;
    zipSelect.innerHTML = '<option value="">Carregando CEPs&hellip;</option>';
    const zipList = await loadZipsLite(streetId);
    if (zipList.length === 0) {
      zipSelect.innerHTML = '<option value="">Este logradouro não tem CEPs cadastrados</option>';
      zipSelect.disabled = true;
      return;
    }
    populateZipSelect(zipSelect, zipList, selectedZipId);
    zipSelect.disabled = false;
  }

  const streetCombobox = initStreetCombobox({
    inputEl: qs('#rule-street-search'),
    suggestionsEl: qs('#rule-street-suggestions'),
    onSelect: (street) => {
      qs('#rule-street-search').closest('.field').classList.remove('has-error');
      loadCepOptionsForStreet(street ? street.id : null);
    },
  });

  if (record && record.zip_codes) {
    streetCombobox.setValue({ id: record.zip_codes.street_id, name: record.zip_codes.streets.name });
    await loadCepOptionsForStreet(record.zip_codes.street_id, record.zip_code_id);
  }

  qs('#rule-cancel').addEventListener('click', closeModal);
  qs('#rule-form').addEventListener('submit', (e) => submitRuleForm(e, record, streetCombobox));
}

async function submitRuleForm(e, record, streetCombobox) {
  e.preventDefault();

  const selectedStreet = streetCombobox.getSelected();
  const streetField = qs('#rule-street-search').closest('.field');
  if (!selectedStreet) {
    streetField.classList.add('has-error');
    return;
  }
  streetField.classList.remove('has-error');

  const zipCodeId = qs('#rule-zip').value;
  if (!zipCodeId) {
    showToast('Selecione um CEP para este logradouro.', 'error');
    return;
  }

  const startRaw = qs('#rule-start').value;
  const endRaw = qs('#rule-end').value;
  const side = qs('#rule-side').value;
  const description = qs('#rule-descr').value.trim() || null;
  
  let startNumber = startRaw === '' ? null : Number(startRaw);
  let endNumber = endRaw === '' ? null : Number(endRaw);
  
  if (Number.isNaN(startNumber)) startNumber = null;
  if (Number.isNaN(endNumber)) endNumber = null;

  if (startNumber === null && endNumber !== null) {
    startNumber = endNumber;
  } else if (endNumber === null && startNumber !== null) {
    endNumber = startNumber;
  }

  const orderError = qs('#rule-order-error');

  if (startNumber !== null && endNumber !== null && startNumber > endNumber) {
    orderError.style.display = 'block';
    return;
  }
  orderError.style.display = 'none';

  const payload = { zip_code_id: zipCodeId, start_number: startNumber, end_number: endNumber, side, description };
  const query = record
    ? sb.from('numbering_rules').update(payload).eq('id', record.id)
    : sb.from('numbering_rules').insert(payload);
  const { error } = await query;

  if (error) {
    showToast(`Erro ao salvar regra: ${error.message}`, 'error');
    return;
  }
  closeModal();
  showToast(record ? 'Regra atualizada.' : 'Regra cadastrada.');
  await loadRules(rulesPage);
}

async function deleteRule(id) {
  openDeleteConfirm('esta regra de numeração', null, async () => {
    const { error } = await sb.from('numbering_rules').delete().eq('id', id);
    if (error) {
      showToast(`Erro ao excluir: ${error.message}`, 'error');
      return;
    }
    closeModal();
    showToast('Regra excluída.');
    await loadRules(rulesPage);
  });
}

// Rules Event Listeners
qs('#rules-prev').addEventListener('click', () => {
  if (rulesPage > 0) loadRules(rulesPage - 1);
});

qs('#rules-next').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(rulesTotalCount / RULES_PAGE_SIZE));
  if (rulesPage + 1 < totalPages) loadRules(rulesPage + 1);
});

rulesFilterZipSelect.addEventListener('change', () => {
  rulesFilterZipId = rulesFilterZipSelect.value;
  loadRules(0);
});

qs('#rules-filter-clear').addEventListener('click', () => {
  rulesFilterStreetId = '';
  rulesFilterZipId = '';
  rulesFilterCombobox.setValue(null);
  resetRulesFilterZipSelect();
  loadRules(0);
});

qs('#btn-new-rule').addEventListener('click', () => openRuleForm());

qs('#rules-tbody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-rule]');
  const deleteBtn = e.target.closest('[data-delete-rule]');
  if (editBtn) {
    const record = rulesCache.find((r) => String(r.id) === editBtn.dataset.editRule);
    if (record) openRuleForm(record);
  }
  if (deleteBtn) deleteRule(deleteBtn.dataset.deleteRule);
});


// =============================================================================
// 08. MODULE: CEP SEARCH ENGINE
// =============================================================================

const SIDE_LABELS = { odd: 'Ímpar', even: 'Par', both: 'Ambos' };

let cepSearchState = { streetId: null, street: null, breakdown: [], searchLogged: false };
let cepSearchDebounce = null;

function goToCepSearch(zipCodeStr) {
  switchTab('cepsearch');
  qs('#cepsearch-query').value = zipCodeStr;
  qs('#cepsearch-number').value = '';
  resolveStreetForQuery(zipCodeStr, { focusNumber: true });
}

async function resolveStreetForQuery(term, opts = {}) {
  const trimmed = term.trim();
  const hintEl = qs('#cepsearch-match-hint');
  const numberInput = qs('#cepsearch-number');
  const resultsEl = qs('#cepsearch-results');
  const emptyEl = qs('#cepsearch-empty');

  if (!trimmed) {
    cepSearchState = { streetId: null, street: null, breakdown: [], searchLogged: false };
    hintEl.textContent = 'Digite para localizar o logradouro.';
    numberInput.disabled = true;
    resultsEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  hintEl.textContent = 'Buscando...';

  const wildcardTerm = normalizeSearchTerm(term);
  const digits = term.replace(/\D/g, '');

  const textPromise = sb
    .from('streets')
    .select('id, name, neighborhood, descr')
    .ilike('search_text', `%${wildcardTerm}%`)
    .order('name')
    .limit(5);

  let zipPromise = Promise.resolve({ data: [] });
  if (digits) {
    const pattern = digitsToZipPattern(normalizeZipDigits(trimmed));
    zipPromise = sb
      .from('zip_codes')
      .select('street_id, streets(id, name, neighborhood, descr)')
      .ilike('zip_code', `%${pattern}%`)
      .limit(5);
  }

  const [{ data: textMatches, error: textError }, { data: zipMatches, error: zipError }] = await Promise.all([textPromise, zipPromise]);

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
    cepSearchState = { streetId: null, street: null, breakdown: [], searchLogged: false };
    hintEl.textContent = 'Nenhum logradouro encontrado para esta busca.';
    numberInput.disabled = true;
    resultsEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
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
    .from('zip_codes')
    .select('id, zip_code, numbering_rules(id, start_number, end_number, side, description)')
    .eq('street_id', street.id)
    .order('zip_code');

  if (error) {
    showToast(`Erro ao carregar CEPs do logradouro: ${error.message}`, 'error');
    cepSearchState = { streetId: street.id, street, breakdown: [], searchLogged: false };
    return;
  }
  cepSearchState = { streetId: street.id, street, breakdown: data, searchLogged: false };
}

function findMatchingZip(breakdown, number) {
  for (const z of breakdown) {
    for (const r of z.numbering_rules || []) {
      const startOk = r.start_number === null || number >= r.start_number;
      const endOk = r.end_number === null || number <= r.end_number;
      if (!startOk || !endOk) continue;

      const parityOk = r.side === 'both' || (r.side === 'odd' && number % 2 === 1) || (r.side === 'even' && number % 2 === 0);
      if (parityOk) return z;
    }
  }
  return null;
}

function renderCepSearchResults() {
  const resultsEl = qs('#cepsearch-results');
  const emptyEl = qs('#cepsearch-empty');

  if (!cepSearchState.streetId) {
    resultsEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  const { street, breakdown } = cepSearchState;
  const numberRaw = qs('#cepsearch-number').value;
  const number = numberRaw === '' ? null : Number(numberRaw);
  const matchedZip = number !== null ? findMatchingZip(breakdown, number) : null;

  let displayBreakdown = [...breakdown];
  if (matchedZip) {
    displayBreakdown = displayBreakdown.filter(z => z.id !== matchedZip.id);
    displayBreakdown.unshift(matchedZip);
  }

  const blocksHtml = displayBreakdown
    .map((z) => {
      const isMatch = Boolean(matchedZip && matchedZip.id === z.id);
      const rulesHtml = (z.numbering_rules || [])
        .map((r) => {
          const start = r.start_number === null ? 'aberto' : r.start_number;
          const end = r.end_number === null ? 'aberto' : r.end_number;
          let label = '';
          
          if (r.start_number !== null && r.start_number === r.end_number) {
            label = `Número ${r.start_number}`;
          } else {
            label = `Faixa ${start}&ndash;${end}`;
          }
          
          const descr = r.description ? ` &middot; ${escapeHtml(r.description)}` : '';
          return `<li>${label} &middot; <span class="side-badge side-${r.side}">${SIDE_LABELS[r.side] || r.side}</span>${descr}</li>`;
        })
        .join('');
        
      const detailsHtml = rulesHtml
          ? `<ul class="zip-block-detail-list">${rulesHtml}</ul>`
          : '<p class="field-hint">Nenhuma regra cadastrada para este CEP.</p>';

      return `
      <div class="zip-block ${isMatch ? 'zip-block--match' : ''}">
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

  let notFoundMessageHtml = '';
  if (number !== null && !matchedZip) {
    notFoundMessageHtml = `
      <div class="zip-block zip-block--not-found" style="border-color: var(--stamp-red); background: #fbeae7;">
        <p class="field-error" style="display:block; margin:0; text-align:center;">
          Número <strong>${number}</strong> não encontrado nas faixas cadastradas.
        </p>
      </div>
    `;
  }

  resultsEl.innerHTML = `
    <div class="envelope-card">
      <div class="envelope-card-airmail" aria-hidden="true"></div>
      <div class="envelope-card-body">
        <p class="field-hint">Logradouro</p>
        <div class="address-window">${escapeHtml(street.name)}</div>
        <p class="field-hint" style="margin-top:10px;">${escapeHtml(formatNeighborhoods(street.neighborhood))}${
          street.descr ? ` &middot; ${escapeHtml(street.descr)}` : ''
        }</p>
        
        ${notFoundMessageHtml}
        ${blocksHtml || '<p class="field-hint">Este logradouro ainda não tem CEPs cadastrados.</p>'}
      </div>
    </div>
  `;
}

// CEP Search Event Listeners
qs('#cepsearch-query').addEventListener('input', (e) => {
  clearTimeout(cepSearchDebounce);
  const value = e.target.value;
  cepSearchDebounce = setTimeout(() => resolveStreetForQuery(value), 320);
});

qs('#cepsearch-number').addEventListener('input', async () => {
  renderCepSearchResults();
  
  const numberRaw = qs('#cepsearch-number').value;
  
  if (numberRaw.trim() !== '' && cepSearchState.streetId && !cepSearchState.searchLogged) {
    cepSearchState.searchLogged = true;
    
    const { error } = await sb
      .from('street_search_logs')
      .insert({ street_id: cepSearchState.streetId });
      
    if (error) {
      console.error('Failed to log street search:', error);
    }
  }
});

qs('#cepsearch-results').addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copy-zip-btn');
  
  if (copyBtn) {
    const zipCode = copyBtn.dataset.clipboard;
    
    try {
      await navigator.clipboard.writeText(zipCode);
      showToast(`CEP ${zipCode} copiado para a área de transferência.`);
    } catch (err) {
      console.error('Failed to copy zip code: ', err);
      showToast('Erro ao copiar o CEP.', 'error');
    }
  }
});

// =============================================================================
// 09. MODULE: CEE MAP & SECTORS
// =============================================================================

let ceeSectorsCache = [];

async function loadCeeSectors() {
  const { data, error } = await sb
    .from('cee_sectors')
    .select('id, code, label, base_start, base_end, current_offset')
    .order('display_order');

  if (error) {
    console.error('Failed to load CEE sectors:', error);
    showToast(`Erro ao carregar setores: ${error.message}`, 'error');
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
    const offsetLabel = sector.current_offset > 0 ? `+${sector.current_offset}` : `${sector.current_offset}`;

    qsa(`.cee-sector[data-sector="${sector.code}"]`).forEach((cell) => {
      cell.innerHTML = `
        <span class="cee-sector-code">${escapeHtml(sector.label)}</span>
        <span class="cee-sector-range">(${effectiveStart}-${effectiveEnd})</span>
        <span class="cee-sector-offset-badge ${sector.current_offset === 0 ? 'hidden' : ''}">${offsetLabel}</span>
      `;
    });
  });
}

function renderCeeOffsetCheckboxes() {
  const container = qs('#cee-offset-sectors');
  if (!container) return;

  if (ceeSectorsCache.length === 0) {
    container.innerHTML = '<span class="empty-state">Nenhum setor cadastrado.</span>';
    return;
  }

  container.innerHTML = ceeSectorsCache
    .map(
      (sector) => `
    <label class="cee-offset-checkbox">
      <input type="checkbox" value="${sector.code}">
      Setor ${escapeHtml(sector.label)}
      <span class="cee-offset-checkbox-offset">${sector.current_offset !== 0 ? `(atual: ${sector.current_offset > 0 ? '+' : ''}${sector.current_offset})` : ''}</span>
    </label>
  `
    )
    .join('');
}

function getCheckedCeeSectorCodes() {
  return qsa('#cee-offset-sectors input[type="checkbox"]:checked').map((el) => el.value);
}

async function applyCeeOffset() {
  const valueInput = qs('#cee-offset-value');
  const offsetValue = Number(valueInput.value);

  if (!valueInput.value.trim() || Number.isNaN(offsetValue) || offsetValue === 0) {
    showToast('Informe um valor de offset diferente de zero.', 'error');
    return;
  }

  const codes = getCheckedCeeSectorCodes();
  if (codes.length === 0) {
    showToast('Selecione ao menos um setor para receber o offset.', 'error');
    return;
  }

  for (const code of codes) {
    const sector = ceeSectorsCache.find((s) => s.code === code);
    if (!sector) continue;
    const newOffset = sector.current_offset + offsetValue;
    const { error } = await sb.from('cee_sectors').update({ current_offset: newOffset }).eq('id', sector.id);
    if (error) {
      showToast(`Erro ao aplicar offset no setor ${sector.label}: ${error.message}`, 'error');
      return;
    }
  }

  valueInput.value = '';
  showToast('Offset aplicado com sucesso!');
  await loadCeeSectors();
}

async function resetCeeOffset() {
  const codes = getCheckedCeeSectorCodes();
  if (codes.length === 0) {
    showToast('Selecione ao menos um setor para zerar o offset.', 'error');
    return;
  }

  for (const code of codes) {
    const sector = ceeSectorsCache.find((s) => s.code === code);
    if (!sector) continue;
    const { error } = await sb.from('cee_sectors').update({ current_offset: 0 }).eq('id', sector.id);
    if (error) {
      showToast(`Erro ao zerar offset do setor ${sector.label}: ${error.message}`, 'error');
      return;
    }
  }

  showToast('Offset zerado para os setores selecionados.');
  await loadCeeSectors();
}

const btnCeeOffsetApply = qs('#cee-offset-apply');
if (btnCeeOffsetApply) btnCeeOffsetApply.addEventListener('click', applyCeeOffset);

const btnCeeOffsetReset = qs('#cee-offset-reset');
if (btnCeeOffsetReset) btnCeeOffsetReset.addEventListener('click', resetCeeOffset);


// =============================================================================
// 10. MODULE: DAILY OPERATIONS (CEE)
// =============================================================================

function getDailyOpsDate() {
  const input = qs('#daily-ops-date');
  return (input && input.value) || todayIsoDate();
}

let dailyTrucksCache = [];
let dailyScansCache = [];
let dailySwapsCache = [];
let dailyMeetingsCache = [];
let dailyMalotesCache = [];

async function loadDailyOps() {
  const dateInput = qs('#daily-ops-date');
  if (dateInput && !dateInput.value) dateInput.value = todayIsoDate();
  const date = getDailyOpsDate();

  await Promise.all([
    loadDailyOpsSummary(date),
    loadDailyTrucks(date),
    loadDailyScans(date),
    loadDailySwaps(date),
    loadDailyMeetings(date),
    loadDailyMalotes(date),
  ]);
}

async function loadDailyOpsSummary(date) {
  const { data, error } = await sb
    .from('daily_operation_summary')
    .select('*')
    .eq('log_date', date)
    .maybeSingle();

  if (error) {
    console.error('Failed to load daily summary:', error);
    return;
  }

  const summary = data || {
    total_trucks: 0,
    total_cdls: 0,
    total_objects: 0,
    total_swaps: 0,
    total_meetings: 0,
    total_malotes: 0,
  };

  qs('#dops-total-trucks').textContent = summary.total_trucks;
  qs('#dops-total-cdls').textContent = summary.total_cdls;
  qs('#dops-total-swaps').textContent = summary.total_swaps;
  qs('#dops-total-meetings').textContent = summary.total_meetings;
  qs('#dops-total-malotes').textContent = summary.total_malotes;
}

// --- Trucks ---
async function loadDailyTrucks(date) {
  const tbody = qs('#daily-trucks-tbody');
  const emptyEl = qs('#daily-trucks-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="5">Carregando&hellip;</td></tr>';

  const { data, error } = await sb.from('daily_truck_arrivals').select('*').eq('log_date', date).order('arrival_time');

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="5">Erro ao carregar: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  dailyTrucksCache = data || [];
  emptyEl.classList.toggle('hidden', dailyTrucksCache.length > 0);
  tbody.innerHTML = dailyTrucksCache.map((t) => `
    <tr>
      <td>${formatTimeShort(t.arrival_time)}</td>
      <td>${escapeHtml(t.truck_identifier)}</td>
      <td><span class="count-badge">${t.cdl_count}</span></td>
      <td>${escapeHtml(t.notes || '')}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-truck="${t.id}">Excluir</button></td>
    </tr>
  `).join('');
}

function truckFormTemplate() {
  return `
    <form id="truck-form">
      <div class="field-row">
        <div class="field"><label for="truck-time">Horário de chegada</label><input type="time" id="truck-time" required></div>
        <div class="field"><label for="truck-cdl-count">Quantidade de CDLs</label><input type="number" id="truck-cdl-count" min="0" required></div>
      </div>
      <div class="field"><label for="truck-identifier">Caminhão (placa, rota ou transportadora)</label><input type="text" id="truck-identifier" placeholder="Ex.: ABC-1234 ou Rota Norte"></div>
      <div class="field"><label for="truck-notes">Observações (opcional)</label><input type="text" id="truck-notes" placeholder="Opcional"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="truck-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar Caminhão</button>
      </div>
    </form>
  `;
}

function openTruckForm() {
  openModal('Registrar Chegada de Caminhão', truckFormTemplate());
  qs('#truck-cancel').addEventListener('click', closeModal);
  qs('#truck-form').addEventListener('submit', submitTruckForm);
}

async function submitTruckForm(e) {
  e.preventDefault();
  let payload = {
    log_date: getDailyOpsDate(),
    arrival_time: qs('#truck-time').value,
    truck_identifier: qs('#truck-identifier').value.trim(),
    cdl_count: Number(qs('#truck-cdl-count').value),
    notes: qs('#truck-notes').value.trim() || null,
  };
  payload.truck_identifier = !payload.truck_identifier ? null : payload.truck_identifier;

  const { error } = await sb.from('daily_truck_arrivals').insert(payload);
  if (error) { showToast(`Erro ao registrar caminhão: ${error.message}`, 'error'); return; }
  closeModal(); showToast('Caminhão registrado com sucesso!'); await loadDailyOps();
}

async function deleteDailyTruck(id) {
  openDeleteConfirm('este registro de caminhão', null, async () => {
    const { error } = await sb.from('daily_truck_arrivals').delete().eq('id', id);
    if (error) { showToast(`Erro ao excluir: ${error.message}`, 'error'); return; }
    closeModal(); showToast('Registro excluído.'); await loadDailyOps();
  });
}

// --- LOEC Records ---

let loecChartInstance = null;

async function loadDailyScans(date) {
  const tbody = qs('#daily-scans-tbody');
  const emptyEl = qs('#daily-scans-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="4">Loading&hellip;</td></tr>';

  const { data, error } = await sb.from('daily_object_scans').select('*').eq('log_date', date).order('scan_time');

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar dados: ${escapeHtml(error.message)}</td></tr>`; 
    return;
  }

  dailyScansCache = data || [];
  emptyEl.classList.toggle('hidden', dailyScansCache.length > 0);
  
  // Render Table
  tbody.innerHTML = dailyScansCache.map((s) => `
    <tr>
      <td>${formatTimeShort(s.scan_time)}</td>
      <td><span class="count-badge">${s.object_count}</span></td>
      <td>${escapeHtml(s.notes || '')}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-scan="${s.id}">Excluir</button></td>
    </tr>
  `).join('');

  // Render Chart
  renderLoecChart(dailyScansCache);
}

function renderLoecChart(records) {
  const ctx = qs('#loec-chart');
  if (!ctx) return;

  // Destroy previous chart instance if it exists to avoid overlapping renders
  if (loecChartInstance) {
    loecChartInstance.destroy();
  }

  const labels = records.map(r => formatTimeShort(r.scan_time));
  const dataPoints = records.map(r => r.object_count);

  loecChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Objects in Suspended LOEC',
        data: dataPoints,
        borderColor: '#00447c',
        backgroundColor: 'rgba(0, 68, 124, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3, // Adds a slight curve to the line
        pointBackgroundColor: '#ffcc00',
        pointBorderColor: '#00447c',
        pointRadius: 4,
        pointHoverRadius: 6
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
          <label for="scan-object-count">Suspended Objects</label>
          <input type="number" id="scan-object-count" min="0" required>
        </div>
      </div>
      <div class="field">
        <label for="scan-notes">Notes (optional)</label>
        <input type="text" id="scan-notes" placeholder="Optional notes">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="scan-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Record</button>
      </div>
    </form>
  `;
}

function openScanForm() {
  openModal('Registrar Leitura de Objetos', scanFormTemplate());
  qs('#scan-cancel').addEventListener('click', closeModal);
  qs('#scan-form').addEventListener('submit', submitScanForm);
}

async function submitScanForm(e) {
  e.preventDefault();
  
  const payload = {
    log_date: getDailyOpsDate(), 
    scan_time: qs('#scan-time').value,
    object_count: Number(qs('#scan-object-count').value),
    notes: qs('#scan-notes').value.trim() || null,
  };

  const { error } = await sb.from('daily_object_scans').insert(payload);
  if (error) { 
    showToast(`Error saving record: ${error.message}`, 'error'); 
    return; 
  }
  
  closeModal(); 
  showToast('LOEC record saved successfully!'); 
  await loadDailyOps();
}

async function deleteDailyScan(id) {
  openDeleteConfirm('este registro de leitura', null, async () => {
    const { error } = await sb.from('daily_object_scans').delete().eq('id', id);
    if (error) { showToast(`Erro ao excluir: ${error.message}`, 'error'); return; }
    closeModal(); showToast('Registro excluído.'); await loadDailyOps();
  });
}

// --- Swaps ---
async function loadDailySwaps(date) {
  const tbody = qs('#daily-swaps-tbody');
  const emptyEl = qs('#daily-swaps-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="4">Carregando&hellip;</td></tr>';

  const { data, error } = await sb.from('daily_label_swaps').select('*').eq('log_date', date).order('occurrence_time');

  if (error) { tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar: ${escapeHtml(error.message)}</td></tr>`; return; }

  dailySwapsCache = data || [];
  emptyEl.classList.toggle('hidden', dailySwapsCache.length > 0);
  tbody.innerHTML = dailySwapsCache.map((s) => `
    <tr>
      <td>${formatTimeShort(s.occurrence_time)}</td>
      <td><span class="count-badge">${s.swap_count}</span></td>
      <td>${escapeHtml(s.notes || '')}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-swap="${s.id}">Excluir</button></td>
    </tr>
  `).join('');
}

function swapFormTemplate() {
  return `
    <form id="swap-form">
      <div class="field-row">
        <div class="field"><label for="swap-time">Horário</label><input type="time" id="swap-time" required></div>
        <div class="field"><label for="swap-count">Quantidade de trocas</label><input type="number" id="swap-count" min="0" required></div>
      </div>
      <div class="field"><label for="swap-notes">Observações (opcional)</label><input type="text" id="swap-notes" placeholder="Ex.: falta de atenção"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="swap-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar Troca</button>
      </div>
    </form>
  `;
}

function openSwapForm() {
  openModal('Registrar Troca de Etiqueta', swapFormTemplate());
  qs('#swap-cancel').addEventListener('click', closeModal);
  qs('#swap-form').addEventListener('submit', submitSwapForm);
}

async function submitSwapForm(e) {
  e.preventDefault();
  const payload = {
    log_date: getDailyOpsDate(), occurrence_time: qs('#swap-time').value,
    swap_count: Number(qs('#swap-count').value), notes: qs('#swap-notes').value.trim() || null,
  };

  const { error } = await sb.from('daily_label_swaps').insert(payload);
  if (error) { showToast(`Erro ao registrar troca: ${error.message}`, 'error'); return; }
  closeModal(); showToast('Troca de etiqueta registrada.'); await loadDailyOps();
}

async function deleteDailySwap(id) {
  openDeleteConfirm('este registro de troca de etiqueta', null, async () => {
    const { error } = await sb.from('daily_label_swaps').delete().eq('id', id);
    if (error) { showToast(`Erro ao excluir: ${error.message}`, 'error'); return; }
    closeModal(); showToast('Registro excluído.'); await loadDailyOps();
  });
}

// --- Meetings ---
async function loadDailyMeetings(date) {
  const tbody = qs('#daily-meetings-tbody');
  const emptyEl = qs('#daily-meetings-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="5">Carregando&hellip;</td></tr>';

  const { data, error } = await sb.from('daily_meetings').select('*').eq('log_date', date).order('meeting_time');

  if (error) { tbody.innerHTML = `<tr class="error-row"><td colspan="5">Erro ao carregar: ${escapeHtml(error.message)}</td></tr>`; return; }

  dailyMeetingsCache = data || [];
  emptyEl.classList.toggle('hidden', dailyMeetingsCache.length > 0);
  tbody.innerHTML = dailyMeetingsCache.map((m) => `
    <tr>
      <td>${formatTimeShort(m.meeting_time)}</td>
      <td>${m.duration_minutes} min</td>
      <td>${m.is_union ? '<span class="union-tag">Sindicato</span>' : '<span class="meeting-tag">Reunião</span>'}</td>
      <td>${escapeHtml(m.notes || '')}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-meeting="${m.id}">Excluir</button></td>
    </tr>
  `).join('');
}

function meetingFormTemplate() {
  return `
    <form id="meeting-form">
      <div class="field-row">
        <div class="field"><label for="meeting-time">Horário</label><input type="time" id="meeting-time" required></div>
        <div class="field"><label for="meeting-duration">Duração (minutos)</label><input type="number" id="meeting-duration" min="0" required></div>
      </div>
      <div class="field">
        <label for="meeting-is-union">Tipo</label>
        <select id="meeting-is-union">
          <option value="false">Reunião comum</option>
          <option value="true">Intervenção do sindicato</option>
        </select>
      </div>
      <div class="field"><label for="meeting-notes">Observações (opcional)</label><input type="text" id="meeting-notes" placeholder="Opcional"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="meeting-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar Reunião</button>
      </div>
    </form>
  `;
}

function openMeetingForm() {
  openModal('Registrar Reunião', meetingFormTemplate());
  qs('#meeting-cancel').addEventListener('click', closeModal);
  qs('#meeting-form').addEventListener('submit', submitMeetingForm);
}

async function submitMeetingForm(e) {
  e.preventDefault();
  const payload = {
    log_date: getDailyOpsDate(), meeting_time: qs('#meeting-time').value,
    duration_minutes: Number(qs('#meeting-duration').value),
    is_union: qs('#meeting-is-union').value === 'true', notes: qs('#meeting-notes').value.trim() || null,
  };

  const { error } = await sb.from('daily_meetings').insert(payload);
  if (error) { showToast(`Erro ao registrar reunião: ${error.message}`, 'error'); return; }
  closeModal(); showToast('Reunião registrada.'); await loadDailyOps();
}

async function deleteDailyMeeting(id) {
  openDeleteConfirm('este registro de reunião', null, async () => {
    const { error } = await sb.from('daily_meetings').delete().eq('id', id);
    if (error) { showToast(`Erro ao excluir: ${error.message}`, 'error'); return; }
    closeModal(); showToast('Registro excluído.'); await loadDailyOps();
  });
}

// --- Malotes ---
async function loadDailyMalotes(date) {
  const tbody = qs('#daily-malotes-tbody');
  const emptyEl = qs('#daily-malotes-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="5">Carregando&hellip;</td></tr>';

  const { data, error } = await sb.from('daily_malote_deliveries').select('*').eq('log_date', date).order('delivery_time');

  if (error) { tbody.innerHTML = `<tr class="error-row"><td colspan="5">Erro ao carregar: ${escapeHtml(error.message)}</td></tr>`; return; }

  dailyMalotesCache = data || [];
  emptyEl.classList.toggle('hidden', dailyMalotesCache.length > 0);
  tbody.innerHTML = dailyMalotesCache.map((m) => `
    <tr>
      <td>${formatTimeShort(m.delivery_time)}</td>
      <td>${escapeHtml(m.carteiro_name)}</td>
      <td><span class="count-badge">${m.malote_count}</span></td>
      <td>${escapeHtml(m.notes || '')}</td>
      <td class="col-actions"><button class="btn btn-danger btn-icon" data-delete-malote="${m.id}">Excluir</button></td>
    </tr>
  `).join('');
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
  openModal('Registrar Malote', maloteFormTemplate());
  qs('#malote-cancel').addEventListener('click', closeModal);
  qs('#malote-form').addEventListener('submit', submitMaloteForm);
}

async function submitMaloteForm(e) {
  e.preventDefault();
  const payload = {
    log_date: getDailyOpsDate(), delivery_time: qs('#malote-time').value,
    carteiro_name: qs('#malote-carteiro').value.trim(), malote_count: Number(qs('#malote-count').value),
    notes: qs('#malote-notes').value.trim() || null,
  };

  const { error } = await sb.from('daily_malote_deliveries').insert(payload);
  if (error) { showToast(`Erro ao registrar malote: ${error.message}`, 'error'); return; }
  closeModal(); showToast('Malote registrado.'); await loadDailyOps();
}

async function deleteDailyMalote(id) {
  openDeleteConfirm('este registro de malote', null, async () => {
    const { error } = await sb.from('daily_malote_deliveries').delete().eq('id', id);
    if (error) { showToast(`Erro ao excluir: ${error.message}`, 'error'); return; }
    closeModal(); showToast('Registro excluído.'); await loadDailyOps();
  });
}

// --- Daily Ops Event Listeners ---
qs('#btn-new-truck').addEventListener('click', openTruckForm);
qs('#daily-trucks-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete-truck]');
  if (btn) deleteDailyTruck(btn.dataset.deleteTruck);
});

qs('#btn-new-scan').addEventListener('click', openScanForm);
qs('#daily-scans-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete-scan]');
  if (btn) deleteDailyScan(btn.dataset.deleteScan);
});

qs('#btn-new-swap').addEventListener('click', openSwapForm);
qs('#daily-swaps-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete-swap]');
  if (btn) deleteDailySwap(btn.dataset.deleteSwap);
});

qs('#btn-new-meeting').addEventListener('click', openMeetingForm);
qs('#daily-meetings-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete-meeting]');
  if (btn) deleteDailyMeeting(btn.dataset.deleteMeeting);
});

qs('#btn-new-malote').addEventListener('click', openMaloteForm);
qs('#daily-malotes-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete-malote]');
  if (btn) deleteDailyMalote(btn.dataset.deleteMalote);
});

const dailyOpsDateInput = qs('#daily-ops-date');
if (dailyOpsDateInput) dailyOpsDateInput.addEventListener('change', () => loadDailyOps());

const btnDailyOpsToday = qs('#daily-ops-today');
if (btnDailyOpsToday) {
  btnDailyOpsToday.addEventListener('click', () => {
    qs('#daily-ops-date').value = todayIsoDate();
    loadDailyOps();
  });
}

// =============================================================================
// 11. MODULE: STATISTICS DASHBOARD
// =============================================================================

async function loadStatistics() {
  const { data: globalData, error: globalError } = await sb.from('stats_global_counts').select('*').single();
  if (!globalError && globalData) {
    qs('#stat-total-streets').textContent = globalData.total_streets;
    qs('#stat-total-zips').textContent = globalData.total_zips;
    qs('#stat-total-rules').textContent = globalData.total_rules;
  } else if (globalError) console.error('Failed to load global stats:', globalError);

  const { data: neighborhoodData, error: neighborhoodError } = await sb.from('stats_neighborhoods').select('*').limit(10);
  if (!neighborhoodError && neighborhoodData) {
    qs('#stat-neighborhoods-tbody').innerHTML = neighborhoodData.map(n => `
      <tr>
        <td>${escapeHtml(n.neighborhood_name)}</td>
        <td class="col-actions"><span class="count-badge">${n.street_count}</span></td>
      </tr>
    `).join('');
  } else if (neighborhoodError) console.error('Failed to load top neighborhoods:', neighborhoodError);

  const { data: topStreetsData, error: topStreetsError } = await sb.from('streets_with_zip_count').select('name, zip_count').order('zip_count', { ascending: false }).limit(10);
  if (!topStreetsError && topStreetsData) {
    qs('#stat-top-streets-tbody').innerHTML = topStreetsData.map(s => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td class="col-actions"><span class="count-badge">${s.zip_count}</span></td>
      </tr>
    `).join('');
  } else if (topStreetsError) console.error('Failed to load top streets:', topStreetsError);

  const { data: topConsultedData, error: topConsultedError } = await sb.from('top_consulted_streets').select('name, consultation_count').order('consultation_count', { ascending: false }).limit(10);
  if (!topConsultedError && topConsultedData) {
    qs('#stat-top-consulted-tbody').innerHTML = topConsultedData.map(s => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td class="col-actions"><span class="count-badge">${s.consultation_count}</span></td>
      </tr>
    `).join('');
  } else if (topConsultedError) console.error('Failed to load top consulted streets:', topConsultedError);
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
  openModal('Reportar um Bug', bugReportFormTemplate());
  qs('#bug-cancel').addEventListener('click', closeModal);
  qs('#bug-report-form').addEventListener('submit', submitBugReportForm);
}

async function submitBugReportForm(e) {
  e.preventDefault();
  const title = qs('#bug-title').value.trim();
  const description = qs('#bug-description').value.trim();
  const payload = { title, description };
  
  const { error } = await sb.from('bug_reports').insert(payload);
  
  if (error) {
    showToast(`Error saving bug report: ${error.message}`, 'error');
    return;
  }
  
  closeModal();
  showToast('Bug report enviado com sucesso!');
}

const btnReportBug = qs('#btn-report-bug');
if (btnReportBug) {
  btnReportBug.addEventListener('click', openBugReportForm);
}

// =============================================================================
// MODULE: MANUAL / ABOUT PAGE (MARKDOWN RENDERER)
// =============================================================================

async function loadAboutPage() {
  const container = qs('#about-content');

  // Prevent fetching the file again if it's already loaded
  if (container.dataset.loaded === 'true') return;

  try {
    // Fetch the README.md file from the root directory
    // Since it's on GitHub Pages, './README.md' points to the public file
    const response = await fetch('./README.md');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const markdownText = await response.text();

    // Convert Markdown to HTML using marked.js
    container.innerHTML = marked.parse(markdownText);

    // Flag as loaded to avoid unnecessary network requests on future tab clicks
    container.dataset.loaded = 'true';
    
  } catch (error) {
    console.error('Failed to load README.md:', error);
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
  const placeholderUrl = SUPABASE_URL.includes('YOUR-PROJECT');
  const placeholderKey = SUPABASE_ANON_KEY.includes('YOUR-ANON');
  if (placeholderUrl || placeholderKey) {
    qs('#config-banner').classList.remove('hidden');
  }

  const dailyOpsDateEl = qs('#daily-ops-date');
  if (dailyOpsDateEl && !dailyOpsDateEl.value) dailyOpsDateEl.value = todayIsoDate();

  await loadZips(0);
  await loadRules();
  await loadStatistics();
}

init();