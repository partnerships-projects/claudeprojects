// ============================================================================
// MASTER DASHBOARD RENDERER
// ============================================================================
function renderMasterDashboard() {
    const { filteredRecords } = Store.state;
    const metrics = MetricsCalc.compute(filteredRecords);
    const content = document.getElementById('dashboard-content');

    Charts.destroyAll();

    const activeClientSheets = new Set(filteredRecords.map(r => r._sheet));
    const clientCount = activeClientSheets.size;
    const dateRange = getDateRangeLabel(filteredRecords);

    let html = `<div class="fade-in">`;

    // Header
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

    html += renderSummaryStrip(metrics);
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

    // Client Comparison
    const clientGroups = MetricsCalc.computeClientComparison(filteredRecords);
    if (clientGroups.length > 1) {
        html += `
            <h3 class="section-title">Client Comparison</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">Client Performance Table</span></div>
                    ${renderClientComparisonTable(filteredRecords)}
                </div>
            </div>
        `;
    }

    // Target Audience
    const audienceGroups = MetricsCalc.computeByDimension(filteredRecords, r => r._targetAudience);
    if (audienceGroups.length > 0 && audienceGroups[0].name !== 'Unknown') {
        html += `
            <h3 class="section-title">Target Audience Performance</h3>
            <div class="grid grid-1">
                <div class="card">
                    <div class="card-header"><span class="card-title">Performance by Audience</span></div>
                    ${renderDimensionTable(filteredRecords, r => r._targetAudience, 'audience', 'Target Audience')}
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
                    <div class="card-header"><span class="card-title">Sent Distribution by Type</span></div>
                    <div class="chart-container md" style="display:flex;align-items:center;justify-content:center;">
                        <canvas id="chart-type-donut"></canvas>
                    </div>
                </div>
            </div>
        `;
    }

    // Hourly + Team Leader
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

    // Copy Used
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

    // Subject Line
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

    // Render charts + set up interactive tables after DOM update
    requestAnimationFrame(() => {
        setupSortableTables();
        renderSentimentChart(metrics);
        renderTrendsCharts(filteredRecords);
        if (typeGroups.length > 0 && typeGroups[0].name !== 'Unknown') {
            renderDimensionDonut('chart-type-donut', filteredRecords, r => r._type, 'totalSent');
        }
        if (hasHourData) renderHourlyChart(filteredRecords);
    });
}
