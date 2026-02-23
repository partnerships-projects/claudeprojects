// ============================================================================
// UI COMPONENT: SENTIMENT BREAKDOWN
// ============================================================================
function renderSentimentHTML(metrics) {
    const total = metrics.totalPositive + metrics.totalNegative + metrics.totalComplex;
    const pctPos = total > 0 ? (metrics.totalPositive / total * 100) : 0;
    const pctNeg = total > 0 ? (metrics.totalNegative / total * 100) : 0;
    const pctCpx = total > 0 ? (metrics.totalComplex / total * 100) : 0;

    return `
        <div style="text-align:center; margin-bottom:18px;">
            <div style="font-size:36px; font-weight:800; letter-spacing:-1px; font-variant-numeric:tabular-nums;">${fmtNum(total)}</div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Total Replies</div>
        </div>
        <div class="sentiment-bar-stack">
            ${pctPos > 0 ? `<div class="sentiment-bar-seg seg-positive" style="width:${pctPos}%" title="Positive: ${fmtNum(metrics.totalPositive)} (${pctPos.toFixed(1)}%)"><span>${pctPos >= 8 ? fmtNum(metrics.totalPositive) : ''}</span></div>` : ''}
            ${pctNeg > 0 ? `<div class="sentiment-bar-seg seg-negative" style="width:${pctNeg}%" title="Negative: ${fmtNum(metrics.totalNegative)} (${pctNeg.toFixed(1)}%)"><span>${pctNeg >= 8 ? fmtNum(metrics.totalNegative) : ''}</span></div>` : ''}
            ${pctCpx > 0 ? `<div class="sentiment-bar-seg seg-complex" style="width:${pctCpx}%" title="Complex: ${fmtNum(metrics.totalComplex)} (${pctCpx.toFixed(1)}%)"><span>${pctCpx >= 8 ? fmtNum(metrics.totalComplex) : ''}</span></div>` : ''}
        </div>
        <div class="sentiment-legend">
            <div class="sentiment-legend-item">
                <span class="sentiment-dot" style="background:#34d399"></span>
                <span class="sentiment-legend-label">Positive</span>
                <span class="sentiment-legend-value">${fmtNum(metrics.totalPositive)}</span>
                <span class="sentiment-legend-pct">${fmtPct(safeDivide(metrics.totalPositive, total))}</span>
            </div>
            <div class="sentiment-legend-item">
                <span class="sentiment-dot" style="background:#f87171"></span>
                <span class="sentiment-legend-label">Negative</span>
                <span class="sentiment-legend-value">${fmtNum(metrics.totalNegative)}</span>
                <span class="sentiment-legend-pct">${fmtPct(safeDivide(metrics.totalNegative, total))}</span>
            </div>
            <div class="sentiment-legend-item">
                <span class="sentiment-dot" style="background:#fbbf24"></span>
                <span class="sentiment-legend-label">Complex</span>
                <span class="sentiment-legend-value">${fmtNum(metrics.totalComplex)}</span>
                <span class="sentiment-legend-pct">${fmtPct(safeDivide(metrics.totalComplex, total))}</span>
            </div>
        </div>
    `;
}

function renderSentimentChart(metrics) {
    // Sentiment is now rendered as a stacked bar + legend (no canvas needed)
}
