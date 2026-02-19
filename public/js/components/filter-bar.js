// ============================================================================
// UI COMPONENT: FILTER BAR
// ============================================================================
function renderFilterBar() {
    const el = document.getElementById('filter-bar');
    const { filterOptions, filters, currentView, filteredRecords, allRecords } = Store.state;

    const totalForView = currentView === 'client' && Store.state.currentClient
        ? allRecords.filter(r => r._sheet === Store.state.currentClient).length
        : allRecords.length;

    let html = `
        <div class="filter-group">
            <span class="filter-label">From</span>
            <input type="date" class="filter-input" id="filter-date-from" value="${filters.dateFrom}"
                ${filterOptions.minDate ? `min="${filterOptions.minDate.toISOString().slice(0, 10)}"` : ''}>
        </div>
        <div class="filter-group">
            <span class="filter-label">To</span>
            <input type="date" class="filter-input" id="filter-date-to" value="${filters.dateTo}"
                ${filterOptions.maxDate ? `max="${filterOptions.maxDate.toISOString().slice(0, 10)}"` : ''}>
        </div>
        <div class="filter-separator"></div>
    `;

    if (currentView === 'master' && filterOptions.clients.length > 1) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Client</span>
                <select class="filter-select" id="filter-client">
                    <option value="all">All Clients</option>
                    ${filterOptions.clients.map(c => `<option value="${escapeHtml(c)}" ${filters.client === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    if (filterOptions.types.length > 1) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Type</span>
                <select class="filter-select" id="filter-type">
                    <option value="all">All Types</option>
                    ${filterOptions.types.map(t => `<option value="${escapeHtml(t)}" ${filters.type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    if (filterOptions.audiences.length > 1) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Audience</span>
                <select class="filter-select" id="filter-audience">
                    <option value="all">All Audiences</option>
                    ${filterOptions.audiences.map(a => `<option value="${escapeHtml(a)}" ${filters.audience === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    html += `
        <button class="filter-reset" id="filter-reset-btn">Reset</button>
        <span class="filter-count">${fmtNum(filteredRecords.length)} of ${fmtNum(totalForView)} records</span>
    `;

    el.innerHTML = html;

    const bind = (id, key) => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('change', () => Store.setFilter(key, input.value));
    };
    bind('filter-date-from', 'dateFrom');
    bind('filter-date-to', 'dateTo');
    bind('filter-client', 'client');
    bind('filter-type', 'type');
    bind('filter-audience', 'audience');

    const resetBtn = document.getElementById('filter-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => Store.resetFilters());
}
