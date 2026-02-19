// ============================================================================
// UI COMPONENT: TIME SERIES CHARTS
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
