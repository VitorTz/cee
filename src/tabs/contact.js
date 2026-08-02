// =============================================================================
// MODULE: CONTACT US
// =============================================================================
import { showToast, openModal, closeModal } from "../ui.js";
import { qs } from "../utils.js";

const MAX_CONTACT_FILE_SIZE = 50 * 1024 * 1024; // 50MB
let contactSelectedFiles = [];

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
      <div class="field">
        <label for="contact-attachments" class="btn btn-secondary btn-icon" style="display: inline-block; cursor: pointer; text-align: center;">
          + Adicionar Anexos (Máx. 50MB)
        </label>
        <input type="file" id="contact-attachments" multiple class="hidden" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx">
        <div id="contact-file-list" class="helpdesk-file-list" style="margin-top: 8px;"></div>
      </div>
      <div class="modal-actions" style="margin-top: 16px;">
        <button type="button" class="btn btn-secondary" id="contact-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary" id="contact-submit">Enviar Mensagem</button>
      </div>
    </form>
    `;
}

/**
 * Renders the selected files as chips in the UI.
 */
function renderContactFileList() {
    const fileListEl = qs("#contact-file-list");
    if (!fileListEl) return;

    fileListEl.innerHTML = contactSelectedFiles.map((file, index) => `
        <span class="helpdesk-file-chip">
            ${escapeHtml(file.name)} 
            <button type="button" data-index="${index}">&times;</button>
        </span>
    `).join("");
}

/**
 * Opens the Contact Us modal and attaches event listeners.
 */
function openContactModal() {
    // Uses the existing openModal function from ui.js
    openModal("Entrar em Contato", contactFormTemplate());
    contactSelectedFiles = []; // Reset state

    const cancelBtn = qs("#contact-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

    const form = qs("#contact-us-form");
    if (form) form.addEventListener("submit", submitContactForm);

    const fileInput = qs("#contact-attachments");
    const fileListEl = qs("#contact-file-list");

    // Handle file selection and 50MB validation
    if (fileInput) {
        fileInput.addEventListener("change", (e) => {
            const newFiles = Array.from(e.target.files);

            newFiles.forEach(file => {
                if (file.size > MAX_CONTACT_FILE_SIZE) {
                    showToast(`O arquivo ${file.name} excede o limite de 50MB.`, "error");
                } else {
                    contactSelectedFiles.push(file);
                }
            });

            renderContactFileList();
            // Reset input so the same file can be selected again if removed
            fileInput.value = "";
        });
    }

    // Handle file removal from the chip list
    if (fileListEl) {
        fileListEl.addEventListener("click", (e) => {
            if (e.target.tagName === "BUTTON") {
                const index = Number(e.target.dataset.index);
                contactSelectedFiles.splice(index, 1);
                renderContactFileList();
            }
        });
    }
}

/**
 * Handles the submission of the Contact Us form, including file uploads.
 */
async function submitContactForm(e) {
    e.preventDefault();

    const subject = qs("#contact-subject").value.trim();
    const message = qs("#contact-message").value.trim();

    if (!subject || !message) return;

    const submitBtn = qs("#contact-submit");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando anexos...";
    }

    const uploadedPaths = [];

    // 1. Upload files to Supabase Storage if any are selected
    if (contactSelectedFiles.length > 0) {
        for (const file of contactSelectedFiles) {
            const fileExt = file.name.split('.').pop();
            const fileName = `${Date.now()}_${Math.random().toString(36).substring(2)}.${fileExt}`;
            const filePath = `${currentUser ? currentUser.id : 'anon'}/${fileName}`;

            const { data: uploadData, error: uploadError } = await sb.storage
                .from('contact_attachments')
                .upload(filePath, file);

            if (uploadError) {
                showToast(`Erro ao enviar ${file.name}: ${uploadError.message}`, "error");
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Enviar Mensagem";
                }
                return; // Stop submission on upload failure
            }

            uploadedPaths.push(uploadData.path);
        }
    }

    if (submitBtn) submitBtn.textContent = "Salvando mensagem...";

    // 2. Insert the message into the Supabase database along with the file paths
    const { error: insertError } = await sb
        .from("contact_messages")
        .insert({
            user_id: currentUser ? currentUser.id : null,
            subject: subject,
            message: message,
            attachments: uploadedPaths
        });

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Enviar Mensagem";
    }

    if (insertError) {
        showToast(`Erro ao enviar mensagem: ${insertError.message}`, "error");
        return;
    }

    closeModal();
    showToast("Mensagem e anexos enviados com sucesso!");
}

// --- Event Listeners ---

const btnContactUs = qs("#btn-contact-us");
if (btnContactUs) {
    btnContactUs.addEventListener("click", openContactModal);
}