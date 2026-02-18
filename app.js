'use strict';

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const CONFIG = {
    SPREADSHEET_ID: '1YSP2hUke2MJQvuiszliZu-GLzAnonuyaXuTmYY9O4CU',
    API_BASE: 'https://sheets.googleapis.com/v4/spreadsheets',

    // Only read columns A through V (first 22 columns).
    // Sheets contain auxiliary/duplicate columns after V that must be ignored.
    MAX_DATA_COLUMNS: 22,
    DATA_RANGE_SUFFIX: '!A:V',

    // Minimum number of recognized headers a sheet must have to be treated as a client sheet.
    // Sheets with fewer matches (e.g. summary/config tabs) are skipped automatically.
    MIN_VALID_HEADERS: 5,

    // Sheet names to always exclude (case-insensitive substring match).
    // These are known non-client sheets like dashboards, templates, and config tabs.
    EXCLUDED_SHEETS: [
        'MASTER DATA SHEE',
        'CLIENT INFO',
        'CLIENT MONTHLY DASHBOARD',
        'CLIENT DAILY DASHBOARD',
        'COPY OF EXAMPLE!DO NOT EDIT ONLY DUPLICATE!',
    ],

    // Keywords that identify summary / total rows (case-insensitive).
    // Any row whose MONTH or DATE cell matches one of these is skipped.
    SUMMARY_ROW_KEYWORDS: [
        'TOTAL', 'TOTALS', 'GRAND TOTAL', 'GRAND TOTALS',
        'SUM', 'SUBTOTAL', 'SUB TOTAL', 'SUB-TOTAL',
        'AVERAGE', 'AVG', 'MEAN',
        'OVERALL', 'SUMMARY', 'AGGREGATE',
    ],

    // Column name normalization map (uppercase key -> internal field).
    // Only columns A:V are processed; duplicates after V are never seen.
    COLUMN_MAP: {
        'MONTH':            'month',
        'DATE':             'date',
        'HOUR':             'hour',
        'HOUR SENT':        'hour',
        'HOURS':            'hour',
        'SENT EMAIL':       'sentEmail',
        'EMAIL (USED)':     'sentEmail',
        'EMAIL USED':       'sentEmail',
        'EMAIL SENT':       'emailSent',
        '#EMAIL SENT':      'emailSent',
        '# EMAIL SENT':     'emailSent',
        'EMAILS SENT':      'emailSent',
        '#EMAILS SENT':     'emailSent',
        '# EMAILS SENT':    'emailSent',
        'TOTAL EMAILS SENT':'emailSent',
        'NO. OF EMAILS SENT':'emailSent',
        'TARGET AUDIENCE':  'targetAudience',
        'AUDIENCE':         'targetAudience',
        'SUBJECT LINE':     'subjectLine',
        'SUBJECT':          'subjectLine',
        'COPY USED':        'copyUsed',
        'COPY':             'copyUsed',
        'SERVERS':          'servers',
        'SERVER':           'servers',
        'POSITIVE':         'positive',
        'POSITIVES':        'positive',
        '#POSITIVE':        'positive',
        '# POSITIVE':       'positive',
        '#POSITIVES':       'positive',
        '# POSITIVES':      'positive',
        'NEGATIVE':         'negative',
        'NEGATIVES':        'negative',
        '#NEGATIVE':        'negative',
        '# NEGATIVE':       'negative',
        '#NEGATIVES':       'negative',
        '# NEGATIVES':      'negative',
        'COMPLEX':          'complex',
        '#COMPLEX':         'complex',
        '# COMPLEX':        'complex',
        'CONVERTED':        'converted',
        'CONVERSIONS':      'converted',
        'CONVERSION':       'converted',
        '#CONVERTED':       'converted',
        '# CONVERTED':      'converted',
        '#CONVERSIONS':     'converted',
        '# CONVERSIONS':    'converted',
        'OPEN RATE':        'openRate',
        'OPEN %':           'openRate',
        'OPEN RATE %':      'openRate',
        'REPLY RATE':       'replyRate',
        'REPLY %':          'replyRate',
        'REPLY RATE %':     'replyRate',
        'OPENS':            'opens',
        'OPEN':             'opens',
        '#OPENS':           'opens',
        '# OPENS':          'opens',
        'TOTAL OPENS':      'opens',
        'REPLIES':          'replies',
        'REPLY':            'replies',
        '#REPLIES':         'replies',
        '# REPLIES':        'replies',
        'TOTAL REPLIES':    'replies',
        'CLIENT NAME':      'clientName',
        'CLIENT':           'clientName',
        'TEAM LEADER':      'teamLeader',
        'TEAM LEAD':        'teamLeader',
        'TL':               'teamLeader',
        'CS':               'cs',
        'TYPE':             'type',
        'GOAL':             'goal',
        'GOALS':            'goal',
    },

    // Palette for clients/segments
    COLORS: [
        '#4f8df5', '#34d399', '#fbbf24', '#f87171', '#a78bfa',
        '#22d3ee', '#fb923c', '#f472b6', '#818cf8', '#2dd4bf',
        '#e879f9', '#84cc16', '#f97316', '#06b6d4', '#8b5cf6',
    ],
};

// ============================================================================
// 2. UTILITY FUNCTIONS
// ============================================================================
function safeNum(val) {
    if (val === null || val === undefined || val === '') return 0;
    const s = String(val).replace(/[,%$]/g, '').trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function safeDivide(num, denom) {
    if (!denom || denom === 0) return 0;
    return num / denom;
}

function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val)) return val;
    const s = String(val).trim();
    if (!s) return null;
    // Try multiple formats
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // Try DD/MM/YYYY
    const parts = s.split(/[\/\-\.]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map(Number);
        if (c > 100) return new Date(c, b - 1, a); // DD/MM/YYYY
        if (a > 100) return new Date(a, b - 1, c); // YYYY/MM/DD
    }
    return null;
}

function formatDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMonthKey(d) {
    if (!d) return 'unknown';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(key) {
    const [y, m] = key.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m) - 1]} ${y}`;
}

function fmtNum(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('en-US');
}

function fmtPct(ratio, decimals = 1) {
    if (ratio === null || ratio === undefined || isNaN(ratio)) return '—';
    return (ratio * 100).toFixed(decimals) + '%';
}

function fmtPctVal(val, decimals = 1) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toFixed(decimals) + '%';
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function colorForIndex(i) {
    return CONFIG.COLORS[i % CONFIG.COLORS.length];
}

function colorWithAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================================
// 3. GOOGLE SHEETS API
// ============================================================================
const SheetsAPI = {
    async getSpreadsheetMeta(apiKey, spreadsheetId) {
        const url = `${CONFIG.API_BASE}/${spreadsheetId}?key=${encodeURIComponent(apiKey)}&fields=sheets.properties.title,properties.title`;
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `API Error ${res.status}`);
        }
        return res.json();
    },

    async getSheetData(apiKey, spreadsheetId, sheetName) {
        // Only fetch columns A:V to avoid duplicate/auxiliary columns after V
        const range = encodeURIComponent(sheetName + CONFIG.DATA_RANGE_SUFFIX);
        const url = `${CONFIG.API_BASE}/${spreadsheetId}/values/${range}?key=${encodeURIComponent(apiKey)}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `API Error ${res.status}`);
        }
        const data = await res.json();
        return data.values || [];
    },

    async fetchAll(apiKey, spreadsheetId, onProgress) {
        // 1. Get all sheet names
        const meta = await this.getSpreadsheetMeta(apiKey, spreadsheetId);
        const allSheetNames = meta.sheets.map(s => s.properties.title);
        const spreadsheetTitle = meta.properties?.title || 'Untitled';

        // 2. Filter out known non-client sheets before fetching any data
        const excluded = CONFIG.EXCLUDED_SHEETS.map(s => s.toUpperCase());
        const sheetNames = allSheetNames.filter(name => {
            const upper = name.toUpperCase().trim();
            return !excluded.some(ex => upper === ex || upper.includes(ex));
        });

        const skipped = allSheetNames.length - sheetNames.length;
        if (skipped > 0) {
            console.log(`[Dashboard] Excluded ${skipped} non-client sheet(s) by name: ${allSheetNames.filter(n => !sheetNames.includes(n)).join(', ')}`);
        }

        if (onProgress) onProgress({ phase: 'sheets', total: sheetNames.length, done: 0 });

        // 3. Fetch data from each client sheet in parallel (batches of 5)
        const allSheetData = {};
        const batchSize = 5;
        let done = 0;

        for (let i = 0; i < sheetNames.length; i += batchSize) {
            const batch = sheetNames.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(name => this.getSheetData(apiKey, spreadsheetId, name))
            );
            results.forEach((result, idx) => {
                const name = batch[idx];
                if (result.status === 'fulfilled' && result.value.length > 1) {
                    allSheetData[name] = result.value;
                }
                done++;
                if (onProgress) onProgress({ phase: 'data', total: sheetNames.length, done, current: name });
            });
        }

        return { spreadsheetTitle, sheetNames, allSheetData };
    }
};

// ============================================================================
// 4. DATA ENGINE
// ============================================================================
const DataEngine = {
    // Normalize a raw header string for matching against COLUMN_MAP.
    // Strips non-breaking spaces, collapses whitespace, trims, uppercases.
    normalizeHeader(raw) {
        return String(raw || '')
            .replace(/[\u00A0\u200B\u2003\u2002\u2009]/g, ' ')   // special spaces -> normal space
            .replace(/\s+/g, ' ')                                  // collapse runs of whitespace
            .trim()
            .toUpperCase();
    },

    // Map raw headers to internal field names (capped to MAX_DATA_COLUMNS)
    mapHeaders(rawHeaders) {
        const maxCols = Math.min(rawHeaders.length, CONFIG.MAX_DATA_COLUMNS);
        const mapped = [];
        for (let i = 0; i < maxCols; i++) {
            const upper = this.normalizeHeader(rawHeaders[i]);
            mapped.push(CONFIG.COLUMN_MAP[upper] || null);
        }
        return mapped;
    },

    // Validate that a sheet's headers match the expected schema.
    // Returns true if enough known columns are present.
    isValidClientSheet(rawHeaders) {
        const mapped = this.mapHeaders(rawHeaders);
        const recognized = mapped.filter(f => f !== null).length;
        return recognized >= CONFIG.MIN_VALID_HEADERS;
    },

    // Check if a value looks like a summary/total row marker (exact match only)
    _isSummaryValue(val) {
        if (val === null || val === undefined || val === '') return false;
        const s = String(val).trim().toUpperCase();
        return CONFIG.SUMMARY_ROW_KEYWORDS.includes(s);
    },

    // Parse a single sheet's raw data into typed records
    parseSheet(rawRows, sheetName) {
        if (!rawRows || rawRows.length < 2) return [];

        const rawHeaders = rawRows[0];

        // Skip sheets that don't have the expected column structure
        if (!this.isValidClientSheet(rawHeaders)) {
            console.log(`[Dashboard] Skipping sheet "${sheetName}": only ${this.mapHeaders(rawHeaders).filter(f=>f).length} recognized columns (need ${CONFIG.MIN_VALID_HEADERS})`);
            return [];
        }

        const fieldMap = this.mapHeaders(rawHeaders);
        const colCount = fieldMap.length; // already capped to MAX_DATA_COLUMNS

        // --- Diagnostic: log column mapping for this sheet ---
        const maxCols = Math.min(rawHeaders.length, CONFIG.MAX_DATA_COLUMNS);
        const mappedCols = [];
        const unmappedCols = [];
        for (let i = 0; i < maxCols; i++) {
            const hdr = this.normalizeHeader(rawHeaders[i]);
            if (!hdr) continue;
            if (fieldMap[i]) {
                mappedCols.push(`[${i}] "${hdr}" -> ${fieldMap[i]}`);
            } else {
                unmappedCols.push(`[${i}] "${hdr}"`);
            }
        }
        console.log(`[Dashboard] Sheet "${sheetName}" mapped columns: ${mappedCols.join(', ')}`);
        if (unmappedCols.length > 0) {
            console.warn(`[Dashboard] Sheet "${sheetName}" UNMAPPED columns: ${unmappedCols.join(', ')}`);
        }

        // --- Find which field indices correspond to MONTH and DATE for summary-row detection ---
        const monthIdx = fieldMap.indexOf('month');
        const dateIdx = fieldMap.indexOf('date');

        const records = [];
        let skippedSummaryRows = 0;

        for (let i = 1; i < rawRows.length; i++) {
            const row = rawRows[i];
            if (!row || row.length === 0) continue;

            // --- Summary / total row detection ---
            // Check if the MONTH or DATE cell contains a summary keyword (e.g. "Total", "Grand Total")
            const monthVal = monthIdx >= 0 ? row[monthIdx] : null;
            const dateVal = dateIdx >= 0 ? row[dateIdx] : null;
            if (this._isSummaryValue(monthVal) || this._isSummaryValue(dateVal)) {
                skippedSummaryRows++;
                continue;
            }

            // Also check the very first cell of the row (column A), since some sheets
            // put "TOTAL" in the first column regardless of what that column is.
            if (row[0] !== undefined && row[0] !== null && this._isSummaryValue(row[0])) {
                skippedSummaryRows++;
                continue;
            }

            const record = { _sheet: sheetName };
            let hasData = false;

            // Only iterate up to the capped column count
            for (let idx = 0; idx < colCount; idx++) {
                const field = fieldMap[idx];
                if (field && row[idx] !== undefined && row[idx] !== null && row[idx] !== '') {
                    record[field] = row[idx];
                    hasData = true;
                }
            }

            // Skip completely empty rows
            if (!hasData) continue;

            // Parse typed fields
            record._emailSent = safeNum(record.emailSent);
            record._positive = safeNum(record.positive);
            record._negative = safeNum(record.negative);
            record._complex = safeNum(record.complex);
            record._converted = safeNum(record.converted);
            record._opens = safeNum(record.opens);
            record._replies = safeNum(record.replies);
            record._openRate = safeNum(record.openRate);
            record._replyRate = safeNum(record.replyRate);
            record._hour = safeNum(record.hour);
            record._date = parseDate(record.date);
            record._clientName = (record.clientName || sheetName || '').toString().trim();
            record._targetAudience = (record.targetAudience || '').toString().trim();
            record._type = (record.type || '').toString().trim();
            record._subjectLine = (record.subjectLine || '').toString().trim();
            record._copyUsed = (record.copyUsed || '').toString().trim();
            record._teamLeader = (record.teamLeader || '').toString().trim();
            record._goal = (record.goal || '').toString().trim();
            record._servers = (record.servers || '').toString().trim();
            record._cs = (record.cs || '').toString().trim();
            record._month = (record.month || '').toString().trim();

            records.push(record);
        }

        // --- Diagnostic: per-sheet summary ---
        if (skippedSummaryRows > 0) {
            console.log(`[Dashboard] Sheet "${sheetName}": skipped ${skippedSummaryRows} summary/total row(s)`);
        }
        if (records.length > 0) {
            const totSent = records.reduce((s, r) => s + r._emailSent, 0);
            const totOpens = records.reduce((s, r) => s + r._opens, 0);
            const totReplies = records.reduce((s, r) => s + r._replies, 0);
            const totPositive = records.reduce((s, r) => s + r._positive, 0);
            const totConverted = records.reduce((s, r) => s + r._converted, 0);
            console.log(`[Dashboard] Sheet "${sheetName}": ${records.length} records | Sent=${totSent}, Opens=${totOpens}, Replies=${totReplies}, Positive=${totPositive}, Converted=${totConverted}`);
        }

        return records;
    },

    // Parse all sheets into a flat array of records.
    // Sheets that fail header validation are silently excluded (logged to console).
    parseAll(allSheetData) {
        const allRecords = [];
        const clientMap = {};
        const skippedSheets = [];

        for (const [sheetName, rawRows] of Object.entries(allSheetData)) {
            const records = this.parseSheet(rawRows, sheetName);
            if (records.length > 0) {
                allRecords.push(...records);
                clientMap[sheetName] = records.length;
            } else if (rawRows.length > 0) {
                skippedSheets.push(sheetName);
            }
        }

        if (skippedSheets.length > 0) {
            console.log(`[Dashboard] Skipped ${skippedSheets.length} non-client sheets: ${skippedSheets.join(', ')}`);
        }
        console.log(`[Dashboard] Loaded ${allRecords.length} records from ${Object.keys(clientMap).length} client sheets: ${Object.keys(clientMap).join(', ')}`);

        return { allRecords, clientMap };
    },

    // Extract unique filter options from records.
    // Client list is derived from sheet names (1 sheet = 1 client), not the CLIENT NAME column.
    getFilterOptions(records, clientMap) {
        const types = new Set();
        const audiences = new Set();
        let minDate = null;
        let maxDate = null;

        records.forEach(r => {
            if (r._type) types.add(r._type);
            if (r._targetAudience) audiences.add(r._targetAudience);
            if (r._date) {
                if (!minDate || r._date < minDate) minDate = r._date;
                if (!maxDate || r._date > maxDate) maxDate = r._date;
            }
        });

        return {
            clients: Object.keys(clientMap).sort(),
            types: [...types].sort(),
            audiences: [...audiences].sort(),
            minDate,
            maxDate,
        };
    },
};

