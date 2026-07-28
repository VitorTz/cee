// =============================================================================
// MODULE: HELP DESK (CHAMADOS)
// =============================================================================
// Carteiros abrem chamados (etiqueta trocada, encomenda faltando/errada,
// pneu furado, acidente, etc.) atrelados à própria conta e trocam mensagens,
// fotos e vídeos com os supervisores. Supervisores/admin enxergam e podem
// responder qualquer chamado, em qualquer estado. RLS no banco é quem
// realmente garante isso — o JS abaixo só reflete essas mesmas regras na UI.

const HELPDESK_BUCKET = "helpdesk-media";
const HELPDESK_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const HELPDESK_KIND_ICONS = {
    image: "🖼️",
    video: "🎬",
    audio: "🎵",
    pdf: "📄",
    file: "📎",
};

const HELPDESK_CATEGORIES = [
    { value: "encomenda_faltando", label: "Encomenda faltando" },
    { value: "etiqueta_trocada", label: "Etiqueta trocada" },
    { value: "encomenda_errada", label: "Encomenda errada" },
    { value: "pneu_furado", label: "Pneu furado" },
    { value: "acidente", label: "Acidente" },
    { value: "outro", label: "Outro" },
];
const HELPDESK_CATEGORY_LABELS = Object.fromEntries(
    HELPDESK_CATEGORIES.map((c) => [c.value, c.label]),
);

const HELPDESK_STATUS_LABELS = {
    aberto: "Em espera",
    em_andamento: "Em andamento",
    concluido_sucesso: "Concluído (sucesso)",
    concluido_sem_sucesso: "Concluído (sem sucesso)",
};
const HELPDESK_STATUS_BADGE_CLASS = {
    aberto: "helpdesk-status-aberto",
    em_andamento: "helpdesk-status-andamento",
    concluido_sucesso: "helpdesk-status-sucesso",
    concluido_sem_sucesso: "helpdesk-status-sem-sucesso",
};

let helpdeskTicketsCache = [];
let helpdeskFilterStatus = ""; // "" = todos
let helpdeskSelectedTicketId = null;
let helpdeskMessagesCache = [];
let helpdeskRealtimeChannel = null;
let helpdeskUserLabelCache = new Map(); // user_id -> { email, role, full_name, phone, ... }
let helpdeskComposerFiles = [];
let helpdeskNewTicketFiles = [];
let helpdeskListLoaded = false;
let helpdeskTicketSupervisorIds = []; // supervisores já vinculados ao chamado aberto
let helpdeskGlobalChannel = null;

// --- Helpers -----------------------------------------------------------

/**
 * Compresses an image file using the browser's Canvas API before uploading.
 * Converts the image to WebP format for maximum size reduction.
 * 
 * @param {File} file - The original image file.
 * @param {number} maxWidthOrHeight - The maximum allowed dimension.
 * @param {number} quality - Compression quality (0.0 to 1.0). Lower is smaller.
 * @returns {Promise<File>} - A promise resolving to the compressed File, or the original if it fails.
 */
async function compressImage(file, maxWidthOrHeight = 1280, quality = 0.5) {
    // Skip compression for non-images, GIFs (would lose animation), or SVGs
    if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") {
        return file;
    }

    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);

        img.onload = () => {
            URL.revokeObjectURL(url);
            let width = img.width;
            let height = img.height;

            // Scale down the image if it exceeds the maximum dimensions
            if (width > height && width > maxWidthOrHeight) {
                height = Math.round((height * maxWidthOrHeight) / width);
                width = maxWidthOrHeight;
            } else if (height > maxWidthOrHeight) {
                width = Math.round((width * maxWidthOrHeight) / height);
                height = maxWidthOrHeight;
            }

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);

            // Export the canvas content as a heavily compressed WebP
            canvas.toBlob(
                (blob) => {
                    if (!blob) {
                        resolve(file); // Fallback to original if something goes wrong
                        return;
                    }
                    // Replace original extension with .webp
                    const newFileName = file.name.replace(/\.[^/.]+$/, "") + ".webp";
                    const compressedFile = new File([blob], newFileName, {
                        type: "image/webp",
                        lastModified: Date.now(),
                    });
                    resolve(compressedFile);
                },
                "image/webp",
                quality
            );
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(file); // Fallback to original on error
        };

        img.src = url;
    });
}


// Mirrors the matrícula/CPF/e-mail formatting already used for the
// logged-in user in the user bar (auth.js), so identities look consistent
// throughout the app.
function formatHelpdeskIdentity(email) {
    if (!email) return "Usuário";
    const syntheticSuffix = "@id.cee.local";
    if (email.endsWith(syntheticSuffix)) {
        const identifier = email.slice(0, -syntheticSuffix.length);
        if (isValidCPF(identifier)) {
            return `CPF: ${identifier}`;
        } else if (hasOnlyDigits(identifier)) {
            return `Matrícula: ${identifier}`;
        }
        return identifier;
    }
    return email;
}

/**
 * Resolves and caches user profile information (name, phone, role, etc.).
 * @param {string[]} userIds - Array of UUIDs to fetch.
 * @param {boolean} checkMissingData - If true, re-fetches users who have an empty profile.
 */
async function resolveHelpdeskUserLabels(userIds, checkMissingData = false) {
    const missing = Array.from(new Set(userIds)).filter((id) => {
        if (!id) return false;
        const cached = helpdeskUserLabelCache.get(id);

        // Always fetch if not found in cache
        if (!cached) return true;

        // If instructed to check for missing data, and profile fields are empty
        if (checkMissingData && !cached.full_name && !cached.phone) {
            // Prevent spamming requests for users who genuinely have an empty profile (throttle 60s)
            if (cached._lastFetch && (Date.now() - cached._lastFetch < 60000)) {
                return false;
            }
            return true;
        }
        return false;
    });

    if (missing.length === 0) return;

    const { data, error } = await sb.rpc("get_helpdesk_user_labels", {
        p_user_ids: missing,
    });

    if (error) {
        console.error("Failed to resolve user labels:", error);
        return;
    }

    const fetchTime = Date.now();
    (data || []).forEach((row) => {
        helpdeskUserLabelCache.set(row.user_id, { ...row, _lastFetch: fetchTime });
    });
}

