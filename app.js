const SUPABASE_URL = 'https://wiligdvkjpdfhscihwva.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpbGlnZHZranBkZmhzY2lod3ZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDczMjcsImV4cCI6MjA5OTk4MzMyN30.icyCigbCCPzR03EzCvXyDZanA_C6utcuUHjHOswOUXw';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ----------------------------------------------------------------------------
// Small DOM helpers
// ----------------------------------------------------------------------------
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----------------------------------------------------------------------------
// CEP normalization — every Florianópolis island CEP starts with "880", so
// people usually type only the last 5 digits. Whenever a typed value does not
// already start with "880", we prepend it before validating, saving, or
// searching.
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Toast notifications (styled as a postmark "stamp-down" confirmation)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Modal (shared by every create/edit form and delete confirmation)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Tabs
// ----------------------------------------------------------------------------
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
}

// =============================================================================
// STREETS — read only, paginated, ordered by number of linked CEPs
// =============================================================================

// Lightweight full list (id, name) kept fresh for populating <select> dropdowns
// elsewhere in the app (e.g. the zip code create/edit form).
let streetsCache = [];

async function loadStreetsLite() {
  const { data, error } = await sb.from('streets').select('id, name').order('name');
  if (error) {
    console.error('Failed to load streets for dropdowns:', error);
    return;
  }
  streetsCache = data;
}

