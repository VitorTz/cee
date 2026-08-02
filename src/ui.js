import { qs, qsa, todayIsoDate, escapeHtml } from "./utils.js";
import { cepSearchState, setCepSearchState } from "./tabs/cep-search.js";
import { loadDailyOps } from "./tabs/daily-ops.js";
import { loadZips } from "./tabs/zips.js";
import { loadRules } from "./tabs/rules.js";
import { loadGeocoding } from "./tabs/geocoding.js";
import { loadFuncionarios, onFuncionariosSubtabChange } from "./tabs/employees.js";
import { loadHelpdeskTickets } from "./tabs/helpdesk.js";
import { loadAccountPage } from "./tabs/account.js";
import { currentUserRole, currentUser, UserRoles } from "./supabase-client.js";
import { loadMetricsDashboard } from "./tabs/metrics.js";

// --- Toasts ---
export function showToast(message, type = "success") {
    const container = qs("#toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type === "error" ? "toast-error" : ""}`.trim();
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("leaving");
        setTimeout(() => toast.remove(), 220);
    }, 3200);
}

// --- Modals ---
const modalOverlay = qs("#modal-overlay");
const modalTitleEl = qs("#modal-title");
const modalBodyEl = qs("#modal-body");

export function openModal(title, bodyHtml, options = {}) {
    modalTitleEl.innerHTML = title;
    modalBodyEl.innerHTML = bodyHtml;
    qs(".modal-slip").classList.toggle("modal-slip-wide", Boolean(options.wide));
    modalOverlay.classList.remove("hidden");
}

export function closeModal() {
    modalOverlay.classList.add("hidden");
    modalBodyEl.innerHTML = "";
    qs(".modal-slip").classList.remove("modal-slip-wide");
    if (typeof loecReportChartInstances !== "undefined" && loecReportChartInstances.length) {
        loecReportChartInstances.forEach((chart) => chart.destroy());
        loecReportChartInstances = [];
    }
}

qs("#modal-close").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalOverlay.classList.contains("hidden"))
        closeModal();
});

