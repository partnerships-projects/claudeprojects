// ============================================================================
// AUTO-REFRESH ENGINE
//
// Two-phase architecture designed to be server-ready:
//
// PHASE 1 — Change detection (TODAY vs FUTURE)
//   TODAY:  Polls Google Drive API every 30s for the spreadsheet's
//           modifiedTime. Cost: 1 tiny API call when nothing changed
//           (instead of fetching all 57 sheets every time).
//   FUTURE: This phase is entirely replaced by an SSE connection to our
//           server. The server uses an Apps Script onEdit trigger to detect
//           which sheet changed and pushes the event to the browser.
//           When that happens, start() opens the SSE stream instead of a
//           timer, and applyRefresh() is called directly on each event.
//
// PHASE 2 — Data fetch + store update (STAYS IDENTICAL)
//   applyRefresh() fetches fresh data and updates the store.
//   This method does NOT change when we move to the server.
// ============================================================================
const AutoRefresh = {
    _timerId: null,
    _lastFingerprint: null,
    _lastModifiedTime: null,  // Drive API timestamp from Phase 1
    _isRefreshing: false,     // prevents overlapping fetches

    // -------------------------------------------------------------------------
    // PHASE 1: Lightweight change detection — 1 API call per poll tick
    // -------------------------------------------------------------------------
    async checkForChanges() {
        const { apiKey, spreadsheetId } = Store.state;
        if (!apiKey || !spreadsheetId) return;

        try {
            const modifiedTime = await SheetsAPI.getModifiedTime(apiKey, spreadsheetId);

            if (modifiedTime && modifiedTime === this._lastModifiedTime) {
                // Nothing changed — skip the expensive full fetch entirely
                this._updateStatusTime();
                console.log('[AutoRefresh] No changes (modifiedTime unchanged)');
                return;
            }

            // Something changed — record the new timestamp and do a full refresh
            console.log('[AutoRefresh] Change detected via Drive API — fetching data');
            this._lastModifiedTime = modifiedTime;
            await this.applyRefresh();

        } catch (err) {
            // Drive API not enabled or quota exceeded — fall back to full refresh
            // so the dashboard still updates even without the Drive API.
            console.warn('[AutoRefresh] Drive API check failed, falling back to full refresh:', err.message);
            await this.applyRefresh();
        }
    },

    // -------------------------------------------------------------------------
    // PHASE 2: Full data fetch + store update
    // This method is called by checkForChanges() today.
    // FUTURE: Called directly by the SSE event handler when the server pushes
    //         a "sheet changed" notification. No other changes needed here.
    // -------------------------------------------------------------------------
    async applyRefresh() {
        if (this._isRefreshing) {
            console.log('[AutoRefresh] Previous refresh still running — skipping');
            return;
        }

        this._isRefreshing = true;

        try {
            const { apiKey, spreadsheetId } = Store.state;
            const { spreadsheetTitle, sheetNames, allSheetData } = await SheetsAPI.fetchAll(
                apiKey, spreadsheetId, null
            );
            const { allRecords, clientMap } = DataEngine.parseAll(allSheetData);

            // Guard 1: never overwrite good data with an empty result
            const currentRecordCount = Store.state.allRecords.length;
            if (allRecords.length === 0 && currentRecordCount > 0) {
                console.warn('[AutoRefresh] Fetch returned 0 records — keeping existing data');
                this._updateStatusTime();
                return;
            }

            // Guard 2: skip if client count dropped below 50% (partial/rate-limited fetch)
            const currentClientCount = Object.keys(Store.state.clientMap).length;
            const newClientCount = Object.keys(clientMap).length;
            if (currentClientCount > 0 && newClientCount < currentClientCount * 0.5) {
                console.warn(`[AutoRefresh] Degraded data (${newClientCount}/${currentClientCount} clients) — keeping existing data`);
                this._updateStatusTime();
                return;
            }

            const newFingerprint = this.fingerprint(allRecords, clientMap);
            this._updateStatusTime();

            if (newFingerprint === this._lastFingerprint) {
                console.log('[AutoRefresh] Fingerprint unchanged after fetch');
                return;
            }

            console.log('[AutoRefresh] Applying updated data to dashboard');
            this._lastFingerprint = newFingerprint;

            const filterOptions = DataEngine.getFilterOptions(allRecords, clientMap);
            let { currentView, currentClient, filters } = Store.state;

            // Guard 3: if the active client view has no data in the new fetch, fall back to master.
            // We fold the view change into the single Store.update() below to avoid a double render.
            const viewOverride = {};
            if (currentView === 'client' && currentClient) {
                const clientHasData = allRecords.some(r => r._sheet === currentClient);
                if (!clientHasData) {
                    console.warn(`[AutoRefresh] Client "${currentClient}" has no data in refresh — switching to master`);
                    currentView = 'master';
                    currentClient = null;
                    viewOverride.currentView = 'master';
                    viewOverride.currentClient = null;
                }
            }

            // Store.update() triggers the subscriber in app.js → renderDashboard()
            Store.update({
                spreadsheetTitle,
                sheetNames,
                allRecords,
                filteredRecords: FilterEngine.apply(allRecords, filters, currentView, currentClient),
                clientMap,
                filterOptions,
                dataLoaded: true,
                ...viewOverride,
            });

            showToast('Data updated automatically', 'success');
        } catch (err) {
            console.warn('[AutoRefresh] Refresh failed:', err.message);
        } finally {
            this._isRefreshing = false;
        }
    },

    // -------------------------------------------------------------------------
    // Fingerprint — detects data changes to avoid unnecessary re-renders
    // -------------------------------------------------------------------------
    fingerprint(allRecords, clientMap) {
        const parts = [allRecords.length];
        for (const [name, count] of Object.entries(clientMap).sort()) {
            parts.push(`${name}:${count}`);
        }
        const sent     = allRecords.reduce((s, r) => s + r._emailSent, 0);
        const replies  = allRecords.reduce((s, r) => s + r._replies, 0);
        const converted = allRecords.reduce((s, r) => s + r._converted, 0);
        parts.push(`s${sent}r${replies}c${converted}`);
        return parts.join('|');
    },

    setFingerprint(allRecords, clientMap) {
        this._lastFingerprint = this.fingerprint(allRecords, clientMap);
    },

    _updateStatusTime() {
        const el = document.getElementById('auto-refresh-time');
        if (el) {
            el.textContent = `Checked ${new Date().toLocaleTimeString()}`;
        }
    },

    // -------------------------------------------------------------------------
    // Lifecycle — start() and stop()
    // FUTURE: start() will open an SSE connection to the server instead of
    //         setting a polling interval. stop() will close the SSE stream.
    // -------------------------------------------------------------------------
    start() {
        this.stop();
        if (CONFIG.AUTO_REFRESH_INTERVAL <= 0) return;
        console.log(`[AutoRefresh] Polling Drive API every ${CONFIG.AUTO_REFRESH_INTERVAL / 1000}s`);
        this._timerId = setInterval(() => this.checkForChanges(), CONFIG.AUTO_REFRESH_INTERVAL);
    },

    stop() {
        if (this._timerId) {
            clearInterval(this._timerId);
            this._timerId = null;
        }
    },
};
