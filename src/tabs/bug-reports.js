// =============================================================================
// MODULE: BUG REPORTS
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