function deleteConfirmTemplate(label, warning) {
    return `
    <p class="confirm-text">Confirma a exclusão de <strong>${escapeHtml(label)}</strong>?</p>
    ${warning ? `<p class="confirm-warning">${warning}</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" id="confirm-cancel">Cancelar</button>
      <button type="button" class="btn btn-danger" id="confirm-delete">Excluir</button>
    </div>
  `;
}

export function openDeleteConfirm(label, warning, onConfirm) {
    openModal("Confirmar exclusão", deleteConfirmTemplate(label, warning));
    qs("#confirm-cancel").addEventListener("click", closeModal);
    qs("#confirm-delete").addEventListener("click", onConfirm);
}

// --- Tabs ---
qsa(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab, true, true));
});

let hasLoadedZips = false;
let hasLoadedRules = false;

export function switchTab(tab, isManualClick = false, shouldFocus = true) {
    qsa(".tab-btn").forEach((btn) => {
        const active = btn.dataset.tab === tab;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", String(active));
    });

    qsa(".panel").forEach((panel) =>
        panel.classList.toggle("active", panel.id === `panel-${tab}`),
    );

    // Close mobile menu if it is currently open
    const tabsNav = qs(".tabs");
    if (tabsNav && tabsNav.classList.contains("is-open")) {
        tabsNav.classList.remove("is-open");
        const mobileMenuBtn = qs("#mobile-menu-toggle");
        if (mobileMenuBtn) mobileMenuBtn.setAttribute("aria-expanded", "false");
    }

    switch (tab) {
        case "cepsearch":
            if (isManualClick) {
                const queryInput = qs("#cepsearch-query");
                const numInput = qs("#cepsearch-number");

                if (queryInput) queryInput.value = "";
                if (numInput) {
                    numInput.value = "";
                    numInput.disabled = true;
                }

                const hintEl = qs("#cepsearch-match-hint");
                if (hintEl) hintEl.textContent = "Digite para localizar o logradouro.";

                const resultsEl = qs("#cepsearch-results");
                if (resultsEl) resultsEl.classList.add("hidden");

                const emptyEl = qs("#cepsearch-empty");
                if (emptyEl) emptyEl.classList.remove("hidden");

                setCepSearchState({
                    streetId: null,
                    street: null,
                    breakdown: [],
                    searchLogged: false,
                })

                // Only trigger autofocus if explicitly allowed
                if (shouldFocus) {
                    setTimeout(() => {
                        if (queryInput) queryInput.focus();
                    }, 50);
                }
            }
            break;
        case "zips":
            if (!hasLoadedZips) {
                loadZips(0);
                hasLoadedZips = true;
            }
            break;
        case "rules":
            if (!hasLoadedRules) {
                loadRules();
                hasLoadedRules = true;
            }
            break;        
        case "daily-ops":
            const dailyOpsDateEl = qs("#daily-ops-date");
            if (dailyOpsDateEl && typeof todayIsoDate === "function") {
                dailyOpsDateEl.value = todayIsoDate();
            }
            if (typeof loadDailyOps === "function") loadDailyOps();
            break;
        case "helpdesk":
            loadHelpdeskTickets();
            break;
        case "account":
            loadAccountPage();
            break;
        case "funcionarios":
            loadFuncionarios();
            break;
        case "metrics":
            loadMetricsDashboard()
            break;
        case "geocoding":
            loadGeocoding();
            break;
        default:
            break;
    }
}

// --- Sub-tabs (used inside the Quadro de Funcionários panel) ---
qsa(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSubtab(btn));
});

function switchSubtab(btn) {
    const group = btn.closest(".panel");
    if (!group) return;
    const target = btn.dataset.subtab;

    qsa(".subtab-btn", group).forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
    });

    qsa(".subpanel", group).forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== `subpanel-${target}`);
    });

    onFuncionariosSubtabChange(target);
}

// --- Mobile Menu Toggle ---
const mobileMenuBtn = qs("#mobile-menu-toggle");
const tabsNav = qs(".tabs");

if (mobileMenuBtn && tabsNav) {
    mobileMenuBtn.addEventListener("click", () => {
        const isOpen = tabsNav.classList.toggle("is-open");
        mobileMenuBtn.setAttribute("aria-expanded", String(isOpen));
    });
}

// --- Lightbox (attachment viewer: images/vídeos/áudios) ---
// Generic full-screen viewer with next/previous navigation, zoom for
// images, play/pause/reset for video & audio, and download. Callers pass a
// flat list of { kind: "image"|"video"|"audio", url, name } plus a
// downloadFn(url, name) so different callers can implement download however
// they need to (e.g. helpdesk.js downloads via a signed URL fetch).
const lightboxOverlayEl = qs("#attachment-lightbox");
let lightboxItems = [];
let lightboxIndex = 0;
let lightboxDownloadFn = null;
let lightboxZoomLevel = 1;

function lightboxCurrentMediaEl() {
    return qs("#lightbox-stage video, #lightbox-stage audio", document);
}

function renderLightboxItem() {
    if (!lightboxOverlayEl) return;
    const stage = qs("#lightbox-stage");
    const caption = qs("#lightbox-caption");
    const item = lightboxItems[lightboxIndex];
    if (!item || !stage) return;

    lightboxZoomLevel = 1;
    caption.textContent = item.name || "";

    const zoomControls = qsa(".lightbox-zoom-control");
    const mediaControls = qsa(".lightbox-media-control");
    zoomControls.forEach((el) => el.classList.toggle("hidden", item.kind !== "image"));
    mediaControls.forEach((el) =>
        el.classList.toggle("hidden", item.kind !== "video" && item.kind !== "audio"),
    );

    if (item.kind === "image") {
        stage.innerHTML = `<img id="lightbox-image" src="${item.url}" alt="${escapeHtml(item.name || "")}" style="transform: scale(1);">`;
    } else if (item.kind === "video") {
        stage.innerHTML = `<video src="${item.url}" controls autoplay></video>`;
    } else if (item.kind === "audio") {
        stage.innerHTML = `
      <div class="lightbox-audio-stage">
        <span class="lightbox-audio-icon">🎵</span>
        <audio src="${item.url}" controls autoplay></audio>
      </div>
    `;
    }

    const prevBtn = qs("#lightbox-prev");
    const nextBtn = qs("#lightbox-next");
    if (prevBtn) prevBtn.classList.toggle("hidden", lightboxItems.length <= 1);
    if (nextBtn) nextBtn.classList.toggle("hidden", lightboxItems.length <= 1);
}

export function openLightbox(items, startIndex = 0, downloadFn = null) {
    if (!lightboxOverlayEl || !items || items.length === 0) return;
    lightboxItems = items;
    lightboxIndex = Math.max(0, Math.min(startIndex, items.length - 1));
    lightboxDownloadFn = downloadFn;
    lightboxOverlayEl.classList.remove("hidden");
    renderLightboxItem();
}

export function closeLightbox() {
    if (!lightboxOverlayEl) return;
    lightboxOverlayEl.classList.add("hidden");
    qs("#lightbox-stage").innerHTML = "";
    lightboxItems = [];
}

export function lightboxShowRelative(delta) {
    if (lightboxItems.length === 0) return;
    lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length;
    renderLightboxItem();
}

export function lightboxApplyZoom() {
    const img = qs("#lightbox-image");
    if (img) img.style.transform = `scale(${lightboxZoomLevel})`;
}

if (lightboxOverlayEl) {
    qs("#lightbox-close").addEventListener("click", closeLightbox);
    qs("#lightbox-prev").addEventListener("click", () => lightboxShowRelative(-1));
    qs("#lightbox-next").addEventListener("click", () => lightboxShowRelative(1));

    qs("#lightbox-zoom-in").addEventListener("click", () => {
        lightboxZoomLevel = Math.min(4, lightboxZoomLevel + 0.5);
        lightboxApplyZoom();
    });
    qs("#lightbox-zoom-out").addEventListener("click", () => {
        lightboxZoomLevel = Math.max(1, lightboxZoomLevel - 0.5);
        lightboxApplyZoom();
    });
    qs("#lightbox-zoom-reset").addEventListener("click", () => {
        lightboxZoomLevel = 1;
        lightboxApplyZoom();
    });

    qs("#lightbox-media-playpause").addEventListener("click", () => {
        const media = lightboxCurrentMediaEl();
        if (!media) return;
        if (media.paused) media.play();
        else media.pause();
    });
    qs("#lightbox-media-reset").addEventListener("click", () => {
        const media = lightboxCurrentMediaEl();
        if (!media) return;
        media.currentTime = 0;
        media.play();
    });

    qs("#lightbox-download").addEventListener("click", () => {
        const item = lightboxItems[lightboxIndex];
        if (!item) return;
        if (lightboxDownloadFn) lightboxDownloadFn(item.url, item.name);
        else window.open(item.url, "_blank");
    });

    lightboxOverlayEl.addEventListener("click", (e) => {
        if (e.target === lightboxOverlayEl) closeLightbox();
    });

    document.addEventListener("keydown", (e) => {
        if (lightboxOverlayEl.classList.contains("hidden")) return;
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowLeft") lightboxShowRelative(-1);
        else if (e.key === "ArrowRight") lightboxShowRelative(1);
    });
}

// --- Global Hotkeys ---
document.addEventListener("keydown", (e) => {
    if (e.key === "F4") {
        e.preventDefault();
        zipsPage = 0;
        zipsSearchTerm = ''

        qsa("input, select, textarea").forEach((el) => {
            if (el.type === "checkbox" || el.type === "radio") {
                el.checked = false;
            } else {
                el.value = "";
            }
        });

        if (
            typeof rulesFilterCombobox !== "undefined" &&
            rulesFilterCombobox.setValue
        ) {
            rulesFilterCombobox.setValue(null);
        }

        if (typeof rulesFilterStreetId !== "undefined") rulesFilterStreetId = "";
        if (typeof rulesFilterZipId !== "undefined") rulesFilterZipId = "";

        if (typeof resetRulesFilterZipSelect === "function")
            resetRulesFilterZipSelect();

        if (typeof cepSearchState !== "undefined") {
            setCepSearchState({
                streetId: null,
                street: null,
                breakdown: [],
                searchLogged: false,
            })
        }

        const resultsEl = qs("#cepsearch-results");
        const emptyEl = qs("#cepsearch-empty");
        if (resultsEl) resultsEl.classList.add("hidden");
        if (emptyEl) emptyEl.classList.remove("hidden");

        if (typeof loadZips === "function") loadZips(0);
        if (typeof loadRules === "function") loadRules();

        const dailyOpsDateEl = qs("#daily-ops-date");
        if (dailyOpsDateEl && typeof loadDailyOps === "function") {
            dailyOpsDateEl.value = todayIsoDate();
            loadDailyOps();
        }

        loadCeeSectors();

        loadFuncionarios();

        resetGeocodingPanel();

        showToast("Todos os campos e filtros foram limpos.");
    }
    if (e.key === "F6") {
        e.preventDefault();
        switchTab("cepsearch");
        const numInput = qs("#cepsearch-number");
        if (numInput && !numInput.disabled) {
            numInput.value = "";
            numInput.focus();
        }
    }

    if (e.key === "F7") {
        e.preventDefault();
        switchTab("cepsearch");
        const queryInput = qs("#cepsearch-query");
        if (queryInput) {
            queryInput.value = "";
            queryInput.focus();
        }
    }
});

const tabKeyMap = {
    1: "daily-ops",
    2: "zips",
    3: "cepsearch",
    4: "rules",
    5: "helpdesk",
    6: "account",
    7: "funcionarios",
    // 8: "geocoding",
};

function canAccessTab(tabName) {
    if (tabName == "metrics") {
        return currentUserRole == UserRoles.ADMIN;
    }
    if (tabName == "funcionarios") {
        return (
            currentUserRole == UserRoles.ADMIN ||
            currentUserRole == UserRoles.SUPERVISOR
        );
    }
    return true;
}

document.addEventListener("keydown", (e) => {
    const activeElement = document.activeElement;
    const isInputFocused =
        activeElement &&
        (activeElement.tagName === "INPUT" ||
            activeElement.tagName === "TEXTAREA" ||
            activeElement.tagName === "SELECT" ||
            activeElement.isContentEditable);

    if (isInputFocused) return;

    const targetTab = tabKeyMap[e.key];

    if (targetTab && canAccessTab(targetTab)) {
        e.preventDefault();
        switchTab(targetTab, true, false);
    }
});