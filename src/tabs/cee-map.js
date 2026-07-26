// =============================================================================
// MODULE: CEE MAP & SECTORS
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

    // Extract the specific IDs to update
    const idsToUpdate = codes
        .map((code) => ceeSectorsCache.find((s) => s.code === code)?.id)
        .filter(Boolean);

    // Perform a single update query for all selected IDs
    const { error } = await sb
        .from("cee_sectors")
        .update({ current_offset: 0 })
        .in("id", idsToUpdate);

    if (error) {
        showToast(`Erro ao zerar offsets: ${error.message}`, "error");
        return;
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