// ============================================================================
// FILTER ENGINE — Apply filters to records
// ============================================================================
const FilterEngine = {
    apply(records, filters, view, clientName) {
        let result = records;

        // For client view, first filter to that client's sheet
        if (view === 'client' && clientName) {
            result = result.filter(r => r._sheet === clientName);
        }

        // Date range
        if (filters.dateFrom) {
            const from = new Date(filters.dateFrom);
            result = result.filter(r => !r._date || r._date >= from);
        }
        if (filters.dateTo) {
            const to = new Date(filters.dateTo);
            to.setHours(23, 59, 59, 999);
            result = result.filter(r => !r._date || r._date <= to);
        }

        // Client filter (only relevant in master view)
        if (view === 'master' && filters.client !== 'all') {
            result = result.filter(r => r._sheet === filters.client);
        }

        // Type
        if (filters.type !== 'all') {
            result = result.filter(r => r._type === filters.type);
        }

        // Target audience
        if (filters.audience !== 'all') {
            result = result.filter(r => r._targetAudience === filters.audience);
        }

        // Owner (matches Team Leader or CS)
        if (filters.owner !== 'all') {
            result = result.filter(r => r._teamLeader === filters.owner || r._cs === filters.owner);
        }

        return result;
    },
};
