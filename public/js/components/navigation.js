// ============================================================================
// UI COMPONENT: NAVIGATION TABS
// ============================================================================
function renderNavigation() {
    const el = document.getElementById('nav-tabs');
    const { sheetNames, clientMap, currentView, currentClient } = Store.state;

    const validSheets = sheetNames.filter(name => clientMap[name] > 0);

    let html = `
        <button class="nav-tab ${currentView === 'master' ? 'active' : ''}" data-view="master">
            <svg class="tab-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zM9 2.5A1.5 1.5 0 0110.5 1h3A1.5 1.5 0 0115 2.5v3A1.5 1.5 0 0113.5 7h-3A1.5 1.5 0 019 5.5v-3zM1 10.5A1.5 1.5 0 012.5 9h3A1.5 1.5 0 017 10.5v3A1.5 1.5 0 015.5 15h-3A1.5 1.5 0 011 13.5v-3zM9 10.5A1.5 1.5 0 0110.5 9h3a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-3A1.5 1.5 0 019 13.5v-3z"/>
            </svg>
            <span>Master Dashboard</span>
        </button>
    `;

    if (validSheets.length > 0) {
        html += '<div class="nav-tab-divider"></div>';
        validSheets.forEach(name => {
            const isActive = currentView === 'client' && currentClient === name;
            html += `
                <button class="nav-tab ${isActive ? 'active' : ''}" data-view="client" data-client="${escapeHtml(name)}">
                    <svg class="tab-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 8a3 3 0 100-6 3 3 0 000 6zM2 14s-1 0-1-1 1-4 7-4 7 3 7 4-1 1-1 1H2z"/>
                    </svg>
                    <span>${escapeHtml(name)}</span>
                </button>
            `;
        });
    }

    el.innerHTML = html;

    el.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.view;
            const client = tab.dataset.client || null;
            Store.setView(view, client);
        });
    });
}
