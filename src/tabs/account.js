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

    // Attempt to update the user bar if the function exists
    if (typeof updateUserBar === "function") updateUserBar();

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

// Autofill address fields when typing the CEP
const accountZipInput = qs("#account-zip");
if (accountZipInput) {
    accountZipInput.addEventListener("input", async (e) => {
        // Strip out non-numeric characters for length checking
        let val = e.target.value.replace(/\D/g, "");

        // Notify the user to type the full CEP
        if (val.length > 0 && val.length < 8) {
            accountSetStatus("Digite o CEP completo (8 dígitos) para autopreencher o endereço.");
        } else if (val.length === 0) {
            accountSetStatus("");
        }

        // Trigger search when exactly 8 digits are typed
        if (val.length === 8) {
            // Format the value to match the database constraint 'XXXXX-XXX'
            const formattedZip = `${val.slice(0, 5)}-${val.slice(5)}`;
            e.target.value = formattedZip;

            accountSetStatus("Buscando endereço no banco de dados...");

            // Query the database joining zip_codes with streets
            const { data, error } = await sb
                .from("zip_codes")
                .select("zip_code, streets(name, neighborhood)")
                .eq("zip_code", formattedZip)
                .maybeSingle();

            if (error) {
                accountSetStatus(`Erro ao buscar CEP: ${error.message}`, true);
                return;
            }

            if (data && data.streets) {
                const streetInput = qs("#account-street");
                const neighborhoodInput = qs("#account-neighborhood");
                const cityInput = qs("#account-city");
                const stateInput = qs("#account-state");
                const numberInput = qs("#account-number");

                if (streetInput) streetInput.value = data.streets.name || "";

                // The 'neighborhood' field is stored as a text array in the database 
                if (neighborhoodInput) {
                    neighborhoodInput.value = data.streets.neighborhood && data.streets.neighborhood.length > 0
                        ? data.streets.neighborhood[0]
                        : "";
                }

                // Default city and state since this database focuses on Florianópolis/SC 
                if (cityInput) cityInput.value = "Florianópolis";
                if (stateInput) stateInput.value = "SC";

                accountSetStatus("Endereço preenchido automaticamente.");

                // Move focus to the 'Número' field for convenience
                if (numberInput) numberInput.focus();
            } else {
                accountSetStatus("CEP não encontrado. Por favor, preencha manualmente.", true);
            }
        }
    });
}

/**
 * Clears only the address-related fields in the form.
 */
function clearAccountAddress() {
    const addressIds = [
        "account-zip",
        "account-street",
        "account-number",
        "account-complement",
        "account-neighborhood",
        "account-city",
        "account-state"
    ];

    addressIds.forEach(id => {
        const input = qs(`#${id}`);
        if (input) input.value = "";
    });

    accountSetStatus("Campos de endereço limpos. Clique em Salvar para aplicar.");

    // Move focus to the first address field so the user can start typing
    const zipInput = qs("#account-zip");
    if (zipInput) zipInput.focus();
}

// --- Event Listeners ---

// Attach the clear address function to the new button
const btnAccountClearAddress = qs("#btn-account-clear-address");
if (btnAccountClearAddress) {
    btnAccountClearAddress.addEventListener("click", clearAccountAddress);
}