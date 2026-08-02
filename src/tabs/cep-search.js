// =============================================================================
// MODULE: CEP SEARCH ENGINE
// =============================================================================
import { qs } from "../utils.js";
import { switchTab } from "../ui.js";
import { initStreetCombobox } from "../combobox.js";

const SIDE_LABELS = { odd: "Ímpar", even: "Par", both: "Ambos" };

let cepSearchState = {
    streetId: null,
    street: null,
    breakdown: [],
    searchLogged: false,
};

let cepSearchCombobox = null;

/**
 * Invoked by external modules (e.g., clicking 'Consultar' in a table)
 * to prepopulate the search and attempt to find a match.
 */
async function goToCepSearch(zipCodeStr) {
    switchTab("cepsearch");

    // Attempt to resolve the street automatically
    const matches = await searchStreetsByTerm(zipCodeStr);
    if (matches.length > 0) {
        // If it's a specific ZIP, it usually matches exactly 1 street.
        const chosen = matches[0];
        if (cepSearchCombobox) cepSearchCombobox.setValue(chosen);
        handleCepSearchSelect(chosen);
    } else {
        if (cepSearchCombobox) cepSearchCombobox.setValue(null);
        handleCepSearchSelect(null);
        // Leave the input with what they passed so they can edit
        const queryInput = qs("#cepsearch-query");
        if (queryInput) queryInput.value = zipCodeStr;
    }
}

/**
 * Handles the selection event triggered by the Combobox (either via 
 * manual click or auto-selection when there is exactly 1 match).
 */
function handleCepSearchSelect(street) {
    const hintEl = qs("#cepsearch-match-hint");
    const numberInput = qs("#cepsearch-number");
    const resultsEl = qs("#cepsearch-results");
    const emptyEl = qs("#cepsearch-empty");

    if (!street) {
        cepSearchState = {
            streetId: null,
            street: null,
            breakdown: [],
            searchLogged: false,
        };
        hintEl.textContent = "Digite para localizar o logradouro.";
        numberInput.disabled = true;
        numberInput.value = "";
        resultsEl.classList.add("hidden");
        emptyEl.classList.remove("hidden");
        return;
    }

    hintEl.innerHTML = `Correspondência: <strong>${escapeHtml(street.name)}</strong>`;

    const isNewMatch = cepSearchState.streetId !== street.id;

    loadStreetBreakdown(street).then(() => {
        numberInput.disabled = false;
        if (isNewMatch) {
            numberInput.value = "";
            numberInput.focus();
        }
        renderCepSearchResults();
    });
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

    const leftColumnContent = `
    ${notFoundMessageHtml}
    ${blocksHtml || '<p class="field-hint">Este logradouro ainda não tem CEPs cadastrados.</p>'}
  `;

    if (resultsEl.dataset.renderedStreet === String(street.id)) {
        const resultsCol = qs('.cepsearch-results-col', resultsEl);
        if (resultsCol) {
            resultsCol.innerHTML = leftColumnContent;
        }
        return; 
    }

    const mapSearchQuery = encodeURIComponent(
        `${street.name}, ${formatNeighborhoods(street.neighborhood)}, Florianópolis, SC, Brasil`
    );

    const mapHtml = `
    <div class="street-map-container">
      <iframe 
        style="width: 100%; height: 100%; min-height: 480px; border: none; display: block;"
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
          <div class="cepsearch-results-col">
            ${leftColumnContent}
          </div>
          <div class="cepsearch-map-col">
            ${mapHtml}
          </div>
        </div>
      </div>
    </div>
  `;

    resultsEl.dataset.renderedStreet = String(street.id);
}

// --- Event Listeners ---

const cepQueryInput = qs("#cepsearch-query");
const cepQuerySuggestions = qs("#cepsearch-query-suggestions");

// Initialize the Combobox wrapper on the search input
if (cepQueryInput && cepQuerySuggestions) {
    cepSearchCombobox = initStreetCombobox({
        inputEl: cepQueryInput,
        suggestionsEl: cepQuerySuggestions,
        onSelect: handleCepSearchSelect
    });
}

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