// ============================================================================
// DATA ENGINE — Parse raw sheet data into normalized records
// ============================================================================
const DataEngine = {
    // Normalize a raw header string for matching against COLUMN_MAP.
    normalizeHeader(raw) {
        return String(raw || '')
            .replace(/[\u00A0\u200B\u2003\u2002\u2009]/g, ' ')
            .replace(/\s+/g, ' ')
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
    isValidClientSheet(rawHeaders) {
        const mapped = this.mapHeaders(rawHeaders);
        const recognized = mapped.filter(f => f !== null).length;
        return recognized >= CONFIG.MIN_VALID_HEADERS;
    },

    // Check if a value looks like a summary/total row marker
    _isSummaryValue(val) {
        if (val === null || val === undefined || val === '') return false;
        const s = String(val).trim().toUpperCase();
        return CONFIG.SUMMARY_ROW_KEYWORDS.includes(s);
    },

    // Parse a single sheet's raw data into typed records
    parseSheet(rawRows, sheetName) {
        if (!rawRows || rawRows.length < 2) return [];

        const rawHeaders = rawRows[0];

        if (!this.isValidClientSheet(rawHeaders)) {
            console.log(`[Dashboard] Skipping sheet "${sheetName}": only ${this.mapHeaders(rawHeaders).filter(f=>f).length} recognized columns (need ${CONFIG.MIN_VALID_HEADERS})`);
            return [];
        }

        const fieldMap = this.mapHeaders(rawHeaders);
        const colCount = fieldMap.length;

        // Diagnostic: log column mapping
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

        const monthIdx = fieldMap.indexOf('month');
        const dateIdx = fieldMap.indexOf('date');

        const records = [];
        let skippedSummaryRows = 0;

        for (let i = 1; i < rawRows.length; i++) {
            const row = rawRows[i];
            if (!row || row.length === 0) continue;

            // Summary / total row detection
            const monthVal = monthIdx >= 0 ? row[monthIdx] : null;
            const dateVal = dateIdx >= 0 ? row[dateIdx] : null;
            if (this._isSummaryValue(monthVal) || this._isSummaryValue(dateVal)) {
                skippedSummaryRows++;
                continue;
            }

            if (row[0] !== undefined && row[0] !== null && this._isSummaryValue(row[0])) {
                skippedSummaryRows++;
                continue;
            }

            const record = { _sheet: sheetName };
            let hasData = false;

            for (let idx = 0; idx < colCount; idx++) {
                const field = fieldMap[idx];
                if (field && row[idx] !== undefined && row[idx] !== null && row[idx] !== '') {
                    record[field] = row[idx];
                    hasData = true;
                }
            }

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
    getFilterOptions(records, clientMap) {
        const types = new Set();
        const audiences = new Set();
        const owners = new Set();
        let minDate = null;
        let maxDate = null;

        records.forEach(r => {
            if (r._type) types.add(r._type);
            if (r._targetAudience) audiences.add(r._targetAudience);
            if (r._teamLeader) owners.add(r._teamLeader);
            if (r._cs) owners.add(r._cs);
            if (r._date) {
                if (!minDate || r._date < minDate) minDate = r._date;
                if (!maxDate || r._date > maxDate) maxDate = r._date;
            }
        });

        return {
            clients: Object.keys(clientMap).sort(),
            types: [...types].sort(),
            audiences: [...audiences].sort(),
            owners: [...owners].sort(),
            minDate,
            maxDate,
        };
    },
};
