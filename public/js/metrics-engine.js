// ============================================================================
// METRICS CALCULATOR — KPI computations, trends, dimension grouping
// ============================================================================
const MetricsCalc = {
    compute(records) {
        if (!records || records.length === 0) {
            return this._empty();
        }

        const totalSent = records.reduce((s, r) => s + r._emailSent, 0);
        const totalOpens = records.reduce((s, r) => s + r._opens, 0);
        const totalReplies = records.reduce((s, r) => s + r._replies, 0);
        const totalPositive = records.reduce((s, r) => s + r._positive, 0);
        const totalNegative = records.reduce((s, r) => s + r._negative, 0);
        const totalComplex = records.reduce((s, r) => s + r._complex, 0);
        const totalConverted = records.reduce((s, r) => s + r._converted, 0);

        return {
            totalRecords: records.length,
            totalSent,
            totalOpens,
            totalReplies,
            totalPositive,
            totalNegative,
            totalComplex,
            totalConverted,

            openRate: safeDivide(totalOpens, totalSent),
            replyRate: safeDivide(totalReplies, totalSent),
            positiveRate: safeDivide(totalPositive, totalReplies),
            negativeRate: safeDivide(totalNegative, totalReplies),
            complexRate: safeDivide(totalComplex, totalReplies),
            conversionRate: safeDivide(totalConverted, totalReplies),
            positiveConversionRate: safeDivide(totalConverted, totalPositive),
            negativeRatio: safeDivide(totalNegative, totalPositive + totalNegative),

            responseQuality: safeDivide(totalPositive, totalPositive + totalNegative + totalComplex),
            engagementRate: safeDivide(totalOpens + totalReplies, totalSent),
        };
    },

    _empty() {
        return {
            totalRecords: 0, totalSent: 0, totalOpens: 0, totalReplies: 0,
            totalPositive: 0, totalNegative: 0, totalComplex: 0, totalConverted: 0,
            openRate: 0, replyRate: 0, positiveRate: 0, negativeRate: 0,
            complexRate: 0, conversionRate: 0, positiveConversionRate: 0,
            negativeRatio: 0, responseQuality: 0, engagementRate: 0,
        };
    },

    computeTrends(records) {
        const byMonth = {};
        records.forEach(r => {
            if (!r._date) return;
            const key = formatMonthKey(r._date);
            if (!byMonth[key]) byMonth[key] = [];
            byMonth[key].push(r);
        });

        return Object.keys(byMonth).sort().map(key => ({
            period: key,
            label: formatMonthLabel(key),
            metrics: this.compute(byMonth[key]),
            count: byMonth[key].length,
        }));
    },

    computeWeeklyTrends(records) {
        const byWeek = {};
        records.forEach(r => {
            if (!r._date) return;
            const d = new Date(r._date);
            const dayOfWeek = d.getDay();
            const startOfWeek = new Date(d);
            startOfWeek.setDate(d.getDate() - dayOfWeek);
            const key = startOfWeek.toISOString().slice(0, 10);
            if (!byWeek[key]) byWeek[key] = [];
            byWeek[key].push(r);
        });

        return Object.keys(byWeek).sort().map(key => ({
            period: key,
            label: formatDate(new Date(key)),
            metrics: this.compute(byWeek[key]),
            count: byWeek[key].length,
        }));
    },

    computeByDimension(records, accessor, label = 'dimension') {
        const groups = {};
        records.forEach(r => {
            const key = accessor(r) || 'Unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        });

        return Object.entries(groups)
            .map(([name, recs]) => ({
                name,
                metrics: this.compute(recs),
                count: recs.length,
            }))
            .sort((a, b) => b.metrics.totalSent - a.metrics.totalSent);
    },

    computeClientComparison(records) {
        return this.computeByDimension(records, r => r._sheet, 'client');
    },
};
