// =============================================================================
// AUTHENTICATION & ROLE-BASED ACCESS CONTROL
// =============================================================================
// Every screen in this app requires an authenticated Supabase session.
// Accounts are created by the admin via the Supabase Auth panel; roles live
// in the `user_roles` table and are set by the admin in the Table Editor.


const loginScreenEl = qs("#login-screen");
const appShellEl = qs("#app-shell");
const loginFormEl = qs("#login-form");
const loginIdentifierEl = qs("#login-identifier");
const loginPasswordEl = qs("#login-password");
const loginErrorEl = qs("#login-error");
const loginSubmitEl = qs("#login-submit");
const userBarEmailEl = qs("#user-bar-email");
const userBarRoleEl = qs("#user-bar-role");
const btnLogoutEl = qs("#btn-logout");
const pingOverlay = qs("#supabase-ping");

// Supabase Auth only understands email (or phone) as an identifier, so
// numeric-ID ("matrícula") logins are implemented by mapping the number to a
// deterministic, never-emailed-to synthetic address under this domain.
// When creating an account for someone who should log in with just a
// number, the admin must register that user in the Supabase Auth panel
// using EXACTLY `<numero>@ID_LOGIN_DOMAIN` as the email (any password).
const ID_LOGIN_DOMAIN = "id.cee.local";
const NUMERIC_ID_REGEX = /^\d{1,19}$/; // up to a signed 64-bit ("long long") value

// Turns whatever the user typed (an email, or a numeric matrícula) into the
// actual identifier Supabase Auth expects. Returns { email } on success or
// { error } if the input matches neither shape.
function resolveLoginIdentifier(raw) {
    const value = (raw || "").trim();

    if (!value) {
        return { error: "Informe seu e-mail ou número de matrícula." };
    }
    if (value.includes("@")) {
        return { email: value.toLowerCase() };
    }
    if (NUMERIC_ID_REGEX.test(value)) {
        return { email: `${value}@${ID_LOGIN_DOMAIN}` };
    }
    return {
        error: "Use um e-mail válido ou uma matrícula somente com números.",
    };
}

const ROLE_LABELS = {
    admin: "Administrador",
    operador: "Operador",
    visualizador: "Visualizador",
};

function setLoginError(message) {
    if (!loginErrorEl) return;
    if (message) {
        loginErrorEl.textContent = message;
        loginErrorEl.classList.remove("hidden");
    } else {
        loginErrorEl.textContent = "";
        loginErrorEl.classList.add("hidden");
    }
}

function setLoginLoading(isLoading) {
    if (!loginSubmitEl) return;
    loginSubmitEl.disabled = isLoading;
    loginSubmitEl.textContent = isLoading ? "Entrando..." : "Entrar";
}

// Fetches the role for the currently logged-in user from user_roles.
// Defaults to 'visualizador' (read-only) if no row exists yet, or if the
// lookup fails for any reason, so a misconfigured account never gets more
// access than the safest default.
async function fetchCurrentUserRole() {
    const { data, error } = await sb
        .from("user_roles")
        .select("role")
        .maybeSingle();

    if (error || !data) {
        if (error) console.error("Failed to load user role:", error);
        return "visualizador";
    }
    return data.role;
}

// Applies UI-level restrictions based on the user's role. This is a
// convenience layer only: the actual enforcement happens server-side via
// PostgreSQL Row Level Security, so hidden controls can never be re-shown
// to bypass permissions.
function applyRolePermissions(role) {
    document.body.classList.remove("restrict-catalog", "restrict-daily");

    if (role === UserRoles.CARTEIRO) {
        document.body.classList.add("restrict-daily");
        if (typeof dailyNotesEditor !== "undefined" && dailyNotesEditor) {
            dailyNotesEditor.disable();
        }
    }
}

// Fetches (and caches) just the display name from the user's own profile
// row, so the user bar can show a real name instead of the bare
// matrícula/e-mail once they've filled it in via "Minha Conta". Safe to
// call repeatedly; RLS only ever returns the caller's own row.
async function fetchCurrentUserDisplayName() {
    const { data, error } = await sb
        .from("user_profiles")
        .select("full_name")
        .eq("user_id", currentUser.id)
        .maybeSingle();

    if (error || !data) return null;
    return data.full_name || null;
}

