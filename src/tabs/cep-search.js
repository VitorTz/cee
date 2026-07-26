// =============================================================================
// MODULE: CEP SEARCH ENGINE
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

    // A "new" match is a different street than whatever was matched before,
    // so retyping within the same street (e.g. adding more characters that
    // still resolve to it) won't keep stealing focus away from the query field.
    const isNewMatch = cepSearchState.streetId !== chosen.id;

    await loadStreetBreakdown(chosen);
    numberInput.disabled = false;
    if (opts.focusNumber || isNewMatch) numberInput.focus();
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