function helpdeskUserLabel(userId) {
    const entry = helpdeskUserLabelCache.get(userId);

    if (entry) {
        return entry.full_name || formatHelpdeskIdentity(entry.email);
    }

    if (currentUser && userId === currentUser.id) {
        return formatHelpdeskIdentity(currentUser.email);
    }

    return "Carregando…";
}

// Builds a short one-line address from whatever profile fields are filled
// in ("Rua X, 123 - Bairro, Cidade/UF"), skipping anything blank.
function formatHelpdeskProfileAddress(entry) {
    if (!entry) return "";
    const streetPart = [entry.address_street, entry.address_number]
        .filter(Boolean)
        .join(", ");
    const cityPart = [entry.address_neighborhood, entry.address_city]
        .filter(Boolean)
        .join(", ");
    const pieces = [streetPart, cityPart, entry.address_state]
        .filter(Boolean);
    let line = pieces.join(" - ");
    if (entry.address_zip) line = line ? `${line} (CEP ${entry.address_zip})` : `CEP ${entry.address_zip}`;
    return line;
}

// Renders a small identity card (name, matrícula/e-mail, telefone, endereço)
// for a helpdesk participant, now including Call and WhatsApp shortcuts.
function helpdeskUserProfileCardHtml(userId, roleLabel, customClass = "") {
    const entry = helpdeskUserLabelCache.get(userId);
    if (!entry) {
        return `<div class="helpdesk-profile-card ${customClass} helpdesk-profile-card-loading">Carregando…</div>`;
    }

    const name = entry.full_name || formatHelpdeskIdentity(entry.email);
    const identity = formatHelpdeskIdentity(entry.email);
    const showIdentitySeparately = entry.full_name && identity !== name;
    const address = formatHelpdeskProfileAddress(entry);

    // Format phone number into actionable links if it exists
    let phoneLineHtml = "";
    if (entry.phone) {
        const cleanPhone = entry.phone.replace(/\D/g, "");
        // Assuming Brazil (+55) if the number has 10 or 11 digits and lacks country code
        const waPhone = (cleanPhone.length === 10 || cleanPhone.length === 11) ? "55" + cleanPhone : cleanPhone;

        phoneLineHtml = `
            <div class="helpdesk-profile-card-line" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <span>${escapeHtml(entry.phone)}</span>
                <a href="tel:${cleanPhone}" title="Ligar" style="display: flex; align-items: center; color: var(--correios-blue); text-decoration: none;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
                </a>
                <a href="https://wa.me/${waPhone}" target="_blank" rel="noopener" title="WhatsApp" style="display: flex; align-items: center; color: #25D366; text-decoration: none;">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                </a>
            </div>
        `;
    }

    return `
    <div class="helpdesk-profile-card ${customClass}">
      ${roleLabel ? `<span class="helpdesk-profile-card-role">${escapeHtml(roleLabel)}</span>` : ""}
      <div class="helpdesk-profile-card-name">${escapeHtml(name)}</div>
      ${showIdentitySeparately ? `<div class="helpdesk-profile-card-line">${escapeHtml(identity)}</div>` : ""}
      ${entry.contact_email ? `<div class="helpdesk-profile-card-line">${escapeHtml(entry.contact_email)}</div>` : ""}
      ${phoneLineHtml}
      ${address ? `<div class="helpdesk-profile-card-line" style="margin-top: 4px;">${escapeHtml(address)}</div>` : ""}
      ${!entry.full_name && !entry.phone && !address ? `<div class="helpdesk-profile-card-empty">Perfil ainda não preenchido.</div>` : ""}
    </div>
  `;
}

