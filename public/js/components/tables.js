// ============================================================================
// UI COMPONENTS: TABLES, DONUTS, HOURLY CHART
// ============================================================================

// Client comparison bar chart (master only)
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

// Client comparison table
function renderClientComparisonTable(records) {
    const clients = MetricsCalc.computeClientComparison(records);
    if (clients.length === 0) return '';

    const bestConv = Math.max(...clients.map(c => c.metrics.conversionRate));

    const rows = clients.map(c => {
        const m = c.metrics;
        const isBest = m.conversionRate === bestConv && bestConv > 0;
        return `
            <tr class="${isBest ? 'highlight-row' : ''}">
                <td class="name-col" data-sort-value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
                <td class="num" data-sort-value="${m.totalSent}">${fmtNum(m.totalSent)}</td>
                <td class="num" data-sort-value="${m.openRate}">${fmtPct(m.openRate)}</td>
                <td class="num" data-sort-value="${m.replyRate}">${fmtPct(m.replyRate)}</td>
                <td class="num" data-sort-value="${m.positiveRate}" style="color:var(--positive)">${fmtPct(m.positiveRate)}</td>
                <td class="num" data-sort-value="${m.conversionRate}">${fmtPct(m.conversionRate)}</td>
                <td class="num" data-sort-value="${m.positiveConversionRate}">${fmtPct(m.positiveConversionRate)}</td>
                <td class="num" data-sort-value="${m.totalConverted}" style="font-weight:700">${fmtNum(m.totalConverted)}</td>
                <td>${isBest ? '<span class="table-badge badge-best">Top</span>' : ''}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="table-scroll-container">
            <table class="data-table sortable-table">
                <thead>
                    <tr>
                        <th class="sortable-th" data-sort-key="0">Client <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="1">Sent <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="2">Open Rate <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="3">Reply Rate <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="4">Positive % <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="5">Conv. Rate <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="6">Pos&rarr;Conv <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="7">Conversions <span class="sort-arrow"></span></th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// Generic dimension performance table (sortable + scrollable)
function renderDimensionTable(records, accessor, label, labelCol = 'Segment') {
    const groups = MetricsCalc.computeByDimension(records, accessor, label);
    if (groups.length === 0) return '<p style="color:var(--text-muted);font-size:13px;">No data available</p>';

    const bestConv = Math.max(...groups.map(g => g.metrics.conversionRate));

    const rows = groups.map(g => {
        const m = g.metrics;
        const isBest = m.conversionRate === bestConv && bestConv > 0;
        return `
            <tr class="${isBest ? 'highlight-row' : ''}">
                <td class="name-col" data-sort-value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</td>
                <td class="num" data-sort-value="${m.totalSent}">${fmtNum(m.totalSent)}</td>
                <td class="num" data-sort-value="${m.openRate}">${fmtPct(m.openRate)}</td>
                <td class="num" data-sort-value="${m.replyRate}">${fmtPct(m.replyRate)}</td>
                <td class="num" data-sort-value="${m.positiveRate}" style="color:var(--positive)">${fmtPct(m.positiveRate)}</td>
                <td class="num" data-sort-value="${m.conversionRate}">${fmtPct(m.conversionRate)}</td>
                <td class="num" data-sort-value="${m.totalConverted}" style="font-weight:700">${fmtNum(m.totalConverted)}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="table-scroll-container">
            <table class="data-table sortable-table">
                <thead>
                    <tr>
                        <th class="sortable-th" data-sort-key="0">${labelCol} <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="1">Sent <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="2">Open Rate <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="3">Reply Rate <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="4">Positive % <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="5">Conv. Rate <span class="sort-arrow"></span></th>
                        <th class="sortable-th" data-sort-key="6">Conversions <span class="sort-arrow"></span></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// Dimension donut chart
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

// Hourly performance chart
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

// Team Leader table (convenience wrapper)
function renderTeamLeaderTable(records) {
    return renderDimensionTable(records, r => r._teamLeader, 'teamLeader', 'Team Leader');
}

// Initialize sorting on all sortable tables in the DOM
function setupSortableTables() {
    document.querySelectorAll('.sortable-table').forEach(table => {
        const headers = table.querySelectorAll('th.sortable-th');
        headers.forEach(th => {
            th.addEventListener('click', () => {
                const colIndex = parseInt(th.dataset.sortKey);
                const tbody = table.querySelector('tbody');
                const rows = Array.from(tbody.querySelectorAll('tr'));

                // Toggle direction
                const currentDir = th.dataset.sortDir || 'none';
                const newDir = currentDir === 'asc' ? 'desc' : 'asc';

                // Reset all headers in this table
                headers.forEach(h => {
                    h.dataset.sortDir = 'none';
                    h.classList.remove('sort-asc', 'sort-desc');
                });

                th.dataset.sortDir = newDir;
                th.classList.add(newDir === 'asc' ? 'sort-asc' : 'sort-desc');

                // Sort rows by data-sort-value
                rows.sort((a, b) => {
                    const aVal = a.cells[colIndex].dataset.sortValue;
                    const bVal = b.cells[colIndex].dataset.sortValue;

                    const aNum = parseFloat(aVal);
                    const bNum = parseFloat(bVal);
                    const isNumeric = !isNaN(aNum) && !isNaN(bNum);

                    let cmp;
                    if (isNumeric) {
                        cmp = aNum - bNum;
                    } else {
                        cmp = (aVal || '').localeCompare(bVal || '');
                    }

                    return newDir === 'asc' ? cmp : -cmp;
                });

                rows.forEach(row => tbody.appendChild(row));
            });
        });
    });
}

// Horizontal stacked bar chart: reply sentiment breakdown by dimension
function renderReplyBreakdownChart(chartId, records, accessor) {
    const groups = MetricsCalc.computeByDimension(records, accessor);
    if (groups.length === 0) return;

    Charts.create(chartId, {
        type: 'bar',
        data: {
            labels: groups.map(g => g.name),
            datasets: [
                {
                    label: 'Positive',
                    data: groups.map(g => g.metrics.totalPositive),
                    backgroundColor: colorWithAlpha('#34d399', 0.75),
                },
                {
                    label: 'Negative',
                    data: groups.map(g => g.metrics.totalNegative),
                    backgroundColor: colorWithAlpha('#f87171', 0.75),
                },
                {
                    label: 'Complex',
                    data: groups.map(g => g.metrics.totalComplex),
                    backgroundColor: colorWithAlpha('#fbbf24', 0.75),
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(35,40,66,0.4)' } },
                y: { stacked: true, grid: { display: false } },
            },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        afterBody: function(items) {
                            const idx = items[0].dataIndex;
                            const g = groups[idx];
                            const total = g.metrics.totalPositive + g.metrics.totalNegative + g.metrics.totalComplex;
                            return total > 0 ? `Total replies: ${fmtNum(total)}` : '';
                        },
                    },
                },
            },
        },
    });
}
