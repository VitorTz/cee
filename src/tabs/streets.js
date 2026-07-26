
// =============================================================================
// MODULE: STREET MANAGEMENT
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