function helpdeskTimeAgo(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function canWriteHelpdeskTicket(ticket) {
    if (!ticket) return false;
    if (ticket.status === "concluido_sucesso" || ticket.status === "concluido_sem_sucesso")
        return false;
    if (currentUserRole === UserRoles.ADMIN || currentUserRole === UserRoles.SUPERVISOR)
        return true;
    return currentUserRole === UserRoles.CARTEIRO && ticket.carteiro_id === currentUser?.id;
}

// --- Ticket list ---------------------------------------------------------

async function loadHelpdeskTickets() {
    const listEl = qs("#helpdesk-ticket-list");
    if (!listEl) return;

    listEl.innerHTML = '<div class="helpdesk-list-loading">Carregando chamados&hellip;</div>';

    let query = sb
        .from("helpdesk_tickets")
        .select("*")
        .order("created_at", { ascending: false });

    if (helpdeskFilterStatus) query = query.eq("status", helpdeskFilterStatus);

    const { data, error } = await query;

    if (error) {
        listEl.innerHTML = `<div class="helpdesk-list-error">Erro ao carregar chamados: ${escapeHtml(error.message)}</div>`;
        return;
    }

    helpdeskTicketsCache = data || [];
    helpdeskListLoaded = true;

    await resolveHelpdeskUserLabels(helpdeskTicketsCache.map((t) => t.carteiro_id));
    renderHelpdeskTicketList();

    // Keep the open ticket's header (status badge etc.) in sync if it moved
    // between tabs/filters or changed state elsewhere.
    if (helpdeskSelectedTicketId) {
        const stillThere = helpdeskTicketsCache.find((t) => t.id === helpdeskSelectedTicketId);
        if (stillThere) renderHelpdeskTicketHeader(stillThere);
    }
}

function renderHelpdeskTicketList() {
    const listEl = qs("#helpdesk-ticket-list");
    const emptyEl = qs("#helpdesk-list-empty");
    if (!listEl) return;

    const isSupervisorView =
        currentUserRole === UserRoles.ADMIN || currentUserRole === UserRoles.SUPERVISOR;

    if (helpdeskTicketsCache.length === 0) {
        listEl.innerHTML = "";
        if (emptyEl) emptyEl.classList.remove("hidden");
        return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");

    listEl.innerHTML = helpdeskTicketsCache
        .map((t) => {
            const isActive = t.id === helpdeskSelectedTicketId;
            const statusClass = HELPDESK_STATUS_BADGE_CLASS[t.status] || "";
            return `
    <button type="button" class="helpdesk-ticket-card ${isActive ? "helpdesk-ticket-card-active" : ""}" data-open-ticket="${t.id}">
      <div class="helpdesk-ticket-card-top">
        <span class="loec-type-chip">${escapeHtml(HELPDESK_CATEGORY_LABELS[t.category] || t.category)}</span>
        <span class="helpdesk-status-badge ${statusClass}">${HELPDESK_STATUS_LABELS[t.status] || t.status}</span>
      </div>
      <div class="helpdesk-ticket-card-title">${escapeHtml(t.title)}</div>
      ${isSupervisorView ? `<div class="helpdesk-ticket-card-meta">${escapeHtml(helpdeskUserLabel(t.carteiro_id))}</div>` : ""}
      <div class="helpdesk-ticket-card-meta">${helpdeskTimeAgo(t.created_at)}</div>
    </button>
  `;
        })
        .join("");
}

// --- Ticket detail / chat --------------------------------------------------

function renderHelpdeskEmptyDetail() {
    const detailEl = qs("#helpdesk-detail");
    const emptyDetailEl = qs("#helpdesk-detail-empty");
    if (detailEl) detailEl.classList.add("hidden");
    if (emptyDetailEl) emptyDetailEl.classList.remove("hidden");
}

function renderHelpdeskTicketHeader(ticket) {
    qs("#helpdesk-detail-title").textContent = ticket.title;
    qs("#helpdesk-detail-category").textContent =
        HELPDESK_CATEGORY_LABELS[ticket.category] || ticket.category;
    const statusEl = qs("#helpdesk-detail-status");
    statusEl.textContent = HELPDESK_STATUS_LABELS[ticket.status] || ticket.status;
    statusEl.className = `helpdesk-status-badge ${HELPDESK_STATUS_BADGE_CLASS[ticket.status] || ""}`;

    const isSupervisorView =
        currentUserRole === UserRoles.ADMIN || currentUserRole === UserRoles.SUPERVISOR;
    const isAdmin = currentUserRole === UserRoles.ADMIN;

    const carteiroEl = qs("#helpdesk-detail-carteiro");
    const legendEl = qs("#helpdesk-profile-legend");

    if (carteiroEl) {
        carteiroEl.innerHTML = isSupervisorView
            ? helpdeskUserProfileCardHtml(ticket.carteiro_id, "Carteiro", "carteiro-card")
            : "";
        carteiroEl.classList.toggle("hidden", !isSupervisorView);
    }

    if (legendEl) {
        legendEl.classList.toggle("hidden", !isSupervisorView);
    }

    const isClosed =
        ticket.status === "concluido_sucesso" || ticket.status === "concluido_sem_sucesso";

    const conclusionActions = qs("#helpdesk-conclusion-actions");
    if (conclusionActions) {
        conclusionActions.classList.toggle("hidden", !isSupervisorView || isClosed);
    }
    const reopenAction = qs("#helpdesk-reopen-action");
    if (reopenAction) {
        reopenAction.classList.toggle("hidden", !isSupervisorView || !isClosed);
    }

    const adminActions = qs("#helpdesk-admin-actions");
    if (adminActions) {
        adminActions.classList.toggle("hidden", !isAdmin);
    }

    const reportBox = qs("#helpdesk-report-box");
    if (reportBox) {
        if (isClosed && ticket.report) {
            reportBox.classList.remove("hidden");
            qs("#helpdesk-report-text").textContent = ticket.report;
        } else {
            reportBox.classList.add("hidden");
        }
    }

    const composerWrap = qs("#helpdesk-composer");
    if (composerWrap) {
        composerWrap.classList.toggle("hidden", !canWriteHelpdeskTicket(ticket));
    }
    const closedNotice = qs("#helpdesk-closed-notice");
    if (closedNotice) closedNotice.classList.toggle("hidden", canWriteHelpdeskTicket(ticket));
}

async function openHelpdeskTicket(ticketId) {
    const id = Number(ticketId);
    helpdeskSelectedTicketId = id;
    renderHelpdeskTicketList();

    const detailEl = qs("#helpdesk-detail");
    const emptyDetailEl = qs("#helpdesk-detail-empty");
    if (emptyDetailEl) emptyDetailEl.classList.add("hidden");
    if (detailEl) detailEl.classList.remove("hidden");

    const ticket = helpdeskTicketsCache.find((t) => t.id === id);
    if (ticket) {
        await resolveHelpdeskUserLabels([ticket.carteiro_id], true);
        renderHelpdeskTicketHeader(ticket);
    }

    qs("#helpdesk-messages").innerHTML =
        '<div class="helpdesk-list-loading">Carregando conversa&hellip;</div>';
    qs("#helpdesk-detail-supervisors")?.classList.add("hidden");

    await Promise.all([loadHelpdeskMessages(id), loadHelpdeskTicketSupervisors(id)]);
    subscribeHelpdeskRealtime(id);
}


// Shows which supervisors/admins have already interacted with this ticket
// (every message from a supervisor/admin links them via a DB trigger).
// The carteiro sees the same info about their supervisor(s) as supervisors
// see about the carteiro.
async function loadHelpdeskTicketSupervisors(ticketId) {
    const el = qs("#helpdesk-detail-supervisors");
    if (!el) return;

    const { data, error } = await sb
        .from("helpdesk_ticket_supervisors")
        .select("supervisor_id")
        .eq("ticket_id", ticketId);

    if (error || !data || data.length === 0) {
        helpdeskTicketSupervisorIds = [];
        el.innerHTML = "";
        el.classList.add("hidden");
        return;
    }

    const ids = data.map((r) => r.supervisor_id);
    helpdeskTicketSupervisorIds = ids;
    await resolveHelpdeskUserLabels(ids, true);

    el.innerHTML = `
    <div class="helpdesk-profile-card-group">
      ${ids.map((sid) => helpdeskUserProfileCardHtml(sid, null, "supervisor-card")).join("")}
    </div>
  `;
    el.classList.remove("hidden");
}

async function loadHelpdeskMessages(ticketId) {
    const { data, error } = await sb
        .from("helpdesk_messages")
        .select("*, helpdesk_attachments(*)")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });

    if (error) {
        qs("#helpdesk-messages").innerHTML =
            `<div class="helpdesk-list-error">Erro ao carregar mensagens: ${escapeHtml(error.message)}</div>`;
        return;
    }

    helpdeskMessagesCache = data || [];

    await resolveHelpdeskUserLabels(helpdeskMessagesCache.map((m) => m.sender_id), true);
    await renderHelpdeskMessages();
}
// Flat, in-order list of every image/video/audio attachment currently
// loaded for this ticket, used to power the lightbox's "next/previous"
// navigation across the whole conversation (not just one message).
let helpdeskMediaGallery = [];

