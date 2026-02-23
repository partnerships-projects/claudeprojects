// ============================================================================
// UI COMPONENT: FILTER BAR
// ============================================================================
function renderFilterBar() {
    const el = document.getElementById('filter-bar');
    const { filterOptions, filters, currentView, filteredRecords, allRecords } = Store.state;

    // Determine the record pool for computing dropdown options.
    // On a client page, scope everything to that client's records only.
    const isClientView = currentView === 'client' && Store.state.currentClient;
    const baseRecords = isClientView
        ? allRecords.filter(r => r._sheet === Store.state.currentClient)
        : allRecords;

    const totalForView = baseRecords.length;

    // Build scoped filter option lists
    const opts = isClientView ? _scopedOptions(baseRecords) : filterOptions;

    let html = `
        <div class="filter-group">
            <span class="filter-label">From</span>
            <input type="text" class="filter-input filter-datepicker" id="filter-date-from"
                value="${filters.dateFrom}" placeholder="Start date" readonly>
        </div>
        <div class="filter-group">
            <span class="filter-label">To</span>
            <input type="text" class="filter-input filter-datepicker" id="filter-date-to"
                value="${filters.dateTo}" placeholder="End date" readonly>
        </div>
        <div class="filter-separator"></div>
    `;

    // Client filter — only on master view
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

    if (opts.types.length > 1) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Type</span>
                <select class="filter-select" id="filter-type">
                    <option value="all">All Types</option>
                    ${opts.types.map(t => `<option value="${escapeHtml(t)}" ${filters.type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    if (opts.audiences.length > 1) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Audience</span>
                <select class="filter-select" id="filter-audience">
                    <option value="all">All Audiences</option>
                    ${opts.audiences.map(a => `<option value="${escapeHtml(a)}" ${filters.audience === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    if (opts.owners.length > 0) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Owner</span>
                <select class="filter-select" id="filter-owner">
                    <option value="all">All Owners</option>
                    ${opts.owners.map(o => `<option value="${escapeHtml(o)}" ${filters.owner === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    if (opts.copies.length > 1) {
        html += `
            <div class="filter-group">
                <span class="filter-label">Copy</span>
                <select class="filter-select" id="filter-copy">
                    <option value="all">All Copies</option>
                    ${opts.copies.map(c => `<option value="${escapeHtml(c)}" ${filters.copy === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
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
    bind('filter-client', 'client');
    bind('filter-type', 'type');
    bind('filter-audience', 'audience');
    bind('filter-owner', 'owner');
    bind('filter-copy', 'copy');

    // Flatpickr calendar pickers
    const fpOpts = {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'M j, Y',
        allowInput: false,
        disableMobile: true,
        ...(opts.minDate ? { minDate: opts.minDate } : {}),
        ...(opts.maxDate ? { maxDate: opts.maxDate } : {}),
    };

    const fromEl = document.getElementById('filter-date-from');
    const toEl = document.getElementById('filter-date-to');

    if (fromEl) {
        flatpickr(fromEl, {
            ...fpOpts,
            defaultDate: filters.dateFrom || null,
            onChange(sel, dateStr) { Store.setFilter('dateFrom', dateStr); },
        });
    }
    if (toEl) {
        flatpickr(toEl, {
            ...fpOpts,
            defaultDate: filters.dateTo || null,
            onChange(sel, dateStr) { Store.setFilter('dateTo', dateStr); },
        });
    }

    const resetBtn = document.getElementById('filter-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => Store.resetFilters());
}

// Build filter option lists scoped to a subset of records
function _scopedOptions(records) {
    const types = new Set();
    const audiences = new Set();
    const owners = new Set();
    const copies = new Set();
    let minDate = null;
    let maxDate = null;

    records.forEach(r => {
        if (r._type) types.add(r._type);
        if (r._targetAudience) audiences.add(r._targetAudience);
        if (r._teamLeader) owners.add(r._teamLeader);
        if (r._cs) owners.add(r._cs);
        if (r._copyUsed) copies.add(r._copyUsed);
        if (r._date) {
            if (!minDate || r._date < minDate) minDate = r._date;
            if (!maxDate || r._date > maxDate) maxDate = r._date;
        }
    });

    return {
        clients: [],
        types: [...types].sort(),
        audiences: [...audiences].sort(),
        owners: [...owners].sort(),
        copies: [...copies].sort(),
        minDate,
        maxDate,
    };
}
