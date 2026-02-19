// ============================================================================
// UI COMPONENT: SENTIMENT BREAKDOWN
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