function rebuildHelpdeskMediaGallery() {
    helpdeskMediaGallery = [];
    helpdeskMessagesCache.forEach((message) => {
        (message.helpdesk_attachments || []).forEach((attachment) => {
            if (["image", "video", "audio"].includes(attachment.kind)) {
                helpdeskMediaGallery.push(attachment);
            }
        });
    });
}

async function renderHelpdeskMessages() {
    const container = qs("#helpdesk-messages");
    if (!container) return;

    if (helpdeskMessagesCache.length === 0) {
        container.innerHTML = '<div class="helpdesk-list-empty-inline">Nenhuma mensagem ainda.</div>';
        helpdeskMediaGallery = [];
        return;
    }

    rebuildHelpdeskMediaGallery();

    const rendered = await Promise.all(
        helpdeskMessagesCache.map((m) => renderHelpdeskMessageBubble(m)),
    );
    container.innerHTML = rendered.join("");
    container.scrollTop = container.scrollHeight;
}

async function renderHelpdeskMessageBubble(message) {
    const isMine = message.sender_id === currentUser?.id;
    const roleClass = `helpdesk-role-${message.sender_role}`;

    const attachmentsHtml = await Promise.all(
        (message.helpdesk_attachments || []).map((a) => renderHelpdeskAttachment(a)),
    );

    return `
    <div class="helpdesk-message ${isMine ? "helpdesk-message-mine" : ""}">
      <div class="helpdesk-message-meta">
        <span class="helpdesk-message-sender ${roleClass}">${escapeHtml(helpdeskUserLabel(message.sender_id))}</span>
        <span class="helpdesk-message-time">${helpdeskTimeAgo(message.created_at)}</span>
      </div>
      ${message.body ? `<div class="helpdesk-message-body">${escapeHtml(message.body)}</div>` : ""}
      ${attachmentsHtml.length ? `<div class="helpdesk-message-attachments">${attachmentsHtml.join("")}</div>` : ""}
    </div>
  `;
}

// Resolves (and caches) the signed URL for one attachment, then renders the
// right preview widget for its kind:
//  - image/video/audio: a clickable thumbnail that opens the full lightbox
//    (next/prev across the whole conversation, zoom, play/pause/reset, download)
//  - pdf: opens directly in a new browser tab, as requested
//  - anything else: a small chip with name + size that downloads on click
async function renderHelpdeskAttachment(attachment) {
    if (!attachment._signedUrl) {
        const { data, error } = await sb.storage
            .from(HELPDESK_BUCKET)
            .createSignedUrl(attachment.storage_path, 3600);
        if (error || !data) {
            return `<div class="helpdesk-attachment-error">Anexo indisponível</div>`;
        }
        attachment._signedUrl = data.signedUrl;
    }

    const url = attachment._signedUrl;
    const name = attachment.download_name || attachment.original_name || "anexo";
    const galleryIndex = helpdeskMediaGallery.indexOf(attachment);

    if (attachment.kind === "image") {
        return `
      <button type="button" class="helpdesk-attachment-thumb" data-gallery-index="${galleryIndex}">
        <img class="helpdesk-attachment-image" src="${url}" alt="${escapeHtml(name)}">
      </button>
    `;
    }

    if (attachment.kind === "video") {
        return `
      <button type="button" class="helpdesk-attachment-thumb helpdesk-attachment-thumb-video" data-gallery-index="${galleryIndex}">
        <video class="helpdesk-attachment-video" src="${url}" muted preload="metadata"></video>
        <span class="helpdesk-attachment-play-badge">▶</span>
      </button>
    `;
    }

    if (attachment.kind === "audio") {
        return `
      <button type="button" class="helpdesk-attachment-thumb helpdesk-attachment-audio-chip" data-gallery-index="${galleryIndex}">
        <span>${HELPDESK_KIND_ICONS.audio}</span>
        <span class="helpdesk-attachment-file-name">${escapeHtml(name)}</span>
      </button>
    `;
    }

    if (attachment.kind === "pdf") {
        // Opens in a new browser tab by default, as requested.
        return `
      <a class="helpdesk-attachment-file-chip" href="${url}" target="_blank" rel="noopener">
        <span>${HELPDESK_KIND_ICONS.pdf}</span>
        <span class="helpdesk-attachment-file-name">${escapeHtml(name)}</span>
        ${attachment.file_size ? `<span class="helpdesk-attachment-file-size">${formatFileSize(attachment.file_size)}</span>` : ""}
      </a>
    `;
    }

    return `
    <button type="button" class="helpdesk-attachment-file-chip" data-download-url="${escapeHtml(url)}" data-download-name="${escapeHtml(name)}">
      <span>${HELPDESK_KIND_ICONS.file}</span>
      <span class="helpdesk-attachment-file-name">${escapeHtml(name)}</span>
      ${attachment.file_size ? `<span class="helpdesk-attachment-file-size">${formatFileSize(attachment.file_size)}</span>` : ""}
    </button>
  `;
}

// Forces a proper download with the friendly filename (a plain <a download>
// isn't reliable for cross-origin signed URLs, so we fetch as a blob first).
async function downloadHelpdeskAttachment(url, filename) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename || "anexo";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    } catch (err) {
        showToast("Erro ao baixar anexo.", "error");
    }
}