// ============================================================================
// 5. METRICS CALCULATOR
// ============================================================================
const MetricsCalc = {
    compute(records) {
        if (!records || records.length === 0) {
            return this._empty();
        }

        const totalSent = records.reduce((s, r) => s + r._emailSent, 0);
        const totalOpens = records.reduce((s, r) => s + r._opens, 0);
        const totalReplies = records.reduce((s, r) => s + r._replies, 0);
        const totalPositive = records.reduce((s, r) => s + r._positive, 0);
        const totalNegative = records.reduce((s, r) => s + r._negative, 0);
        const totalComplex = records.reduce((s, r) => s + r._complex, 0);
        const totalConverted = records.reduce((s, r) => s + r._converted, 0);

        return {
            totalRecords: records.length,
            totalSent,
            totalOpens,
            totalReplies,
            totalPositive,
            totalNegative,
            totalComplex,
            totalConverted,

            // Calculated rates
            openRate: safeDivide(totalOpens, totalSent),
            replyRate: safeDivide(totalReplies, totalSent),
            positiveRate: safeDivide(totalPositive, totalReplies),
            negativeRate: safeDivide(totalNegative, totalReplies),
            complexRate: safeDivide(totalComplex, totalReplies),
            conversionRate: safeDivide(totalConverted, totalReplies),
            positiveConversionRate: safeDivide(totalConverted, totalPositive),
            negativeRatio: safeDivide(totalNegative, totalPositive + totalNegative),

            // Additional derived
            responseQuality: safeDivide(totalPositive, totalPositive + totalNegative + totalComplex),
            engagementRate: safeDivide(totalOpens + totalReplies, totalSent),
        };
    },

    _empty() {
        return {
            totalRecords: 0, totalSent: 0, totalOpens: 0, totalReplies: 0,
            totalPositive: 0, totalNegative: 0, totalComplex: 0, totalConverted: 0,
            openRate: 0, replyRate: 0, positiveRate: 0, negativeRate: 0,
            complexRate: 0, conversionRate: 0, positiveConversionRate: 0,
            negativeRatio: 0, responseQuality: 0, engagementRate: 0,
        };
    },

    // Group records by time period (month) and compute trends
    computeTrends(records) {
        const byMonth = {};
        records.forEach(r => {
            if (!r._date) return;
            const key = formatMonthKey(r._date);
            if (!byMonth[key]) byMonth[key] = [];
            byMonth[key].push(r);
        });

        return Object.keys(byMonth).sort().map(key => ({
            period: key,
            label: formatMonthLabel(key),
            metrics: this.compute(byMonth[key]),
            count: byMonth[key].length,
        }));
    },

    // Group by weekly
    computeWeeklyTrends(records) {
        const byWeek = {};
        records.forEach(r => {
            if (!r._date) return;
            const d = new Date(r._date);
            const dayOfWeek = d.getDay();
            const startOfWeek = new Date(d);
            startOfWeek.setDate(d.getDate() - dayOfWeek);
            const key = startOfWeek.toISOString().slice(0, 10);
            if (!byWeek[key]) byWeek[key] = [];
            byWeek[key].push(r);
        });

        return Object.keys(byWeek).sort().map(key => ({
            period: key,
            label: formatDate(new Date(key)),
            metrics: this.compute(byWeek[key]),
            count: byWeek[key].length,
        }));
    },

    // Group by any dimension
    computeByDimension(records, accessor, label = 'dimension') {
        const groups = {};
        records.forEach(r => {
            const key = accessor(r) || 'Unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        });

        return Object.entries(groups)
            .map(([name, recs]) => ({
                name,
                metrics: this.compute(recs),
                count: recs.length,
            }))
            .sort((a, b) => b.metrics.totalSent - a.metrics.totalSent);
    },

    // Compute per-client metrics (grouped by sheet name, since 1 sheet = 1 client)
    computeClientComparison(records) {
        return this.computeByDimension(records, r => r._sheet, 'client');
    },
};

// ============================================================================
// 6. STATE STORE
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
        // Re-apply filters for the new view context
        this.state.filteredRecords = FilterEngine.apply(this.state.allRecords, this.state.filters, view, client);
        this.notify();
    },
};