function updateUserBar() {
    if (userBarEmailEl) {
        const email = currentUser?.email || "";
        const syntheticSuffix = `@${ID_LOGIN_DOMAIN}`;
        const identity = email.endsWith(syntheticSuffix)
            ? (() => {
                const identifier = email.slice(0, -syntheticSuffix.length);
                if (isValidCPF(identifier)) {
                    return `CPF: ${identifier}`
                } else if (hasOnlyDigits(identifier)) {
                    return `Matrícula: ${identifier}`
                }
                return identifier;
            })()
            : email;

        userBarEmailEl.textContent = identity;

        // Fire-and-forget upgrade to the person's actual name once it loads,
        // without blocking the rest of the login flow.
        fetchCurrentUserDisplayName().then((name) => {
            if (name) userBarEmailEl.textContent = `${name} (${identity})`;
        });
    }
    if (userBarRoleEl) {
        userBarRoleEl.textContent = currentUserRole || UserRoles.CARTEIRO;
        userBarRoleEl.className = `role-badge role-badge-${currentUserRole || UserRoles.CARTEIRO}`;
    }
}

async function showApp(session) {
    currentUser = session.user;

    if (loginScreenEl) loginScreenEl.classList.add("hidden");
    if (appShellEl) appShellEl.classList.remove("hidden");
    setLoginError(null);
    if (loginFormEl) loginFormEl.reset();

    currentUserRole = await fetchCurrentUserRole();
    applyRolePermissions(currentUserRole);
    updateUserBar();

    if (!appInitialized) {
        appInitialized = true;
        await init();
        initSupabasePing();
    }
}

function showLogin() {
    currentUser = null;
    currentUserRole = null;
    appInitialized = false;
    if (appShellEl) appShellEl.classList.add("hidden");
    if (loginScreenEl) loginScreenEl.classList.remove("hidden");
    setLoginLoading(false);
    if (loginIdentifierEl) setTimeout(() => loginIdentifierEl.focus(), 50);
}

if (loginFormEl) {
    loginFormEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        setLoginError(null);

        const resolved = resolveLoginIdentifier(loginIdentifierEl.value);
        if (resolved.error) {
            setLoginError(resolved.error);
            return;
        }

        setLoginLoading(true);

        const { error } = await sb.auth.signInWithPassword({
            email: resolved.email,
            password: loginPasswordEl.value,
        });

        setLoginLoading(false);

        if (error) {
            setLoginError(
                error.message === "Invalid login credentials"
                    ? "Credenciais inválidas."
                    : error.message,
            );
        }
    });
}

if (btnLogoutEl) {
    btnLogoutEl.addEventListener("click", async () => {
        btnLogoutEl.disabled = true;
        await sb.auth.signOut();
        btnLogoutEl.disabled = false;
    });
}

async function handleSessionChange(session) {
    if (session) {
        await showApp(session);
    } else {
        showLogin();
    }
    if (currentUserRole == UserRoles.ADMIN) {
        qs("#metrics-tab").classList.remove("hidden");
        pingOverlay.classList.remove("hidden");
    } else {
        qs("#metrics-tab").classList.add("hidden");
        pingOverlay.classList.add("hidden");
    }

    const funcionariosTabEl = qs("#funcionarios-tab");
    if (funcionariosTabEl) {
        const canSeeFuncionarios =
            currentUserRole == UserRoles.ADMIN ||
            currentUserRole == UserRoles.SUPERVISOR;
        funcionariosTabEl.classList.toggle("hidden", !canSeeFuncionarios);
        // If the role changed (e.g. a fresh login) while this tab was open,
        // bounce back to a tab every role can see.
        if (!canSeeFuncionarios && funcionariosTabEl.classList.contains("active")) {
            switchTab("zips");
        }
    }
}

sb.auth.onAuthStateChange((event, session) => handleSessionChange(session));