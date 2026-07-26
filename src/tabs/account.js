// =============================================================================
// MODULE: MINHA CONTA (PERFIL DO USUÁRIO)
// =============================================================================
// A conta em si (e-mail/matrícula + senha) continua sendo criada pelo admin
// direto no painel do Supabase Auth, como já era. O que essa aba faz é
// deixar o próprio usuário completar as informações de perfil (nome,
// telefone, e-mail de contato, endereço) depois de logado. Tudo aqui lê e
// grava só a própria linha do usuário em public.user_profiles — a RLS do
// banco garante isso mesmo que o JS tente algo diferente.

let accountProfile = null;
let accountLoaded = false;
let accountDirty = false;

const ACCOUNT_FIELDS = [
    { id: "account-full-name", key: "full_name", label: "Nome completo" },
    { id: "account-phone", key: "phone", label: "Telefone" },
    { id: "account-contact-email", key: "contact_email", label: "E-mail de contato" },
    { id: "account-zip", key: "address_zip", label: "CEP" },
    { id: "account-street", key: "address_street", label: "Rua / Logradouro" },
    { id: "account-number", key: "address_number", label: "Número" },
    { id: "account-complement", key: "address_complement", label: "Complemento" },
    { id: "account-neighborhood", key: "address_neighborhood", label: "Bairro" },
    { id: "account-city", key: "address_city", label: "Cidade" },
    { id: "account-state", key: "address_state", label: "UF" },
];

function accountSetStatus(message, isError = false) {
    const el = qs("#account-status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
    el.classList.toggle("field-error", isError);
}

function accountFillForm(profile) {
    ACCOUNT_FIELDS.forEach(({ id, key }) => {
        const input = qs(`#${id}`);
        if (input) input.value = (profile && profile[key]) || "";
    });
}

function accountReadForm() {
    const values = {};
    ACCOUNT_FIELDS.forEach(({ id, key }) => {
        const input = qs(`#${id}`);
        values[key] = input ? input.value.trim() || null : null;
    });
    return values;
}

async function loadAccountPage() {
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

    // A single row per user: insert on first save, update afterwards. RLS
    // only allows user_id = auth.uid(), for both the insert and update paths.
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

function confirmDeleteAccountProfile() {
    if (!currentUser || !accountProfile) return;
    openDeleteConfirm(
        "seus dados de perfil",
        "O nome, telefone e endereço cadastrados serão apagados. Isso não afeta seu login.",
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
            updateUserBar();

            const deleteBtn = qs("#btn-account-delete");
            if (deleteBtn) deleteBtn.classList.add("hidden");
        },
    );
}

const accountFormEl = qs("#account-form");
if (accountFormEl) accountFormEl.addEventListener("submit", saveAccountProfile);

const btnAccountDelete = qs("#btn-account-delete");
if (btnAccountDelete) btnAccountDelete.addEventListener("click", confirmDeleteAccountProfile);