// Opens the shared lightbox (defined in ui.js) with every image/video/audio
// attachment in this ticket's conversation, so the user can page through
// next/previous without leaving the viewer.
function openHelpdeskLightbox(startIndex) {
    const items = helpdeskMediaGallery.map((attachment) => ({
        kind: attachment.kind,
        url: attachment._signedUrl,
        name: attachment.download_name || attachment.original_name || "anexo",
        mimeType: attachment.mime_type,
    }));
    if (items.length === 0) return;
    openLightbox(items, startIndex, downloadHelpdeskAttachment);
}

// --- Realtime --------------------------------------------------------------

function unsubscribeHelpdeskRealtime() {
    if (helpdeskRealtimeChannel) {
        sb.removeChannel(helpdeskRealtimeChannel);
        helpdeskRealtimeChannel = null;
    }
}

function subscribeHelpdeskRealtime(ticketId) {
    unsubscribeHelpdeskRealtime();

    helpdeskRealtimeChannel = sb
        .channel(`helpdesk-ticket-${ticketId}`)
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "helpdesk_messages",
                filter: `ticket_id=eq.${ticketId}`,
            },
            async (payload) => {
                if (helpdeskMessagesCache.some((m) => m.id === payload.new.id)) return;
                // Attachments for this message may still be in flight (they're
                // inserted right after the message itself), so give them a brief
                // moment before fetching the full row with its attachments joined.
                setTimeout(async () => {
                    const { data } = await sb
                        .from("helpdesk_messages")
                        .select("*, helpdesk_attachments(*)")
                        .eq("id", payload.new.id)
                        .maybeSingle();
                    if (!data) return;
                    if (helpdeskMessagesCache.some((m) => m.id === data.id)) return;
                    helpdeskMessagesCache.push(data);
                    await resolveHelpdeskUserLabels([data.sender_id], true);
                    renderHelpdeskMessages();
                    if (data.sender_role !== "carteiro") loadHelpdeskTicketSupervisors(ticketId);
                }, 400);
            },
        )
        .on(
            "postgres_changes",
            {
                event: "UPDATE",
                schema: "public",
                table: "helpdesk_tickets",
                filter: `id=eq.${ticketId}`,
            },
            (payload) => {
                const idx = helpdeskTicketsCache.findIndex((t) => t.id === payload.new.id);
                if (idx >= 0) helpdeskTicketsCache[idx] = payload.new;
                else helpdeskTicketsCache.unshift(payload.new);
                renderHelpdeskTicketHeader(payload.new);
                renderHelpdeskTicketList();
            },
        )
        .subscribe();
}


// Any file type is accepted now; only the 50MB cap is enforced (both here
// and again at selection time in the UI, see attachFileInputHandler below).
function classifyHelpdeskFile(file) {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    if (file.type === "application/pdf") return "pdf";
    return "file";
}

function isHelpdeskFileSizeValid(file) {
    return file.size <= HELPDESK_MAX_FILE_SIZE;
}

function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name) {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx) : "";
}

// Attachment display/download names are built from the ticket id, the
// carteiro's id, the involved supervisor's id (the sender if a
// supervisor/admin sent it, otherwise the first supervisor already
// assigned to the ticket, or "pendente" if none yet), and the date.
function buildHelpdeskDownloadName(ticket, senderId, senderRole, originalName) {
    const supervisorId =
        senderRole === UserRoles.CARTEIRO
            ? helpdeskTicketSupervisorIds[0] || "pendente"
            : senderId;
    const dateStr = todayIsoDate().replace(/-/g, "");
    const ext = fileExtension(originalName);
    return `chamado${ticket.id}-carteiro${ticket.carteiro_id}-supervisor${supervisorId}-${dateStr}${ext}`;
}

/**
 * Uploads files to the Supabase Storage, applying client-side compression to images.
 */
async function uploadHelpdeskAttachments(ticketId, files, ticket, senderId, senderRole) {
    const dateFolder = todayIsoDate();
    const uploaded = [];

    for (let file of files) {
        if (!isHelpdeskFileSizeValid(file)) {
            showToast(`Anexo "${file.name}" excede 50MB e não foi enviado.`, "error");
            continue;
        }

        // Apply aggressive compression if the file is an image
        if (file.type.startsWith("image/")) {
            file = await compressImage(file, 1280, 0.5);
        }

        const kind = classifyHelpdeskFile(file);
        const uniqueId =
            window.crypto && window.crypto.randomUUID
                ? window.crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        // Keep uniqueId to prevent file collisions, but use the exact original file name
        const path = `${ticketId}/${dateFolder}/${uniqueId}-${file.name}`;

        // The downloaded file name is customized based on the ticket context
        const downloadName = ticket
            ? buildHelpdeskDownloadName(ticket, senderId, senderRole, file.name)
            : file.name;

        const { error } = await sb.storage.from(HELPDESK_BUCKET).upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });

        if (error) {
            showToast(`Erro ao enviar anexo ${file.name}: ${error.message}`, "error");
            continue;
        }

        uploaded.push({
            storage_path: path,
            mime_type: file.type || "application/octet-stream",
            kind,
            original_name: file.name,
            file_size: file.size,
            download_name: downloadName,
        });
    }

    return uploaded;
}

