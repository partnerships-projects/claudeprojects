// ============================================================================
// UI COMPONENT: SUMMARY STRIP
// ============================================================================
function renderSummaryStrip(metrics) {
    return `
        <div class="summary-strip">
            <div class="summary-item">
                <div class="s-label">Emails Sent</div>
                <div class="s-value text-blue">${fmtNum(metrics.totalSent)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Opens</div>
                <div class="s-value text-purple">${fmtNum(metrics.totalOpens)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Replies</div>
                <div class="s-value text-green">${fmtNum(metrics.totalReplies)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Positives</div>
                <div class="s-value text-cyan">${fmtNum(metrics.totalPositive)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Negatives</div>
                <div class="s-value text-red">${fmtNum(metrics.totalNegative)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Complex</div>
                <div class="s-value text-yellow">${fmtNum(metrics.totalComplex)}</div>
            </div>
            <div class="summary-item">
                <div class="s-label">Conversions</div>
                <div class="s-value text-orange">${fmtNum(metrics.totalConverted)}</div>
            </div>
        </div>
    `;
}
