// ============================================================================
// UI COMPONENT: KPI CARDS
// ============================================================================
function renderKPICards(metrics) {
    return `
        <div class="grid grid-4">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Open Rate</span>
                    <div class="card-icon bg-purple text-purple">&#9993;</div>
                </div>
                <div class="kpi-value text-purple">${fmtPct(metrics.openRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalOpens)} opens / ${fmtNum(metrics.totalSent)} sent</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Reply Rate</span>
                    <div class="card-icon bg-green text-green">&#8617;</div>
                </div>
                <div class="kpi-value text-green">${fmtPct(metrics.replyRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalReplies)} replies / ${fmtNum(metrics.totalSent)} sent</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Positive Rate</span>
                    <div class="card-icon bg-cyan text-cyan">&#10003;</div>
                </div>
                <div class="kpi-value text-cyan">${fmtPct(metrics.positiveRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalPositive)} positive / ${fmtNum(metrics.totalReplies)} replies</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Conversion Rate</span>
                    <div class="card-icon bg-orange text-orange">&#127919;</div>
                </div>
                <div class="kpi-value text-orange">${fmtPct(metrics.conversionRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalConverted)} converted / ${fmtNum(metrics.totalReplies)} replies</div>
            </div>
        </div>
        <div class="grid grid-4">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Positive &rarr; Conversion</span>
                    <div class="card-icon bg-yellow text-yellow">&#9733;</div>
                </div>
                <div class="kpi-value text-yellow">${fmtPct(metrics.positiveConversionRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalConverted)} converted / ${fmtNum(metrics.totalPositive)} positive</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Negative Ratio</span>
                    <div class="card-icon bg-red text-red">&#10007;</div>
                </div>
                <div class="kpi-value text-red">${fmtPct(metrics.negativeRatio)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalNegative)} neg / ${fmtNum(metrics.totalPositive + metrics.totalNegative)} pos+neg</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Complex Rate</span>
                    <div class="card-icon bg-yellow text-yellow">&#9888;</div>
                </div>
                <div class="kpi-value text-yellow">${fmtPct(metrics.complexRate)}</div>
                <div class="kpi-sub">${fmtNum(metrics.totalComplex)} complex / ${fmtNum(metrics.totalReplies)} replies</div>
            </div>
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Engagement Rate</span>
                    <div class="card-icon bg-indigo text-indigo">&#9679;</div>
                </div>
                <div class="kpi-value text-indigo">${fmtPct(metrics.engagementRate)}</div>
                <div class="kpi-sub">(Opens + Replies) / Sent</div>
            </div>
        </div>
    `;
}
