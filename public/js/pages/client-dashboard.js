// ============================================================================
// CLIENT DASHBOARD RENDERER
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

    // Back button
    html += `
        <button class="btn-back-to-clients" id="btn-back-clients">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.53 11.53a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 0-1.06l3-3a.75.75 0 1 1 1.06 1.06L7.06 8l2.47 2.47a.75.75 0 0 1 0 1.06z"/>
            </svg>
            All Clients
        </button>
    `;

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

    // Copy Used
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

    // Hourly + Team Leader
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

    // Back to directory
    document.getElementById('btn-back-clients')?.addEventListener('click', () => {
        Store.setView('clients');
    });

    // Render charts + set up interactive tables
    requestAnimationFrame(() => {
        setupSortableTables();
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
