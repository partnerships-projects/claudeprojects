// ============================================================================
// AUTO-REFRESH ENGINE — Poll for changes and update dashboard
// ============================================================================
const AutoRefresh = {
    _timerId: null,
    _lastFingerprint: null,
    _isRefreshing: false,   // prevents overlapping fetches

    fingerprint(allRecords, clientMap) {
        const parts = [allRecords.length];
        for (const [name, count] of Object.entries(clientMap).sort()) {
            parts.push(`${name}:${count}`);
        }
        const sent = allRecords.reduce((s, r) => s + r._emailSent, 0);
        const replies = allRecords.reduce((s, r) => s + r._replies, 0);
        const converted = allRecords.reduce((s, r) => s + r._converted, 0);
        parts.push(`s${sent}r${replies}c${converted}`);
        return parts.join('|');
    },

    setFingerprint(allRecords, clientMap) {
        this._lastFingerprint = this.fingerprint(allRecords, clientMap);
    },

    async silentRefresh() {
        const { apiKey, spreadsheetId } = Store.state;
        if (!apiKey || !spreadsheetId) return;

        // Prevent overlapping fetches (e.g. 57 sheets taking > 30s)
        if (this._isRefreshing) {
            console.log('[AutoRefresh] Previous refresh still running — skipping');
            return;
        }

        this._isRefreshing = true;

        try {
            const { spreadsheetTitle, sheetNames, allSheetData } = await SheetsAPI.fetchAll(
                apiKey, spreadsheetId, null
            );
            const { allRecords, clientMap } = DataEngine.parseAll(allSheetData);

            // Safety guard: never replace good data with empty/degraded data.
            // If the new fetch returns no records but we currently have data,
            // it means something went wrong (rate limit, network blip) — skip.
            const currentRecordCount = Store.state.allRecords.length;
            if (allRecords.length === 0 && currentRecordCount > 0) {
                console.warn('[AutoRefresh] Fetch returned 0 records — keeping existing data');
                this._updateStatusTime();
                return;
            }

            const newFingerprint = this.fingerprint(allRecords, clientMap);

            this._updateStatusTime();

            if (newFingerprint === this._lastFingerprint) {
                console.log('[AutoRefresh] No changes detected');
                return;
            }

            console.log('[AutoRefresh] Changes detected — updating dashboard');
            this._lastFingerprint = newFingerprint;

            const filterOptions = DataEngine.getFilterOptions(allRecords, clientMap);
            const { currentView, currentClient, filters } = Store.state;

            // Store.update() triggers the subscriber in app.js which calls
            // renderDashboard(). Do NOT call render functions manually here
            // to avoid double-rendering.
            Store.update({
                spreadsheetTitle,
                sheetNames,
                allRecords,
                filteredRecords: FilterEngine.apply(allRecords, filters, currentView, currentClient),
                clientMap,
                filterOptions,
                dataLoaded: true,
            });

            showToast('Data updated automatically', 'success');
        } catch (err) {
            console.warn('[AutoRefresh] Silent refresh failed:', err.message);
        } finally {
            this._isRefreshing = false;
        }
    },

    _updateStatusTime() {
        const el = document.getElementById('auto-refresh-time');
        if (el) {
            const now = new Date();
            el.textContent = `Updated ${now.toLocaleTimeString()}`;
        }
    },

    start() {
        this.stop();
        if (CONFIG.AUTO_REFRESH_INTERVAL <= 0) return;
        console.log(`[AutoRefresh] Polling every ${CONFIG.AUTO_REFRESH_INTERVAL / 1000}s`);
        this._timerId = setInterval(() => this.silentRefresh(), CONFIG.AUTO_REFRESH_INTERVAL);
    },

    stop() {
        if (this._timerId) {
            clearInterval(this._timerId);
            this._timerId = null;
        }
    },
};