// ============================================================================
// 7. FILTER ENGINE
// ============================================================================
const FilterEngine = {
    apply(records, filters, view, clientName) {
        let result = records;

        // For client view, first filter to that client's sheet
        if (view === 'client' && clientName) {
            result = result.filter(r => r._sheet === clientName);
        }

        // Date range
        if (filters.dateFrom) {
            const from = new Date(filters.dateFrom);
            result = result.filter(r => !r._date || r._date >= from);
        }
        if (filters.dateTo) {
            const to = new Date(filters.dateTo);
            to.setHours(23, 59, 59, 999);
            result = result.filter(r => !r._date || r._date <= to);
        }

        // Client filter (only relevant in master view).
        // Matches on sheet name since 1 sheet = 1 client.
        if (view === 'master' && filters.client !== 'all') {
            result = result.filter(r => r._sheet === filters.client);
        }

        // Type
        if (filters.type !== 'all') {
            result = result.filter(r => r._type === filters.type);
        }

        // Target audience
        if (filters.audience !== 'all') {
            result = result.filter(r => r._targetAudience === filters.audience);
        }

        return result;
    },
};

// ============================================================================
// 8. CHART REGISTRY
// ============================================================================
const Charts = {
    _instances: {},

    create(id, config) {
        this.destroy(id);
        const canvas = document.getElementById(id);
        if (!canvas) return null;
        const chart = new Chart(canvas, config);
        this._instances[id] = chart;
        return chart;
    },

    destroy(id) {
        if (this._instances[id]) {
            this._instances[id].destroy();
            delete this._instances[id];
        }
    },

    destroyAll() {
        Object.keys(this._instances).forEach(id => this.destroy(id));
    },
};

// Chart.js global defaults
function setupChartDefaults() {
    Chart.defaults.color = '#8b8fa3';
    Chart.defaults.borderColor = 'rgba(35, 40, 66, 0.5)';
    Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
    Chart.defaults.plugins.legend.labels.padding = 14;
    Chart.defaults.plugins.tooltip.backgroundColor = '#1e2235';
    Chart.defaults.plugins.tooltip.borderColor = '#2a2f45';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
    Chart.defaults.elements.bar.borderRadius = 4;
    Chart.defaults.elements.bar.borderSkipped = false;
}

// ============================================================================
// 9. UI COMPONENT: NAVIGATION
// ============================================================================
function renderNavigation() {
    const el = document.getElementById('nav-tabs');
    const { sheetNames, clientMap, currentView, currentClient } = Store.state;

    // Only show sheets that had valid data
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
            const count = clientMap[name] || 0;
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

    // Event delegation
    el.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.view;
            const client = tab.dataset.client || null;
            Store.setView(view, client);
        });
    });
}

// ============================================================================
// 10. UI COMPONENT: FILTER BAR
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

    // Client filter only in master view
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

    // Bind events
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

// ============================================================================
// 11. UI COMPONENT: SUMMARY STRIP
// ============================================================================
function renderSummaryStrip(metrics) {
    return `
        <div class="summary-strip">
            <div class="summary-item">
                <div class="s-label">Emails Sent</div>
                <div class="s-value text-blue">${fmtNum(metrics.totalSent)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Opens</div>
                <div class="s-value text-purple">${fmtNum(metrics.totalOpens)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Replies</div>
                <div class="s-value text-green">${fmtNum(metrics.totalReplies)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Positives</div>
                <div class="s-value text-cyan">${fmtNum(metrics.totalPositive)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Negatives</div>
                <div class="s-value text-red">${fmtNum(metrics.totalNegative)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Conversions</div>
                <div class="s-value text-orange">${fmtNum(metrics.totalConverted)}</div>
            </div>
        </div>
    `;
}

// ============================================================================
// 12. UI COMPONENT: KPI CARDS
// ============================================================================
function renderKPICards(metrics) {
    return `
        <div class="grid grid-4">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Open Rate</span>
                    <div class="card-icon bg-purple text-purple">&#9993;</div>
                </div>
                <div class="kpi-value text-purple">${fmtPct(metrics.openRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalOpens)} opens / ${fmtNum(metrics.totalSent)} sent</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Reply Rate</span>
                    <div class="card-icon bg-green text-green">&#8617;</div>
                </div>
                <div class="kpi-value text-green">${fmtPct(metrics.replyRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalReplies)} replies / ${fmtNum(metrics.totalSent)} sent</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Positive Rate</span>
                    <div class="card-icon bg-cyan text-cyan">&#10003;</div>
                </div>
                <div class="kpi-value text-cyan">${fmtPct(metrics.positiveRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalPositive)} positive / ${fmtNum(metrics.totalReplies)} replies</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Conversion Rate</span>
                    <div class="card-icon bg-orange text-orange">&#127919;</div>
                </div>
                <div class="kpi-value text-orange">${fmtPct(metrics.conversionRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalConverted)} converted / ${fmtNum(metrics.totalReplies)} replies</div>
            </div>
        </div>
        <div class="grid grid-4">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Positive &rarr; Conversion</span>
                    <div class="card-icon bg-yellow text-yellow">&#9733;</div>
                </div>
                <div class="kpi-value text-yellow">${fmtPct(metrics.positiveConversionRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalConverted)} converted / ${fmtNum(metrics.totalPositive)} positive</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Negative Ratio</span>
                    <div class="card-icon bg-red text-red">&#10007;</div>
                </div>
                <div class="kpi-value text-red">${fmtPct(metrics.negativeRatio)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalNegative)} neg / ${fmtNum(metrics.totalPositive + metrics.totalNegative)} pos+neg</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Complex Rate</span>
                    <div class="card-icon bg-yellow text-yellow">&#9888;</div>
                </div>
                <div class="kpi-value text-yellow">${fmtPct(metrics.complexRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalComplex)} complex / ${fmtNum(metrics.totalReplies)} replies</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Engagement Rate</span>
                    <div class="card-icon bg-indigo text-indigo">&#9679;</div>
                </div>
                <div class="kpi-value text-indigo">${fmtPct(metrics.engagementRate)}</div>
                <div class="kpi-sub">(Opens + Replies) / Sent</div>
            </div>
        </div>
    `;
}

// ============================================================================
// 13. UI COMPONENT: ENGAGEMENT FUNNEL
// ============================================================================
function renderFunnelHTML(metrics) {
    const steps = [
        { label: 'Sent', value: metrics.totalSent, color: 'var(--accent-blue)' },
        { label: 'Opened', value: metrics.totalOpens, color: 'var(--accent-purple)' },
        { label: 'Replied', value: metrics.totalReplies, color: 'var(--accent-green)' },
        { label: 'Positive', value: metrics.totalPositive, color: 'var(--accent-cyan)' },
        { label: 'Converted', value: metrics.totalConverted, color: 'var(--accent-orange)' },
    ];

    const maxVal = Math.max(steps[0].value, 1);

    return steps.map((s, i) => {
        const widthPct = Math.max((s.value / maxVal) * 100, 6);
        const rate = i === 0 ? '' : fmtPct(safeDivide(s.value, steps[i - 1].value));
        return `
            <div class="funnel-step">
                <div class="funnel-label">${s.label}</div>
                <div class="funnel-bar-wrap">
                    <div class="funnel-bar" style="width:${widthPct}%;background:${s.color};">${fmtNum(s.value)}</div>
                </div>
                <div class="funnel-rate">${rate}</div>
            </div>
        `;
    }).join('');
}