// Inserts a message (+ optional attachments) on an existing ticket. Used by
// both the chat composer and the "new ticket" form (which sends the initial
// description as the first message).
async function sendHelpdeskMessage(ticketId, body, files) {
    const trimmedBody = (body || "").trim();
    if (!trimmedBody && (!files || files.length === 0)) return null;

    // Defensive re-check: never send the message if an oversized attachment slipped through
    const oversized = (files || []).filter((f) => !isHelpdeskFileSizeValid(f));
    if (oversized.length > 0) {
        showToast(
            `Mensagem não enviada: anexo "${oversized[0].name}" excede o limite de 50MB.`,
            "error",
        );
        return null;
    }

    let uploaded = [];

    // 1. Upload files to Storage FIRST. This is the slowest operation.
    // Doing this before inserting the database row prevents the Realtime
    // listener from rendering an empty message while the upload is ongoing.
    if (files && files.length > 0) {
        const ticket = helpdeskTicketsCache.find((t) => t.id === ticketId) || {
            id: ticketId,
            carteiro_id: currentUserRole === UserRoles.CARTEIRO ? currentUser.id : "desconhecido",
        };
        uploaded = await uploadHelpdeskAttachments(
            ticketId,
            files,
            ticket,
            currentUser.id,
            currentUserRole,
        );
    }

    // 2. Insert the message row into the database.
    const payload = {
        ticket_id: ticketId,
        sender_id: currentUser.id,
        sender_role: currentUserRole,
        body: trimmedBody || null,
    };

    const { data: message, error } = await sb
        .from("helpdesk_messages")
        .insert(payload)
        .select()
        .single();

    if (error) {
        showToast(`Erro ao enviar mensagem: ${error.message}`, "error");
        return null;
    }

    // 3. Link the uploaded attachments to the newly created message.
    if (uploaded.length > 0) {
        const attachmentRows = uploaded.map((u) => ({ ...u, message_id: message.id, ticket_id: ticketId }));
        const { error: attError } = await sb.from("helpdesk_attachments").insert(attachmentRows);
        if (attError) {
            showToast(`Erro ao vincular anexos: ${attError.message}`, "error");
        }
    }

    return message;
}

async function submitHelpdeskComposer() {
    const textarea = qs("#helpdesk-composer-text");
    const btn = qs("#helpdesk-composer-send");
    if (!helpdeskSelectedTicketId || !textarea) return;

    const body = textarea.value;
    const files = helpdeskComposerFiles;

    if (!body.trim() && files.length === 0) return;

    // Provide visual feedback during long uploads
    btn.disabled = true;
    textarea.disabled = true;
    const originalBtnText = btn.textContent;
    btn.textContent = "Enviando...";

    const message = await sendHelpdeskMessage(helpdeskSelectedTicketId, body, files);

    // Restore UI state
    btn.disabled = false;
    textarea.disabled = false;
    btn.textContent = originalBtnText;

    if (!message) return;

    textarea.value = "";
    helpdeskComposerFiles = [];
    renderHelpdeskComposerFileList();

    // Optimistic refresh as a safety net in case the realtime event is slow
    // or the channel didn't connect; render() dedupes by id.
    if (!helpdeskMessagesCache.some((m) => m.id === message.id)) {
        const { data } = await sb
            .from("helpdesk_messages")
            .select("*, helpdesk_attachments(*)")
            .eq("id", message.id)
            .maybeSingle();
        if (data && !helpdeskMessagesCache.some((m) => m.id === data.id)) {
            helpdeskMessagesCache.push(data);
            renderHelpdeskMessages();
        }
    }

    // A supervisor's first reply flips "aberto" -> "em_andamento" server-side;
    // pull the fresh ticket list so status badges reflect that immediately.
    await loadHelpdeskTickets();
    if (currentUserRole !== UserRoles.CARTEIRO) {
        await loadHelpdeskTicketSupervisors(helpdeskSelectedTicketId);
    }
}

// Splits a FileList/array into files within the 50MB cap and files over it,
// so callers can add the valid ones and warn about the rest without ever
// letting an oversized file into the attachment list.
function partitionFilesBySize(files) {
    const accepted = [];
    const rejected = [];
    files.forEach((f) => (isHelpdeskFileSizeValid(f) ? accepted.push(f) : rejected.push(f)));
    return { accepted, rejected };
}

function helpdeskFileChipHtml(file, index, removeAttr) {
    return `
    <span class="helpdesk-file-chip">
      <span>${HELPDESK_KIND_ICONS[classifyHelpdeskFile(file)]}</span>
      ${escapeHtml(file.name)} (${formatFileSize(file.size)})
      <button type="button" data-${removeAttr}="${index}">&times;</button>
    </span>
  `;
}

function renderHelpdeskComposerFileList() {
    const listEl = qs("#helpdesk-composer-files");
    if (!listEl) return;
    if (helpdeskComposerFiles.length === 0) {
        listEl.innerHTML = "";
        return;
    }
    listEl.innerHTML = helpdeskComposerFiles
        .map((f, i) => helpdeskFileChipHtml(f, i, "remove-composer-file"))
        .join("");
}

function renderHelpdeskNewFileList() {
    const listEl = qs("#helpdesk-new-file-list");
    if (!listEl) return;
    listEl.innerHTML = helpdeskNewTicketFiles
        .map((f, i) => helpdeskFileChipHtml(f, i, "remove-new-file"))
        .join("");
}

// --- New ticket form ---------------------------------------------------

function helpdeskCategoryOptionsHtml() {
    return HELPDESK_CATEGORIES.map(
        (c) => `<option value="${c.value}">${escapeHtml(c.label)}</option>`,
    ).join("");
}

function newHelpdeskTicketFormTemplate() {
    return `
    <form id="helpdesk-new-ticket-form">
      <div class="field">
        <label for="helpdesk-new-category">Tipo de problema</label>
        <select id="helpdesk-new-category" required>${helpdeskCategoryOptionsHtml()}</select>
      </div>
      <div class="field">
        <label for="helpdesk-new-title">Título</label>
        <input type="text" id="helpdesk-new-title" required maxlength="150" placeholder="Ex: Pneu furado na Rua Felipe Schmidt">
      </div>
      <div class="field">
        <label for="helpdesk-new-files">Anexos (opcional, até 50MB cada)</label>
        <input type="file" id="helpdesk-new-files" multiple>
        <div class="helpdesk-file-list" id="helpdesk-new-file-list"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="helpdesk-new-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Abrir chamado</button>
      </div>
    </form>
  `;
}

