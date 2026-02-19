// ============================================================================
// STATE STORE — Centralized application state with observer pattern
// ============================================================================
const Store = {
    state: {
        apiKey: localStorage.getItem('dashboard_api_key') || '',
        spreadsheetId: localStorage.getItem('dashboard_spreadsheet_id') || CONFIG.SPREADSHEET_ID,
        spreadsheetTitle: '',
        sheetNames: [],
        allRecords: [],
        filteredRecords: [],
        clientMap: {},
        filterOptions: { clients: [], types: [], audiences: [], minDate: null, maxDate: null },
        filters: {
            dateFrom: '',
            dateTo: '',
            client: 'all',
            type: 'all',
            audience: 'all',
        },
        currentView: 'master',
        currentClient: null,
        loading: false,
        error: null,
        dataLoaded: false,
    },

    _listeners: [],

    subscribe(fn) {
        this._listeners.push(fn);
        return () => { this._listeners = this._listeners.filter(l => l !== fn); };
    },

    notify() {
        this._listeners.forEach(fn => fn(this.state));
    },

    update(partial) {
        Object.assign(this.state, partial);
        this.notify();
    },

    setFilter(key, value) {
        this.state.filters[key] = value;
        this.state.filteredRecords = FilterEngine.apply(this.state.allRecords, this.state.filters, this.state.currentView, this.state.currentClient);
        this.notify();
    },

    resetFilters() {
        this.state.filters = { dateFrom: '', dateTo: '', client: 'all', type: 'all', audience: 'all' };
        this.state.filteredRecords = FilterEngine.apply(this.state.allRecords, this.state.filters, this.state.currentView, this.state.currentClient);
        this.notify();
    },

    setView(view, client = null) {
        this.state.currentView = view;
        this.state.currentClient = client;
        this.state.filteredRecords = FilterEngine.apply(this.state.allRecords, this.state.filters, view, client);
        this.notify();
    },
};
