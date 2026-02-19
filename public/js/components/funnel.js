// ============================================================================
// UI COMPONENT: ENGAGEMENT FUNNEL
// ============================================================================
function renderFunnelHTML(metrics) {
    const steps = [
        { label: 'Sent', value: metrics.totalSent, color: 'var(--accent-blue)' },
        { label: 'Opened', value: metrics.totalOpens, color: 'var(--accent-purple)' },
        { label: 'Replied', value: metrics.totalReplies, color: 'var(--accent-green)' },
        { label: 'Positive', value: metrics.totalPositive, color: 'var(--accent-cyan)' },
        { label: 'Converted', value: metrics.totalConverted, color: 'var(--accent-orange)' },
    ];

    const maxVal = Math.max(steps[0].value, 1);

    return steps.map((s, i) => {
        const widthPct = Math.max((s.value / maxVal) * 100, 6);
        const rate = i === 0 ? '' : fmtPct(safeDivide(s.value, steps[i - 1].value));
        return `
            <div class="funnel-step">
                <div class="funnel-label">${s.label}</div>
                <div class="funnel-bar-wrap">
                    <div class="funnel-bar" style="width:${widthPct}%;background:${s.color};">${fmtNum(s.value)}</div>
                </div>
                <div class="funnel-rate">${rate}</div>
            </div>
        `;
    }).join('');
}
