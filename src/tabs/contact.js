// =============================================================================
// MODULE: CONTACT US
// =============================================================================

/**
 * Generates the HTML template for the Contact Us form modal.
 */
function contactFormTemplate() {
    return `
    <form id="contact-us-form">
      <div class="field">
        <label for="contact-subject">Assunto</label>
        <input type="text" id="contact-subject" required maxlength="150" placeholder="Qual o motivo do contato?">
      </div>
      <div class="field">
        <label for="contact-message">Mensagem</label>
        <textarea id="contact-message" required rows="5" placeholder="Escreva sua mensagem detalhada aqui..."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="contact-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary" id="contact-submit">Enviar Mensagem</button>
      </div>
    </form>
    `;
}

/**
 * Opens the Contact Us modal and attaches event listeners.
 */
function openContactModal() {
    // Uses the existing openModal function from ui.js
    openModal("Entrar em Contato", contactFormTemplate());

    const cancelBtn = qs("#contact-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

    const form = qs("#contact-us-form");
    if (form) form.addEventListener("submit", submitContactForm);
}

/**
 * Handles the submission of the Contact Us form.
 */
async function submitContactForm(e) {
    e.preventDefault();

    const subject = qs("#contact-subject").value.trim();
    const message = qs("#contact-message").value.trim();

    if (!subject || !message) return;

    const submitBtn = qs("#contact-submit");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando...";
    }

    // Insert the message into the Supabase database
    const { error } = await sb
        .from("contact_messages")
        .insert({
            user_id: currentUser ? currentUser.id : null,
            subject: subject,
            message: message
        });

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Enviar Mensagem";
    }

    if (error) {
        showToast(`Erro ao enviar mensagem: ${error.message}`, "error");
        return;
    }

    closeModal();
    showToast("Mensagem enviada com sucesso!");
}

// --- Event Listeners ---

const btnContactUs = qs("#btn-contact-us");
if (btnContactUs) {
    btnContactUs.addEventListener("click", openContactModal);
}