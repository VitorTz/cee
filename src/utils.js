// --- DOM Helpers (needed by the auth block right below) ---
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let currentTab = '';

export function normalizeSearchTerm(term) {
    const withoutAccents = term
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    return withoutAccents.replace(/[^a-z0-9]+/g, "%");
}

export function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function formatNeighborhoods(neighborhoods) {
    if (Array.isArray(neighborhoods)) return neighborhoods.join(", ");
    return neighborhoods || "—";
}

// --- ZIP Code Normalization ---
export const ZIP_REGEX = /^880[0-6][0-9]-[0-9]{3}$/;

export function normalizeZipDigits(raw) {
    let digits = (raw || "").replace(/\D/g, "");
    if (!digits) return "";
    if (!digits.startsWith("880")) {
        digits = `880${digits}`;
    }
    return digits.slice(0, 8);
}

export function digitsToZipPattern(digits) {
    if (!digits) return "";
    if (digits.length > 5) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    return digits;
}

export function attachZipMask(inputEl) {
    inputEl.addEventListener("input", () => {
        let digits = inputEl.value.replace(/\D/g, "").slice(0, 8);
        if (digits.length > 5) digits = `${digits.slice(0, 5)}-${digits.slice(5)}`;
        inputEl.value = digits;
    });
    inputEl.addEventListener("blur", () => {
        if (!inputEl.value.trim()) return;
        inputEl.value = digitsToZipPattern(normalizeZipDigits(inputEl.value));
    });
}

// --- Date & Time Helpers ---
export function todayIsoDate() {
    const now = new Date();
    const offsetMs = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

export function formatTimeShort(value) {
    if (!value) return "&mdash;";
    return value.slice(0, 5);
}

export function isValidCPF(value) {
    const cpf = value.replace(/\D/g, "");

    // CPF must have exactly 11 digits
    if (cpf.length !== 11) {
        return false;
    }

    // Reject CPFs with all identical digits
    if (/^(\d)\1{10}$/.test(cpf)) {
        return false;
    }

    // Validate first check digit
    let sum = 0;

    for (let i = 0; i < 9; i++) {
        sum += Number(cpf[i]) * (10 - i);
    }

    let digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;

    if (digit !== Number(cpf[9])) {
        return false;
    }

    // Validate second check digit
    sum = 0;

    for (let i = 0; i < 10; i++) {
        sum += Number(cpf[i]) * (11 - i);
    }

    digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;

    return digit === Number(cpf[10]);
}

export function getLeftOfChar(value, char) {
    const index = value.indexOf(char);
    return index === -1 ? value : value.slice(0, index);
}

export function hasOnlyDigits(value) {
    return /^\d+$/.test(value);
}

/**
 * Normalizes a CEP string to the standard "880XX-XXX" format.
 * Handles 8-digit strings ("88047103" -> "88047-103") and 
 * 5-digit strings ("47103" -> "88047-103").
 * 
 * @param {string|number} rawCep - The raw CEP input.
 * @returns {string} The formatted CEP.
 */
export function normalizeCep(rawCep) {
    if (!rawCep) return "";

    // Remove all non-numeric characters
    let cleanCep = String(rawCep).replace(/\D/g, "");

    // If it's exactly 5 digits, prepend the default "880" prefix
    if (cleanCep.length === 5) {
        cleanCep = "880" + cleanCep;
    }

    // If it has exactly 8 digits, apply the standard XXXXX-XXX mask
    if (cleanCep.length === 8) {
        return cleanCep.replace(/^(\d{5})(\d{3})$/, "$1-$2");
    }

    // Return the cleaned string if it doesn't match the expected lengths
    return cleanCep;
}