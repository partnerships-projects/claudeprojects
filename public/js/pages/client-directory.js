// ============================================================================
// CLIENT DIRECTORY — Searchable card grid of all clients
// ============================================================================
function renderClientDirectory() {
    const { allRecords, clientMap, sheetNames } = Store.state;
    const content = document.getElementById('dashboard-content');

    Charts.destroyAll();

    const validClients = sheetNames
        .filter(name => clientMap[name] > 0)
        .sort((a, b) => a.localeCompare(b));

    let html = `<div class="fade-in">`;

    // Header with search
    html += `
        <div class="directory-header">
            <div class="directory-title-row">
                <h2 class="directory-title">All Clients</h2>
                <span class="directory-count">${validClients.length} clients</span>
            </div>
            <div class="directory-search-wrap">
                <svg class="directory-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                </svg>
                <input type="text" id="client-search" class="directory-search-input" placeholder="Search clients..." autocomplete="off">
            </div>
        </div>
    `;

    // Card grid
    html += `<div id="client-grid" class="client-grid">`;

    validClients.forEach(name => {
        const clientRecords = allRecords.filter(r => r._sheet === name);
        const metrics = MetricsCalc.compute(clientRecords);
        const clientColor = colorForIndex(hashString(name) % CONFIG.COLORS.length);
        const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const dateRange = getDateRangeLabel(clientRecords);

        html += `
            <div class="client-card" data-client="${escapeHtml(name)}">
                <div class="client-card-top">
                    <div class="client-card-avatar" style="background:${colorWithAlpha(clientColor, 0.15)}; color:${clientColor};">
                        ${initials}
                    </div>
                    <div class="client-card-info">
                        <h3 class="client-card-name">${escapeHtml(name)}</h3>
                        <span class="client-card-sub">${fmtNum(clientRecords.length)} records</span>
                    </div>
                    <svg class="client-card-arrow" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M6.47 4.47a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1 0 1.06l-3 3a.75.75 0 1 1-1.06-1.06L8.94 8 6.47 5.53a.75.75 0 0 1 0-1.06z"/>
                    </svg>
                </div>
                <div class="client-card-metrics">
                    <div class="client-card-metric">
                        <span class="ccm-value">${fmtNum(metrics.totalSent)}</span>
                        <span class="ccm-label">Sent</span>
                    </div>
                    <div class="client-card-metric">
                        <span class="ccm-value">${fmtPct(metrics.openRate)}</span>
                        <span class="ccm-label">Open Rate</span>
                    </div>
                    <div class="client-card-metric">
                        <span class="ccm-value">${fmtPct(metrics.replyRate)}</span>
                        <span class="ccm-label">Reply Rate</span>
                    </div>
                    <div class="client-card-metric">
                        <span class="ccm-value">${fmtPct(metrics.positiveRate)}</span>
                        <span class="ccm-label">Positive</span>
                    </div>
                </div>
            </div>
        `;
    });

    html += `</div></div>`;
    content.innerHTML = html;

    // --- Search ---
    const searchInput = document.getElementById('client-search');
    const grid = document.getElementById('client-grid');

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase().trim();
        grid.querySelectorAll('.client-card').forEach(card => {
            card.style.display = card.dataset.client.toLowerCase().includes(q) ? '' : 'none';
        });
    });

    // --- Click → open client dashboard ---
    grid.querySelectorAll('.client-card').forEach(card => {
        card.addEventListener('click', () => {
            Store.setView('client', card.dataset.client);
        });
    });
}