function openNewHelpdeskTicketForm() {
    helpdeskNewTicketFiles = [];
    openModal("Novo Chamado", newHelpdeskTicketFormTemplate());

    qs("#helpdesk-new-cancel").addEventListener("click", closeModal);
    qs("#helpdesk-new-files").addEventListener("change", (e) => {
        const picked = Array.from(e.target.files || []);
        const { accepted, rejected } = partitionFilesBySize(picked);
        rejected.forEach((f) =>
            showToast(`Anexo "${f.name}" excede 50MB e não foi adicionado.`, "error"),
        );
        helpdeskNewTicketFiles = helpdeskNewTicketFiles.concat(accepted);
        renderHelpdeskNewFileList();
        e.target.value = "";
    });
    qs("#helpdesk-new-file-list").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-new-file]");
        if (!btn) return;
        helpdeskNewTicketFiles.splice(Number(btn.dataset.removeNewFile), 1);
        renderHelpdeskNewFileList();
    });
    qs("#helpdesk-new-ticket-form").addEventListener("submit", submitNewHelpdeskTicketForm);
}

async function submitNewHelpdeskTicketForm(e) {
    e.preventDefault();

    const category = qs("#helpdesk-new-category").value;
    const title = qs("#helpdesk-new-title").value.trim();

    if (!title) return;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Enviando...";

    const { data: ticket, error } = await sb
        .from("helpdesk_tickets")
        .insert({
            carteiro_id: currentUser.id,
            category,
            title
            // Removed description from the insert payload
        })
        .select()
        .single();

    if (error) {
        showToast(`Erro ao abrir chamado: ${error.message}`, "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "Abrir chamado";
        return;
    }

    await sendHelpdeskMessage(ticket.id, title, helpdeskNewTicketFiles);

    closeModal();
    showToast("Chamado aberto com sucesso!");
    helpdeskFilterStatus = "";
    updateHelpdeskFilterButtons();
    await loadHelpdeskTickets();
    await openHelpdeskTicket(ticket.id);
}

// --- Conclusion / reopen -------------------------------------------------

function helpdeskConclusionFormTemplate(statusLabel) {
    return `
    <form id="helpdesk-conclusion-form">
      <p class="confirm-text">Concluir este chamado como <strong>${escapeHtml(statusLabel)}</strong>?</p>
      <div class="field">
        <label for="helpdesk-conclusion-report">Relatório (opcional)</label>
        <textarea id="helpdesk-conclusion-report" rows="4" placeholder="Descreva a resolução do chamado..."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="helpdesk-conclusion-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar conclusão</button>
      </div>
    </form>
  `;
}

function openHelpdeskConclusionForm(status) {
    if (!helpdeskSelectedTicketId) return;
    const statusLabel = HELPDESK_STATUS_LABELS[status];

    openModal("Concluir Chamado", helpdeskConclusionFormTemplate(statusLabel));
    qs("#helpdesk-conclusion-cancel").addEventListener("click", closeModal);
    qs("#helpdesk-conclusion-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const report = qs("#helpdesk-conclusion-report").value.trim();

        const { error } = await sb.rpc("close_helpdesk_ticket", {
            p_ticket_id: helpdeskSelectedTicketId,
            p_status: status,
            p_report: report || null,
        });

        if (error) {
            showToast(`Erro ao concluir chamado: ${error.message}`, "error");
            return;
        }

        closeModal();
        showToast("Chamado concluído.");
        await loadHelpdeskTickets();
        const ticket = helpdeskTicketsCache.find((t) => t.id === helpdeskSelectedTicketId);
        if (ticket) renderHelpdeskTicketHeader(ticket);
    });
}

async function reopenHelpdeskTicket() {
    if (!helpdeskSelectedTicketId) return;
    const { error } = await sb.rpc("reopen_helpdesk_ticket", {
        p_ticket_id: helpdeskSelectedTicketId,
    });
    if (error) {
        showToast(`Erro ao reabrir chamado: ${error.message}`, "error");
        return;
    }
    showToast("Chamado reaberto.");
    await loadHelpdeskTickets();
    const ticket = helpdeskTicketsCache.find((t) => t.id === helpdeskSelectedTicketId);
    if (ticket) renderHelpdeskTicketHeader(ticket);
}

// --- Filters / tab entry point -------------------------------------------

function updateHelpdeskFilterButtons() {
    qsa(".helpdesk-filter-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.status === helpdeskFilterStatus);
    });
}

async function loadHelpdesk() {
    const isSupervisorView =
        currentUserRole === UserRoles.ADMIN || currentUserRole === UserRoles.SUPERVISOR;

    const newTicketBtn = qs("#btn-new-helpdesk-ticket");
    if (newTicketBtn) newTicketBtn.classList.toggle("hidden", isSupervisorView);

    const filterBar = qs("#helpdesk-filter-bar");
    if (filterBar) filterBar.classList.toggle("hidden", false);

    await loadHelpdeskTickets();

    if (!helpdeskSelectedTicketId) renderHelpdeskEmptyDetail();
}

// --- Event listeners -------------------------------------------------------

const btnNewHelpdeskTicket = qs("#btn-new-helpdesk-ticket");
if (btnNewHelpdeskTicket)
    btnNewHelpdeskTicket.addEventListener("click", openNewHelpdeskTicketForm);

const helpdeskTicketListEl = qs("#helpdesk-ticket-list");
if (helpdeskTicketListEl) {
    helpdeskTicketListEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-open-ticket]");
        if (btn) openHelpdeskTicket(btn.dataset.openTicket);
    });
}

qsa(".helpdesk-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        helpdeskFilterStatus = btn.dataset.status;
        updateHelpdeskFilterButtons();
        loadHelpdeskTickets();
    });
});

const helpdeskComposerForm = qs("#helpdesk-composer-form");
if (helpdeskComposerForm) {
    helpdeskComposerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        submitHelpdeskComposer();
    });
}

const helpdeskComposerFilesInput = qs("#helpdesk-composer-file-input");
if (helpdeskComposerFilesInput) {
    helpdeskComposerFilesInput.addEventListener("change", (e) => {
        const picked = Array.from(e.target.files || []);
        const { accepted, rejected } = partitionFilesBySize(picked);
        rejected.forEach((f) =>
            showToast(`Anexo "${f.name}" excede 50MB e não foi adicionado.`, "error"),
        );
        helpdeskComposerFiles = helpdeskComposerFiles.concat(accepted);
        renderHelpdeskComposerFileList();
        e.target.value = "";
    });
}

