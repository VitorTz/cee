// =============================================================================
// MODULE: MANUAL / ABOUT PAGE (MARKDOWN RENDERER)
// =============================================================================

async function loadAboutPage() {
    const container = qs("#about-content");
    if (container.dataset.loaded === "true") return;

    try {
        // Fetch the README.md file from the root directory
        // Since it's on GitHub Pages, './README.md' points to the public file
        const response = await fetch("./README.md");

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const markdownText = await response.text();
        container.innerHTML = marked.parse(markdownText);

        container.dataset.loaded = "true";
    } catch (error) {
        console.error("Failed to load README.md:", error);
        container.innerHTML = `
      <div class="field-error" style="display: block; padding: 20px; text-align: center;">
        <strong>Error loading the manual.</strong><br> 
        Please check if README.md exists at the project root.
      </div>`;
    }
}