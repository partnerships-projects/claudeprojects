// ============================================================================
// GOOGLE SHEETS API — Fetch spreadsheet metadata and data
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
