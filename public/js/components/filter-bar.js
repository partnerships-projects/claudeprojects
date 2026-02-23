// ============================================================================
// UI COMPONENT: FILTER BAR
// ============================================================================
function renderFilterBar() {
    const el = document.getElementById('filter-bar');
    const { filterOptions, filters, currentView, filteredRecords, allRecords } = Store.state;

    const isClientView = currentView === 'client' && Store.state.currentClient;
    const baseRecords = isClientView
        ? allRecords.filter(r => r._sheet === Store.state.currentClient)
        : allRecords;

    const totalForView = baseRecords.length;
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

    // Client — single select, master only
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

    // Type — single select
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

    // Audience — multi-select
    if (opts.audiences.length > 1) {
        html += _multiSelectHTML('audience', 'Audience', opts.audiences, filters.audience);
    }

    // Owner — single select
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

    // Copy — multi-select
    if (opts.copies.length > 1) {
        html += _multiSelectHTML('copy', 'Copy', opts.copies, filters.copy);
    }

    html += `
        <button class="filter-reset" id="filter-reset-btn">Reset</button>
        <span class="filter-count">${fmtNum(filteredRecords.length)} of ${fmtNum(totalForView)} records</span>
    `;

    el.innerHTML = html;

    // --- Bind single-selects ---
    const bind = (id, key) => {
        const input = document.getElementById(id);
        if (input) input.addEventListener('change', () => Store.setFilter(key, input.value));
    };
    bind('filter-client', 'client');
    bind('filter-type', 'type');
    bind('filter-owner', 'owner');

    // --- Bind multi-selects ---
    _initMultiSelect('audience');
    _initMultiSelect('copy');

    // --- Flatpickr ---
    const fpOpts = {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'M j, Y',
        allowInput: false,
        disableMobile: true,
        animate: false,
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

// ==================== Multi-select helpers ====================

function _multiSelectHTML(key, label, options, selected) {
    const count = selected.length;
    const plural = label === 'Copy' ? 'Copies' : `${label}s`;
    const btnLabel = count === 0 ? `All ${plural}` : `${label} (${count})`;

    let itemsHtml = `
        <button class="ms-deselect" data-ms-key="${key}">Deselect All</button>
    `;
    options.forEach(val => {
        const checked = selected.includes(val) ? 'checked' : '';
        itemsHtml += `
            <label class="ms-option">
                <input type="checkbox" value="${escapeHtml(val)}" ${checked}>
                <span>${escapeHtml(val)}</span>
            </label>
        `;
    });

    return `
        <div class="filter-group filter-ms-wrap" data-ms="${key}">
            <span class="filter-label">${label}</span>
            <button class="filter-select ms-trigger" id="ms-btn-${key}">${escapeHtml(btnLabel)}</button>
            <div class="ms-dropdown hidden" id="ms-dd-${key}">
                ${itemsHtml}
            </div>
        </div>
    `;
}

function _initMultiSelect(key) {
    const wrap = document.querySelector(`.filter-ms-wrap[data-ms="${key}"]`);
    if (!wrap) return;

    const btn = wrap.querySelector('.ms-trigger');
    const dd = wrap.querySelector('.ms-dropdown');
    const label = btn.closest('.filter-ms-wrap').querySelector('.filter-label').textContent;

    function _updateBtnLabel() {
        const count = dd.querySelectorAll('input[type="checkbox"]:checked').length;
        const plural = label === 'Copy' ? 'Copies' : `${label}s`;
        btn.textContent = count === 0 ? `All ${plural}` : `${label} (${count})`;
    }

    // Toggle dropdown — only on the trigger button
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close & apply other open multi-selects first
        _msCloseAllExcept(key);
        dd.classList.toggle('hidden');
    });

    // ALL clicks inside the dropdown stay inside — never bubble to document
    dd.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Checkbox changes — just update the label, don't apply yet
    dd.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            _updateBtnLabel();
        });
    });

    // Deselect all — update label, stay open
    const deselectBtn = dd.querySelector('.ms-deselect');
    if (deselectBtn) {
        deselectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dd.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
            _updateBtnLabel();
        });
    }

    // Enter key → close and apply
    dd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            _msCloseAndApply(key);
        }
    });
}

/* Close a specific multi-select and apply its checked values */
function _msCloseAndApply(key) {
    const wrap = document.querySelector(`.filter-ms-wrap[data-ms="${key}"]`);
    if (!wrap) return;
    const dd = wrap.querySelector('.ms-dropdown');
    if (!dd || dd.classList.contains('hidden')) return;
    dd.classList.add('hidden');
    const checked = [...dd.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    Store.setFilter(key, checked);
}

/* Close & apply all open multi-selects except the one with the given key */
function _msCloseAllExcept(exceptKey) {
    document.querySelectorAll('.filter-ms-wrap').forEach(wrap => {
        const key = wrap.dataset.ms;
        if (key === exceptKey) return;
        const dd = wrap.querySelector('.ms-dropdown');
        if (dd && !dd.classList.contains('hidden')) {
            dd.classList.add('hidden');
            const checked = [...dd.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
            Store.setFilter(key, checked);
        }
    });
}

/* Single global handler: close & apply any open dropdown on outside click.
   Registered ONCE so it never piles up. */
if (!window.__msOutsideClickBound) {
    window.__msOutsideClickBound = true;
    document.addEventListener('click', () => {
        document.querySelectorAll('.filter-ms-wrap').forEach(wrap => {
            const dd = wrap.querySelector('.ms-dropdown');
            if (dd && !dd.classList.contains('hidden')) {
                dd.classList.add('hidden');
                const key = wrap.dataset.ms;
                const checked = [...dd.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
                Store.setFilter(key, checked);
            }
        });
    });
}

// ==================== Scoped options ====================

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
