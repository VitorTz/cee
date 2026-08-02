import { qs } from "../utils.js";
import { showToast, openDeleteConfirm, closeModal } from "../ui.js";
import { sb, currentUser } from "../supabase-client.js";
import { updateUserBar } from "../auth.js";


let accountProfile = null;
let accountLoaded = false;
let accountDirty = false;

const ACCOUNT_FIELDS = [
    { id: "account-full-name", key: "full_name", label: "Nome completo" },
    { id: "account-phone", key: "phone", label: "Telefone" },
    { id: "account-contact-email", key: "contact_email", label: "E-mail de contato" },
];

/**
 * Updates the status message below the account title.
 */
function accountSetStatus(message, isError = false) {
    const el = qs("#account-status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
    el.classList.toggle("field-error", isError);
}

/**
 * Fills the form inputs with data from the profile object.
 */
function accountFillForm(profile) {
    ACCOUNT_FIELDS.forEach(({ id, key }) => {
        const input = qs(`#${id}`);
        if (input) input.value = (profile && profile[key]) || "";
    });
}

/**
 * Reads the current values from the form inputs.
 */
function accountReadForm() {
    const values = {};
    ACCOUNT_FIELDS.forEach(({ id, key }) => {
        const input = qs(`#${id}`);
        values[key] = input ? input.value.trim() || null : null;
    });
    return values;
}

/**
 * Loads the user's profile from the database and populates the form.
 */
export async function loadAccountPage() {
    const formEl = qs("#account-form");
    if (!formEl || !currentUser) return;

    accountSetStatus("Carregando…");

    const { data, error } = await sb
        .from("user_profiles")
        .select("*")
        .eq("user_id", currentUser.id)
        .maybeSingle();

    if (error) {
        accountSetStatus(`Erro ao carregar perfil: ${error.message}`, true);
        return;
    }

    accountProfile = data;
    accountLoaded = true;

    accountFillForm(data);
    accountSetStatus(
        data ? "" : "Você ainda não preencheu seus dados. Complete abaixo.",
    );

    const deleteBtn = qs("#btn-account-delete");
    if (deleteBtn) deleteBtn.classList.toggle("hidden", !data);
}

/**
 * Saves the current form data to the user's profile in the database.
 */
async function saveAccountProfile(e) {
    e.preventDefault();
    if (!currentUser) return;

    const submitBtn = qs("#btn-account-save");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Salvando...";
    }

    const values = accountReadForm();
    const payload = { user_id: currentUser.id, ...values };

    // A single row per user: insert on first save, update afterwards. 
    // RLS only allows user_id = auth.uid(), for both the insert and update paths.
    const { data, error } = await sb
        .from("user_profiles")
        .upsert(payload, { onConflict: "user_id" })
        .select()
        .single();

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Salvar";
    }

    if (error) {
        accountSetStatus(`Erro ao salvar: ${error.message}`, true);
        showToast(`Erro ao salvar perfil: ${error.message}`, "error");
        return;
    }

    accountProfile = data;
    accountSetStatus("Dados salvos com sucesso.");
    showToast("Perfil atualizado com sucesso!");

    updateUserBar();

    const deleteBtn = qs("#btn-account-delete");
    if (deleteBtn) deleteBtn.classList.remove("hidden");
}

/**
 * Prompts the user for confirmation before deleting their profile data.
 */
function confirmDeleteAccountProfile() {
    if (!currentUser || !accountProfile) return;
    openDeleteConfirm(
        "seus dados de perfil",
        "O nome, email e telefone cadastrados serão apagados. Isso não afeta seu login.",
        async () => {
            const { error } = await sb
                .from("user_profiles")
                .delete()
                .eq("user_id", currentUser.id);

            if (error) {
                showToast(`Erro ao excluir dados: ${error.message}`, "error");
                return;
            }

            accountProfile = null;
            accountFillForm(null);
            accountSetStatus("Dados removidos.");
            closeModal();
            showToast("Dados de perfil excluídos.");

            if (typeof updateUserBar === "function") updateUserBar();

            const deleteBtn = qs("#btn-account-delete");
            if (deleteBtn) deleteBtn.classList.add("hidden");
        },
    );
}

// --- Event Listeners ---

const accountFormEl = qs("#account-form");
if (accountFormEl) accountFormEl.addEventListener("submit", saveAccountProfile);

const btnAccountDelete = qs("#btn-account-delete");
if (btnAccountDelete) btnAccountDelete.addEventListener("click", confirmDeleteAccountProfile);