// ============================================================================
// 14. UI COMPONENT: SENTIMENT BREAKDOWN
// ============================================================================
function renderSentimentHTML(metrics) {
    const total = metrics.totalPositive + metrics.totalNegative + metrics.totalComplex;

    return `
        <div class="sentiment-pills">
            <div class="pill pill-positive">
                <div class="pill-count">${fmtNum(metrics.totalPositive)}</div>
                <div class="pill-label">Positive</div>
                <div class="pill-rate">${fmtPct(safeDivide(metrics.totalPositive, total))}</div>
            </div>
            <div class="pill pill-negative">
                <div class="pill-count">${fmtNum(metrics.totalNegative)}</div>
                <div class="pill-label">Negative</div>
                <div class="pill-rate">${fmtPct(safeDivide(metrics.totalNegative, total))}</div>
            </div>
            <div class="pill pill-complex">
                <div class="pill-count">${fmtNum(metrics.totalComplex)}</div>
                <div class="pill-label">Complex</div>
                <div class="pill-rate">${fmtPct(safeDivide(metrics.totalComplex, total))}</div>
            </div>
        </div>
        <div style="margin-top: 16px;">
            <div class="chart-container sm">
                <canvas id="chart-sentiment-donut"></canvas>
            </div>
        </div>
    `;
}