const helpdeskComposerFileListEl = qs("#helpdesk-composer-files");
if (helpdeskComposerFileListEl) {
    helpdeskComposerFileListEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-composer-file]");
        if (!btn) return;
        helpdeskComposerFiles.splice(Number(btn.dataset.removeComposerFile), 1);
        renderHelpdeskComposerFileList();
    });
}

const btnHelpdeskConcludeSuccess = qs("#btn-helpdesk-conclude-success");
if (btnHelpdeskConcludeSuccess)
    btnHelpdeskConcludeSuccess.addEventListener("click", () =>
        openHelpdeskConclusionForm("concluido_sucesso"),
    );

const btnHelpdeskConcludeFailure = qs("#btn-helpdesk-conclude-failure");
if (btnHelpdeskConcludeFailure)
    btnHelpdeskConcludeFailure.addEventListener("click", () =>
        openHelpdeskConclusionForm("concluido_sem_sucesso"),
    );

const btnHelpdeskReopen = qs("#btn-helpdesk-reopen");
if (btnHelpdeskReopen) btnHelpdeskReopen.addEventListener("click", reopenHelpdeskTicket);

const helpdeskMessagesEl = qs("#helpdesk-messages");
if (helpdeskMessagesEl) {
    helpdeskMessagesEl.addEventListener("click", (e) => {
        const thumb = e.target.closest("[data-gallery-index]");
        if (thumb) {
            openHelpdeskLightbox(Number(thumb.dataset.galleryIndex));
            return;
        }
        const downloadBtn = e.target.closest("[data-download-url]");
        if (downloadBtn) {
            downloadHelpdeskAttachment(downloadBtn.dataset.downloadUrl, downloadBtn.dataset.downloadName);
        }
    });
}


/**
 * Prompts for confirmation and deletes the currently selected ticket (Admins only).
 * Also removes all associated media files from Supabase Storage.
 */
async function deleteHelpdeskTicket() {
    if (!helpdeskSelectedTicketId) return;

    // Reuse the generic confirmation modal from ui.js
    openDeleteConfirm(
        `o chamado #${helpdeskSelectedTicketId}`,
        "Todas as mensagens e anexos associados serão apagados permanentemente.",
        async () => {
            // 1. Fetch all attachment paths for this ticket before deleting the database row
            const { data: attachments, error: fetchError } = await sb
                .from("helpdesk_attachments")
                .select("storage_path")
                .eq("ticket_id", helpdeskSelectedTicketId);

            if (fetchError) {
                showToast(`Erro ao buscar anexos para exclusão: ${fetchError.message}`, "error");
                return;
            }

            // 2. If there are attachments, remove them from the Storage bucket
            if (attachments && attachments.length > 0) {
                const pathsToDelete = attachments.map(att => att.storage_path);
                const { error: storageError } = await sb.storage
                    .from(HELPDESK_BUCKET)
                    .remove(pathsToDelete);

                if (storageError) {
                    console.error("Failed to delete storage files:", storageError);
                    showToast("Aviso: Alguns arquivos podem não ter sido apagados do storage.", "error");
                }
            }

            // 3. Delete the ticket from the database (this cascades to messages and attachment rows)
            const { error: dbError } = await sb
                .from("helpdesk_tickets")
                .delete()
                .eq("id", helpdeskSelectedTicketId);

            if (dbError) {
                showToast(`Erro ao excluir chamado: ${dbError.message}`, "error");
                return;
            }

            closeModal();
            showToast("Chamado e anexos excluídos com sucesso.");
            helpdeskSelectedTicketId = null;
            renderHelpdeskEmptyDetail();
            await loadHelpdeskTickets();
        }
    );
}

const btnHelpdeskDelete = qs("#btn-helpdesk-delete");
if (btnHelpdeskDelete) {
    btnHelpdeskDelete.addEventListener("click", deleteHelpdeskTicket);
}

/**
 * Plays a short, non-intrusive sine wave beep.
 */
function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
        gain.gain.setValueAtTime(0.05, ctx.currentTime);

        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
        console.error("Audio playback failed", e);
    }
}

/**
 * Triggers a browser notification and sound if the user is not actively
 * viewing the Helpdesk tab.
 */
function triggerHelpdeskNotification(title, body) {
    const isHelpdeskTabActive = document.querySelector('.tab-btn[data-tab="helpdesk"]')?.classList.contains('active');
    const isPageVisible = !document.hidden && document.hasFocus();

    // Do not notify if the user is actively viewing the Helpdesk tab
    if (isHelpdeskTabActive && isPageVisible) return;

    playNotificationSound();

    if (Notification.permission === "granted") {
        new Notification(title, { body: body });
    } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                new Notification(title, { body: body });
            }
        });
    }
}

/**
 * Initializes global realtime listeners for new tickets and messages.
 */
function initHelpdeskNotifications() {
    if (helpdeskGlobalChannel) {
        sb.removeChannel(helpdeskGlobalChannel);
    }

    // Preemptively ask for notification permissions
    if (Notification.permission === "default") {
        Notification.requestPermission();
    }

    helpdeskGlobalChannel = sb.channel('helpdesk-global-notifications')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'helpdesk_tickets' },
            (payload) => {
                // Only notify admins/supervisors of new tickets
                if (currentUserRole === UserRoles.ADMIN || currentUserRole === UserRoles.SUPERVISOR) {
                    triggerHelpdeskNotification("Novo Chamado", payload.new.title);
                    if (helpdeskListLoaded) loadHelpdeskTickets();
                }
            }
        )
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'helpdesk_messages' },
            (payload) => {
                // Prevent notifying the user about their own messages
                if (payload.new.sender_id === currentUser.id) return;

                // Ensure the user has access to the ticket receiving the message
                const ticket = helpdeskTicketsCache.find(t => t.id === payload.new.ticket_id);
                if (ticket) {
                    const bodyText = payload.new.body || "Novo anexo recebido.";
                    triggerHelpdeskNotification(`Nova mensagem: Chamado #${ticket.id}`, bodyText);
                }
            }
        )
        .subscribe();
}