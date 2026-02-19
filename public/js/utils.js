// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function safeNum(val) {
    if (val === null || val === undefined || val === '') return 0;
    const s = String(val).replace(/[,%$]/g, '').trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function safeDivide(num, denom) {
    if (!denom || denom === 0) return 0;
    return num / denom;
}

function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val)) return val;
    const s = String(val).trim();
    if (!s) return null;
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // Try DD/MM/YYYY
    const parts = s.split(/[\/\-\.]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map(Number);
        if (c > 100) return new Date(c, b - 1, a); // DD/MM/YYYY
        if (a > 100) return new Date(a, b - 1, c); // YYYY/MM/DD
    }
    return null;
}

function formatDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMonthKey(d) {
    if (!d) return 'unknown';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(key) {
    const [y, m] = key.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m) - 1]} ${y}`;
}

function fmtNum(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('en-US');
}

function fmtPct(ratio, decimals = 1) {
    if (ratio === null || ratio === undefined || isNaN(ratio)) return '—';
    return (ratio * 100).toFixed(decimals) + '%';
}

function fmtPctVal(val, decimals = 1) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toFixed(decimals) + '%';
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function colorForIndex(i) {
    return CONFIG.COLORS[i % CONFIG.COLORS.length];
}

function colorWithAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getDateRangeLabel(records) {
    let min = null, max = null;
    records.forEach(r => {
        if (!r._date) return;
        if (!min || r._date < min) min = r._date;
        if (!max || r._date > max) max = r._date;
    });
    if (!min || !max) return '';
    return `${formatDate(min)} &ndash; ${formatDate(max)}`;
}