function renderSentimentChart(metrics) {
    Charts.create('chart-sentiment-donut', {
        type: 'doughnut',
        data: {
            labels: ['Positive', 'Negative', 'Complex'],
            datasets: [{
                data: [metrics.totalPositive, metrics.totalNegative, metrics.totalComplex],
                backgroundColor: ['#34d399', '#f87171', '#fbbf24'],
                borderWidth: 0,
                hoverOffset: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
                legend: { position: 'bottom', labels: { padding: 12 } },
            },
        },
    });
}

// ============================================================================
// 15. UI COMPONENT: TIME SERIES CHARTS
// ============================================================================
function renderTrendsCharts(records) {
    const trends = MetricsCalc.computeTrends(records);
    if (trends.length === 0) return;

    // Volume over time (bar)
    Charts.create('chart-volume-time', {
        type: 'bar',
        data: {
            labels: trends.map(t => t.label),
            datasets: [
                {
                    label: 'Sent',
                    data: trends.map(t => t.metrics.totalSent),
                    backgroundColor: colorWithAlpha('#4f8df5', 0.6),
                },
                {
                    label: 'Opens',
                    data: trends.map(t => t.metrics.totalOpens),
                    backgroundColor: colorWithAlpha('#a78bfa', 0.5),
                },
                {
                    label: 'Replies',
                    data: trends.map(t => t.metrics.totalReplies),
                    backgroundColor: colorWithAlpha('#34d399', 0.5),
                },
                {
                    label: 'Conversions',
                    data: trends.map(t => t.metrics.totalConverted),
                    backgroundColor: colorWithAlpha('#fb923c', 0.6),
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true, grid: { color: 'rgba(35,40,66,0.4)' } },
            },
            plugins: { legend: { position: 'top' } },
        },
    });

    // Rates over time (line)
    Charts.create('chart-rates-time', {
        type: 'line',
        data: {
            labels: trends.map(t => t.label),
            datasets: [
                {
                    label: 'Open Rate',
                    data: trends.map(t => (t.metrics.openRate * 100).toFixed(1)),
                    borderColor: '#a78bfa',
                    backgroundColor: colorWithAlpha('#a78bfa', 0.06),
                    fill: true, tension: 0.35, pointRadius: 4, pointHoverRadius: 6,
                    pointBackgroundColor: '#a78bfa', borderWidth: 2.5,
                },
                {
                    label: 'Reply Rate',
                    data: trends.map(t => (t.metrics.replyRate * 100).toFixed(1)),
                    borderColor: '#34d399',
                    backgroundColor: colorWithAlpha('#34d399', 0.06),
                    fill: true, tension: 0.35, pointRadius: 4, pointHoverRadius: 6,
                    pointBackgroundColor: '#34d399', borderWidth: 2.5,
                },
                {
                    label: 'Conversion Rate',
                    data: trends.map(t => (t.metrics.conversionRate * 100).toFixed(1)),
                    borderColor: '#fb923c',
                    backgroundColor: colorWithAlpha('#fb923c', 0.06),
                    fill: true, tension: 0.35, pointRadius: 4, pointHoverRadius: 6,
                    pointBackgroundColor: '#fb923c', borderWidth: 2.5,
                },
                {
                    label: 'Positive Rate',
                    data: trends.map(t => (t.metrics.positiveRate * 100).toFixed(1)),
                    borderColor: '#22d3ee',
                    backgroundColor: colorWithAlpha('#22d3ee', 0.04),
                    fill: false, tension: 0.35, pointRadius: 3, pointHoverRadius: 5,
                    pointBackgroundColor: '#22d3ee', borderWidth: 2, borderDash: [5, 3],
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true, grid: { color: 'rgba(35,40,66,0.4)' }, ticks: { callback: v => v + '%' } },
            },
            plugins: { legend: { position: 'top' } },
        },
    });
}

// ============================================================================
// 16. UI COMPONENT: CLIENT COMPARISON (Master only)
// ============================================================================
function renderClientComparisonChart(records) {
    const clients = MetricsCalc.computeClientComparison(records);
    if (clients.length < 2) return;

    Charts.create('chart-client-comparison', {
        type: 'bar',
        data: {
            labels: clients.map(c => c.name),
            datasets: [
                {
                    label: 'Reply Rate %',
                    data: clients.map(c => (c.metrics.replyRate * 100).toFixed(1)),
                    backgroundColor: colorWithAlpha('#34d399', 0.6),
                },
                {
                    label: 'Open Rate %',
                    data: clients.map(c => (c.metrics.openRate * 100).toFixed(1)),
                    backgroundColor: colorWithAlpha('#a78bfa', 0.5),
                },
                {
                    label: 'Conversion Rate %',
                    data: clients.map(c => (c.metrics.conversionRate * 100).toFixed(1)),
                    backgroundColor: colorWithAlpha('#fb923c', 0.6),
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
                x: { beginAtZero: true, grid: { color: 'rgba(35,40,66,0.4)' }, ticks: { callback: v => v + '%' } },
                y: { grid: { display: false } },
            },
            plugins: { legend: { position: 'top' } },
        },
    });
}

function renderClientComparisonTable(records) {
    const clients = MetricsCalc.computeClientComparison(records);
    if (clients.length === 0) return '';

    // Find best conversion rate for highlighting
    const bestConv = Math.max(...clients.map(c => c.metrics.conversionRate));

    const rows = clients.map(c => {
        const m = c.metrics;
        const isBest = m.conversionRate === bestConv && bestConv > 0;
        return `
            <tr class="${isBest ? 'highlight-row' : ''}">
                <td class="name-col">${escapeHtml(c.name)}</td>
                <td class="num">${fmtNum(m.totalSent)}</td>
                <td class="num">${fmtPct(m.openRate)}</td>
                <td class="num">${fmtPct(m.replyRate)}</td>
                <td class="num" style="color:var(--positive)">${fmtPct(m.positiveRate)}</td>
                <td class="num">${fmtPct(m.conversionRate)}</td>
                <td class="num">${fmtPct(m.positiveConversionRate)}</td>
                <td class="num" style="font-weight:700">${fmtNum(m.totalConverted)}</td>
                <td>${isBest ? '<span class="table-badge badge-best">Top</span>' : ''}</td>
            </tr>
        `;
    }).join('');

    return `
        <table class="data-table">
            <thead>
                <tr>
                    <th>Client</th>
                    <th>Sent</th>
                    <th>Open Rate</th>
                    <th>Reply Rate</th>
                    <th>Positive %</th>
                    <th>Conv. Rate</th>
                    <th>Pos&rarr;Conv</th>
                    <th>Conversions</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// ============================================================================
// 17. UI COMPONENT: DIMENSION PERFORMANCE TABLE
// ============================================================================
function renderDimensionTable(records, accessor, label, labelCol = 'Segment') {
    const groups = MetricsCalc.computeByDimension(records, accessor, label);
    if (groups.length === 0) return '<p style="color:var(--text-muted);font-size:13px;">No data available</p>';

    const bestConv = Math.max(...groups.map(g => g.metrics.conversionRate));

    const rows = groups.map(g => {
        const m = g.metrics;
        const isBest = m.conversionRate === bestConv && bestConv > 0;
        return `
            <tr class="${isBest ? 'highlight-row' : ''}">
                <td class="name-col">${escapeHtml(g.name)}</td>
                <td class="num">${fmtNum(m.totalSent)}</td>
                <td class="num">${fmtPct(m.openRate)}</td>
                <td class="num">${fmtPct(m.replyRate)}</td>
                <td class="num" style="color:var(--positive)">${fmtPct(m.positiveRate)}</td>
                <td class="num">${fmtPct(m.conversionRate)}</td>
                <td class="num" style="font-weight:700">${fmtNum(m.totalConverted)}</td>
            </tr>
        `;
    }).join('');

    return `
        <table class="data-table">
            <thead>
                <tr>
                    <th>${labelCol}</th>
                    <th>Sent</th>
                    <th>Open Rate</th>
                    <th>Reply Rate</th>
                    <th>Positive %</th>
                    <th>Conv. Rate</th>
                    <th>Conversions</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// ============================================================================
// 18. UI COMPONENT: DIMENSION PIE/DONUT CHART
// ============================================================================
function renderDimensionDonut(chartId, records, accessor, metricKey = 'totalReplies') {
    const groups = MetricsCalc.computeByDimension(records, accessor);
    if (groups.length === 0) return;

    Charts.create(chartId, {
        type: 'doughnut',
        data: {
            labels: groups.map(g => g.name),
            datasets: [{
                data: groups.map(g => g.metrics[metricKey]),
                backgroundColor: groups.map((_, i) => colorForIndex(i)),
                borderWidth: 0,
                hoverOffset: 6,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: { position: 'bottom', labels: { padding: 10, font: { size: 11 } } },
            },
        },
    });
}

// ============================================================================
// 19. UI COMPONENT: HOURLY PERFORMANCE
// ============================================================================
function renderHourlyChart(records) {
    const byHour = {};
    records.forEach(r => {
        if (r._hour === undefined) return;
        const h = Math.floor(r._hour);
        if (h < 0 || h > 23) return;
        if (!byHour[h]) byHour[h] = [];
        byHour[h].push(r);
    });

    const hours = [];
    for (let h = 0; h <= 23; h++) {
        const recs = byHour[h] || [];
        const m = MetricsCalc.compute(recs);
        hours.push({ hour: h, label: `${h}:00`, replyRate: m.replyRate * 100, count: recs.length });
    }

    const maxRate = Math.max(...hours.map(h => h.replyRate), 1);

    Charts.create('chart-hourly', {
        type: 'bar',
        data: {
            labels: hours.map(h => h.label),
            datasets: [{
                label: 'Reply Rate %',
                data: hours.map(h => h.replyRate.toFixed(2)),
                backgroundColor: hours.map(h =>
                    h.replyRate > maxRate * 0.7 ? colorWithAlpha('#34d399', 0.6) :
                    h.replyRate > maxRate * 0.3 ? colorWithAlpha('#4f8df5', 0.5) :
                    colorWithAlpha('#f87171', 0.3)
                ),
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true, grid: { color: 'rgba(35,40,66,0.4)' }, ticks: { callback: v => v + '%' } },
            },
            plugins: { legend: { display: false } },
        },
    });
}

// ============================================================================
// 20. UI COMPONENT: TEAM LEADER PERFORMANCE
// ============================================================================
function renderTeamLeaderTable(records) {
    return renderDimensionTable(records, r => r._teamLeader, 'teamLeader', 'Team Leader');
}

// ============================================================================
// 21. MASTER DASHBOARD RENDERER
// ============================================================================
function renderMasterDashboard() {
    const { filteredRecords } = Store.state;
    const metrics = MetricsCalc.compute(filteredRecords);
    const content = document.getElementById('dashboard-content');

    Charts.destroyAll();

    // Count distinct client sheets represented in the filtered data
    const activeClientSheets = new Set(filteredRecords.map(r => r._sheet));
    const clientCount = activeClientSheets.size;
    const dateRange = getDateRangeLabel(filteredRecords);

    let html = `<div class="fade-in">`;

    // Header section
    html += `
        <div style="margin-bottom: 20px;">
            <h2 class="section-title" style="font-size: 20px; margin-bottom: 4px;">Master Dashboard</h2>
            <p style="font-size: 13px; color: var(--text-secondary);">
                Aggregated across <strong>${clientCount}</strong> client${clientCount !== 1 ? 's' : ''}
                ${dateRange ? ` &mdash; ${dateRange}` : ''}
                &mdash; ${fmtNum(filteredRecords.length)} records
            </p>
        </div>
    `;

    // Summary strip
    html += renderSummaryStrip(metrics);

    // KPI cards (2 rows of 4)
    html += renderKPICards(metrics);

    // Funnel + Sentiment
    html += `
        <div class="grid grid-2">
            <div class="card">
                <div class="card-header"><span class="card-title">Engagement Funnel</span></div>
                ${renderFunnelHTML(metrics)}
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">Reply Sentiment</span></div>
                ${renderSentimentHTML(metrics)}
            </div>
        </div>
    `;

    // Time Series: Volume + Rates
    html += `
        <h3 class="section-title">Trends Over Time</h3>
        <div class="grid grid-2">
            <div class="card">
                <div class="card-header"><span class="card-title">Volume by Month</span></div>
                <div class="chart-container md"><canvas id="chart-volume-time"></canvas></div>
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">Rates by Month</span></div>
                <div class="chart-container md"><canvas id="chart-rates-time"></canvas></div>
            </div>
        </div>
    `;

    // Client Comparison (master only)
    const clientGroups = MetricsCalc.computeClientComparison(filteredRecords);
    if (clientGroups.length > 1) {
        html += `
            <h3 class="section-title">Client Comparison</h3>
            <div class="grid grid-3-2">
                <div class="card">
                    <div class="card-header"><span class="card-title">Client Performance Table</span></div>
                    ${renderClientComparisonTable(filteredRecords)}
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">Rates by Client</span></div>
                    <div class="chart-container lg"><canvas id="chart-client-comparison"></canvas></div>
                </div>
            </div>
        `;
    }

    // Target Audience
    const audienceGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._targetAudience);
    if (audienceGroups.length > 0 && audienceGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Target Audience Performance</h3>
            <div class="grid grid-3-2">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Audience</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._targetAudience, 'audience', 'Target Audience')}
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">Reply Distribution by Audience</span></div>
                    <div class="chart-container md" style="display:flex;align-items:center;justify-content:center;">
                        <canvas id="chart-audience-donut"></canvas>
                    </div>
                </div>
            </div>
        `;
    }

    // Campaign Type Performance
    const typeGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._type);
    if (typeGroups.length > 0 && typeGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Campaign Type Performance</h3>
            <div class="grid grid-3-2">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Type</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._type, 'type', 'Type')}
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">Sent Distribution by Type</span></div>
                    <div class="chart-container md" style="display:flex;align-items:center;justify-content:center;">
                        <canvas id="chart-type-donut"></canvas>
                    </div>
                </div>
            </div>
        `;
    }

    // Hourly Performance
    const hasHourData = filteredRecords.some(r => r._hour > 0);
    if (hasHourData) {
        html += `
            <h3 class="section-title">Additional Insights</h3>
            <div class="grid grid-2">
                <div class="card">
                    <div class="card-header"><span class="card-title">Reply Rate by Hour</span></div>
                    <div class="chart-container md"><canvas id="chart-hourly"></canvas></div>
                </div>
        `;
    } else {
        html += `
            <h3 class="section-title">Additional Insights</h3>
            <div class="grid grid-2">
        `;
    }

    // Team Leader Performance
    const teamGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._teamLeader);
    if (teamGroups.length > 0 && teamGroups[0].name !== 'Unknown') {
        html += `
                <div class="card">
                    <div class="card-header"><span class="card-title">Team Leader Performance</span></div>
                    ${renderTeamLeaderTable(filteredRecords)}
                </div>
            </div>
        `;
    } else {
        html += `</div>`;
    }

    // Copy Used Performance
    const copyGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._copyUsed);
    if (copyGroups.length > 1 && copyGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Email Copy Performance</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">A/B Performance by Copy Variant</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._copyUsed, 'copyUsed', 'Copy Variant')}
                </div>
            </div>
        `;
    }

    // Subject Line Performance
    const subjectGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._subjectLine);
    if (subjectGroups.length > 1 && subjectGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Subject Line Performance</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Subject Line</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._subjectLine, 'subjectLine', 'Subject Line')}
                </div>
            </div>
        `;
    }

    html += `</div>`;
    content.innerHTML = html;

    // Render charts after DOM is updated
    requestAnimationFrame(() => {
        renderSentimentChart(metrics);
        renderTrendsCharts(filteredRecords);
        if (clientGroups.length > 1) renderClientComparisonChart(filteredRecords);
        if (audienceGroups.length > 0 && audienceGroups[0].name !== 'Unknown') {
            renderDimensionDonut('chart-audience-donut', filteredRecords, r => r._targetAudience);
        }
        if (typeGroups.length > 0 && typeGroups[0].name !== 'Unknown') {
            renderDimensionDonut('chart-type-donut', filteredRecords, r => r._type, 'totalSent');
        }
        if (hasHourData) renderHourlyChart(filteredRecords);
    });
}

