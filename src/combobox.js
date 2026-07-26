
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
        query = query.or(`search_text.ilike.%${wildcardTerm}%,id.in.(${zipStreetIds.join(",")})`,);
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