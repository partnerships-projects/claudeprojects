// ============================================================================
// CHART REGISTRY — Chart.js instance management and defaults
// ============================================================================
const Charts = {
    _instances: {},

    create(id, config) {
        this.destroy(id);
        const canvas = document.getElementById(id);
        if (!canvas) return null;
        const chart = new Chart(canvas, config);
        this._instances[id] = chart;
        return chart;
    },

    destroy(id) {
        if (this._instances[id]) {
            this._instances[id].destroy();
            delete this._instances[id];
        }
    },

    destroyAll() {
        Object.keys(this._instances).forEach(id => this.destroy(id));
    },
};

function setupChartDefaults() {
    Chart.defaults.color = '#8b8fa3';
    Chart.defaults.borderColor = 'rgba(35, 40, 66, 0.5)';
    Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
    Chart.defaults.plugins.legend.labels.padding = 14;
    Chart.defaults.plugins.tooltip.backgroundColor = '#1e2235';
    Chart.defaults.plugins.tooltip.borderColor = '#2a2f45';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
    Chart.defaults.elements.bar.borderRadius = 4;
    Chart.defaults.elements.bar.borderSkipped = false;
}