// ============================================================================
// 22. CLIENT DASHBOARD RENDERER
// ============================================================================
function renderClientDashboard() {
    const { filteredRecords, currentClient } = Store.state;
    const metrics = MetricsCalc.compute(filteredRecords);
    const content = document.getElementById('dashboard-content');

    Charts.destroyAll();

    const dateRange = getDateRangeLabel(filteredRecords);
    const clientColor = colorForIndex(hashString(currentClient || '') % CONFIG.COLORS.length);
    const initials = (currentClient || 'C').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

    let html = `<div class="fade-in">`;

    // Client header
    html += `
        <div class="client-header">
            <div class="client-avatar" style="background: ${colorWithAlpha(clientColor, 0.2)}; color: ${clientColor};">
                ${initials}
            </div>
            <div class="client-info">
                <h2>${escapeHtml(currentClient || 'Client')}</h2>
                <p>${fmtNum(filteredRecords.length)} records${dateRange ? ` &mdash; ${dateRange}` : ''}</p>
            </div>
        </div>
    `;

    // Summary strip
    html += renderSummaryStrip(metrics);

    // KPI cards
    html += renderKPICards(metrics);

    // Funnel + Sentiment
    html += `
        <div class="grid grid-2">
            <div class="card">
                <div class="card-header"><span class="card-title">Engagement Funnel</span></div>
                ${renderFunnelHTML(metrics)}
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">Reply Sentiment</span></div>
                ${renderSentimentHTML(metrics)}
            </div>
        </div>
    `;

    // Trends
    html += `
        <h3 class="section-title">Trends Over Time</h3>
        <div class="grid grid-2">
            <div class="card">
                <div class="card-header"><span class="card-title">Volume by Month</span></div>
                <div class="chart-container md"><canvas id="chart-volume-time"></canvas></div>
            </div>
            <div class="card">
                <div class="card-header"><span class="card-title">Rates by Month</span></div>
                <div class="chart-container md"><canvas id="chart-rates-time"></canvas></div>
            </div>
        </div>
    `;

    // Target Audience
    const audienceGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._targetAudience);
    if (audienceGroups.length > 0 && audienceGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Target Audience Performance</h3>
            <div class="grid grid-3-2">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Audience</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._targetAudience, 'audience', 'Target Audience')}
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">Audience Distribution</span></div>
                    <div class="chart-container md" style="display:flex;align-items:center;justify-content:center;">
                        <canvas id="chart-audience-donut"></canvas>
                    </div>
                </div>
            </div>
        `;
    }

    // Campaign Type
    const typeGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._type);
    if (typeGroups.length > 0 && typeGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Campaign Type Performance</h3>
            <div class="grid grid-3-2">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Type</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._type, 'type', 'Type')}
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">Type Distribution</span></div>
                    <div class="chart-container md" style="display:flex;align-items:center;justify-content:center;">
                        <canvas id="chart-type-donut"></canvas>
                    </div>
                </div>
            </div>
        `;
    }

    // Subject Line Performance
    const subjectGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._subjectLine);
    if (subjectGroups.length > 1 && subjectGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Subject Line Performance</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Subject Line</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._subjectLine, 'subjectLine', 'Subject Line')}
                </div>
            </div>
        `;
    }

    // Copy Used Performance
    const copyGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._copyUsed);
    if (copyGroups.length > 1 && copyGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Email Copy Performance</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Copy</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._copyUsed, 'copyUsed', 'Copy Variant')}
                </div>
            </div>
        `;
    }

    // Additional insights row
    const hasHourData = filteredRecords.some(r => r._hour > 0);
    const teamGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._teamLeader);
    const hasTeamData = teamGroups.length > 0 && teamGroups[0].name !== 'Unknown';

    if (hasHourData || hasTeamData) {
        html += `<h3 class="section-title">Additional Insights</h3><div class="grid grid-2">`;
        if (hasHourData) {
            html += `
                <div class="card">
                    <div class="card-header"><span class="card-title">Reply Rate by Hour</span></div>
                    <div class="chart-container md"><canvas id="chart-hourly"></canvas></div>
                </div>
            `;
        }
        if (hasTeamData) {
            html += `
                <div class="card">
                    <div class="card-header"><span class="card-title">Team Leader Performance</span></div>
                    ${renderTeamLeaderTable(filteredRecords)}
                </div>
            `;
        }
        html += `</div>`;
    }

    // Goal tracking
    const goalGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._goal);
    if (goalGroups.length > 0 && goalGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Goal Tracking</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Goal</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._goal, 'goal', 'Goal')}
                </div>
            </div>
        `;
    }

    html += `</div>`;
    content.innerHTML = html;

    // Render charts
    requestAnimationFrame(() => {
        renderSentimentChart(metrics);
        renderTrendsCharts(filteredRecords);
        if (audienceGroups.length > 0 && audienceGroups[0].name !== 'Unknown') {
            renderDimensionDonut('chart-audience-donut', filteredRecords, r => r._targetAudience);
        }
        if (typeGroups.length > 0 && typeGroups[0].name !== 'Unknown') {
            renderDimensionDonut('chart-type-donut', filteredRecords, r => r._type, 'totalSent');
        }
        if (hasHourData) renderHourlyChart(filteredRecords);
    });
}

// ============================================================================
// 23. HELPER: DATE RANGE LABEL
// ============================================================================
function getDateRangeLabel(records) {
    let min = null, max = null;
    records.forEach(r => {
        if (!r._date) return;
        if (!min || r._date < min) min = r._date;
        if (!max || r._date > max) max = r._date;
    });
    if (!min || !max) return '';
    return `${formatDate(min)} &ndash; ${formatDate(max)}`;
}

// ============================================================================
// 24. TOAST NOTIFICATIONS
// ============================================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================================================
// 25. MAIN RENDER ORCHESTRATOR
// ============================================================================
const renderDashboard = debounce(() => {
    const { currentView, filteredRecords, dataLoaded } = Store.state;

    if (!dataLoaded) return;

    // Show/hide empty state
    const emptyEl = document.getElementById('empty-state');
    const contentEl = document.getElementById('dashboard-content');

    if (filteredRecords.length === 0) {
        emptyEl?.classList.remove('hidden');
        contentEl?.classList.add('hidden');
        return;
    }

    emptyEl?.classList.add('hidden');
    contentEl?.classList.remove('hidden');

    // Render appropriate view
    if (currentView === 'master') {
        renderMasterDashboard();
    } else {
        renderClientDashboard();
    }

    // Update navigation and filters
    renderNavigation();
    renderFilterBar();
}, 50);

// ============================================================================
// 26. INITIALIZATION & DATA LOADING
// ============================================================================
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

        // Parse all data (non-client sheets are automatically excluded by header validation)
        const { allRecords, clientMap } = DataEngine.parseAll(allSheetData);
        const filterOptions = DataEngine.getFilterOptions(allRecords, clientMap);

        // Update store
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

        // Update UI state
        loadingEl?.classList.add('hidden');
        contentEl?.classList.remove('hidden');

        const statusBadge = document.getElementById('data-status');
        if (statusBadge) {
            statusBadge.textContent = `${Object.keys(clientMap).length} clients`;
            statusBadge.classList.add('connected');
        }

        // Initial render
        renderNavigation();
        renderFilterBar();
        renderDashboard();

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

function init() {
    setupChartDefaults();

    const setupOverlay = document.getElementById('setup-overlay');
    const appEl = document.getElementById('app');
    const apiKeyInput = document.getElementById('input-api-key');
    const spreadsheetIdInput = document.getElementById('input-spreadsheet-id');
    const connectBtn = document.getElementById('btn-connect');
    const setupError = document.getElementById('setup-error');

    // Pre-fill from storage
    apiKeyInput.value = Store.state.apiKey;
    spreadsheetIdInput.value = Store.state.spreadsheetId;

    // Connect button handler
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
            // Test connection by fetching metadata
            await SheetsAPI.getSpreadsheetMeta(apiKey, spreadsheetId);

            // Save credentials
            localStorage.setItem('dashboard_api_key', apiKey);
            localStorage.setItem('dashboard_spreadsheet_id', spreadsheetId);
            Store.update({ apiKey, spreadsheetId });

            // Show app
            setupOverlay.classList.add('hidden');
            appEl.classList.remove('hidden');

            // Load data
            await loadData(apiKey, spreadsheetId);

        } catch (err) {
            setupError.textContent = `Connection failed: ${err.message}`;
            setupError.classList.remove('hidden');
            connectBtn.querySelector('.btn-text').textContent = 'Connect & Load Data';
            connectBtn.querySelector('.btn-spinner')?.classList.add('hidden');
            connectBtn.disabled = false;
        }
    });

    // Auto-connect if we have saved credentials
    if (Store.state.apiKey && Store.state.spreadsheetId) {
        setupOverlay.classList.add('hidden');
        appEl.classList.remove('hidden');
        loadData(Store.state.apiKey, Store.state.spreadsheetId);
    }

    // Refresh button
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
        if (Store.state.apiKey && Store.state.spreadsheetId) {
            loadData(Store.state.apiKey, Store.state.spreadsheetId);
        }
    });

    // Settings button (show setup)
    document.getElementById('btn-settings')?.addEventListener('click', () => {
        appEl.classList.add('hidden');
        setupOverlay.classList.remove('hidden');
        connectBtn.querySelector('.btn-text').textContent = 'Connect & Load Data';
        connectBtn.querySelector('.btn-spinner')?.classList.add('hidden');
        connectBtn.disabled = false;
    });

    // Retry button
    document.getElementById('btn-retry')?.addEventListener('click', () => {
        if (Store.state.apiKey && Store.state.spreadsheetId) {
            loadData(Store.state.apiKey, Store.state.spreadsheetId);
        }
    });

    // Reset filters button (in empty state)
    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
        Store.resetFilters();
    });

    // Subscribe to state changes for re-rendering
    Store.subscribe(() => {
        renderDashboard();
    });
}

// Boot
document.addEventListener('DOMContentLoaded', init);
