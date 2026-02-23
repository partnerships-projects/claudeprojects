'use strict';

// ============================================================================
// APPLICATION CONFIGURATION
// No secrets here — API keys live server-side.
// ============================================================================
const CONFIG = {
    SPREADSHEET_ID: '1YSP2hUke2MJQvuiszliZu-GLzAnonuyaXuTmYY9O4CU',
    API_BASE: 'https://sheets.googleapis.com/v4/spreadsheets',

    // Only read columns A through V (first 22 columns).
    // Sheets contain auxiliary/duplicate columns after V that must be ignored.
    MAX_DATA_COLUMNS: 22,
    DATA_RANGE_SUFFIX: '!A:V',

    // Auto-refresh interval in milliseconds (30 seconds).
    // Set to 0 to disable auto-refresh.
    AUTO_REFRESH_INTERVAL: 30_000,

    // Minimum number of recognized headers a sheet must have to be treated as a client sheet.
    // Sheets with fewer matches (e.g. summary/config tabs) are skipped automatically.
    MIN_VALID_HEADERS: 5,

    // Sheet names to always exclude (case-insensitive substring match).
    // These are known non-client sheets like dashboards, templates, and config tabs.
    EXCLUDED_SHEETS: [
        'MASTER DATA SHEE',
        'CLIENT INFO',
        'CLIENT MONTHLY DASHBOARD',
        'CLIENT DAILY DASHBOARD',
        'COPY OF EXAMPLE!DO NOT EDIT ONLY DUPLICATE!',
    ],

    // Keywords that identify summary / total rows (case-insensitive).
    // Any row whose MONTH or DATE cell matches one of these is skipped.
    SUMMARY_ROW_KEYWORDS: [
        'TOTAL', 'TOTALS', 'GRAND TOTAL', 'GRAND TOTALS',
        'SUM', 'SUBTOTAL', 'SUB TOTAL', 'SUB-TOTAL',
        'AVERAGE', 'AVG', 'MEAN',
        'OVERALL', 'SUMMARY', 'AGGREGATE',
    ],

    // Column name normalization map (uppercase key -> internal field).
    // Only columns A:V are processed; duplicates after V are never seen.
    COLUMN_MAP: {
        'MONTH':            'month',
        'DATE':             'date',
        'HOUR':             'hour',
        'HOUR SENT':        'hour',
        'HOURS':            'hour',
        'SENT EMAIL':       'sentEmail',
        'EMAIL (USED)':     'sentEmail',
        'EMAIL USED':       'sentEmail',
        'EMAIL SENT':       'emailSent',
        '#EMAIL SENT':      'emailSent',
        '# EMAIL SENT':     'emailSent',
        'EMAILS SENT':      'emailSent',
        '#EMAILS SENT':     'emailSent',
        '# EMAILS SENT':    'emailSent',
        'TOTAL EMAILS SENT':'emailSent',
        'NO. OF EMAILS SENT':'emailSent',
        'TARGET AUDIENCE':  'targetAudience',
        'AUDIENCE':         'targetAudience',
        'SUBJECT LINE':     'subjectLine',
        'SUBJECT':          'subjectLine',
        'COPY USED':        'copyUsed',
        'COPY':             'copyUsed',
        'SERVERS':          'servers',
        'SERVER':           'servers',
        'POSITIVE':         'positive',
        'POSITIVES':        'positive',
        '#POSITIVE':        'positive',
        '# POSITIVE':       'positive',
        '#POSITIVES':       'positive',
        '# POSITIVES':      'positive',
        'NEGATIVE':         'negative',
        'NEGATIVES':        'negative',
        '#NEGATIVE':        'negative',
        '# NEGATIVE':       'negative',
        '#NEGATIVES':       'negative',
        '# NEGATIVES':      'negative',
        'COMPLEX':          'complex',
        '#COMPLEX':         'complex',
        '# COMPLEX':        'complex',
        'CONVERTED':        'converted',
        'CONVERSIONS':      'converted',
        'CONVERSION':       'converted',
        '#CONVERTED':       'converted',
        '# CONVERTED':      'converted',
        '#CONVERSIONS':     'converted',
        '# CONVERSIONS':    'converted',
        'OPEN RATE':        'openRate',
        'OPEN %':           'openRate',
        'OPEN RATE %':      'openRate',
        'REPLY RATE':       'replyRate',
        'REPLY %':          'replyRate',
        'REPLY RATE %':     'replyRate',
        'OPENS':            'opens',
        'OPEN':             'opens',
        '#OPENS':           'opens',
        '# OPENS':          'opens',
        'TOTAL OPENS':      'opens',
        'REPLIES':          'replies',
        'REPLY':            'replies',
        '#REPLIES':         'replies',
        '# REPLIES':        'replies',
        'TOTAL REPLIES':    'replies',
        'CLIENT NAME':      'clientName',
        'CLIENT':           'clientName',
        'TEAM LEADER':      'teamLeader',
        'TEAM LEAD':        'teamLeader',
        'TL':               'teamLeader',
        'CS':               'cs',
        'OWNER':            'owner',
        'ACCOUNT OWNER':    'owner',
        'CLIENT OWNER':     'owner',
        'MANAGED BY':       'owner',
        'TYPE':             'type',
        'GOAL':             'goal',
        'GOALS':            'goal',
    },

    // Palette for clients/segments
    COLORS: [
        '#4f8df5', '#34d399', '#fbbf24', '#f87171', '#a78bfa',
        '#22d3ee', '#fb923c', '#f472b6', '#818cf8', '#2dd4bf',
        '#e879f9', '#84cc16', '#f97316', '#06b6d4', '#8b5cf6',
    ],
};
