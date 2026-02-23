// ============================================================================
// MAIN APPLICATION — Render orchestrator, data loading, initialization
// ============================================================================

// Main render dispatcher (debounced)
const renderDashboard = debounce(() => {
    const { currentView, filteredRecords, dataLoaded } = Store.state;

    if (!dataLoaded) return;

    const emptyEl = document.getElementById('empty-state');
    const contentEl = document.getElementById('dashboard-content');
    const filterBarEl = document.getElementById('filter-bar');

    // Client directory doesn't use filters or empty-state
    if (currentView === 'clients') {
        emptyEl?.classList.add('hidden');
        contentEl?.classList.remove('hidden');
        filterBarEl?.classList.add('hidden');
        renderClientDirectory();
        renderNavigation();
        return;
    }

    // Show filter bar for master & client views
    filterBarEl?.classList.remove('hidden');

    if (filteredRecords.length === 0) {
        emptyEl?.classList.remove('hidden');
        contentEl?.classList.add('hidden');
        renderNavigation();
        renderFilterBar();
        return;
    }

    emptyEl?.classList.add('hidden');
    contentEl?.classList.remove('hidden');

    if (currentView === 'master') {
        renderMasterDashboard();
    } else {
        renderClientDashboard();
    }

    renderNavigation();
    renderFilterBar();
}, 50);

// Data loading with progress UI
async function loadData(apiKey, spreadsheetId) {
    const loadingEl = document.getElementById('loading-overlay');
    const loadingMsg = document.getElementById('loading-message');
    const loadingBar = document.getElementById('loading-progress-bar');
    const errorEl = document.getElementById('error-state');
    const contentEl = document.getElementById('dashboard-content');

    loadingEl?.classList.remove('hidden');
    errorEl?.classList.add('hidden');
    contentEl?.classList.add('hidden');

    try {
        const { spreadsheetTitle, sheetNames, allSheetData } = await SheetsAPI.fetchAll(
            apiKey, spreadsheetId,
            ({ phase, total, done, current }) => {
                if (phase === 'sheets') {
                    loadingMsg.textContent = `Discovered ${total} sheets...`;
                } else {
                    const pct = Math.round((done / total) * 100);
                    loadingBar.style.width = `${pct}%`;
                    loadingMsg.textContent = `Loading sheet: ${current} (${done}/${total})`;
                }
            }
        );

        const { allRecords, clientMap } = DataEngine.parseAll(allSheetData);
        const filterOptions = DataEngine.getFilterOptions(allRecords, clientMap);

        Store.update({
            spreadsheetTitle,
            sheetNames,
            allRecords,
            filteredRecords: allRecords,
            clientMap,
            filterOptions,
            dataLoaded: true,
            loading: false,
            error: null,
        });

        loadingEl?.classList.add('hidden');
        contentEl?.classList.remove('hidden');

        const statusBadge = document.getElementById('data-status');
        if (statusBadge) {
            statusBadge.textContent = `${Object.keys(clientMap).length} clients`;
            statusBadge.classList.add('connected');
        }

        renderNavigation();
        renderFilterBar();
        renderDashboard();

        AutoRefresh.setFingerprint(allRecords, clientMap);
        AutoRefresh.start();

        showToast(`Loaded ${fmtNum(allRecords.length)} records from ${Object.keys(clientMap).length} client sheets`, 'success');

    } catch (err) {
        loadingEl?.classList.add('hidden');
        errorEl?.classList.remove('hidden');

        const errorTitle = document.getElementById('error-title');
        const errorMsg = document.getElementById('error-message');
        if (errorTitle) errorTitle.textContent = 'Connection Error';
        if (errorMsg) errorMsg.textContent = err.message || 'Failed to load data from Google Sheets.';

        Store.update({ loading: false, error: err.message });
    }
}

// Application initialization
function init() {
    setupChartDefaults();

    const setupOverlay = document.getElementById('setup-overlay');
    const appEl = document.getElementById('app');
    const apiKeyInput = document.getElementById('input-api-key');
    const spreadsheetIdInput = document.getElementById('input-spreadsheet-id');
    const connectBtn = document.getElementById('btn-connect');
    const setupError = document.getElementById('setup-error');

    apiKeyInput.value = Store.state.apiKey;
    spreadsheetIdInput.value = Store.state.spreadsheetId;

    connectBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const spreadsheetId = spreadsheetIdInput.value.trim();

        if (!apiKey) {
            setupError.textContent = 'Please enter a Google API Key.';
            setupError.classList.remove('hidden');
            return;
        }
        if (!spreadsheetId) {
            setupError.textContent = 'Please enter a Spreadsheet ID.';
            setupError.classList.remove('hidden');
            return;
        }

        setupError.classList.add('hidden');
        connectBtn.querySelector('.btn-text').textContent = 'Connecting...';
        connectBtn.querySelector('.btn-spinner')?.classList.remove('hidden');
        connectBtn.disabled = true;

        try {
            await SheetsAPI.getSpreadsheetMeta(apiKey, spreadsheetId);

            localStorage.setItem('dashboard_api_key', apiKey);
            localStorage.setItem('dashboard_spreadsheet_id', spreadsheetId);
            Store.update({ apiKey, spreadsheetId });

            setupOverlay.classList.add('hidden');
            appEl.classList.remove('hidden');

            await loadData(apiKey, spreadsheetId);

        } catch (err) {
            setupError.textContent = `Connection failed: ${err.message}`;
            setupError.classList.remove('hidden');
            connectBtn.querySelector('.btn-text').textContent = 'Connect & Load Data';
            connectBtn.querySelector('.btn-spinner')?.classList.add('hidden');
            connectBtn.disabled = false;
        }
    });

    if (Store.state.apiKey && Store.state.spreadsheetId) {
        setupOverlay.classList.add('hidden');
        appEl.classList.remove('hidden');
        loadData(Store.state.apiKey, Store.state.spreadsheetId);
    }

    document.getElementById('btn-refresh')?.addEventListener('click', () => {
        if (Store.state.apiKey && Store.state.spreadsheetId) {
            loadData(Store.state.apiKey, Store.state.spreadsheetId);
        }
    });

    document.getElementById('btn-settings')?.addEventListener('click', () => {
        appEl.classList.add('hidden');
        setupOverlay.classList.remove('hidden');
        connectBtn.querySelector('.btn-text').textContent = 'Connect & Load Data';
        connectBtn.querySelector('.btn-spinner')?.classList.add('hidden');
        connectBtn.disabled = false;
    });

    document.getElementById('btn-retry')?.addEventListener('click', () => {
        if (Store.state.apiKey && Store.state.spreadsheetId) {
            loadData(Store.state.apiKey, Store.state.spreadsheetId);
        }
    });

    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
        Store.resetFilters();
    });

    Store.subscribe(() => {
        renderDashboard();
    });
}

// Boot
document.addEventListener('DOMContentLoaded', init);