function populateStreetSelect(selectEl, selectedId) {
  const options = ['<option value="">Selecione um logradouro&hellip;</option>'].concat(
    streetsCache.map(
      (s) => `<option value="${s.id}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
    )
  );
  selectEl.innerHTML = options.join('');
}

const STREETS_PAGE_SIZE = 25;
let streetsSearchTerm = '';
let streetsPage = 0;
let streetsTotalCount = 0;
let streetsSearchDebounce = null;

qs('#streets-search').addEventListener('input', (e) => {
  clearTimeout(streetsSearchDebounce);
  const value = e.target.value;
  streetsSearchDebounce = setTimeout(() => {
    streetsSearchTerm = value;
    loadStreets(0);
  }, 320);
});

qs('#streets-prev').addEventListener('click', () => {
  if (streetsPage > 0) loadStreets(streetsPage - 1);
});
qs('#streets-next').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(streetsTotalCount / STREETS_PAGE_SIZE));
  if (streetsPage + 1 < totalPages) loadStreets(streetsPage + 1);
});

async function loadStreets(page = 0) {
  streetsPage = page;
  const tbody = qs('#streets-tbody');
  const emptyEl = qs('#streets-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="4">Carregando manifesto&hellip;</td></tr>';

  const term = streetsSearchTerm.trim();
  const from = page * STREETS_PAGE_SIZE;
  const to = from + STREETS_PAGE_SIZE - 1;

  // streets_with_zip_count is a view (see README.md) that pre-aggregates the
  // number of zip codes per street so we can order/paginate by it server-side.
  let query = sb.from('streets_with_zip_count').select('id, name, neighborhood, descr, zip_count', { count: 'exact' });

  if (term) {
    const escaped = term.replace(/[%,]/g, '');
    const orParts = [`name.ilike.%${escaped}%`, `neighborhood.ilike.%${escaped}%`, `descr.ilike.%${escaped}%`];

    // Also allow finding a street by one of its linked CEPs.
    const digits = term.replace(/\D/g, '');
    if (digits) {
      const pattern = digitsToZipPattern(normalizeZipDigits(term));
      const { data: zipMatches } = await sb.from('zip_codes').select('street_id').ilike('zip_code', `%${pattern}%`);
      const streetIds = [...new Set((zipMatches || []).map((z) => z.street_id))];
      if (streetIds.length) orParts.push(`id.in.(${streetIds.join(',')})`);
    }

    query = query.or(orParts.join(','));
  }

  query = query.order('zip_count', { ascending: false }).order('name', { ascending: true }).range(from, to);

  const { data, error, count } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar logradouros: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  streetsTotalCount = count || 0;
  emptyEl.classList.toggle('hidden', data.length > 0);
  tbody.innerHTML = data
    .map(
      (s) => `
    <tr>
      <td><strong>${escapeHtml(s.name)}</strong></td>
      <td>${escapeHtml(s.neighborhood)}</td>
      <td>${escapeHtml(s.descr) || '<span class="field-hint">&mdash;</span>'}</td>
      <td><span class="count-badge">${s.zip_count}</span></td>
    </tr>
  `
    )
    .join('');

  renderStreetsPagination();
}

function renderStreetsPagination() {
  const totalPages = Math.max(1, Math.ceil(streetsTotalCount / STREETS_PAGE_SIZE));
  const countLabel = streetsTotalCount === 1 ? 'logradouro' : 'logradouros';
  qs('#streets-page-info').textContent = `Página ${streetsPage + 1} de ${totalPages} · ${streetsTotalCount} ${countLabel}`;
  qs('#streets-prev').disabled = streetsPage <= 0;
  qs('#streets-next').disabled = streetsPage + 1 >= totalPages;
}

// =============================================================================
// ZIP CODES — full CRUD, combined search across CEP / street / neighborhood / descr
// =============================================================================

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

async function refreshZipFilterDropdowns() {
  const allZips = await loadZipsLite();
  ['#ranges-filter-zip', '#numbers-filter-zip'].forEach((selector) => {
    const el = qs(selector);
    const current = el.value;
    const options = ['<option value="">Todos os CEPs</option>'].concat(
      allZips.map((z) => `<option value="${z.id}">${z.zip_code} &mdash; ${escapeHtml(z.streets ? z.streets.name : '')}</option>`)
    );
    el.innerHTML = options.join('');
    el.value = current;
  });
}

let zipsSearchTerm = '';
let zipsSearchDebounce = null;

qs('#zips-search').addEventListener('input', (e) => {
  clearTimeout(zipsSearchDebounce);
  const value = e.target.value;
  zipsSearchDebounce = setTimeout(() => {
    zipsSearchTerm = value;
    loadZips();
  }, 320);
});

async function loadZips() {
  const tbody = qs('#zips-tbody');
  const emptyEl = qs('#zips-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="4">Carregando manifesto&hellip;</td></tr>';

  const term = zipsSearchTerm.trim();
  let query = sb.from('zip_codes').select('id, zip_code, street_id, streets(name, neighborhood)').order('zip_code');

  if (term) {
    const escaped = term.replace(/[%,]/g, '');
    const { data: streetMatches, error: streetError } = await sb
      .from('streets')
      .select('id')
      .or(`name.ilike.%${escaped}%,neighborhood.ilike.%${escaped}%,descr.ilike.%${escaped}%`);

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
      emptyEl.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }
    query = query.or(orParts.join(','));
  }

  const { data, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="4">Erro ao carregar CEPs: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  emptyEl.classList.toggle('hidden', data.length > 0);
  tbody.innerHTML = data
    .map(
      (z) => `
    <tr>
      <td class="zip-code-cell">${z.zip_code}</td>
      <td>${escapeHtml(z.streets ? z.streets.name : '&mdash;')}</td>
      <td>${escapeHtml(z.streets ? z.streets.neighborhood : '&mdash;')}</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-view-zip="${z.id}" data-zip-value="${z.zip_code}">Ver detalhes</button>
          <button class="btn btn-secondary btn-icon" data-edit-zip="${z.id}">Editar</button>
          <button class="btn btn-danger btn-icon" data-delete-zip="${z.id}" data-zip-label="${z.zip_code}">Excluir</button>
        </span>
      </td>
    </tr>
  `
    )
    .join('');
}

function zipFormTemplate(record) {
  return `
    <form id="zip-form">
      <div class="field">
        <label for="zip-street">Logradouro</label>
        <select id="zip-street" required></select>
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
  populateStreetSelect(qs('#zip-street'), record ? record.street_id : '');
  attachZipMask(qs('#zip-code-input'));
  qs('#zip-cancel').addEventListener('click', closeModal);
  qs('#zip-form').addEventListener('submit', (e) => submitZipForm(e, record));
}

async function submitZipForm(e, record) {
  e.preventDefault();
  const streetId = qs('#zip-street').value;
  const zipInput = qs('#zip-code-input');
  const normalizedZip = digitsToZipPattern(normalizeZipDigits(zipInput.value));
  zipInput.value = normalizedZip;
  const zipField = qs('#zip-code-field');

  if (!ZIP_REGEX.test(normalizedZip)) {
    zipField.classList.add('has-error');
    return;
  }
  zipField.classList.remove('has-error');

  const payload = { street_id: streetId, zip_code: normalizedZip };
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
  await loadZips();
  await refreshZipFilterDropdowns();
}

async function deleteZip(id, label) {
  openDeleteConfirm(`CEP ${label}`, 'Excluir este CEP também remove as faixas de numeração e números únicos vinculados a ele.', async () => {
    const { error } = await sb.from('zip_codes').delete().eq('id', id);
    if (error) {
      showToast(`Erro ao excluir: ${error.message}`, 'error');
      return;
    }
    closeModal();
    showToast('CEP excluído.');
    await loadZips();
    await refreshZipFilterDropdowns();
  });
}

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
      .select('id, zip_code, street_id')
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
// CEP SEARCH — resolve a street from a CEP/name/descr query, then locate which
// of its CEPs covers a given property number (via unique_numbers or number_ranges).
// =============================================================================
const SIDE_LABELS = { odd: 'Ímpar', even: 'Par', both: 'Ambos' };

let cepSearchState = { streetId: null, street: null, breakdown: [] };
let cepSearchDebounce = null;

qs('#cepsearch-query').addEventListener('input', (e) => {
  clearTimeout(cepSearchDebounce);
  const value = e.target.value;
  cepSearchDebounce = setTimeout(() => resolveStreetForQuery(value), 320);
});

qs('#cepsearch-number').addEventListener('input', () => renderCepSearchResults());

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
    cepSearchState = { streetId: null, street: null, breakdown: [] };
    hintEl.textContent = 'Digite para localizar o logradouro.';
    numberInput.disabled = true;
    resultsEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  hintEl.textContent = 'Buscando...';

  const escaped = trimmed.replace(/[%,]/g, '');
  const digits = trimmed.replace(/\D/g, '');

  const textPromise = sb
    .from('streets')
    .select('id, name, neighborhood, descr')
    .or(`name.ilike.%${escaped}%,neighborhood.ilike.%${escaped}%,descr.ilike.%${escaped}%`)
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

  // CEP matches are more specific than free-text matches, so they take priority.
  const merged = new Map();
  (zipMatches || []).forEach((z) => {
    if (z.streets) merged.set(z.streets.id, z.streets);
  });
  (textMatches || []).forEach((s) => {
    if (!merged.has(s.id)) merged.set(s.id, s);
  });

  const candidates = Array.from(merged.values());

  if (candidates.length === 0) {
    cepSearchState = { streetId: null, street: null, breakdown: [] };
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
    .select('id, zip_code, number_ranges(id, start_number, end_number, side), unique_numbers(id, address_number, description)')
    .eq('street_id', street.id)
    .order('zip_code');

  if (error) {
    showToast(`Erro ao carregar CEPs do logradouro: ${error.message}`, 'error');
    cepSearchState = { streetId: street.id, street, breakdown: [] };
    return;
  }
  cepSearchState = { streetId: street.id, street, breakdown: data };
}

function findMatchingZip(breakdown, number) {
  for (const z of breakdown) {
    if ((z.unique_numbers || []).some((u) => u.address_number === number)) return z;
  }
  for (const z of breakdown) {
    for (const r of z.number_ranges || []) {
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

  const blocksHtml = breakdown
    .map((z) => {
      const isMatch = Boolean(matchedZip && matchedZip.id === z.id);
      const rangesHtml = (z.number_ranges || [])
        .map((r) => {
          const start = r.start_number === null ? 'aberto' : r.start_number;
          const end = r.end_number === null ? 'aberto' : r.end_number;
          return `<li>Faixa ${start}&ndash;${end} &middot; <span class="side-badge side-${r.side}">${SIDE_LABELS[r.side] || r.side}</span></li>`;
        })
        .join('');
      const uniquesHtml = (z.unique_numbers || [])
        .map((u) => `<li>Número ${u.address_number}${u.description ? ` &middot; ${escapeHtml(u.description)}` : ''}</li>`)
        .join('');
      const detailsHtml =
        rangesHtml || uniquesHtml
          ? `<ul class="zip-block-detail-list">${rangesHtml}${uniquesHtml}</ul>`
          : '<p class="field-hint">Nenhuma faixa ou número cadastrado para este CEP.</p>';

      return `
      <div class="zip-block ${isMatch ? 'zip-block--match' : ''}">
        <div class="zip-block-header">
          <span class="zip-block-title">${z.zip_code}</span>
          ${isMatch ? '<span class="match-tag">CEP correto</span>' : ''}
        </div>
        ${detailsHtml}
      </div>
    `;
    })
    .join('');

  resultsEl.innerHTML = `
    <div class="envelope-card">
      <div class="envelope-card-airmail" aria-hidden="true"></div>
      <div class="envelope-card-body">
        <p class="field-hint">Logradouro</p>
        <div class="address-window">${escapeHtml(street.name)}</div>
        <p class="field-hint" style="margin-top:10px;">${escapeHtml(street.neighborhood)}${
    street.descr ? ` &middot; ${escapeHtml(street.descr)}` : ''
  }</p>
        ${blocksHtml || '<p class="field-hint">Este logradouro ainda não tem CEPs cadastrados.</p>'}
      </div>
    </div>
  `;
}

// =============================================================================
// NUMBER RANGES — full CRUD (unchanged tab)
// =============================================================================
let rangesCache = [];

async function loadRanges() {
  const tbody = qs('#ranges-tbody');
  const emptyEl = qs('#ranges-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="6">Carregando manifesto&hellip;</td></tr>';

  const filterZipId = qs('#ranges-filter-zip').value;
  let query = sb
    .from('number_ranges')
    .select('id, start_number, end_number, side, zip_code_id, zip_codes(zip_code, streets(name))')
    .order('id');
  if (filterZipId) query = query.eq('zip_code_id', filterZipId);

  const { data, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="6">Erro ao carregar faixas: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  rangesCache = data;
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
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-edit-range="${r.id}">Editar</button>
          <button class="btn btn-danger btn-icon" data-delete-range="${r.id}">Excluir</button>
        </span>
      </td>
    </tr>
  `
    )
    .join('');
}

function rangeFormTemplate(record) {
  return `
    <form id="range-form">
      <div class="field">
        <label for="range-zip">CEP</label>
        <select id="range-zip" required></select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="range-start">Número inicial</label>
          <input id="range-start" type="number" min="0" value="${record && record.start_number !== null ? record.start_number : ''}">
        </div>
        <div class="field">
          <label for="range-end">Número final</label>
          <input id="range-end" type="number" min="0" value="${record && record.end_number !== null ? record.end_number : ''}">
        </div>
      </div>
      <p class="field-error" id="range-order-error">O número inicial deve ser menor ou igual ao final.</p>
      <div class="field">
        <label for="range-side">Lado da rua</label>
        <select id="range-side">
          <option value="both" ${!record || record.side === 'both' ? 'selected' : ''}>Ambos</option>
          <option value="odd" ${record && record.side === 'odd' ? 'selected' : ''}>Ímpar</option>
          <option value="even" ${record && record.side === 'even' ? 'selected' : ''}>Par</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="range-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${record ? 'Salvar alterações' : 'Cadastrar faixa'}</button>
      </div>
    </form>
  `;
}

async function openRangeForm(record = null) {
  openModal(record ? 'Editar Faixa de Numeração' : 'Nova Faixa de Numeração', rangeFormTemplate(record));
  const zipList = await loadZipsLite();
  populateZipSelect(qs('#range-zip'), zipList, record ? record.zip_code_id : '');
  qs('#range-cancel').addEventListener('click', closeModal);
  qs('#range-form').addEventListener('submit', (e) => submitRangeForm(e, record));
}

async function submitRangeForm(e, record) {
  e.preventDefault();
  const zipCodeId = qs('#range-zip').value;
  const startRaw = qs('#range-start').value;
  const endRaw = qs('#range-end').value;
  const side = qs('#range-side').value;
  const startNumber = startRaw === '' ? null : Number(startRaw);
  const endNumber = endRaw === '' ? null : Number(endRaw);
  const orderError = qs('#range-order-error');

  if (startNumber !== null && endNumber !== null && startNumber > endNumber) {
    orderError.style.display = 'block';
    return;
  }
  orderError.style.display = 'none';

  const payload = { zip_code_id: zipCodeId, start_number: startNumber, end_number: endNumber, side };
  const query = record
    ? sb.from('number_ranges').update(payload).eq('id', record.id)
    : sb.from('number_ranges').insert(payload);
  const { error } = await query;

  if (error) {
    showToast(`Erro ao salvar faixa: ${error.message}`, 'error');
    return;
  }
  closeModal();
  showToast(record ? 'Faixa atualizada.' : 'Faixa cadastrada.');
  await loadRanges();
}

async function deleteRange(id) {
  openDeleteConfirm('esta faixa de numeração', null, async () => {
    const { error } = await sb.from('number_ranges').delete().eq('id', id);
    if (error) {
      showToast(`Erro ao excluir: ${error.message}`, 'error');
      return;
    }
    closeModal();
    showToast('Faixa excluída.');
    await loadRanges();
  });
}

qs('#btn-new-range').addEventListener('click', () => openRangeForm());
qs('#ranges-filter-zip').addEventListener('change', loadRanges);

qs('#ranges-tbody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-range]');
  const deleteBtn = e.target.closest('[data-delete-range]');
  if (editBtn) {
    const record = rangesCache.find((r) => String(r.id) === editBtn.dataset.editRange);
    if (record) openRangeForm(record);
  }
  if (deleteBtn) deleteRange(deleteBtn.dataset.deleteRange);
});

// =============================================================================
// UNIQUE NUMBERS — full CRUD (unchanged tab)
// =============================================================================
let numbersCache = [];

async function loadNumbers() {
  const tbody = qs('#numbers-tbody');
  const emptyEl = qs('#numbers-empty');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="5">Carregando manifesto&hellip;</td></tr>';

  const filterZipId = qs('#numbers-filter-zip').value;
  let query = sb
    .from('unique_numbers')
    .select('id, address_number, description, zip_code_id, zip_codes(zip_code, streets(name))')
    .order('address_number');
  if (filterZipId) query = query.eq('zip_code_id', filterZipId);

  const { data, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr class="error-row"><td colspan="5">Erro ao carregar números: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  numbersCache = data;
  emptyEl.classList.toggle('hidden', data.length > 0);
  tbody.innerHTML = data
    .map(
      (n) => `
    <tr>
      <td class="zip-code-cell">${n.zip_codes ? n.zip_codes.zip_code : '&mdash;'}</td>
      <td>${escapeHtml(n.zip_codes && n.zip_codes.streets ? n.zip_codes.streets.name : '&mdash;')}</td>
      <td>${n.address_number}</td>
      <td>${escapeHtml(n.description) || '<span class="field-hint">&mdash;</span>'}</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="btn btn-secondary btn-icon" data-edit-number="${n.id}">Editar</button>
          <button class="btn btn-danger btn-icon" data-delete-number="${n.id}">Excluir</button>
        </span>
      </td>
    </tr>
  `
    )
    .join('');
}

function numberFormTemplate(record) {
  return `
    <form id="number-form">
      <div class="field">
        <label for="number-zip">CEP</label>
        <select id="number-zip" required></select>
      </div>
      <div class="field">
        <label for="number-address">Número do imóvel</label>
        <input id="number-address" type="number" min="0" value="${record ? record.address_number : ''}" required>
      </div>
      <div class="field">
        <label for="number-descr">Descrição</label>
        <input id="number-descr" type="text" maxlength="255" placeholder="Ex.: Hospital, condomínio, prédio comercial&hellip;"
               value="${record && record.description ? escapeHtml(record.description) : ''}">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="number-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${record ? 'Salvar alterações' : 'Cadastrar número'}</button>
      </div>
    </form>
  `;
}

async function openNumberForm(record = null) {
  openModal(record ? 'Editar Número Único' : 'Novo Número Único', numberFormTemplate(record));
  const zipList = await loadZipsLite();
  populateZipSelect(qs('#number-zip'), zipList, record ? record.zip_code_id : '');
  qs('#number-cancel').addEventListener('click', closeModal);
  qs('#number-form').addEventListener('submit', (e) => submitNumberForm(e, record));
}

async function submitNumberForm(e, record) {
  e.preventDefault();
  const zipCodeId = qs('#number-zip').value;
  const addressNumber = Number(qs('#number-address').value);
  const description = qs('#number-descr').value.trim() || null;

  const payload = { zip_code_id: zipCodeId, address_number: addressNumber, description };
  const query = record
    ? sb.from('unique_numbers').update(payload).eq('id', record.id)
    : sb.from('unique_numbers').insert(payload);
  const { error } = await query;

  if (error) {
    showToast(`Erro ao salvar número: ${error.message}`, 'error');
    return;
  }
  closeModal();
  showToast(record ? 'Número atualizado.' : 'Número cadastrado.');
  await loadNumbers();
}

async function deleteNumber(id) {
  openDeleteConfirm('este número único', null, async () => {
    const { error } = await sb.from('unique_numbers').delete().eq('id', id);
    if (error) {
      showToast(`Erro ao excluir: ${error.message}`, 'error');
      return;
    }
    closeModal();
    showToast('Número excluído.');
    await loadNumbers();
  });
}

qs('#btn-new-number').addEventListener('click', () => openNumberForm());
qs('#numbers-filter-zip').addEventListener('change', loadNumbers);

qs('#numbers-tbody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-number]');
  const deleteBtn = e.target.closest('[data-delete-number]');
  if (editBtn) {
    const record = numbersCache.find((n) => String(n.id) === editBtn.dataset.editNumber);
    if (record) openNumberForm(record);
  }
  if (deleteBtn) deleteNumber(deleteBtn.dataset.deleteNumber);
});

// =============================================================================
// Init
// =============================================================================
async function init() {
  const placeholderUrl = SUPABASE_URL.includes('YOUR-PROJECT');
  const placeholderKey = SUPABASE_ANON_KEY.includes('YOUR-ANON');
  if (placeholderUrl || placeholderKey) {
    qs('#config-banner').classList.remove('hidden');
  }

  await loadStreetsLite();
  await loadStreets(0);
  await loadZips();
  await refreshZipFilterDropdowns();
  await loadRanges();
  await loadNumbers();
}

init();